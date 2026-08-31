//! Integration tests for the resume dispatcher (M6): `repo::claim_for_resume`/
//! `finish_resume`/`recover_stuck_resumes` against a real Postgres, and the
//! full `dispatcher::run` loop + `RuntimeResumeNotifier` against a real HTTP
//! server standing in for an agent container. Needs infra up (`just infra`;
//! override with `TEST_PG_URL`), same convention as `tests/repo.rs`. Each
//! test creates and drops its own scratch database so tests can run
//! concurrently without colliding.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use nasiko_hitl::dispatcher::{self, DispatcherConfig};
use nasiko_hitl::notifier::RuntimeResumeNotifier;
use nasiko_hitl::repo::{self, NewAuthRequired, ResolveDecision};
use nasiko_hitl::{HitlKind, HitlStatus, ResumeStatus};
use nasiko_runtime::{ContainerId, ContainerRuntime, DeploymentSpec, SimulatedRuntime};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

fn pg_admin_url() -> String {
    std::env::var("TEST_PG_URL")
        .unwrap_or_else(|_| "postgres://nasiko:nasiko@localhost:5432/nasiko_dev".into())
}

/// Fresh, migrated scratch database with one seed user and one seed agent —
/// mirrors `tests/repo.rs`'s own `TestDb` fixture (kept separate rather than
/// shared, matching this crate's existing per-file convention).
struct TestDb {
    pool: PgPool,
    agent_id: Uuid,
    owner_user_id: Uuid,
}

