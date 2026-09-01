//! Postgres-backed `HitlStore`/`authorize_hitl_action` integration tests (§16 of the HITL plan).
//! Requires `DATABASE_URL` — run via `just infra` then
//! `cargo test -p nasiko-hitl --test store -- --ignored --test-threads=1` (serial: each test
//! truncates `hitl_requests` on entry, same `--test-threads=1` convention the repo's own
//! `test-server-oss`/`test-one` recipes use).

use nasiko_hitl::{HitlIdentity, HitlKind, HitlStatus, HitlStore, NewHitlRequest, PgHitlStore};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> PgPool {
    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let pool = PgPool::connect(&db_url).await.expect("connect");
    // Self-contained: this crate's tests don't depend on `nasiko-server`'s test harness having
    // already run migrations against the same DB. Idempotent — a no-op once applied.
    sqlx::migrate!("../migrations")
        .run(&pool)
        .await
        .expect("run migrations");
    // These tests run serially (`--test-threads=1`) against a shared dev/CI Postgres that isn't
    // necessarily reset between invocations; a leftover row from an earlier run (e.g. an
    // unclaimed `resolved` row from a previous `stale_lease_is_reclaimable` run) would otherwise
    // outrank a fresh test's own fixture in `claim_for_resume`'s `ORDER BY resolved_at` and make
    // the test flaky. This table belongs entirely to this crate, so truncating it here is safe.
    sqlx::query("TRUNCATE hitl_requests")
        .execute(&pool)
        .await
        .expect("truncate hitl_requests before the suite runs");
    pool
}

/// Every test gets its own user/agent fixture rows (unique random `username`/`email`/`name`), so
/// tests never collide with each other even though the DB isn't reset between them.
async fn fixture_user(pool: &PgPool) -> Uuid {
    let tag = Uuid::new_v4();
    sqlx::query_scalar("INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id")
        .bind(format!("hitl-test-{tag}"))
        .bind(format!("hitl-test-{tag}@example.test"))
        .fetch_one(pool)
        .await
        .expect("insert fixture user")
}

