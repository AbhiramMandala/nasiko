use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::authz::HitlIdentity;
use crate::types::{HitlOrigin, HitlRequest, HitlStatus, NewHitlRequest};

#[derive(Debug, thiserror::Error)]
pub enum HitlError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("row {0} vanished immediately after being written")]
    NotFound(Uuid),
    #[error("corrupt hitl_requests row: {0}")]
    CorruptRow(String),
}

/// The two outcomes `HitlStore::resolve` can produce — both are a *success* from the caller's
/// point of view (§5: a lost double-resolve race is an idempotent 200, never a 500 or a second
/// resume dispatch), so this is not a `Result` variant.
#[derive(Debug, Clone)]
pub enum ResolveOutcome {
    /// This call's `UPDATE` was the one that recorded the human's decision.
    Applied(HitlRequest),
    /// Someone else already decided this row first; here is its current state.
    AlreadyDecided(HitlRequest),
}

/// Persistence + lifecycle operations for `hitl_requests` (§2/§3/§4/§5 of the HITL plan).
/// Authorization is a separate concern — see [`crate::authorize_hitl_action`] — deliberately not
/// a method on this trait, so a caller can never accidentally list/fetch without it (callers are
/// expected to filter via `list_pending_for`'s built-in scoping, and to call
/// `authorize_hitl_action` themselves for single-row `get`/`resolve` accesses).
#[async_trait]
pub trait HitlStore: Send + Sync {
    async fn create(&self, req: NewHitlRequest) -> Result<HitlRequest, HitlError>;
    async fn get(&self, id: Uuid) -> Result<Option<HitlRequest>, HitlError>;
    /// Filtered **inside the query** (§10) — never a post-fetch filter a future call site could
    /// forget to apply.
    async fn list_pending_for(
        &self,
        identity: &HitlIdentity,
    ) -> Result<Vec<HitlRequest>, HitlError>;
    /// The exact `UPDATE ... WHERE status = 'pending' RETURNING *` from §5. `status` is the
    /// human's decision (`Resolved` or, for future `tool_approval` rejects, `Rejected`).
    async fn resolve(
        &self,
        id: Uuid,
        human_response: Value,
        resolved_by: Uuid,
        status: HitlStatus,
    ) -> Result<ResolveOutcome, HitlError>;
    /// The exact claim from §3.2: atomically leases one `resolved`/`not_started` row whose lease
    /// (if any) is older than `lease_secs`. Returns `None` when nothing is claimable.
    async fn claim_for_resume(&self, lease_secs: i64) -> Result<Option<HitlRequest>, HitlError>;
    /// Delivery succeeded — a response was received and classified, regardless of the agent's own
    /// business outcome (§3.2: "peer confirmed receipt").
    async fn mark_resume_completed(&self, id: Uuid) -> Result<(), HitlError>;
    /// Delivery failed before or during the attempt. Releases the lease for a retry unless
    /// `resume_dispatch_attempts` has reached `max_attempts`, in which case `resume_status`
    /// becomes the terminal `failed`.
    async fn mark_resume_failed(
        &self,
        id: Uuid,
        error: &str,
        max_attempts: i32,
    ) -> Result<(), HitlError>;
    /// Flips every `pending` row whose `expires_at` has passed to `expired`. Called once per
    /// dispatcher poll tick (`hitl/mod.rs::run`) — cheap, since `idx_hitl_pending_owner` already
    /// covers `status = 'pending'`. Returns the number of rows expired, for logging.
    async fn expire_stale(&self) -> Result<u64, HitlError>;
    /// Same shape as `resolve` (idempotent — cancelling an already-cancelled row is
    /// `AlreadyDecided`, not an error), but sets `status = 'canceled'` and leaves
    /// `human_response` null: the owner is withdrawing the request, not answering it.
    async fn cancel(&self, id: Uuid, canceled_by: Uuid) -> Result<ResolveOutcome, HitlError>;
    /// A row that survived past `claim_for_resume`'s reach without a clean `completed`/`failed`
    /// outcome — i.e. every attempt up to the cap crashed the dispatcher process mid-delivery
    /// rather than failing cleanly (a clean HTTP/parse failure already self-terminates via
    /// `mark_resume_failed`'s own cap check). Sets `resume_status = 'delivery_outcome_unknown'`
    /// and releases the lease so it stops being reclaimed.
    async fn mark_resume_unknown(&self, id: Uuid) -> Result<(), HitlError>;
    /// Records that the human clicked "start authorization" (§7/Phase 4) — an in-place,
    /// non-terminal annotation on `human_response.auth_outcome`, deliberately **not** a call to
    /// `resolve()`: the row stays `pending` (the human hasn't actually completed the external
    /// auth step yet, only begun it), so no resume is triggered. Idempotent — calling it again
    /// before `confirm` just re-writes the same marker. Only matches a still-`pending`
    /// `auth_required` row; `Ok(None)` means the row was already resolved/expired/canceled or was
    /// never `auth_required`, so the caller should fall back to reporting its current state.
    async fn record_auth_start(&self, id: Uuid) -> Result<Option<HitlRequest>, HitlError>;
}

