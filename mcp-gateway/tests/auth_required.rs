//! End-to-end integration test for M3's AuthRequired runtime wiring —
//! needs infra up (`just infra` from the repo root; override the admin
//! connection with `TEST_PG_URL`), same convention `oss/hitl/tests/repo.rs`
//! and `oss/server/tests` use. Each test creates and drops its own scratch
//! database so tests can run concurrently without colliding.
//!
//! `resolved: ResolvedSession` is constructed directly (bypassing
//! `session::resolve_session`'s real connector/credential resolution,
//! already covered by `credentials.rs`'s own tests) so these tests exercise
//! exactly the new code: `protocol::handle_tools_call`'s AuthRequired
//! branch, `session::resolve_context_id`'s `session_traces` lookup, and
//! `nasiko_hitl::repo::create_pending_auth_required`'s real persistence.

use std::collections::HashMap;

use nasiko_mcp_gateway::config::McpConfig;
use nasiko_mcp_gateway::permissions::PermissionContext;
use nasiko_mcp_gateway::protocol::handle_tools_call;
use nasiko_mcp_gateway::provider::{GenericMcpProvider, Providers};
use nasiko_mcp_gateway::session::ResolvedSession;
use nasiko_mcp_gateway::types::{ConnectorUnusable, MCPServerConfig, UnusableConnector, codes};
use nasiko_mcp_gateway::{McpState, OssConnectorAuthorizer};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

fn pg_admin_url() -> String {
    std::env::var("TEST_PG_URL")
        .unwrap_or_else(|_| "postgres://nasiko:nasiko@localhost:5432/nasiko_dev".into())
}

struct TestDb {
    state: McpState,
    agent_id: Uuid,
    owner_user_id: Uuid,
}

impl TestDb {
    async fn new() -> Self {
        let pg_admin = pg_admin_url();
        let db_name = format!("nasiko_mcp_auth_required_test_{}", Uuid::new_v4().simple());

        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&pg_admin)
            .await
            .expect("connect to postgres — is infra up? (set TEST_PG_URL to override; `just infra` starts it)");
        sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
            .execute(&admin)
            .await
            .expect("create scratch test database");

        let base = pg_admin
            .rsplit_once('/')
            .map_or(pg_admin.as_str(), |(b, _)| b);
        let db_url = format!("{base}/{db_name}");
        let db: PgPool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&db_url)
            .await
            .expect("connect to scratch test database");

        sqlx::migrate!("../migrations")
            .run(&db)
            .await
            .expect("run oss/migrations against scratch database");

        let owner_user_id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, email) VALUES ($1, $2, $3)")
            .bind(owner_user_id)
            .bind(format!("mcp-auth-test-{}", owner_user_id.simple()))
            .bind(format!(
                "mcp-auth-test-{}@example.com",
                owner_user_id.simple()
            ))
            .execute(&db)
            .await
            .expect("seed user");

        let agent_id = Uuid::new_v4();
        sqlx::query("INSERT INTO agents (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(agent_id)
            .bind(format!("mcp-auth-test-agent-{}", agent_id.simple()))
            .bind(owner_user_id)
            .execute(&db)
            .await
            .expect("seed agent");

        let state = McpState {
            db,
            redis: redis::Client::open("redis://127.0.0.1:1/").expect("lazy redis client"),
            http_client: reqwest::Client::new(),
            guarded_http_client: reqwest::Client::new(),
            config: McpConfig {
                composio_api_key: None,
                composio_base_url: "http://localhost".to_string(),
                composio_webhook_secret: None,
                gateway_public_url: None,
                oauth_redirect_base_url: None,
                composio_callback_base_url: None,
                session_ttl_seconds: 60,
                perm_cache_ttl_seconds: 60,
                manifest_ttl_seconds: 60,
                toolcount_ttl_seconds: 3600,
                oauth_state_signing_key: "test".to_string(),
                description_model: "gpt-4o-mini".to_string(),
            },
            providers: Providers {
                composio: None,
                mcp: GenericMcpProvider::new(reqwest::Client::new(), reqwest::Client::new()),
            },
            authorizer: std::sync::Arc::new(OssConnectorAuthorizer),
            endpoint_refresher: std::sync::Arc::new(
                nasiko_mcp_gateway::endpoint_refresh::NoopEndpointRefresher,
            ),
            llm: nasiko_orchestrator::providers::LLMProvider::from_env(reqwest::Client::new()),
        };

        Self {
            state,
            agent_id,
            owner_user_id,
        }
    }

    /// Seed a `chat_sessions` + `session_traces` row so `trace_id` resolves
    /// to `session_id` (the A2A contextId) via `session::resolve_context_id`.
    async fn seed_session_trace(&self, session_id: &str, trace_id: &str) {
        sqlx::query(
            "INSERT INTO chat_sessions (session_id, user_id, title) VALUES ($1, $2, 'test session')",
        )
        .bind(session_id)
        .bind(self.owner_user_id)
        .execute(&self.state.db)
        .await
        .expect("seed chat_sessions row");

        sqlx::query("INSERT INTO session_traces (session_id, trace_id) VALUES ($1, $2)")
            .bind(session_id)
            .bind(trace_id)
            .execute(&self.state.db)
            .await
            .expect("seed session_traces row");
    }

    fn perms(&self) -> PermissionContext {
        PermissionContext {
            agent_id: self.agent_id,
            enabled_connectors: Default::default(),
            rules: vec![],
            hash: "h".into(),
        }
    }
}