async fn fixture_agent(pool: &PgPool, owner_id: Uuid) -> Uuid {
    let tag = Uuid::new_v4();
    sqlx::query_scalar("INSERT INTO agents (name, owner_id) VALUES ($1, $2) RETURNING id")
        .bind(format!("hitl-test-agent-{tag}"))
        .bind(owner_id)
        .fetch_one(pool)
        .await
        .expect("insert fixture agent")
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn duplicate_pending_create_on_same_task_is_idempotent() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;
    let task_id = format!("task-{}", Uuid::new_v4());
    let ctx = format!("ctx-{}", Uuid::new_v4());

    let first = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            task_id.clone(),
            ctx.clone(),
            json!({"message": "first"}),
        ))
        .await
        .expect("first create");

    let second = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            task_id,
            ctx,
            json!({"message": "second — should be ignored"}),
        ))
        .await
        .expect("second create is idempotent, not an error");

    assert_eq!(
        first.id, second.id,
        "second create must return the SAME pending row"
    );
    assert_eq!(
        second.question,
        json!({"message": "first"}),
        "the original question must survive"
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn duplicate_pending_tool_approval_is_idempotent_and_distinct_tools_never_collide() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;
    let connector_id = Uuid::new_v4();
    let ctx = format!("ctx-{}", Uuid::new_v4());

    let first = store
        .create(NewHitlRequest::mcp_tool(
            agent,
            owner,
            ctx.clone(),
            connector_id,
            "github_create_issue",
            None,
            json!({"tool_name": "github_create_issue"}),
        ))
        .await
        .expect("first create");

    let duplicate = store
        .create(NewHitlRequest::mcp_tool(
            agent,
            owner,
            ctx.clone(),
            connector_id,
            "github_create_issue",
            None,
            json!({"tool_name": "github_create_issue", "arguments": {"different": true}}),
        ))
        .await
        .expect("duplicate create is idempotent");
    assert_eq!(
        first.id, duplicate.id,
        "same tool+conversation must collapse to one row"
    );

    // Regression test for the v4 index fix (§4): a DIFFERENT tool on the same
    // agent/connector/conversation must get its OWN row, never collide on the first tool's.
    let different_tool = store
        .create(NewHitlRequest::mcp_tool(
            agent,
            owner,
            ctx,
            connector_id,
            "github_close_issue",
            None,
            json!({"tool_name": "github_close_issue"}),
        ))
        .await
        .expect("a different tool must be its own row, not collide");
    assert_ne!(first.id, different_tool.id);
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn resolve_once_then_twice_is_idempotent_not_an_error() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();

    let first = store
        .resolve(
            row.id,
            json!({"answer": "yes"}),
            owner,
            HitlStatus::Resolved,
        )
        .await
        .expect("first resolve");
    assert!(matches!(first, nasiko_hitl::ResolveOutcome::Applied(_)));

    let second = store
        .resolve(
            row.id,
            json!({"answer": "a different answer"}),
            owner,
            HitlStatus::Resolved,
        )
        .await
        .expect("second resolve must be a 200-shaped idempotent no-op, not an error");
    match second {
        nasiko_hitl::ResolveOutcome::AlreadyDecided(r) => {
            assert_eq!(
                r.human_response,
                Some(json!({"answer": "yes"})),
                "the FIRST answer must win"
            );
        }
        nasiko_hitl::ResolveOutcome::Applied(_) => panic!("second resolve must not re-apply"),
    }
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn concurrent_claim_for_resume_only_one_winner() {
    let pool = pool().await;
    let store = std::sync::Arc::new(PgHitlStore::new(pool.clone()));
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();
    store
        .resolve(row.id, json!({"answer": "go"}), owner, HitlStatus::Resolved)
        .await
        .unwrap();

    let (a, b) = tokio::join!(
        {
            let s = store.clone();
            async move { s.claim_for_resume(120).await.unwrap() }
        },
        {
            let s = store.clone();
            async move { s.claim_for_resume(120).await.unwrap() }
        },
    );
    let winners = [a, b].into_iter().flatten().count();
    assert_eq!(
        winners, 1,
        "exactly one concurrent claim must win the lease"
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn stale_lease_is_reclaimable() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();
    store
        .resolve(row.id, json!({"answer": "go"}), owner, HitlStatus::Resolved)
        .await
        .unwrap();

    // Simulate a claim whose owning process died: lease held, well in the past.
    sqlx::query(
        "UPDATE hitl_requests SET resume_claimed_at = now() - interval '10 minutes' WHERE id = $1",
    )
    .bind(row.id)
    .execute(&pool)
    .await
    .unwrap();

    let reclaimed = store
        .claim_for_resume(120) // 2-minute lease — the 10-minute-old claim above is well past it
        .await
        .unwrap();
    assert_eq!(reclaimed.map(|r| r.id), Some(row.id));
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn list_pending_for_never_returns_another_users_row() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let other_user = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    // One conversational row and one tool_approval row, both owned by `owner`.
    store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();
    store
        .create(NewHitlRequest::mcp_tool(
            agent,
            owner,
            format!("ctx-{}", Uuid::new_v4()),
            Uuid::new_v4(),
            "some_tool",
            None,
            json!({"tool_name": "some_tool"}),
        ))
        .await
        .unwrap();

    let other_identity = HitlIdentity {
        user_id: other_user,
        is_superuser: false,
    };
    let visible_to_other = store.list_pending_for(&other_identity).await.unwrap();
    assert!(
        visible_to_other.iter().all(|r| r.owner_user_id != owner),
        "a non-superuser must never see another user's pending row, of any kind"
    );

    let owner_identity = HitlIdentity {
        user_id: owner,
        is_superuser: false,
    };
    let visible_to_owner = store.list_pending_for(&owner_identity).await.unwrap();
    assert!(visible_to_owner.iter().all(|r| r.owner_user_id == owner));
    assert!(visible_to_owner.len() >= 2);
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn create_sets_a_future_expiry() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();

    let expires_at = row.expires_at.expect("create must set expires_at");
    let days_out = (expires_at - chrono::Utc::now()).num_hours();
    assert!(
        (6 * 24..=8 * 24).contains(&days_out),
        "expected roughly a 7-day default, got {days_out}h out"
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn with_ttl_days_overrides_the_default() {
    let pool = pool().await;
    let store = PgHitlStore::with_ttl_days(pool.clone(), 1);
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();

    let expires_at = row.expires_at.expect("create must set expires_at");
    let hours_out = (expires_at - chrono::Utc::now()).num_hours();
    assert!(
        (12..=36).contains(&hours_out),
        "expected roughly a 1-day TTL from with_ttl_days(1), got {hours_out}h out"
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn expire_stale_only_flips_pending_rows_past_their_expiry() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let stale = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "stale"}),
        ))
        .await
        .unwrap();
    // Backdate directly — `create` always sets a 7-day-out expiry, so this is the only way to
    // get a row past it without waiting a week.
    sqlx::query("UPDATE hitl_requests SET expires_at = now() - interval '1 hour' WHERE id = $1")
        .bind(stale.id)
        .execute(&pool)
        .await
        .unwrap();

    let fresh = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "fresh"}),
        ))
        .await
        .unwrap();

    let already_resolved = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "resolved, also backdated"}),
        ))
        .await
        .unwrap();
    sqlx::query(
        "UPDATE hitl_requests SET status = 'resolved', expires_at = now() - interval '1 hour' WHERE id = $1",
    )
    .bind(already_resolved.id)
    .execute(&pool)
    .await
    .unwrap();

    let swept = store.expire_stale().await.unwrap();
    assert_eq!(swept, 1, "only the stale PENDING row should be swept");

    let stale_after = store.get(stale.id).await.unwrap().unwrap();
    assert_eq!(stale_after.status, HitlStatus::Expired);

    let fresh_after = store.get(fresh.id).await.unwrap().unwrap();
    assert_eq!(
        fresh_after.status,
        HitlStatus::Pending,
        "a row not yet past its expiry must be left alone"
    );

    let resolved_after = store.get(already_resolved.id).await.unwrap().unwrap();
    assert_eq!(
        resolved_after.status,
        HitlStatus::Resolved,
        "expiry only ever applies to still-pending rows"
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn cancel_once_then_twice_is_idempotent() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();

    let first = store.cancel(row.id, owner).await.expect("first cancel");
    assert!(
        matches!(first, nasiko_hitl::ResolveOutcome::Applied(r) if r.status == HitlStatus::Canceled)
    );

    let second = store
        .cancel(row.id, owner)
        .await
        .expect("second cancel must be a no-op, not an error");
    assert!(matches!(
        second,
        nasiko_hitl::ResolveOutcome::AlreadyDecided(r) if r.status == HitlStatus::Canceled
    ));
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn cancel_does_not_apply_to_an_already_resolved_row() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();
    store
        .resolve(row.id, json!({"answer": "ok"}), owner, HitlStatus::Resolved)
        .await
        .unwrap();

    let outcome = store.cancel(row.id, owner).await.unwrap();
    assert!(
        matches!(outcome, nasiko_hitl::ResolveOutcome::AlreadyDecided(r) if r.status == HitlStatus::Resolved),
        "cancelling an already-resolved row must leave its resolved status alone"
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn mark_resume_unknown_sets_the_terminal_state_and_releases_the_lease() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::InputRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "?"}),
        ))
        .await
        .unwrap();
    store
        .resolve(row.id, json!({"answer": "ok"}), owner, HitlStatus::Resolved)
        .await
        .unwrap();
    // Simulate a claim in progress, same shape `claim_for_resume` itself would leave behind.
    sqlx::query(
        "UPDATE hitl_requests SET resume_claimed_at = now(), resume_dispatch_attempts = 5 WHERE id = $1",
    )
    .bind(row.id)
    .execute(&pool)
    .await
    .unwrap();

    store.mark_resume_unknown(row.id).await.unwrap();

    let after = store.get(row.id).await.unwrap().unwrap();
    assert_eq!(
        after.resume_status,
        nasiko_hitl::ResumeStatus::DeliveryOutcomeUnknown
    );
    assert!(
        after.resume_claimed_at.is_none(),
        "the lease must be released, not left dangling on a terminal row"
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn record_auth_start_annotates_without_resolving() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::AuthRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "authorize with GitHub", "auth_url": "https://example.test/oauth"}),
        ))
        .await
        .unwrap();

    let started = store
        .record_auth_start(row.id)
        .await
        .expect("record_auth_start should succeed")
        .expect("a pending auth_required row must match");
    assert_eq!(
        started.status,
        HitlStatus::Pending,
        "start must not resolve the row"
    );
    assert_eq!(
        started.human_response.unwrap()["auth_outcome"],
        json!("started")
    );

    // Idempotent: calling it again before confirm just re-writes the same marker.
    let started_again = store
        .record_auth_start(row.id)
        .await
        .unwrap()
        .expect("still pending, still matches");
    assert_eq!(started_again.status, HitlStatus::Pending);

    // A subsequent confirm still resolves normally — "start" never consumed the pending state.
    let outcome = store
        .resolve(
            row.id,
            json!({"auth_outcome": "confirmed"}),
            owner,
            HitlStatus::Resolved,
        )
        .await
        .unwrap();
    let resolved = match outcome {
        nasiko_hitl::ResolveOutcome::Applied(row) => row,
        nasiko_hitl::ResolveOutcome::AlreadyDecided(_) => {
            panic!("confirm must be the row's first real resolution")
        }
    };
    assert_eq!(resolved.status, HitlStatus::Resolved);
    assert_eq!(
        resolved.human_response.unwrap()["auth_outcome"],
        json!("confirmed")
    );
}

#[tokio::test]
#[ignore = "requires PostgreSQL (DATABASE_URL)"]
async fn record_auth_start_is_a_noop_once_already_resolved() {
    let pool = pool().await;
    let store = PgHitlStore::new(pool.clone());
    let owner = fixture_user(&pool).await;
    let agent = fixture_agent(&pool, owner).await;

    let row = store
        .create(NewHitlRequest::direct_chat(
            HitlKind::AuthRequired,
            agent,
            owner,
            format!("task-{}", Uuid::new_v4()),
            format!("ctx-{}", Uuid::new_v4()),
            json!({"message": "authorize"}),
        ))
        .await
        .unwrap();
    store
        .resolve(
            row.id,
            json!({"auth_outcome": "confirmed"}),
            owner,
            HitlStatus::Resolved,
        )
        .await
        .unwrap();

    let result = store.record_auth_start(row.id).await.unwrap();
    assert!(
        result.is_none(),
        "a late 'start' after the row already resolved must not resurrect or mutate it"
    );
    let after = store.get(row.id).await.unwrap().unwrap();
    assert_eq!(
        after.human_response.unwrap()["auth_outcome"],
        json!("confirmed"),
        "the earlier confirm's human_response must be untouched"
    );
}
