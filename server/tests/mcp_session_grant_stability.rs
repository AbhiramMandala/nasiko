//! End-to-end regression test for the MCP session-grant stability bug: found
//! live testing a real deployed agent through a real chat conversation —
//! `mcp_session_tool_grants` was keyed by the trace-derived `context_id`
//! (`session::resolve_context_id`), a *per-message* value, so a grant
//! created against message 1's trace context could never match message 2's
//! different trace context. "Allow for Session" behaved almost exactly like
//! "Allow Once".
//!
//! The fix (`nasiko_hitl::repo::resolve_stable_session_context`) keys
//! session-grant creation and lookup by the stable `chat_sessions.session_id`
//! instead — the same identity direct-chat's own HITL rows already use —
//! while leaving `once`-scope claiming (still trace-derived) and the
//! dispatcher/HITL architecture untouched.
//!
//! Two tiers: when `session::resolve_context_id` has already resolved the
//! call's own trace to a real `chat_sessions.session_id` (via a
//! `session_traces` row — what a real deployment always has once
//! `agent_proxy` has forwarded at least one message), that exact session is
//! trusted directly — this is what actually prevents a grant approved in one
//! active chat from leaking into a different, more-recently-touched chat
//! with the same agent (`session_grant_never_leaks_across_concurrent_chats_...`
//! below exercises this tier explicitly, including the adversarial
//! `updated_at` ordering that the naive "most recent" heuristic alone gets
//! wrong). Only when the trace has no `session_traces` mapping at all does
//! this fall back to "most recent session for this (user, agent) pair" —
//! `session_grant_spans_multiple_messages_...` below exercises that fallback
//! tier, since `handle_tools_call` in these tests never goes through
//! `agent_proxy` and so never produces a real `session_traces` row itself.
//!
//!   cargo test -p nasiko-server --test mcp_session_grant_stability -- --test-threads=1

mod common;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use nasiko_mcp_gateway::config::McpConfig;
use nasiko_mcp_gateway::permissions::{PermissionContext, PermissionRule};
use nasiko_mcp_gateway::protocol::handle_tools_call;
use nasiko_mcp_gateway::provider::{GenericMcpProvider, Providers};
use nasiko_mcp_gateway::repo::McpConnector;
use nasiko_mcp_gateway::session::ResolvedSession;
use nasiko_mcp_gateway::types::{
    AccessReason, MCPServerConfig, OrgGrantConsumer, ServerType, Stance, codes,
};
use nasiko_mcp_gateway::{ConnectorAuthorizer, McpState};
use serde_json::{Value, json};
use serial_test::serial;
use sqlx::PgPool;
use uuid::Uuid;

/// Layer-1 stub that always allows — mirrors `oss/mcp-gateway/tests/tool_approval.rs`'s
/// own copy; not reachable from this crate.
struct AllowAllAuthorizer;
#[async_trait]
impl ConnectorAuthorizer for AllowAllAuthorizer {
    async fn can_access_connector(
        &self,
        _db: &PgPool,
        _user_id: Uuid,
        _connector_id: Uuid,
    ) -> nasiko_mcp_gateway::Result<bool> {
        Ok(true)
    }
    async fn list_accessible_connectors(
        &self,
        _db: &PgPool,
        _user_id: Uuid,
    ) -> nasiko_mcp_gateway::Result<Vec<McpConnector>> {
        Ok(vec![])
    }
    async fn list_accessible_mcp_connectors(
        &self,
        _db: &PgPool,
        _user_id: Uuid,
    ) -> nasiko_mcp_gateway::Result<Vec<McpConnector>> {
        Ok(vec![])
    }
    async fn list_access_reasons(
        &self,
        _db: &PgPool,
        _connector: &McpConnector,
    ) -> nasiko_mcp_gateway::Result<Vec<AccessReason>> {
        Ok(vec![])
    }
    async fn list_org_grant_consumers(
        &self,
        _db: &PgPool,
        _connector_id: Uuid,
    ) -> nasiko_mcp_gateway::Result<(Vec<OrgGrantConsumer>, Vec<OrgGrantConsumer>)> {
        Ok((vec![], vec![]))
    }
}

/// A live stub MCP backend so the post-grant retry has something real to
/// succeed against, not just avoid an ask.
async fn start_stub_mcp_server_ok() -> String {
    async fn respond() -> axum::Json<Value> {
        axum::Json(json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}))
    }
    let app = axum::Router::new().route("/", axum::routing::post(respond));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://127.0.0.1:{port}/")
}