/// Mirrors the `hitl_requests` table with plain column types (`String` for the four CHECK-backed
/// enum columns) rather than deriving `sqlx::FromRow` directly on [`HitlRequest`] — this crate has
/// no custom `sqlx::Type`/`Decode` impls for its enums (the wire/DB format is `TEXT`, not a native
/// Postgres enum type), so decoding through `FromStr` here is both simpler and keeps a corrupt
/// value a typed error instead of a decode panic.
#[derive(sqlx::FromRow)]
struct HitlRequestRow {
    id: Uuid,
    kind: String,
    origin: String,
    status: String,
    resume_status: String,
    agent_id: Uuid,
    owner_user_id: Uuid,
    resolved_by: Option<Uuid>,
    task_id: Option<String>,
    context_id: Option<String>,
    chat_session_id: Option<String>,
    maf_execution_id: Option<Uuid>,
    maf_step_index: Option<i32>,
    connector_id: Option<Uuid>,
    tool_name: Option<String>,
    arguments_hash: Option<String>,
    consumed_at: Option<DateTime<Utc>>,
    question: Value,
    human_response: Option<Value>,
    resume_state: Value,
    resume_claimed_at: Option<DateTime<Utc>>,
    resume_dispatch_attempts: i32,
    resume_last_error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    resolved_at: Option<DateTime<Utc>>,
}

impl TryFrom<HitlRequestRow> for HitlRequest {
    type Error = HitlError;

    fn try_from(row: HitlRequestRow) -> Result<Self, HitlError> {
        fn corrupt(column: &str, value: &str) -> HitlError {
            HitlError::CorruptRow(format!(
                "{column} column holds unrecognized value {value:?}"
            ))
        }
        Ok(HitlRequest {
            id: row.id,
            kind: row.kind.parse().map_err(|_| corrupt("kind", &row.kind))?,
            origin: row
                .origin
                .parse()
                .map_err(|_| corrupt("origin", &row.origin))?,
            status: row
                .status
                .parse()
                .map_err(|_| corrupt("status", &row.status))?,
            resume_status: row
                .resume_status
                .parse()
                .map_err(|_| corrupt("resume_status", &row.resume_status))?,
            agent_id: row.agent_id,
            owner_user_id: row.owner_user_id,
            resolved_by: row.resolved_by,
            task_id: row.task_id,
            context_id: row.context_id,
            chat_session_id: row.chat_session_id,
            maf_execution_id: row.maf_execution_id,
            maf_step_index: row.maf_step_index,
            connector_id: row.connector_id,
            tool_name: row.tool_name,
            arguments_hash: row.arguments_hash,
            consumed_at: row.consumed_at,
            question: row.question,
            human_response: row.human_response,
            resume_state: row.resume_state,
            resume_claimed_at: row.resume_claimed_at,
            resume_dispatch_attempts: row.resume_dispatch_attempts,
            resume_last_error: row.resume_last_error,
            created_at: row.created_at,
            updated_at: row.updated_at,
            expires_at: row.expires_at,
            resolved_at: row.resolved_at,
        })
    }
}

pub struct PgHitlStore {
    pool: PgPool,
    /// Applied at row-creation time (`create`) as `now() + interval 'N days'`. Configurable so an
    /// operator can tune it without a code change — see `with_ttl_days`.
    ttl_days: i64,
}

