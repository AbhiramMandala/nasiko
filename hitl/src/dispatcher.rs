//! The shared Resume Dispatcher (M6) — turns a resolved `hitl_requests` row
//! into an actual push into the paused conversation, closing the gap M5 left
//! open ("resolving a row today has no effect an agent could ever observe").
//!
//! Shared across every `HitlOrigin`, not MCP-specific: this module only knows
//! how to claim a resolved row and hand it to a [`ResumeNotifier`] — it has no
//! opinion on *how* delivery happens, deliberately, so `direct_chat`/
//! `orchestrator`/`maf` origins can reuse the same claim/lease machinery with
//! a different notifier later. `crate::notifier::RuntimeResumeNotifier` is
//! the one concrete transport this milestone ships, proven against MCP's
//! `mcp_tool` origin.
//!
//! Structurally mirrors `oss/server/src/agents/build_worker.rs`: a poll loop
//! that drains the claim queue on each tick, a slower periodic sweep that
//! quarantines abandoned claims, and panic isolation around the per-row work
//! so one bad row can't take down the loop.

use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;
use uuid::Uuid;

use crate::repo::{self, DEFAULT_RESUME_LEASE_MINUTES};
use crate::types::{HitlRequest, ResumeStatus};

/// Why a [`ResumeNotifier`] failed to deliver a resume push. Every variant is
/// treated as retryable by the dispatcher's own in-process retry loop — there
/// is no "permanent" vs "transient" split here, matching the fixed
/// `max_attempts` budget applied uniformly regardless of cause.
#[derive(Debug, thiserror::Error)]
pub enum NotifyError {
    #[error("hitl request {0} has no context_id to resume against")]
    MissingContextId(Uuid),
    #[error("could not resolve a live endpoint for agent {agent_id}: {reason}")]
    EndpointResolution { agent_id: Uuid, reason: String },
    #[error("transport error delivering resume notification: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("peer rejected the resume notification: {0}")]
    PeerError(String),
}

/// Delivers a resolved [`HitlRequest`]'s decision into whatever is paused
/// waiting for it. Transport-agnostic by design — the dispatcher loop only
/// ever depends on this trait, never on a concrete HTTP/A2A client, so the
/// claim/lease machinery below is reusable for a non-MCP origin with an
/// entirely different delivery mechanism.
#[async_trait::async_trait]
pub trait ResumeNotifier: Send + Sync {
    async fn notify(&self, request: &HitlRequest) -> Result<(), NotifyError>;
}

/// Tunables for [`run`]. `Default` matches `build_worker`'s own constants
/// (5s poll, 10 min recovery sweep) where a direct analogue exists.
#[derive(Debug, Clone)]
pub struct DispatcherConfig {
    /// How often to check for newly resolved rows when the queue was empty
    /// on the last pass.
    pub poll_interval: Duration,
    /// How often to run `recover_stuck_resumes`.
    pub recovery_interval: Duration,
    /// Lease staleness threshold passed to `recover_stuck_resumes` — a claim
    /// older than this with no recorded outcome is presumed abandoned.
    pub lease_minutes: i64,
    /// Total outbound attempts made per claim before giving up and recording
    /// `ResumeStatus::Failed`.
    pub max_attempts: u32,
    /// Delay between in-process retry attempts.
    pub retry_delay: Duration,
}

impl Default for DispatcherConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(5),
            recovery_interval: Duration::from_secs(10 * 60),
            lease_minutes: DEFAULT_RESUME_LEASE_MINUTES,
            max_attempts: 3,
            retry_delay: Duration::from_secs(2),
        }
    }
}

/// Concurrent in-flight deliveries, mirroring `oss/server/src/hitl/mod.rs::run`'s own
/// `MAX_CONCURRENT_DELIVERIES` on the same claim/spawn shape. Before this, `spawn(...).await`
/// gave panic isolation but zero concurrency: one unreachable agent (`notifier.rs`'s 300s
/// transport timeout x `max_attempts` retries x `retry_delay`) blocked the entire drain for
/// minutes, and — since the `select!` in `run` sits outside the drain loop — blocked the recovery
/// sweep along with it.
const MAX_CONCURRENT_DELIVERIES: usize = 8;