fn mcp_state(db: PgPool) -> McpState {
    McpState {
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
            hitl_request_ttl_days: 7,
        },
        providers: Providers {
            composio: None,
            mcp: GenericMcpProvider::new(reqwest::Client::new(), reqwest::Client::new()),
        },
        authorizer: Arc::new(AllowAllAuthorizer),
        endpoint_refresher: Arc::new(nasiko_mcp_gateway::endpoint_refresh::NoopEndpointRefresher),
        llm: nasiko_orchestrator::providers::LLMProvider::from_env(reqwest::Client::new()),
    }
}

fn mcp_session(connector_id: Uuid, backend_url: &str) -> ResolvedSession {
    ResolvedSession {
        servers: vec![MCPServerConfig {
            connector_id,
            kind: ServerType::Mcp,
            name: "test-connector".into(),
            url: backend_url.into(),
            headers: HashMap::new(),
            transport: "streamable_http".into(),
            trusted: false,
        }],
        connected_toolkits: vec![],
        toolkit_to_connector: HashMap::new(),
        unusable_connectors: HashMap::new(),
    }
}

async fn init_admin(server: &common::TestServer) -> (String, Uuid) {
    let v = server
        .client
        .post(server.url("/api/auth/initialize-admin"))
        .json(&json!({"username": "admin", "email": "admin@test.local"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let id = v["user_id"].as_str().unwrap().to_string();
    (id.clone(), Uuid::parse_str(&id).unwrap())
}

async fn seed_connector(server: &common::TestServer, owner: Uuid, url: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO mcp_connectors (provider_type, owner_id, name, url, auth_type)
         VALUES ('mcp_server', $1, 'session-grant-test-connector', $2, 'none') RETURNING id",
    )
    .bind(owner)
    .bind(url)
    .fetch_one(&server.db)
    .await
    .unwrap()
}

async fn seed_agent(server: &common::TestServer, owner: Uuid, name: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO agents (name, owner_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(name)
    .bind(owner)
    .fetch_one(&server.db)
    .await
    .unwrap()
}

/// `updated_at DESC` is what `resolve_stable_session_context` orders by, so
/// tests control "most recently active session" explicitly rather than
/// relying on real-clock timing between two `now()`-defaulted inserts.
async fn seed_chat_session(
    server: &common::TestServer,
    session_id: &str,
    user_id: Uuid,
    agent_id: Uuid,
    updated_at: chrono::DateTime<chrono::Utc>,
) {
    sqlx::query(
        "INSERT INTO chat_sessions (session_id, user_id, agent_id, title, updated_at) \
         VALUES ($1, $2, $3, 'test session', $4)",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(agent_id)
    .bind(updated_at)
    .execute(&server.db)
    .await
    .unwrap();
}

fn traceparent(trace_id: &str) -> String {
    format!("00-{trace_id}-b7ad6b7169203331-01")
}

/// What `agent_proxy` inserts for every real forwarded chat message — the mapping
/// `session::resolve_context_id` uses to resolve a call's raw trace id to the real
/// `chat_sessions.session_id` it belongs to. `handle_tools_call` in these tests never goes through
/// `agent_proxy`, so tests that want to exercise the trace-resolved tier (rather than the
/// most-recent-session fallback) must seed this row themselves.
async fn seed_session_trace(
    server: &common::TestServer,
    session_id: &str,
    trace_id: &str,
    agent_id: Uuid,
) {
    sqlx::query("INSERT INTO session_traces (session_id, trace_id, agent_id) VALUES ($1, $2, $3)")
        .bind(session_id)
        .bind(trace_id)
        .bind(agent_id)
        .execute(&server.db)
        .await
        .unwrap();
}

/// Exercises the fallback tier only ("most recent session for this user+agent") — none of these
/// calls goes through `agent_proxy`, so no `session_traces` row ever maps any of these traces to a
/// real session, and `resolve_stable_session_context`'s trace-resolved primary tier never fires.
/// This is why the "different chat" assertion at the end only holds given the ordering this test
/// pins (chat B created, with a newer `updated_at`, only after the grant already exists) — it is
/// a property of the fallback heuristic, not proof that a grant can never leak across two chats
/// that are *both* already active. See `session_grant_never_leaks_across_concurrent_chats_even_when_the_other_is_more_recently_active`
/// below for that stronger, trace-resolved guarantee.
#[tokio::test]
#[serial]
async fn session_grant_spans_multiple_messages_in_the_same_chat_but_not_a_different_one() {
    let server = common::TestServer::start().await;
    let (admin_id, admin_uuid) = init_admin(&server).await;

    let backend_url = start_stub_mcp_server_ok().await;
    let connector_id = seed_connector(&server, admin_uuid, &backend_url).await;
    let agent_id = seed_agent(&server, admin_uuid, "session-grant-test-agent").await;

    // "Chat A" — the conversation the human is actually approving in.
    let chat_a = "ses_chat_a_session_stability_test";
    seed_chat_session(
        &server,
        chat_a,
        admin_uuid,
        agent_id,
        chrono::Utc::now() - chrono::Duration::minutes(10),
    )
    .await;

    let state = mcp_state(server.db.clone());
    let perms = PermissionContext {
        agent_id,
        enabled_connectors: [connector_id].into_iter().collect(),
        rules: vec![PermissionRule {
            connector_id,
            tool_pattern: "list_repos".into(),
            stance: Stance::Ask,
        }],
        hash: "h".into(),
    };
    let resolved = mcp_session(connector_id, &backend_url);
    let tool = format!(
        "{}__list_repos",
        nasiko_mcp_gateway::types::connector_prefix(connector_id)
    );

    // ── Message 1: ask, then approve with scope=session ────────────────────
    let msg1_trace = traceparent("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let res1 = handle_tools_call(
        &state,
        admin_uuid,
        &json!(1),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&msg1_trace),
    )
    .await;
    assert_eq!(
        res1["error"]["code"],
        json!(codes::TOOL_ASK),
        "message 1 must ask: {res1}"
    );
    let hitl_id = res1["error"]["data"]["hitl_request_id"]
        .as_str()
        .expect("hitl_request_id present");

    let req = server
        .client
        .post(server.url(&format!("/api/hitl/{hitl_id}/resolve")));
    let resolve_res = common::as_superuser(req, &admin_id, "admin")
        .json(&json!({"decision": "approve", "scope": "session"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resolve_res.status(), 200);
    assert_eq!(
        resolve_res.json::<Value>().await.unwrap()["status"],
        "resolved"
    );

    // ── Message 2, same chat, a totally different trace ─────────────────────
    // The whole point of the bug: message 2 is a fresh distributed trace, so
    // if the grant were still keyed by trace context, this would ask again.
    let msg2_trace = traceparent("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let res2 = handle_tools_call(
        &state,
        admin_uuid,
        &json!(2),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&msg2_trace),
    )
    .await;
    assert!(
        res2.get("error").is_none(),
        "message 2 in the SAME chat must proceed without asking again — the session grant \
         must span messages, not just the one trace it was created against: {res2}"
    );

    // ── A different chat session (agent unchanged) ──────────────────────────
    // Newer `updated_at` than chat A, so it's now "the most recent session"
    // for this (user, agent) pair — the grant, created for chat A, must not
    // leak into it.
    let chat_b = "ses_chat_b_session_stability_test";
    seed_chat_session(&server, chat_b, admin_uuid, agent_id, chrono::Utc::now()).await;

    let msg3_trace = traceparent("ccccccccccccccccccccccccccccccc9");
    let res3 = handle_tools_call(
        &state,
        admin_uuid,
        &json!(3),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&msg3_trace),
    )
    .await;
    assert_eq!(
        res3["error"]["code"],
        json!(codes::TOOL_ASK),
        "a different chat session must ask again — the session grant must not leak across \
         conversations: {res3}"
    );

    server.cleanup().await;
}

/// The stronger guarantee `session_grant_spans_multiple_messages_...` above can't prove: two chats
/// against the same agent are BOTH already active — chat B is already the most-recently-updated
/// session for this `(user, agent)` pair *before* the human ever approves anything in chat A — and
/// the grant approved in chat A must still never leak into chat B. Every trace here is mapped to
/// its real chat via a seeded `session_traces` row, exactly like a real deployment, so
/// `resolve_stable_session_context`'s trace-resolved primary tier is what's under test, not the
/// most-recent-session fallback. Before that primary tier existed, this exact scenario was the bug:
/// "most recent session for this user+agent" would have picked chat B for every lookup, including
/// the one that creates the grant, so the human's approval in chat A would have (silently, with no
/// error) authorized the tool in chat B instead.
#[tokio::test]
#[serial]
async fn session_grant_never_leaks_across_concurrent_chats_even_when_the_other_is_more_recently_active()
 {
    let server = common::TestServer::start().await;
    let (admin_id, admin_uuid) = init_admin(&server).await;

    let backend_url = start_stub_mcp_server_ok().await;
    let connector_id = seed_connector(&server, admin_uuid, &backend_url).await;
    let agent_id = seed_agent(&server, admin_uuid, "concurrent-chats-test-agent").await;

    // Chat B is already the most recently active session for (user, agent) before chat A's
    // approval ever happens — the exact ordering that defeats the "most recent" heuristic alone.
    let chat_b = "ses_chat_b_concurrent_test";
    seed_chat_session(&server, chat_b, admin_uuid, agent_id, chrono::Utc::now()).await;
    let chat_a = "ses_chat_a_concurrent_test";
    seed_chat_session(
        &server,
        chat_a,
        admin_uuid,
        agent_id,
        chrono::Utc::now() - chrono::Duration::minutes(10),
    )
    .await;

    let state = mcp_state(server.db.clone());
    let perms = PermissionContext {
        agent_id,
        enabled_connectors: [connector_id].into_iter().collect(),
        rules: vec![PermissionRule {
            connector_id,
            tool_pattern: "list_repos".into(),
            stance: Stance::Ask,
        }],
        hash: "h".into(),
    };
    let resolved = mcp_session(connector_id, &backend_url);
    let tool = format!(
        "{}__list_repos",
        nasiko_mcp_gateway::types::connector_prefix(connector_id)
    );

    // ── Message 1, in chat A, mapped to chat A via a real session_traces row ───────────────────
    let msg1_trace = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
    seed_session_trace(&server, chat_a, msg1_trace, agent_id).await;
    let res1 = handle_tools_call(
        &state,
        admin_uuid,
        &json!(1),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent(msg1_trace)),
    )
    .await;
    let hitl_id = res1["error"]["data"]["hitl_request_id"]
        .as_str()
        .expect("hitl_request_id present");

    let req = server
        .client
        .post(server.url(&format!("/api/hitl/{hitl_id}/resolve")));
    common::as_superuser(req, &admin_id, "admin")
        .json(&json!({"decision": "approve", "scope": "session"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .expect("resolve must succeed");

    let (row_context_id,): (String,) = sqlx::query_as(
        "SELECT context_id FROM mcp_session_tool_grants WHERE agent_id = $1 AND connector_id = $2",
    )
    .bind(agent_id)
    .bind(connector_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(
        row_context_id, chat_a,
        "the grant must be keyed by chat A, the conversation actually approved in — not chat B, \
         which was merely the more recently active session at approval time"
    );

    // ── Message 2, a fresh trace also mapped to chat A ─────────────────────────────────────────
    let msg2_trace = "2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";
    seed_session_trace(&server, chat_a, msg2_trace, agent_id).await;
    let res2 = handle_tools_call(
        &state,
        admin_uuid,
        &json!(2),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent(msg2_trace)),
    )
    .await;
    assert!(
        res2.get("error").is_none(),
        "a second message in chat A must reuse the grant: {res2}"
    );

    // ── Message 3, a fresh trace mapped to chat B ──────────────────────────────────────────────
    let msg3_trace = "3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b";
    seed_session_trace(&server, chat_b, msg3_trace, agent_id).await;
    let res3 = handle_tools_call(
        &state,
        admin_uuid,
        &json!(3),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent(msg3_trace)),
    )
    .await;
    assert_eq!(
        res3["error"]["code"],
        json!(codes::TOOL_ASK),
        "chat B must ask again — the grant approved in chat A must never authorize chat B, even \
         though chat B was already the most recently active session when the grant was created: {res3}"
    );

    server.cleanup().await;
}

/// The grant this test relies on for its own message-2 assertion must be
/// backed by a real `mcp_session_tool_grants` row keyed by the *chat*
/// session id, not the trace id — proving the fix's actual mechanism, not
/// just its externally-observable effect above.
#[tokio::test]
#[serial]
async fn session_grant_row_is_keyed_by_the_chat_session_id_not_the_trace_id() {
    let server = common::TestServer::start().await;
    let (admin_id, admin_uuid) = init_admin(&server).await;

    let backend_url = start_stub_mcp_server_ok().await;
    let connector_id = seed_connector(&server, admin_uuid, &backend_url).await;
    let agent_id = seed_agent(&server, admin_uuid, "session-grant-row-test-agent").await;

    let chat_id = "ses_chat_row_keying_test";
    seed_chat_session(&server, chat_id, admin_uuid, agent_id, chrono::Utc::now()).await;

    let state = mcp_state(server.db.clone());
    let perms = PermissionContext {
        agent_id,
        enabled_connectors: [connector_id].into_iter().collect(),
        rules: vec![PermissionRule {
            connector_id,
            tool_pattern: "list_repos".into(),
            stance: Stance::Ask,
        }],
        hash: "h".into(),
    };
    let resolved = mcp_session(connector_id, &backend_url);
    let tool = format!(
        "{}__list_repos",
        nasiko_mcp_gateway::types::connector_prefix(connector_id)
    );
    let trace = traceparent("ddddddddddddddddddddddddddddddd1");

    let res = handle_tools_call(
        &state,
        admin_uuid,
        &json!(1),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&trace),
    )
    .await;
    let hitl_id = res["error"]["data"]["hitl_request_id"]
        .as_str()
        .expect("hitl_request_id present");

    let req = server
        .client
        .post(server.url(&format!("/api/hitl/{hitl_id}/resolve")));
    common::as_superuser(req, &admin_id, "admin")
        .json(&json!({"decision": "approve", "scope": "session"}))
        .send()
        .await
        .unwrap();

    let (row_context_id,): (String,) = sqlx::query_as(
        "SELECT context_id FROM mcp_session_tool_grants WHERE agent_id = $1 AND connector_id = $2",
    )
    .bind(agent_id)
    .bind(connector_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(
        row_context_id, chat_id,
        "the grant must be keyed by the stable chat_sessions.session_id, not a trace-derived value"
    );

    server.cleanup().await;
}

/// Orchestrator-routed chat sessions are inserted with `chat_sessions.agent_id
/// = NULL` (`ensure_orchestrator_chat_session` — the session fronts every
/// sub-agent the orchestrator delegates to, not one) so the primary tier's
/// original `agent_id = $3` probe always missed for them, falling through to
/// "most recent direct chat with this agent" and writing the grant against
/// whichever unrelated direct chat happened to be more recently active
/// (found in review — the same over-broad-grant failure mode
/// `session_grant_never_leaks_across_concurrent_chats_...` above proves is
/// closed for two *direct* chats, surviving specifically for an orchestrator
/// conversation). This seeds exactly that shape — an orchestrator chat
/// (`agent_id = NULL`) and a more-recently-active direct chat with the same
/// agent — and asserts the grant lands on the orchestrator chat the human
/// actually approved in, not the direct chat.
#[tokio::test]
#[serial]
async fn session_grant_from_an_orchestrator_chat_does_not_leak_into_a_direct_chat() {
    let server = common::TestServer::start().await;
    let (admin_id, admin_uuid) = init_admin(&server).await;

    let backend_url = start_stub_mcp_server_ok().await;
    let connector_id = seed_connector(&server, admin_uuid, &backend_url).await;
    let agent_id = seed_agent(&server, admin_uuid, "orchestrator-grant-test-agent").await;

    // The direct chat is already the most recently active session for
    // (user, agent) before the orchestrator approval ever happens — the same
    // adversarial ordering the concurrent-chats test above pins.
    let direct_chat = "ses_direct_chat_orchestrator_leak_test";
    seed_chat_session(
        &server,
        direct_chat,
        admin_uuid,
        agent_id,
        chrono::Utc::now(),
    )
    .await;

    // The orchestrator chat: `agent_id = NULL`, exactly what
    // `ensure_orchestrator_chat_session` inserts.
    let orch_chat = "ses_orchestrator_chat_leak_test";
    seed_chat_session(
        &server,
        orch_chat,
        admin_uuid,
        agent_id,
        chrono::Utc::now() - chrono::Duration::minutes(10),
    )
    .await;
    sqlx::query("UPDATE chat_sessions SET agent_id = NULL WHERE session_id = $1")
        .bind(orch_chat)
        .execute(&server.db)
        .await
        .unwrap();

    let state = mcp_state(server.db.clone());
    let perms = PermissionContext {
        agent_id,
        enabled_connectors: [connector_id].into_iter().collect(),
        rules: vec![PermissionRule {
            connector_id,
            tool_pattern: "list_repos".into(),
            stance: Stance::Ask,
        }],
        hash: "h".into(),
    };
    let resolved = mcp_session(connector_id, &backend_url);
    let tool = format!(
        "{}__list_repos",
        nasiko_mcp_gateway::types::connector_prefix(connector_id)
    );

    // Message 1, in the orchestrator chat, mapped to it via a real
    // session_traces row exactly like `agent_proxy` writes when the
    // orchestrator forwards a call to this sub-agent.
    let msg1_trace = "1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c";
    seed_session_trace(&server, orch_chat, msg1_trace, agent_id).await;
    let res1 = handle_tools_call(
        &state,
        admin_uuid,
        &json!(1),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent(msg1_trace)),
    )
    .await;
    let hitl_id = res1["error"]["data"]["hitl_request_id"]
        .as_str()
        .expect("hitl_request_id present");

    let req = server
        .client
        .post(server.url(&format!("/api/hitl/{hitl_id}/resolve")));
    common::as_superuser(req, &admin_id, "admin")
        .json(&json!({"decision": "approve", "scope": "session"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .expect("resolve must succeed");

    let (row_context_id,): (String,) = sqlx::query_as(
        "SELECT context_id FROM mcp_session_tool_grants WHERE agent_id = $1 AND connector_id = $2",
    )
    .bind(agent_id)
    .bind(connector_id)
    .fetch_one(&server.db)
    .await
    .unwrap();
    assert_eq!(
        row_context_id, orch_chat,
        "the grant must be keyed by the orchestrator chat actually approved in — not the \
         unrelated direct chat, which was merely the more recently active session with this \
         agent at approval time"
    );

    // A second message in the direct chat, never previously touched, must
    // still ask — the orchestrator-chat grant must not have leaked into it.
    let msg2_trace = "2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c";
    seed_session_trace(&server, direct_chat, msg2_trace, agent_id).await;
    let res2 = handle_tools_call(
        &state,
        admin_uuid,
        &json!(2),
        &json!({ "name": tool, "arguments": {} }),
        &resolved,
        &perms,
        Some(&traceparent(msg2_trace)),
    )
    .await;
    assert_eq!(
        res2["error"]["code"],
        json!(codes::TOOL_ASK),
        "the direct chat must ask again — a grant approved in the orchestrator chat must never \
         authorize the direct chat: {res2}"
    );

    server.cleanup().await;
}

/// Direct-chat's own HITL kinds (`input_required`/`auth_required`) never
/// touch `mcp_session_tool_grants` or `chat_sessions.updated_at` lookups at
/// all — `grant_session_scope` only ever runs for `tool_approval` rows. This
/// is already covered by `oss/server/tests/hitl.rs`'s
/// `session_scope_is_rejected_for_a_non_tool_approval_kind`; this test adds
/// the direct check that the fix introduced no new `chat_sessions` read for
/// those kinds by confirming a `direct_chat`-origin resolve with `scope`
/// supplied is still rejected exactly as before.
#[tokio::test]
#[serial]
async fn direct_chat_auth_required_resolve_is_unaffected_by_the_session_grant_fix() {
    let server = common::TestServer::start().await;
    let (admin_id, admin_uuid) = init_admin(&server).await;
    let agent_id = seed_agent(&server, admin_uuid, "direct-chat-unaffected-test-agent").await;

    let row_id: Uuid = sqlx::query_scalar(
        "INSERT INTO hitl_requests \
            (kind, origin, agent_id, owner_user_id, context_id, question, status, expires_at) \
         VALUES ('auth_required', 'direct_chat', $1, $2, 'ses_direct_chat_unaffected', '{}'::jsonb, \
                 'pending', now() + interval '7 days') \
         RETURNING id",
    )
    .bind(agent_id)
    .bind(admin_uuid)
    .fetch_one(&server.db)
    .await
    .unwrap();

    let req = server
        .client
        .post(server.url(&format!("/api/hitl/{row_id}/resolve")));
    let res = common::as_superuser(req, &admin_id, "admin")
        .json(&json!({"decision": "approve", "scope": "session"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        400,
        "scope must still be rejected for a non-tool_approval kind, unchanged by the fix"
    );

    let grant_count: i64 = sqlx::query_scalar("SELECT count(*) FROM mcp_session_tool_grants")
        .fetch_one(&server.db)
        .await
        .unwrap();
    assert_eq!(
        grant_count, 0,
        "a direct_chat-origin resolve must never create an mcp_session_tool_grants row"
    );

    server.cleanup().await;
}