impl TestDb {
    async fn new() -> Self {
        let pg_admin = pg_admin_url();
        let db_name = format!("nasiko_hitl_dispatch_test_{}", Uuid::new_v4().simple());

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
            .max_connections(8)
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
            .bind(format!("hitl-dispatch-test-{}", owner_user_id.simple()))
            .bind(format!(
                "hitl-dispatch-test-{}@example.com",
                owner_user_id.simple()
            ))
            .execute(&pool)
            .await
            .expect("seed user");

        let agent_id = Uuid::new_v4();
        sqlx::query("INSERT INTO agents (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(agent_id)
            .bind(format!("hitl-dispatch-test-agent-{}", agent_id.simple()))
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

    /// Create and immediately resolve (approve) a `tool_approval` row for
    /// this fixture's agent/owner — the dispatcher only ever acts on
    /// `status = 'resolved'` rows.
    async fn seed_resolved_tool_approval(&self, context_id: &str) -> Uuid {
        let created = repo::create_pending_tool_approval(
            &self.pool,
            repo::NewToolApproval {
                agent_id: self.agent_id,
                owner_user_id: self.owner_user_id,
                connector_id: Uuid::new_v4(),
                tool_name: "GITHUB_DELETE_REPO".to_string(),
                context_id: context_id.to_string(),
                question: serde_json::json!({"tool_name": "GITHUB_DELETE_REPO"}),
            },
        )
        .await
        .expect("create pending tool_approval");

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

    async fn seed_resolved_auth_required(&self, context_id: &str) -> Uuid {
        let created = repo::create_pending_auth_required(
            &self.pool,
            NewAuthRequired {
                agent_id: self.agent_id,
                owner_user_id: self.owner_user_id,
                connector_id: Uuid::new_v4(),
                context_id: context_id.to_string(),
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

    async fn resume_status_of(&self, id: Uuid) -> String {
        sqlx::query_scalar("SELECT resume_status FROM hitl_requests WHERE id = $1")
            .bind(id)
            .fetch_one(&self.pool)
            .await
            .expect("fetch resume_status")
    }
}

fn agent_spec(container_id: ContainerId) -> DeploymentSpec {
    DeploymentSpec {
        container_id,
        name: "hitl-dispatch-test-agent".to_string(),
        image: "example/agent:latest".to_string(),
        min_replicas: 1,
        max_replicas: 1,
        env_vars: HashMap::new(),
        ports: vec![8080],
        resources: None,
        image_pull_secret_name: None,
        image_pull_credential_seed: None,
        harden: false,
        network_override: None,
        workload_kind: Default::default(),
        writable: false,
        writable_path: None,
        owner_id: Uuid::nil(),
    }
}

// ─── claim_for_resume / finish_resume / recover_stuck_resumes ──────────────

#[tokio::test]
async fn claim_for_resume_only_claims_resolved_not_started_rows() {
    let db = TestDb::new().await;
    let pending_id = repo::create_pending_tool_approval(
        &db.pool,
        repo::NewToolApproval {
            agent_id: db.agent_id,
            owner_user_id: db.owner_user_id,
            connector_id: Uuid::new_v4(),
            tool_name: "GITHUB_DELETE_REPO".to_string(),
            context_id: "ctx-pending".to_string(),
            question: serde_json::json!({}),
        },
    )
    .await
    .expect("create pending row")
    .id;
    let resolved_id = db.seed_resolved_tool_approval("ctx-resolved").await;

    let claimed = repo::claim_for_resume(&db.pool)
        .await
        .expect("claim query")
        .expect("exactly one resolved row is claimable");

    assert_eq!(
        claimed.id, resolved_id,
        "must claim the resolved row, not the still-pending one"
    );
    assert_ne!(claimed.id, pending_id);

    // The queue is now empty — the only resolved row is already claimed.
    assert!(
        repo::claim_for_resume(&db.pool)
            .await
            .expect("claim query")
            .is_none()
    );
}

#[tokio::test]
async fn concurrent_claims_exactly_one_wins() {
    let db = TestDb::new().await;
    db.seed_resolved_tool_approval("ctx-1").await;

    let (a, b) = tokio::join!(
        repo::claim_for_resume(&db.pool),
        repo::claim_for_resume(&db.pool),
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
        "exactly one of two concurrent claims on the same row must win"
    );
}

#[tokio::test]
async fn finish_resume_records_completed_outcome() {
    let db = TestDb::new().await;
    let id = db.seed_resolved_tool_approval("ctx-1").await;
    repo::claim_for_resume(&db.pool)
        .await
        .expect("claim")
        .expect("row claimable");

    let updated = repo::finish_resume(&db.pool, id, ResumeStatus::Completed, 1, None)
        .await
        .expect("finish_resume")
        .expect("claimed row can be finished");
    assert_eq!(updated.resume_status, ResumeStatus::Completed);
    assert_eq!(updated.resume_dispatch_attempts, 1);
}

#[tokio::test]
async fn finish_resume_does_not_clobber_a_quarantined_row() {
    let db = TestDb::new().await;
    let id = db.seed_resolved_tool_approval("ctx-1").await;
    repo::claim_for_resume(&db.pool)
        .await
        .expect("claim")
        .expect("row claimable");

    // Simulate the dispatcher process dying mid-attempt: the lease is set,
    // resume_status is still not_started. A 0-minute lease makes it
    // immediately eligible for quarantine.
    let quarantined = repo::recover_stuck_resumes(&db.pool, 0)
        .await
        .expect("recovery sweep");
    assert_eq!(quarantined, 1);
    assert_eq!(db.resume_status_of(id).await, "delivery_outcome_unknown");

    // A late-finishing zombie attempt must not be able to overwrite that.
    let result = repo::finish_resume(&db.pool, id, ResumeStatus::Completed, 1, None)
        .await
        .expect("finish_resume must not error");
    assert!(
        result.is_none(),
        "finish_resume must refuse to overwrite a row the recovery sweep already quarantined"
    );
    assert_eq!(db.resume_status_of(id).await, "delivery_outcome_unknown");
}

#[tokio::test]
async fn a_quarantined_row_is_never_reclaimed() {
    let db = TestDb::new().await;
    let id = db.seed_resolved_tool_approval("ctx-1").await;
    repo::claim_for_resume(&db.pool)
        .await
        .expect("claim")
        .expect("row claimable");
    repo::recover_stuck_resumes(&db.pool, 0)
        .await
        .expect("recovery sweep");

    assert_eq!(db.resume_status_of(id).await, "delivery_outcome_unknown");
    assert!(
        repo::claim_for_resume(&db.pool)
            .await
            .expect("claim query")
            .is_none(),
        "claim_for_resume must never select a quarantined row"
    );
}

#[tokio::test]
async fn recover_stuck_resumes_ignores_unclaimed_rows() {
    let db = TestDb::new().await;
    db.seed_resolved_tool_approval("ctx-1").await;

    // Nothing has been claimed yet, so a 0-minute lease must still find
    // nothing to quarantine — recover_stuck_resumes only ever touches rows
    // with resume_claimed_at already set.
    let quarantined = repo::recover_stuck_resumes(&db.pool, 0)
        .await
        .expect("recovery sweep");
    assert_eq!(quarantined, 0);
}

// ─── End-to-end: dispatcher::run + RuntimeResumeNotifier ───────────────────

#[tokio::test]
async fn resolved_row_is_delivered_exactly_once_end_to_end() {
    let db = TestDb::new().await;
    let request_id = db.seed_resolved_auth_required("ctx-e2e").await;

    let mut mock_server = mockito::Server::new_async().await;
    let mock = mock_server
        .mock("POST", "/")
        .match_header("a2a-version", "1.0")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"jsonrpc":"2.0","id":"1","result":{"kind":"message"}}"#)
        .expect(1)
        .create_async()
        .await;

    let runtime = Arc::new(SimulatedRuntime::new(mock_server.url()));
    let container_id = ContainerId::from_uuid(db.agent_id);
    runtime
        .deploy(&agent_spec(container_id))
        .await
        .expect("seed the simulated runtime's endpoint for this agent");

    let notifier: Arc<dyn nasiko_hitl::ResumeNotifier> = Arc::new(RuntimeResumeNotifier::new(
        db.pool.clone(),
        runtime.clone(),
        reqwest::Client::new(),
    ));

    let config = DispatcherConfig {
        poll_interval: Duration::from_millis(20),
        recovery_interval: Duration::from_secs(3600),
        ..Default::default()
    };
    let handle = tokio::spawn(dispatcher::run(db.pool.clone(), notifier, config));

    // Bounded poll for the async loop to pick up and finish the row —
    // generous but not infinite, so a real regression fails the test instead
    // of hanging the suite.
    let mut delivered = false;
    for _ in 0..100 {
        if db.resume_status_of(request_id).await == "completed" {
            delivered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    handle.abort();

    assert!(
        delivered,
        "dispatcher must mark the row completed once delivered"
    );
    mock.assert_async().await;

    let row = repo::get_by_id(&db.pool, request_id)
        .await
        .expect("get_by_id")
        .expect("row exists");
    assert_eq!(row.kind, HitlKind::AuthRequired);
    assert_eq!(row.status, HitlStatus::Resolved);
    assert_eq!(row.resume_status, ResumeStatus::Completed);
    assert_eq!(row.resume_dispatch_attempts, 1);
}

#[tokio::test]
async fn peer_error_response_is_retried_then_marked_failed() {
    let db = TestDb::new().await;
    let request_id = db.seed_resolved_tool_approval("ctx-peer-error").await;

    let mut mock_server = mockito::Server::new_async().await;
    let mock = mock_server
        .mock("POST", "/")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"jsonrpc":"2.0","id":"1","error":{"code":-32000,"message":"boom"}}"#)
        .expect(3)
        .create_async()
        .await;

    let runtime = Arc::new(SimulatedRuntime::new(mock_server.url()));
    let container_id = ContainerId::from_uuid(db.agent_id);
    runtime
        .deploy(&agent_spec(container_id))
        .await
        .expect("seed the simulated runtime's endpoint for this agent");

    let notifier: Arc<dyn nasiko_hitl::ResumeNotifier> = Arc::new(RuntimeResumeNotifier::new(
        db.pool.clone(),
        runtime.clone(),
        reqwest::Client::new(),
    ));

    let config = DispatcherConfig {
        poll_interval: Duration::from_millis(20),
        recovery_interval: Duration::from_secs(3600),
        max_attempts: 3,
        retry_delay: Duration::from_millis(10),
        ..Default::default()
    };
    let handle = tokio::spawn(dispatcher::run(db.pool.clone(), notifier, config));

    let mut finished = false;
    for _ in 0..200 {
        let status = db.resume_status_of(request_id).await;
        if status == "failed" {
            finished = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    handle.abort();

    assert!(
        finished,
        "dispatcher must give up and mark the row failed after exhausting retries"
    );
    mock.assert_async().await;

    let row = repo::get_by_id(&db.pool, request_id)
        .await
        .expect("get_by_id")
        .expect("row exists");
    assert_eq!(row.resume_dispatch_attempts, 3);
    assert!(row.resume_last_error.is_some());
}