impl PgHitlStore {
    /// Defaults to a 7-day TTL. Production code should use [`Self::with_ttl_days`] instead,
    /// sourced from `Config::hitl_request_ttl_days` (env: `HITL_REQUEST_TTL_DAYS`) — this
    /// constructor exists so call sites that don't care about the TTL (tests, mainly) don't have
    /// to thread a value through.
    pub fn new(pool: PgPool) -> Self {
        Self::with_ttl_days(pool, 7)
    }

    pub fn with_ttl_days(pool: PgPool, ttl_days: i64) -> Self {
        Self { pool, ttl_days }
    }

    /// Re-fetch the pending row a unique-violation on `create` must have collided with — either
    /// the `uq_hitl_pending_per_task` or `uq_hitl_pending_per_tool_call` index (§5).
    async fn find_existing_pending(
        &self,
        req: &NewHitlRequest,
    ) -> Result<Option<HitlRequest>, HitlError> {
        let row: Option<HitlRequestRow> = if req.origin == HitlOrigin::McpTool {
            sqlx::query_as(
                "SELECT * FROM hitl_requests
                 WHERE status = 'pending' AND kind = 'tool_approval'
                   AND agent_id = $1 AND connector_id = $2 AND tool_name = $3 AND context_id = $4",
            )
            .bind(req.agent_id)
            .bind(req.connector_id)
            .bind(&req.tool_name)
            .bind(&req.context_id)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query_as("SELECT * FROM hitl_requests WHERE status = 'pending' AND task_id = $1")
                .bind(&req.task_id)
                .fetch_optional(&self.pool)
                .await?
        };
        row.map(HitlRequest::try_from).transpose()
    }
}