/// Main resume-dispatcher loop. Spawned once at server startup (mirrors
/// `build_worker::run`'s own call site) and runs until the process exits —
/// there is no shutdown channel because, unlike the build worker, there is no
/// sender whose drop should end the loop; the task is simply aborted with the
/// rest of the process.
pub async fn run(db: PgPool, notifier: Arc<dyn ResumeNotifier>, config: DispatcherConfig) {
    if let Err(e) = repo::recover_stuck_resumes(&db, config.lease_minutes).await {
        tracing::error!(%e, "resume dispatcher: startup recovery sweep failed");
    }

    let recovery_start = tokio::time::Instant::now() + config.recovery_interval;
    let mut recovery_tick = tokio::time::interval_at(recovery_start, config.recovery_interval);
    recovery_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    tracing::info!("resume dispatcher: started");
    // Tracks in-flight `dispatch_one` calls across poll cycles so one slow/unreachable agent never
    // blocks claiming or delivering anything else — see `MAX_CONCURRENT_DELIVERIES`'s doc comment.
    let mut deliveries: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(config.poll_interval) => {}
            _ = recovery_tick.tick() => {
                match repo::recover_stuck_resumes(&db, config.lease_minutes).await {
                    Ok(0) => {}
                    Ok(n) => tracing::warn!(
                        count = n,
                        "resume dispatcher: quarantined stuck claims as delivery_outcome_unknown"
                    ),
                    Err(e) => tracing::error!(%e, "resume dispatcher: recovery sweep failed"),
                }
            }
        }

        // Drain: keep claiming while a delivery slot is free and the queue has a claimable row,
        // same pattern as `build_worker::run`. Claim runs here in the loop itself (minimal, no
        // panic risk); delivery runs in a spawned task tracked by `deliveries`, concurrently with
        // every other in-flight one.
        while deliveries.len() < MAX_CONCURRENT_DELIVERIES {
            let request = match repo::claim_for_resume(&db).await {
                Ok(Some(r)) => r,
                Ok(None) => break,
                Err(e) => {
                    tracing::error!(%e, "resume dispatcher: claim error");
                    break;
                }
            };

            let db = db.clone();
            let notifier = notifier.clone();
            let config = config.clone();
            deliveries.spawn(async move {
                dispatch_one(&db, notifier.as_ref(), request, &config).await;
            });
        }

        // Reap whatever has finished without blocking this tick — a still-running delivery is
        // simply left in `deliveries` and picked up on a later iteration, mirroring
        // `oss/server/src/hitl/mod.rs::run`'s own non-blocking reap.
        while let Some(result) = deliveries.try_join_next() {
            if let Err(e) = result
                && e.is_panic()
            {
                tracing::error!(
                    "resume dispatcher: task panicked — claim left unresolved, \
                     the recovery sweep will quarantine it as delivery_outcome_unknown"
                );
            }
        }
    }
}

/// Deliver one already-claimed row, retrying in-process up to
/// `config.max_attempts` times, then record the definitive outcome via
/// `repo::finish_resume`. Runs as a `tokio::task::spawn` target so a panic
/// inside a notifier implementation is isolated from the poll loop (mirrors
/// `build_worker::execute_claimed_job`'s own panic-isolation rationale).
async fn dispatch_one(
    db: &PgPool,
    notifier: &dyn ResumeNotifier,
    request: HitlRequest,
    config: &DispatcherConfig,
) {
    let request_id = request.id;
    let mut attempts = 0u32;

    let last_error = loop {
        attempts += 1;
        match notifier.notify(&request).await {
            Ok(()) => {
                tracing::info!(id = %request_id, attempts, "resume dispatcher: delivered");
                if let Err(e) = repo::finish_resume(
                    db,
                    request_id,
                    ResumeStatus::Completed,
                    attempts as i32,
                    None,
                )
                .await
                {
                    tracing::error!(id = %request_id, %e, "resume dispatcher: failed to record completion");
                }
                return;
            }
            Err(e) => {
                let error = e.to_string();
                tracing::warn!(
                    id = %request_id,
                    attempt = attempts,
                    max_attempts = config.max_attempts,
                    %error,
                    "resume dispatcher: delivery attempt failed"
                );
                if attempts >= config.max_attempts {
                    break error;
                }
                tokio::time::sleep(config.retry_delay).await;
            }
        }
    };

    if let Err(e) = repo::finish_resume(
        db,
        request_id,
        ResumeStatus::Failed,
        attempts as i32,
        Some(&last_error),
    )
    .await
    {
        tracing::error!(id = %request_id, %e, "resume dispatcher: failed to record failure");
    }
}
