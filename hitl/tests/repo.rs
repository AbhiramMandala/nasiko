//! Integration tests for `nasiko_hitl::repo` against a real Postgres — needs
//! infra up (`just infra` from the repo root; override the admin connection
//! with `TEST_PG_URL` for CI), same convention `oss/server/tests` uses. Each
//! test creates and drops its own scratch database so tests can run
//! concurrently without colliding.

use nasiko_hitl::HitlStatus;
use nasiko_hitl::repo::{self, NewAuthRequired, NewSessionGrant, NewToolApproval, ResolveDecision};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

fn pg_admin_url() -> String {
    std::env::var("TEST_PG_URL")
        .unwrap_or_else(|_| "postgres://nasiko:nasiko@localhost:5432/nasiko_dev".into())
}

/// Fresh, migrated scratch database with one seed user and one seed agent —
/// `hitl_requests.agent_id`/`owner_user_id` are `NOT NULL` foreign keys, so
/// every test needs both to exist before it can insert a row.
struct TestDb {
    pool: PgPool,
    agent_id: Uuid,
    owner_user_id: Uuid,
}

impl TestDb {
    async fn new() -> Self {
        let pg_admin = pg_admin_url();
        let db_name = format!("nasiko_hitl_test_{}", Uuid::new_v4().simple());

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
        let pool = PgPoolOptions::new()
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
            .bind(format!("hitl-test-{}", owner_user_id.simple()))
            .bind(format!("hitl-test-{}@example.com", owner_user_id.simple()))
            .execute(&pool)
            .await
            .expect("seed user");

        let agent_id = Uuid::new_v4();
        sqlx::query("INSERT INTO agents (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(agent_id)
            .bind(format!("hitl-test-agent-{}", agent_id.simple()))
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

    fn new_auth_required(&self, connector_id: Uuid, context_id: &str) -> NewAuthRequired {
        NewAuthRequired {
            agent_id: self.agent_id,
            owner_user_id: self.owner_user_id,
            connector_id,
            context_id: context_id.to_string(),
            question: serde_json::json!({"connector": "github", "auth_url": "https://example.com/authorize"}),
        }
    }

    fn new_tool_approval(
        &self,
        connector_id: Uuid,
        tool_name: &str,
        context_id: &str,
    ) -> NewToolApproval {
        NewToolApproval {
            agent_id: self.agent_id,
            owner_user_id: self.owner_user_id,
            connector_id,
            tool_name: tool_name.to_string(),
            context_id: context_id.to_string(),
            question: serde_json::json!({"connector_id": connector_id, "tool_name": tool_name}),
        }
    }

    async fn seed_user(&self) -> Uuid {
        let user_id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, email) VALUES ($1, $2, $3)")
            .bind(user_id)
            .bind(format!("hitl-test-{}", user_id.simple()))
            .bind(format!("hitl-test-{}@example.com", user_id.simple()))
            .execute(&self.pool)
            .await
            .expect("seed second user");
        user_id
    }
}

#[tokio::test]
async fn create_pending_auth_required_persists_a_pending_row() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();

    let created =
        repo::create_pending_auth_required(&db.pool, db.new_auth_required(connector_id, "ctx-1"))
            .await
            .expect("create pending auth_required row");

    assert_eq!(created.agent_id, db.agent_id);
    assert_eq!(created.owner_user_id, db.owner_user_id);
    assert_eq!(created.connector_id, Some(connector_id));
    assert_eq!(created.context_id.as_deref(), Some("ctx-1"));
    assert_eq!(created.kind, nasiko_hitl::HitlKind::AuthRequired);
    assert_eq!(created.origin, nasiko_hitl::HitlOrigin::McpTool);
    assert_eq!(created.status, nasiko_hitl::HitlStatus::Pending);

    let fetched = repo::get_by_id(&db.pool, created.id)
        .await
        .expect("get_by_id")
        .expect("row exists");
    assert_eq!(fetched.id, created.id);
}