#[async_trait]
impl HitlStore for PgHitlStore {
    async fn create(&self, req: NewHitlRequest) -> Result<HitlRequest, HitlError> {
        // Configurable via `HITL_REQUEST_TTL_DAYS` (`Config::hitl_request_ttl_days`, 7-day
        // default per the Implementation Plan §9) — a store-level policy, not something any
        // origin constructor needs to know about.
        let expires_at = Utc::now() + chrono::Duration::days(self.ttl_days);
        let result: Result<HitlRequestRow, sqlx::Error> = sqlx::query_as(
            "INSERT INTO hitl_requests
                (kind, origin, agent_id, owner_user_id, task_id, context_id, chat_session_id,
                 maf_execution_id, maf_step_index, connector_id, tool_name, arguments_hash, question,
                 expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING *",
        )
        .bind(req.kind.as_str())
        .bind(req.origin.as_str())
        .bind(req.agent_id)
        .bind(req.owner_user_id)
        .bind(&req.task_id)
        .bind(&req.context_id)
        .bind(&req.chat_session_id)
        .bind(req.maf_execution_id)
        .bind(req.maf_step_index)
        .bind(req.connector_id)
        .bind(&req.tool_name)
        .bind(&req.arguments_hash)
        .bind(&req.question)
        .bind(expires_at)
        .fetch_one(&self.pool)
        .await;

        match result {
            Ok(row) => row.try_into(),
            Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => {
                match self.find_existing_pending(&req).await? {
                    Some(existing) => Ok(existing),
                    None => Err(HitlError::Db(sqlx::Error::Database(db_err))),
                }
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn get(&self, id: Uuid) -> Result<Option<HitlRequest>, HitlError> {
        let row: Option<HitlRequestRow> =
            sqlx::query_as("SELECT * FROM hitl_requests WHERE id = $1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        row.map(HitlRequest::try_from).transpose()
    }

    async fn list_pending_for(
        &self,
        identity: &HitlIdentity,
    ) -> Result<Vec<HitlRequest>, HitlError> {
        let rows: Vec<HitlRequestRow> = if identity.is_superuser {
            sqlx::query_as(
                "SELECT * FROM hitl_requests WHERE status = 'pending' ORDER BY created_at",
            )
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query_as(
                "SELECT * FROM hitl_requests WHERE status = 'pending' AND owner_user_id = $1 ORDER BY created_at",
            )
            .bind(identity.user_id)
            .fetch_all(&self.pool)
            .await?
        };
        rows.into_iter().map(HitlRequest::try_from).collect()
    }

    async fn resolve(
        &self,
        id: Uuid,
        human_response: Value,
        resolved_by: Uuid,
        status: HitlStatus,
    ) -> Result<ResolveOutcome, HitlError> {
        let row: Option<HitlRequestRow> = sqlx::query_as(
            "UPDATE hitl_requests
                SET status = $1, human_response = $2, resolved_by = $3, resolved_at = now()
              WHERE id = $4 AND status = 'pending'
          RETURNING *",
        )
        .bind(status.as_str())
        .bind(&human_response)
        .bind(resolved_by)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(ResolveOutcome::Applied(row.try_into()?)),
            None => {
                let current = self.get(id).await?.ok_or(HitlError::NotFound(id))?;
                Ok(ResolveOutcome::AlreadyDecided(current))
            }
        }
    }

    async fn claim_for_resume(&self, lease_secs: i64) -> Result<Option<HitlRequest>, HitlError> {
        let stale_before = Utc::now() - chrono::Duration::seconds(lease_secs);

        let mut tx = self.pool.begin().await?;

        // Scoped to the two origins this dispatcher actually knows how to deliver (a real A2A
        // task resume via `task_id` — `deliver()` fails outright on anything else). `mcp_tool`
        // rows have no `task_id` at all and are claimed by `oss/hitl`'s own dispatcher instead
        // (`nasiko_hitl::repo::claim_for_resume`, scoped the other way) — without this filter
        // the two dispatchers would race on the same rows and fail whichever they claimed by
        // mistake.
        let row: Option<HitlRequestRow> = sqlx::query_as(
            "SELECT * FROM hitl_requests
              WHERE status = 'resolved' AND resume_status = 'not_started'
                AND (resume_claimed_at IS NULL OR resume_claimed_at < $1)
                AND origin IN ('direct_chat', 'agent_proxy')
              ORDER BY resolved_at
              FOR UPDATE SKIP LOCKED
              LIMIT 1",
        )
        .bind(stale_before)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(None);
        };

        sqlx::query(
            "UPDATE hitl_requests
                SET resume_claimed_at = now(), resume_dispatch_attempts = resume_dispatch_attempts + 1
              WHERE id = $1",
        )
        .bind(row.id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        let mut claimed: HitlRequest = row.try_into()?;
        claimed.resume_dispatch_attempts += 1;
        Ok(Some(claimed))
    }

    async fn mark_resume_completed(&self, id: Uuid) -> Result<(), HitlError> {
        sqlx::query(
            "UPDATE hitl_requests SET resume_status = 'completed', resume_claimed_at = NULL WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn mark_resume_failed(
        &self,
        id: Uuid,
        error: &str,
        max_attempts: i32,
    ) -> Result<(), HitlError> {
        sqlx::query(
            "UPDATE hitl_requests
                SET resume_last_error = $2,
                    resume_claimed_at = NULL,
                    resume_status = CASE WHEN resume_dispatch_attempts >= $3 THEN 'failed' ELSE resume_status END
              WHERE id = $1",
        )
        .bind(id)
        .bind(error)
        .bind(max_attempts)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn expire_stale(&self) -> Result<u64, HitlError> {
        let result = sqlx::query(
            "UPDATE hitl_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < now()",
        )
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    async fn cancel(&self, id: Uuid, canceled_by: Uuid) -> Result<ResolveOutcome, HitlError> {
        let row: Option<HitlRequestRow> = sqlx::query_as(
            "UPDATE hitl_requests
                SET status = 'canceled', resolved_by = $1, resolved_at = now()
              WHERE id = $2 AND status = 'pending'
          RETURNING *",
        )
        .bind(canceled_by)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        match row {
            Some(row) => Ok(ResolveOutcome::Applied(row.try_into()?)),
            None => {
                let current = self.get(id).await?.ok_or(HitlError::NotFound(id))?;
                Ok(ResolveOutcome::AlreadyDecided(current))
            }
        }
    }

    async fn mark_resume_unknown(&self, id: Uuid) -> Result<(), HitlError> {
        sqlx::query(
            "UPDATE hitl_requests
                SET resume_status = 'delivery_outcome_unknown', resume_claimed_at = NULL
              WHERE id = $1",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn record_auth_start(&self, id: Uuid) -> Result<Option<HitlRequest>, HitlError> {
        let row: Option<HitlRequestRow> = sqlx::query_as(
            "UPDATE hitl_requests
                SET human_response = jsonb_set(
                        coalesce(human_response, '{}'::jsonb), '{auth_outcome}', '\"started\"', true)
              WHERE id = $1 AND status = 'pending' AND kind = 'auth_required'
          RETURNING *",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(HitlRequest::try_from).transpose()
    }
}