/// A resolved session with an empty `servers` list and one connector
/// recorded as unusable for `reason` — mirrors what a real
/// `session::resolve_session` produces for a connector whose credential is
/// missing/expired.
fn unusable_session(connector_id: Uuid, reason: ConnectorUnusable, name: &str) -> ResolvedSession {
    ResolvedSession {
        servers: Vec::<MCPServerConfig>::new(),
        connected_toolkits: vec![],
        toolkit_to_connector: HashMap::new(),
        unusable_connectors: HashMap::from([(
            connector_id,
            UnusableConnector {
                reason,
                name: name.to_string(),
            },
        )]),
    }
}

fn connector_tool_name(connector_id: Uuid, tool: &str) -> String {
    format!(
        "{}__{tool}",
        nasiko_mcp_gateway::types::connector_prefix(connector_id)
    )
}

#[tokio::test]
async fn auth_required_persists_hitl_row_and_returns_auth_required_code() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    let trace_id = "0af7651916cd43dd8448eb211c80319c";
    let session_id = "ses_test_auth_required";
    db.seed_session_trace(session_id, trace_id).await;

    let resolved = unusable_session(connector_id, ConnectorUnusable::AuthRequired, "github");
    let perms = db.perms();
    let tool = connector_tool_name(connector_id, "list_repos");
    let traceparent = format!("00-{trace_id}-b7ad6b7169203331-01");

    let res = handle_tools_call(
        &db.state,
        db.owner_user_id,
        &json!(1),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent),
    )
    .await;

    assert_eq!(
        res["error"]["code"],
        json!(codes::AUTH_REQUIRED),
        "must return the new AUTH_REQUIRED code, not the generic INVALID_PARAMS: {res}"
    );
    let hitl_request_id = res["error"]["data"]["hitl_request_id"]
        .as_str()
        .expect("response data must carry the hitl_request_id");

    let row =
        nasiko_hitl::repo::get_by_id(&db.state.db, hitl_request_id.parse().expect("valid uuid"))
            .await
            .expect("get_by_id")
            .expect("row must exist");

    assert_eq!(row.kind, nasiko_hitl::HitlKind::AuthRequired);
    assert_eq!(row.origin, nasiko_hitl::HitlOrigin::McpTool);
    assert_eq!(row.status, nasiko_hitl::HitlStatus::Pending);
    assert_eq!(row.agent_id, db.agent_id);
    assert_eq!(row.owner_user_id, db.owner_user_id);
    assert_eq!(row.connector_id, Some(connector_id));
    // The trace_id resolves to the seeded chat session — the A2A contextId —
    // not the raw trace_id, proving the session_traces lookup actually ran.
    assert_eq!(row.context_id.as_deref(), Some(session_id));
}

#[tokio::test]
async fn auth_required_falls_back_to_raw_trace_id_when_no_session_trace_exists() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    let trace_id = "1bf7651916cd43dd8448eb211c80319d";

    let resolved = unusable_session(connector_id, ConnectorUnusable::AuthRequired, "github");
    let perms = db.perms();
    let tool = connector_tool_name(connector_id, "list_repos");
    let traceparent = format!("00-{trace_id}-b7ad6b7169203331-01");

    let res = handle_tools_call(
        &db.state,
        db.owner_user_id,
        &json!(1),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent),
    )
    .await;

    assert_eq!(res["error"]["code"], json!(codes::AUTH_REQUIRED), "{res}");
    let hitl_request_id: Uuid = res["error"]["data"]["hitl_request_id"]
        .as_str()
        .expect("hitl_request_id present")
        .parse()
        .expect("valid uuid");
    let row = nasiko_hitl::repo::get_by_id(&db.state.db, hitl_request_id)
        .await
        .expect("get_by_id")
        .expect("row must exist");

    assert_eq!(row.context_id.as_deref(), Some(trace_id));
}

#[tokio::test]
async fn repeated_calls_for_the_same_connector_and_conversation_reuse_the_same_hitl_row() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    let trace_id = "2cf7651916cd43dd8448eb211c80319e";

    let resolved = unusable_session(connector_id, ConnectorUnusable::AuthRequired, "github");
    let perms = db.perms();
    let tool = connector_tool_name(connector_id, "list_repos");
    let traceparent = format!("00-{trace_id}-b7ad6b7169203331-01");

    let first = handle_tools_call(
        &db.state,
        db.owner_user_id,
        &json!(1),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent),
    )
    .await;
    let second = handle_tools_call(
        &db.state,
        db.owner_user_id,
        &json!(2),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent),
    )
    .await;

    assert_eq!(
        first["error"]["data"]["hitl_request_id"], second["error"]["data"]["hitl_request_id"],
        "a retried call against the same still-unusable connector must not create a second pending row"
    );
}

#[tokio::test]
async fn missing_credential_reason_never_persists_a_hitl_row() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    let trace_id = "3df7651916cd43dd8448eb211c80319f";

    let resolved = unusable_session(connector_id, ConnectorUnusable::MissingCredential, "github");
    let perms = db.perms();
    let tool = connector_tool_name(connector_id, "list_repos");
    let traceparent = format!("00-{trace_id}-b7ad6b7169203331-01");

    let res = handle_tools_call(
        &db.state,
        db.owner_user_id,
        &json!(1),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent),
    )
    .await;

    assert_eq!(
        res["error"]["code"],
        json!(codes::INVALID_PARAMS),
        "MissingCredential must keep today's generic error, not AUTH_REQUIRED: {res}"
    );

    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM hitl_requests")
        .fetch_one(&db.state.db)
        .await
        .expect("count rows");
    assert_eq!(
        count, 0,
        "no hitl_requests row should exist for a non-AuthRequired reason"
    );
}