#[tokio::test]
async fn repeated_calls_for_the_same_identity_are_idempotent() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();

    let first =
        repo::create_pending_auth_required(&db.pool, db.new_auth_required(connector_id, "ctx-1"))
            .await
            .expect("first create");
    let second =
        repo::create_pending_auth_required(&db.pool, db.new_auth_required(connector_id, "ctx-1"))
            .await
            .expect("second create for the same identity");

    assert_eq!(
        first.id, second.id,
        "a second call for the same (agent, connector, context) must return the existing row, not a duplicate"
    );

    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM hitl_requests WHERE agent_id = $1 AND connector_id = $2 AND context_id = $3",
    )
    .bind(db.agent_id)
    .bind(connector_id)
    .bind("ctx-1")
    .fetch_one(&db.pool)
    .await
    .expect("count rows");
    assert_eq!(count, 1, "exactly one row must exist for this identity");
}

#[tokio::test]
async fn different_context_id_creates_a_distinct_pending_row() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();

    let ctx1 =
        repo::create_pending_auth_required(&db.pool, db.new_auth_required(connector_id, "ctx-1"))
            .await
            .expect("create for ctx-1");
    let ctx2 =
        repo::create_pending_auth_required(&db.pool, db.new_auth_required(connector_id, "ctx-2"))
            .await
            .expect("create for ctx-2");

    assert_ne!(
        ctx1.id, ctx2.id,
        "different conversations must not share a pending auth_required row"
    );
}

#[tokio::test]
async fn different_connector_creates_a_distinct_pending_row() {
    let db = TestDb::new().await;
    let context_id = "ctx-shared";

    let a = repo::create_pending_auth_required(
        &db.pool,
        db.new_auth_required(Uuid::new_v4(), context_id),
    )
    .await
    .expect("create for connector a");
    let b = repo::create_pending_auth_required(
        &db.pool,
        db.new_auth_required(Uuid::new_v4(), context_id),
    )
    .await
    .expect("create for connector b");

    assert_ne!(
        a.id, b.id,
        "different connectors in the same conversation must not collide"
    );
}

// ─── M5: list_pending_for / authorize_hitl_action / resolve ────────────────

#[tokio::test]
async fn list_pending_for_returns_only_the_owners_pending_rows() {
    let db = TestDb::new().await;
    let other_user_id = db.seed_user().await;

    let mine =
        repo::create_pending_auth_required(&db.pool, db.new_auth_required(Uuid::new_v4(), "ctx-1"))
            .await
            .expect("create pending row for the owner");

    // A different owner's row must never show up in this user's inbox.
    let mut someone_elses = db.new_auth_required(Uuid::new_v4(), "ctx-2");
    someone_elses.owner_user_id = other_user_id;
    repo::create_pending_auth_required(&db.pool, someone_elses)
        .await
        .expect("create pending row for a different owner");

    let inbox = repo::list_pending_for(&db.pool, db.owner_user_id)
        .await
        .expect("list_pending_for");

    assert_eq!(
        inbox.len(),
        1,
        "must see only this owner's pending row: {inbox:?}"
    );
    assert_eq!(inbox[0].id, mine.id);
}

#[tokio::test]
async fn list_pending_for_excludes_resolved_rows() {
    let db = TestDb::new().await;
    let created = repo::create_pending_tool_approval(
        &db.pool,
        db.new_tool_approval(Uuid::new_v4(), "GITHUB_DELETE_REPO", "ctx-1"),
    )
    .await
    .expect("create pending tool_approval");

    repo::resolve(
        &db.pool,
        created.id,
        ResolveDecision::Approve,
        db.owner_user_id,
        serde_json::json!({"decision": "approve"}),
    )
    .await
    .expect("resolve")
    .expect("row was pending");

    let inbox = repo::list_pending_for(&db.pool, db.owner_user_id)
        .await
        .expect("list_pending_for");
    assert!(
        inbox.is_empty(),
        "a resolved row must not appear in the pending inbox: {inbox:?}"
    );
}

#[tokio::test]
async fn authorize_hitl_action_denies_a_different_owner() {
    let db = TestDb::new().await;
    let other_user_id = db.seed_user().await;
    let request =
        repo::create_pending_auth_required(&db.pool, db.new_auth_required(Uuid::new_v4(), "ctx-1"))
            .await
            .expect("create pending row");

    assert!(repo::authorize_hitl_action(&request, db.owner_user_id));
    assert!(!repo::authorize_hitl_action(&request, other_user_id));
}

