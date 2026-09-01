//! Regression test for the two resume dispatchers' origin scoping (`repo::claim_for_resume` vs.
//! `PgHitlStore::claim_for_resume`, `oss/server/src/state.rs`). Before this scoping existed, both
//! claim queries matched *any* resolved row regardless of `origin` — running both dispatchers
//! unmodified would race on the same rows, and whichever claimed a row it can't actually deliver
//! (an `mcp_tool` row has no `task_id` for the direct-chat dispatcher's A2A task resume; a
//! `direct_chat` row is never even looked at by MCP's plain-nudge dispatcher) would just fail it.
//! Needs infra up (`just infra`; override with `TEST_PG_URL`), same convention as `tests/repo.rs`.

use nasiko_hitl::repo::{self, NewAuthRequired, ResolveDecision};
use nasiko_hitl::{HitlStatus, HitlStore, NewHitlRequest, PgHitlStore};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

fn pg_admin_url() -> String {
    std::env::var("TEST_PG_URL")
        .unwrap_or_else(|_| "postgres://nasiko:nasiko@localhost:5432/nasiko_dev".into())
}

struct TestDb {
    pool: PgPool,
    agent_id: Uuid,
    owner_user_id: Uuid,
}

impl TestDb {
    async fn new() -> Self {
        let pg_admin = pg_admin_url();
        let db_name = format!(
            "nasiko_hitl_origin_isolation_test_{}",
            Uuid::new_v4().simple()
        );

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
        let pool: PgPool = PgPoolOptions::new()
            .max_connections(4)
            .connect(&db_url)
            .await
            .expect("connect to scratch test database");

        sqlx::migrate!("../migrations")
            .run(&pool)
            .await
            .expect("run oss/migrations against scratch database");

        let owner_user_id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, email) VALUES ($1, $2, $3)")
            .bind(owner_user_id)
            .bind(format!("origin-isolation-test-{}", owner_user_id.simple()))
            .bind(format!(
                "origin-isolation-test-{}@example.com",
                owner_user_id.simple()
            ))
            .execute(&pool)
            .await
            .expect("seed user");

        let agent_id = Uuid::new_v4();
        sqlx::query("INSERT INTO agents (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(agent_id)
            .bind(format!("origin-isolation-test-agent-{}", agent_id.simple()))
            .bind(owner_user_id)
            .execute(&pool)
            .await
            .expect("seed agent");

        Self {
            pool,
            agent_id,
            owner_user_id,
        }
    }

    /// A resolved `origin = mcp_tool` row, seeded and resolved via `nasiko_hitl::repo` — the
    /// plain-function API MCP's own dispatcher/gateway code calls.
    async fn seed_resolved_mcp_tool_row(&self) -> Uuid {
        let created = repo::create_pending_auth_required(
            &self.pool,
            NewAuthRequired {
                agent_id: self.agent_id,
                owner_user_id: self.owner_user_id,
                connector_id: Uuid::new_v4(),
                context_id: "ctx-mcp".to_string(),
                question: serde_json::json!({"connector": "github"}),
            },
        )
        .await
        .expect("create pending auth_required");

        repo::resolve(
            &self.pool,
            created.id,
            ResolveDecision::Approve,
            self.owner_user_id,
            serde_json::json!({"decision": "approve"}),
        )
        .await
        .expect("resolve")
        .expect("row was pending");

        created.id
    }

    /// A resolved `origin = direct_chat` row, seeded and resolved via `HitlStore` — the
    /// trait-based API the direct-chat dispatcher's own code calls.
    async fn seed_resolved_direct_chat_row(&self) -> Uuid {
        let store = PgHitlStore::new(self.pool.clone());
        let created = store
            .create(NewHitlRequest::direct_chat(
                nasiko_hitl::HitlKind::InputRequired,
                self.agent_id,
                self.owner_user_id,
                "task-direct-chat",
                "ctx-direct-chat",
                serde_json::json!({"message": "need input"}),
            ))
            .await
            .expect("create pending direct_chat row");

        store
            .resolve(
                created.id,
                serde_json::json!({"answer": "here you go"}),
                self.owner_user_id,
                HitlStatus::Resolved,
            )
            .await
            .expect("resolve");

        created.id
    }
}

#[tokio::test]
async fn mcp_dispatcher_never_claims_a_direct_chat_row() {
    let db = TestDb::new().await;
    let mcp_row = db.seed_resolved_mcp_tool_row().await;
    let direct_chat_row = db.seed_resolved_direct_chat_row().await;

    let claimed = repo::claim_for_resume(&db.pool)
        .await
        .expect("claim_for_resume")
        .expect("must claim the one mcp_tool row available");
    assert_eq!(
        claimed.id, mcp_row,
        "must claim the mcp_tool row, never the direct_chat one"
    );

    // Nothing else left for this dispatcher to claim — the direct_chat row is invisible to it,
    // not merely deprioritized.
    let second = repo::claim_for_resume(&db.pool)
        .await
        .expect("claim_for_resume");
    assert!(
        second.is_none(),
        "the direct_chat row must never be claimable by MCP's dispatcher: {second:?}"
    );

    let direct_chat_status: String =
        sqlx::query_scalar("SELECT resume_status FROM hitl_requests WHERE id = $1")
            .bind(direct_chat_row)
            .fetch_one(&db.pool)
            .await
            .expect("fetch resume_status");
    assert_eq!(
        direct_chat_status, "not_started",
        "the direct_chat row must be completely untouched by MCP's dispatcher"
    );
}

#[tokio::test]
async fn direct_chat_dispatcher_never_claims_an_mcp_tool_row() {
    let db = TestDb::new().await;
    let mcp_row = db.seed_resolved_mcp_tool_row().await;
    let direct_chat_row = db.seed_resolved_direct_chat_row().await;

    let store = PgHitlStore::new(db.pool.clone());
    let claimed = store
        .claim_for_resume(120)
        .await
        .expect("claim_for_resume")
        .expect("must claim the one direct_chat row available");
    assert_eq!(
        claimed.id, direct_chat_row,
        "must claim the direct_chat row, never the mcp_tool one"
    );

    let second = store.claim_for_resume(120).await.expect("claim_for_resume");
    assert!(
        second.is_none(),
        "the mcp_tool row must never be claimable by the direct-chat dispatcher: {second:?}"
    );

    let mcp_row_status: String =
        sqlx::query_scalar("SELECT resume_status FROM hitl_requests WHERE id = $1")
            .bind(mcp_row)
            .fetch_one(&db.pool)
            .await
            .expect("fetch resume_status");
    assert_eq!(
        mcp_row_status, "not_started",
        "the mcp_tool row must be completely untouched by the direct-chat dispatcher"
    );
}
