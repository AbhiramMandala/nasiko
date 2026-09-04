//! Shared Postgres fixture for `nasiko-hitl`'s integration tests (`dispatcher.rs`,
//! `origin_isolation.rs`, `repo.rs`) — needs infra up (`just infra` from the repo root; override
//! the admin connection with `TEST_PG_URL`), same convention `oss/server/tests/common` uses. Each
//! call creates and migrates its own scratch database so tests can run concurrently without
//! colliding; nothing here is shared *state* across tests, only shared *setup code*.
//!
//! Each test file wraps this with its own `impl TestDb { ... }` block for file-specific seed
//! helpers (e.g. `seed_resolved_tool_approval`) — inherent impls aren't module-scoped, so this
//! works from any module in the same test binary without needing a wrapper type.

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use uuid::Uuid;

pub fn pg_admin_url() -> String {
    std::env::var("TEST_PG_URL")
        .unwrap_or_else(|_| "postgres://nasiko:nasiko@localhost:5432/nasiko_dev".into())
}

/// Fresh, migrated scratch database with one seed user and one seed agent — `hitl_requests`'s
/// `agent_id`/`owner_user_id` are `NOT NULL` foreign keys, so every test needs both to exist
/// before it can insert a row.
pub struct TestDb {
    pub pool: PgPool,
    pub agent_id: Uuid,
    pub owner_user_id: Uuid,
}

impl TestDb {
    /// `prefix` names the scratch database and seed rows (e.g. `"hitl_dispatch_test"`) so a
    /// failure is traceable to the suite that left it behind.
    pub async fn new(prefix: &str) -> Self {
        let pg_admin = pg_admin_url();
        let db_name = format!("nasiko_{prefix}_{}", Uuid::new_v4().simple());

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
            .bind(format!("{prefix}-{}", owner_user_id.simple()))
            .bind(format!("{prefix}-{}@example.com", owner_user_id.simple()))
            .execute(&pool)
            .await
            .expect("seed user");

        let agent_id = Uuid::new_v4();
        sqlx::query("INSERT INTO agents (id, name, owner_id) VALUES ($1, $2, $3)")
            .bind(agent_id)
            .bind(format!("{prefix}-agent-{}", agent_id.simple()))
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
}