#[tokio::test]
async fn resolve_approve_transitions_tool_approval_to_resolved_with_audit_fields() {
    let db = TestDb::new().await;
    let created = repo::create_pending_tool_approval(
        &db.pool,
        db.new_tool_approval(Uuid::new_v4(), "GITHUB_DELETE_REPO", "ctx-1"),
    )
    .await
    .expect("create pending tool_approval");

    let resolved = repo::resolve(
        &db.pool,
        created.id,
        ResolveDecision::Approve,
        db.owner_user_id,
        serde_json::json!({"decision": "approve", "scope": "once"}),
    )
    .await
    .expect("resolve")
    .expect("row was pending");

    assert_eq!(resolved.status, HitlStatus::Resolved);
    assert_eq!(resolved.resolved_by, Some(db.owner_user_id));
    assert!(resolved.resolved_at.is_some());
    assert_eq!(
        resolved.human_response,
        Some(serde_json::json!({"decision": "approve", "scope": "once"}))
    );
}

#[tokio::test]
async fn resolve_reject_transitions_auth_required_to_rejected() {
    let db = TestDb::new().await;
    let created =
        repo::create_pending_auth_required(&db.pool, db.new_auth_required(Uuid::new_v4(), "ctx-1"))
            .await
            .expect("create pending auth_required");

    let resolved = repo::resolve(
        &db.pool,
        created.id,
        ResolveDecision::Reject,
        db.owner_user_id,
        serde_json::json!({"decision": "reject"}),
    )
    .await
    .expect("resolve")
    .expect("row was pending");

    assert_eq!(resolved.status, HitlStatus::Rejected);
}

#[tokio::test]
async fn resolve_a_non_pending_row_returns_none_not_an_error() {
    let db = TestDb::new().await;
    let created = repo::create_pending_tool_approval(
        &db.pool,
        db.new_tool_approval(Uuid::new_v4(), "GITHUB_DELETE_REPO", "ctx-1"),
    )
    .await
    .expect("create pending tool_approval");

    repo::resolve(
        &db.pool,
        created.id,
        ResolveDecision::Approve,
        db.owner_user_id,
        serde_json::json!({"decision": "approve"}),
    )
    .await
    .expect("first resolve")
    .expect("row was pending");

    let second = repo::resolve(
        &db.pool,
        created.id,
        ResolveDecision::Reject,
        db.owner_user_id,
        serde_json::json!({"decision": "reject"}),
    )
    .await
    .expect("second resolve must not error");

    assert!(
        second.is_none(),
        "a second resolve of an already-resolved row must be a no-op, not silently re-apply"
    );
}

#[tokio::test]
async fn resolve_unknown_id_returns_none() {
    let db = TestDb::new().await;
    let result = repo::resolve(
        &db.pool,
        Uuid::new_v4(),
        ResolveDecision::Approve,
        db.owner_user_id,
        serde_json::json!({}),
    )
    .await
    .expect("resolve on an unknown id must not error");
    assert!(result.is_none());
}

#[tokio::test]
async fn concurrent_resolve_attempts_exactly_one_wins() {
    let db = TestDb::new().await;
    let created = repo::create_pending_tool_approval(
        &db.pool,
        db.new_tool_approval(Uuid::new_v4(), "GITHUB_DELETE_REPO", "ctx-1"),
    )
    .await
    .expect("create pending tool_approval");

    let (a, b) = tokio::join!(
        repo::resolve(
            &db.pool,
            created.id,
            ResolveDecision::Approve,
            db.owner_user_id,
            serde_json::json!({"decision": "approve"}),
        ),
        repo::resolve(
            &db.pool,
            created.id,
            ResolveDecision::Reject,
            db.owner_user_id,
            serde_json::json!({"decision": "reject"}),
        ),
    );

    let winners = [
        a.expect("first call must not error"),
        b.expect("second call must not error"),
    ]
    .into_iter()
    .filter(|r| r.is_some())
    .count();
    assert_eq!(
        winners, 1,
        "exactly one of two concurrent resolve attempts on the same row must win"
    );
}

// ─── M7: claim_resolved_tool_approval / session grants ─────────────────────

impl TestDb {
    /// Create + resolve a `tool_approval` row in one step, for tests that
    /// only care about the post-resolve retry-matching behavior.
    async fn resolved_tool_approval(
        &self,
        connector_id: Uuid,
        tool_name: &str,
        context_id: &str,
        decision: ResolveDecision,
        scope: Option<&str>,
    ) -> nasiko_hitl::HitlRequest {
        let created = repo::create_pending_tool_approval(
            &self.pool,
            self.new_tool_approval(connector_id, tool_name, context_id),
        )
        .await
        .expect("create pending tool_approval");

        let decision_label = match decision {
            ResolveDecision::Approve => "approve",
            ResolveDecision::Reject => "reject",
        };
        repo::resolve(
            &self.pool,
            created.id,
            decision,
            self.owner_user_id,
            serde_json::json!({"decision": decision_label, "scope": scope}),
        )
        .await
        .expect("resolve")
        .expect("row was pending")
    }
}

#[tokio::test]
async fn claim_resolved_tool_approval_claims_an_approved_once_row() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    db.resolved_tool_approval(
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
        ResolveDecision::Approve,
        Some("once"),
    )
    .await;

    let claimed = repo::claim_resolved_tool_approval(
        &db.pool,
        db.agent_id,
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await
    .expect("claim must not error")
    .expect("an approved, unconsumed row must be claimable");

    assert!(claimed.consumed_at.is_some(), "claim must set consumed_at");
    assert_eq!(
        claimed.human_response.unwrap()["decision"],
        serde_json::json!("approve")
    );
}

#[tokio::test]
async fn claim_resolved_tool_approval_is_single_use() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    db.resolved_tool_approval(
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
        ResolveDecision::Approve,
        Some("once"),
    )
    .await;

    let first = repo::claim_resolved_tool_approval(
        &db.pool,
        db.agent_id,
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await
    .expect("first claim must not error");
    assert!(first.is_some(), "first retry must find the approved row");

    let second = repo::claim_resolved_tool_approval(
        &db.pool,
        db.agent_id,
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await
    .expect("second claim must not error");
    assert!(
        second.is_none(),
        "a second retry of the same once-scope approval must find nothing (already consumed) — must re-ask"
    );
}

#[tokio::test]
async fn claim_resolved_tool_approval_claims_a_rejected_row() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    db.resolved_tool_approval(
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
        ResolveDecision::Reject,
        None,
    )
    .await;

    let claimed = repo::claim_resolved_tool_approval(
        &db.pool,
        db.agent_id,
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await
    .expect("claim must not error")
    .expect("a rejected row must also be claimable, for the deny-on-retry path");

    assert_eq!(
        claimed.human_response.unwrap()["decision"],
        serde_json::json!("reject")
    );
}

#[tokio::test]
async fn claim_resolved_tool_approval_never_claims_a_session_scoped_row() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    db.resolved_tool_approval(
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
        ResolveDecision::Approve,
        Some("session"),
    )
    .await;

    let claimed = repo::claim_resolved_tool_approval(
        &db.pool,
        db.agent_id,
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await
    .expect("claim must not error");

    assert!(
        claimed.is_none(),
        "a session-scoped approval's reusability lives in mcp_session_tool_grants — \
         claim_resolved_tool_approval must never consume it"
    );
}

#[tokio::test]
async fn claim_resolved_tool_approval_ignores_a_still_pending_row() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    repo::create_pending_tool_approval(
        &db.pool,
        db.new_tool_approval(connector_id, "GITHUB_DELETE_REPO", "ctx-1"),
    )
    .await
    .expect("create pending tool_approval");

    let claimed = repo::claim_resolved_tool_approval(
        &db.pool,
        db.agent_id,
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
    )
    .await
    .expect("claim must not error");

    assert!(
        claimed.is_none(),
        "a still-pending (not yet resolved) row must never be claimed"
    );
}

#[tokio::test]
async fn concurrent_claims_of_the_same_approval_exactly_one_wins() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    db.resolved_tool_approval(
        connector_id,
        "GITHUB_DELETE_REPO",
        "ctx-1",
        ResolveDecision::Approve,
        Some("once"),
    )
    .await;

    let (a, b) = tokio::join!(
        repo::claim_resolved_tool_approval(
            &db.pool,
            db.agent_id,
            connector_id,
            "GITHUB_DELETE_REPO",
            "ctx-1",
        ),
        repo::claim_resolved_tool_approval(
            &db.pool,
            db.agent_id,
            connector_id,
            "GITHUB_DELETE_REPO",
            "ctx-1",
        ),
    );

    let winners = [
        a.expect("first claim must not error"),
        b.expect("second claim must not error"),
    ]
    .into_iter()
    .filter(|r| r.is_some())
    .count();
    assert_eq!(
        winners, 1,
        "exactly one of two concurrent retries of the same approved tool call must execute"
    );
}

#[tokio::test]
async fn session_grant_is_visible_to_has_active_session_grant() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    let resolved = db
        .resolved_tool_approval(
            connector_id,
            "GITHUB_DELETE_REPO",
            "ctx-1",
            ResolveDecision::Approve,
            Some("session"),
        )
        .await;

    assert!(
        !repo::has_active_session_grant(
            &db.pool,
            db.agent_id,
            connector_id,
            "GITHUB_DELETE_REPO",
            "ctx-1",
        )
        .await
        .expect("lookup must not error"),
        "resolving with scope=session does not itself create a grant — \
         the caller (the resolve API) must call create_session_grant separately"
    );

    repo::create_session_grant(
        &db.pool,
        NewSessionGrant {
            agent_id: db.agent_id,
            connector_id,
            tool_name: "GITHUB_DELETE_REPO".to_string(),
            context_id: "ctx-1".to_string(),
            granted_by: db.owner_user_id,
            hitl_request_id: Some(resolved.id),
        },
    )
    .await
    .expect("create_session_grant must not error");

    assert!(
        repo::has_active_session_grant(
            &db.pool,
            db.agent_id,
            connector_id,
            "GITHUB_DELETE_REPO",
            "ctx-1",
        )
        .await
        .expect("lookup must not error"),
        "an unexpired grant for the exact tuple must be found"
    );
}

#[tokio::test]
async fn session_grant_does_not_match_a_different_tool_or_conversation() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();
    repo::create_session_grant(
        &db.pool,
        NewSessionGrant {
            agent_id: db.agent_id,
            connector_id,
            tool_name: "GITHUB_DELETE_REPO".to_string(),
            context_id: "ctx-1".to_string(),
            granted_by: db.owner_user_id,
            hitl_request_id: None,
        },
    )
    .await
    .expect("create_session_grant must not error");

    assert!(
        !repo::has_active_session_grant(
            &db.pool,
            db.agent_id,
            connector_id,
            "GITHUB_CREATE_ISSUE", // different tool
            "ctx-1",
        )
        .await
        .expect("lookup must not error")
    );
    assert!(
        !repo::has_active_session_grant(
            &db.pool,
            db.agent_id,
            connector_id,
            "GITHUB_DELETE_REPO",
            "ctx-2", // different conversation
        )
        .await
        .expect("lookup must not error")
    );
}

#[tokio::test]
async fn expired_session_grant_is_not_active() {
    let db = TestDb::new().await;
    let connector_id = Uuid::new_v4();

    // Insert an already-expired grant directly — create_session_grant always
    // computes a future expiry, so an expired row can only be exercised by
    // writing it in by hand, exactly like the dispatcher's own lease tests do.
    sqlx::query(
        r#"
        INSERT INTO mcp_session_tool_grants
            (agent_id, connector_id, tool_name, context_id, granted_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour')
        "#,
    )
    .bind(db.agent_id)
    .bind(connector_id)
    .bind("GITHUB_DELETE_REPO")
    .bind("ctx-1")
    .bind(db.owner_user_id)
    .execute(&db.pool)
    .await
    .expect("seed expired grant");

    assert!(
        !repo::has_active_session_grant(
            &db.pool,
            db.agent_id,
            connector_id,
            "GITHUB_DELETE_REPO",
            "ctx-1",
        )
        .await
        .expect("lookup must not error"),
        "an expired grant must not be treated as active"
    );
}
