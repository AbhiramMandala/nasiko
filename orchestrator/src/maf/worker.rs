use std::sync::Arc;

use nasiko_hitl::{HitlStore, NewHitlRequest};
use nasiko_observability::ObservabilityProvider;
use sqlx::PgPool;
use tracing::{error, info, warn};
use uuid::Uuid;

use super::{
    executor,
    llm::LlmClient,
    types::{MafDefinition, PausedStep, StepOutcome, StepResult},
};

const STREAM_KEY: &str = "nasiko:maf:execute";
const GROUP_NAME: &str = "maf-workers";
// Messages idle for longer than this are reclaimed on restart (10 minutes in ms)
const RECLAIM_IDLE_MS: u64 = 600_000;

/// Unique per process: pod name (HOSTNAME in k8s/docker) + OS PID.
/// Two pods or two local processes will never share the same name, so Redis
/// can track their pending-entry lists independently.
fn consumer_name() -> String {
    let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "worker".into());
    format!("maf-worker-{hostname}-{}", std::process::id())
}

pub async fn run(
    db: PgPool,
    redis: redis::Client,
    http_client: reqwest::Client,
    observability: Arc<dyn ObservabilityProvider>,
    llm: LlmClient,
    hitl_store: Arc<dyn HitlStore>,
) {
    let consumer = consumer_name();

    let mut conn = match redis.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => {
            error!("MAF worker: failed to connect to Redis: {e}");
            return;
        }
    };

    // Create consumer group if it doesn't exist ('$' = only new messages; MKSTREAM creates stream)
    let _: redis::RedisResult<()> = redis::cmd("XGROUP")
        .arg("CREATE")
        .arg(STREAM_KEY)
        .arg(GROUP_NAME)
        .arg("$")
        .arg("MKSTREAM")
        .query_async(&mut conn)
        .await;

    // Reclaim messages that were in-flight when the server last crashed
    reclaim_pending(
        &mut conn,
        &db,
        &http_client,
        observability.as_ref(),
        &llm,
        &hitl_store,
        &consumer,
    )
    .await;

    info!("MAF worker started, consumer={consumer}, stream={STREAM_KEY}");

    loop {
        let result: redis::RedisResult<redis::Value> = redis::cmd("XREADGROUP")
            .arg("GROUP")
            .arg(GROUP_NAME)
            .arg(&consumer)
            .arg("BLOCK")
            .arg(2000u64)
            .arg("COUNT")
            .arg(1u64)
            .arg("STREAMS")
            .arg(STREAM_KEY)
            .arg(">")
            .query_async(&mut conn)
            .await;

        match result {
            Ok(redis::Value::Nil) => {
                // Block timeout — no messages, loop back
            }
            Ok(val) => {
                for (msg_id, fields) in extract_messages(val) {
                    if let Some(job) = parse_job(&fields) {
                        process_job(
                            job,
                            &msg_id,
                            &mut conn,
                            &db,
                            &http_client,
                            observability.as_ref(),
                            &llm,
                            &hitl_store,
                        )
                        .await;
                    } else {
                        // Malformed message — ACK to remove from PEL so it doesn't retry forever
                        warn!("MAF worker: could not parse job from message {msg_id}, discarding");
                        ack(&mut conn, &msg_id).await;
                    }
                }
            }
            Err(e) => {
                error!("MAF worker XREADGROUP error: {e}");
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            }
        }
    }
}

struct Job {
    execution_id: Uuid,
    maf_json: String,
    user_id: Uuid,
    /// Present only on a continuation job, `oss/server/src/hitl/mod.rs::deliver_maf`'s `XADD` —
    /// a fresh run always omits these three (`docs/HITL_IMPLEMENTATION_PLAN.md` §2.3).
    resume: Option<ResumeFields>,
}

struct ResumeFields {
    step_index: i32,
    task_id: String,
    answer: String,
}

fn parse_job(fields: &[redis::Value]) -> Option<Job> {
    let mut execution_id = None;
    let mut maf_json = None;
    let mut user_id = None;
    let mut resume_step_index = None;
    let mut resume_task_id = None;
    let mut resume_answer = None;

    let mut i = 0;
    while i + 1 < fields.len() {
        // Use continue instead of ? so one malformed field doesn't drop the whole job
        let key = match bulk_str(&fields[i]) {
            Some(k) => k,
            None => {
                i += 2;
                continue;
            }
        };
        let val = match bulk_str(&fields[i + 1]) {
            Some(v) => v,
            None => {
                i += 2;
                continue;
            }
        };
        match key.as_str() {
            "execution_id" => execution_id = val.parse().ok(),
            "maf_json" => maf_json = Some(val),
            "user_id" => user_id = val.parse().ok(),
            "resume_step_index" => resume_step_index = val.parse().ok(),
            "resume_task_id" => resume_task_id = Some(val),
            "resume_answer" => resume_answer = Some(val),
            _ => {}
        }
        i += 2;
    }

    let resume = match (resume_step_index, resume_task_id, resume_answer) {
        (Some(step_index), Some(task_id), Some(answer)) => Some(ResumeFields {
            step_index,
            task_id,
            answer,
        }),
        _ => None,
    };

    Some(Job {
        execution_id: execution_id?,
        maf_json: maf_json?,
        user_id: user_id?,
        resume,
    })
}

fn bulk_str(val: &redis::Value) -> Option<String> {
    match val {
        redis::Value::BulkString(b) => String::from_utf8(b.clone()).ok(),
        redis::Value::SimpleString(s) => Some(s.clone()),
        _ => None,
    }
}

// XREADGROUP returns: Array([Array([stream_key, Array([Array([msg_id, Array([k,v,...])])])])])
fn extract_messages(val: redis::Value) -> Vec<(String, Vec<redis::Value>)> {
    let outer = match val {
        redis::Value::Array(v) => v,
        _ => return vec![],
    };
    let stream_entry = match outer.into_iter().next() {
        Some(redis::Value::Array(v)) => v,
        _ => return vec![],
    };
    let messages = match stream_entry.into_iter().nth(1) {
        Some(redis::Value::Array(v)) => v,
        _ => return vec![],
    };

    let mut result = vec![];
    for msg in messages {
        let mut parts = match msg {
            redis::Value::Array(p) if p.len() == 2 => p.into_iter(),
            _ => continue,
        };
        let msg_id = match parts.next().and_then(|v| bulk_str(&v)) {
            Some(id) => id,
            None => continue,
        };
        let fields = match parts.next() {
            Some(redis::Value::Array(f)) => f,
            _ => continue,
        };
        result.push((msg_id, fields));
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn process_job(
    job: Job,
    msg_id: &str,
    conn: &mut redis::aio::MultiplexedConnection,
    db: &PgPool,
    http_client: &reqwest::Client,
    observability: &dyn ObservabilityProvider,
    llm: &LlmClient,
    hitl_store: &Arc<dyn HitlStore>,
) {
    let execution_id = job.execution_id;
    let user_id = job.user_id;
    let maf_json_str = job.maf_json;
    let is_resume = job.resume.is_some();

    // Fetch current attempt counters
    #[derive(sqlx::FromRow)]
    struct AttemptRow {
        attempt_count: i32,
        max_attempts: i32,
    }

    let row = sqlx::query_as::<_, AttemptRow>(
        "SELECT attempt_count, max_attempts FROM maf_executions WHERE id = $1",
    )
    .bind(execution_id)
    .fetch_optional(db)
    .await;

    let (attempt_count, max_attempts) = match row {
        Ok(Some(r)) => (r.attempt_count, r.max_attempts),
        Ok(None) => {
            warn!("MAF execution {execution_id} not found, discarding");
            ack(conn, msg_id).await;
            return;
        }
        Err(e) => {
            error!("MAF worker: DB error for execution {execution_id}: {e}");
            return;
        }
    };

    let new_attempt = attempt_count + 1;

    // Mark as running and increment attempt counter before work begins
    if let Err(e) = sqlx::query(
        "UPDATE maf_executions SET attempt_count = $1, status = 'running', started_at = now(), error = NULL WHERE id = $2",
    )
    .bind(new_attempt)
    .bind(execution_id)
    .execute(db)
    .await
    {
        error!("MAF worker: failed to mark execution {execution_id} running: {e}");
        return;
    }

    let maf_def: MafDefinition = match serde_json::from_str(&maf_json_str) {
        Ok(d) => d,
        Err(e) => {
            let err = format!("invalid maf_json: {e}");
            mark_failed(db, execution_id, &err).await;
            ack(conn, msg_id).await;
            return;
        }
    };

    let outcome = match job.resume {
        None => {
            executor::run_maf(
                http_client,
                db,
                observability,
                execution_id,
                user_id,
                &maf_def,
                llm,
            )
            .await
        }
        Some(resume) => match fetch_resume_state(db, execution_id).await {
            Ok((step_results, tokens_used, output_generation)) => {
                executor::run_maf_from(
                    http_client,
                    db,
                    observability,
                    execution_id,
                    user_id,
                    &maf_def,
                    llm,
                    step_results,
                    tokens_used,
                    output_generation,
                    resume.step_index as usize,
                    resume.task_id,
                    execution_id.to_string(),
                    resume.answer,
                )
                .await
            }
            Err(e) => Err(format!("failed to load resume state: {e}")),
        },
    };

    finish_job(
        outcome,
        execution_id,
        msg_id,
        conn,
        db,
        hitl_store,
        user_id,
        &maf_json_str,
        new_attempt,
        max_attempts,
        &maf_def,
        is_resume,
    )
    .await;
}

/// Loads the durable state a resume needs from `maf_executions`: `step_results` (every step's
/// plan is embedded in it — see `run_maf_from`'s doc comment), the running token total, and the
/// planner's `output_generation` guideline (both new in `oss/migrations/0008_maf_hitl.sql`).
async fn fetch_resume_state(
    db: &PgPool,
    execution_id: Uuid,
) -> Result<(Vec<StepResult>, i64, String), String> {
    #[derive(sqlx::FromRow)]
    struct ResumeStateRow {
        step_results: Option<String>,
        tokens_used: i64,
        output_generation: Option<String>,
    }

    let row = sqlx::query_as::<_, ResumeStateRow>(
        "SELECT step_results::text AS step_results, tokens_used, output_generation \
         FROM maf_executions WHERE id = $1",
    )
    .bind(execution_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "execution not found".to_string())?;

    let step_results: Vec<StepResult> = match row.step_results.as_deref() {
        Some(s) => serde_json::from_str(s).map_err(|e| format!("invalid step_results: {e}"))?,
        None => return Err("execution has no step_results to resume from".to_string()),
    };

    Ok((
        step_results,
        row.tokens_used,
        row.output_generation.unwrap_or_default(),
    ))
}

/// Handles a MAF run's outcome — success, a fresh pause, or an error — shared by both a normal
/// run and a resumed one so the two paths never diverge in how they finish.
#[allow(clippy::too_many_arguments)]
async fn finish_job(
    outcome: Result<StepOutcome, String>,
    execution_id: Uuid,
    msg_id: &str,
    conn: &mut redis::aio::MultiplexedConnection,
    db: &PgPool,
    hitl_store: &Arc<dyn HitlStore>,
    user_id: Uuid,
    maf_json_str: &str,
    new_attempt: i32,
    max_attempts: i32,
    maf_def: &MafDefinition,
    is_resume: bool,
) {
    match outcome {
        Ok(StepOutcome::Completed(result)) => {
            let step_json = serde_json::to_value(&result.step_results).unwrap_or_default();
            let step_json_str = step_json.to_string();
            let _ = sqlx::query(
                r#"UPDATE maf_executions
                   SET status = 'success',
                       output = $1,
                       step_results = $2::jsonb,
                       tokens_used = $3,
                       completed_at = now(),
                       duration_ms = EXTRACT(EPOCH FROM (now() - started_at))::BIGINT * 1000
                   WHERE id = $4"#,
            )
            .bind(&result.output)
            .bind(&step_json_str)
            .bind(result.tokens_used)
            .bind(execution_id)
            .execute(db)
            .await;
            ack(conn, msg_id).await;
            info!("MAF execution {execution_id} succeeded");
        }
        Ok(StepOutcome::AwaitingHuman(paused)) => {
            // `step_results`/`tokens_used` were already persisted by the executor at the moment
            // it detected the pause (`execute_step`/`continue_paused_step`'s own
            // `persist_progress` call) — only the execution-level status still needs flipping.
            let _ =
                sqlx::query("UPDATE maf_executions SET status = 'awaiting_human' WHERE id = $1")
                    .bind(execution_id)
                    .execute(db)
                    .await;
            create_hitl_request(hitl_store, execution_id, user_id, maf_def, &paused).await;
            // Done for now — no retry, no re-enqueue. The row waits for
            // `POST /api/hitl/{id}/resolve` to trigger a continuation job.
            ack(conn, msg_id).await;
            info!(
                "MAF execution {execution_id} paused at step {} awaiting a human",
                paused.step_index
            );
        }
        Err(e) => {
            // A resumed job's failure is never retried by restarting from step 0 — that would
            // silently redo already-succeeded steps' agent calls and discard the human's answer.
            // Terminal failure here, not a re-enqueue, is the safe default (`docs/
            // HITL_IMPLEMENTATION_PLAN.md` doesn't specify resume-retry semantics; hardening that
            // is a Phase 9-shaped follow-up, not required for Phase 8).
            if is_resume || new_attempt >= max_attempts {
                mark_failed(db, execution_id, &e).await;
                ack(conn, msg_id).await;
                warn!(
                    "MAF execution {execution_id} terminal failure after {new_attempt} attempt(s): {e}"
                );
            } else {
                // Reset to pending and re-enqueue for retry
                let _ = sqlx::query(
                    "UPDATE maf_executions SET status = 'pending', error = $1 WHERE id = $2",
                )
                .bind(&e)
                .bind(execution_id)
                .execute(db)
                .await;
                re_enqueue(conn, execution_id, maf_json_str, user_id).await;
                ack(conn, msg_id).await;
                warn!(
                    "MAF execution {execution_id} failed (attempt {new_attempt}/{max_attempts}), re-enqueued: {e}"
                );
            }
        }
    }
}

/// Creates the `hitl_requests` row a paused step surfaces to a human, resolved via the generic
/// `POST /api/hitl/{id}/resolve` (`oss/server/src/router/hitl.rs` — already origin-agnostic).
async fn create_hitl_request(
    hitl_store: &Arc<dyn HitlStore>,
    execution_id: Uuid,
    user_id: Uuid,
    maf_def: &MafDefinition,
    paused: &PausedStep,
) {
    let Some(step) = maf_def.steps.get(paused.step_index as usize) else {
        error!(
            "MAF execution {execution_id}: paused step index {} out of range, cannot record the HITL pause",
            paused.step_index
        );
        return;
    };
    let req = NewHitlRequest::maf(
        paused.kind,
        step.agent_id,
        user_id,
        paused.task_id.clone(),
        paused.context_id.clone(),
        execution_id,
        paused.step_index,
        paused.question.clone(),
    );
    if let Err(e) = hitl_store.create(req).await {
        error!("MAF execution {execution_id}: failed to persist HITL pause: {e}");
    }
}

async fn mark_failed(db: &PgPool, execution_id: Uuid, error: &str) {
    let _ = sqlx::query(
        r#"UPDATE maf_executions
           SET status = 'failed',
               error = $1,
               completed_at = now(),
               duration_ms = EXTRACT(EPOCH FROM (now() - COALESCE(started_at, now())))::BIGINT * 1000
           WHERE id = $2"#,
    )
    .bind(error)
    .bind(execution_id)
    .execute(db)
    .await;
}

async fn ack(conn: &mut redis::aio::MultiplexedConnection, msg_id: &str) {
    let _: redis::RedisResult<()> = redis::cmd("XACK")
        .arg(STREAM_KEY)
        .arg(GROUP_NAME)
        .arg(msg_id)
        .query_async(conn)
        .await;
}

async fn re_enqueue(
    conn: &mut redis::aio::MultiplexedConnection,
    execution_id: Uuid,
    maf_json: &str,
    user_id: Uuid,
) {
    let _: redis::RedisResult<String> = redis::cmd("XADD")
        .arg(STREAM_KEY)
        .arg("*")
        .arg("execution_id")
        .arg(execution_id.to_string())
        .arg("maf_json")
        .arg(maf_json)
        .arg("user_id")
        .arg(user_id.to_string())
        .query_async(conn)
        .await;
}

async fn reclaim_pending(
    conn: &mut redis::aio::MultiplexedConnection,
    db: &PgPool,
    http_client: &reqwest::Client,
    observability: &dyn ObservabilityProvider,
    llm: &LlmClient,
    hitl_store: &Arc<dyn HitlStore>,
    consumer: &str,
) {
    let result: redis::RedisResult<redis::Value> = redis::cmd("XAUTOCLAIM")
        .arg(STREAM_KEY)
        .arg(GROUP_NAME)
        .arg(consumer)
        .arg(RECLAIM_IDLE_MS)
        .arg("0-0")
        .arg("COUNT")
        .arg(100u64)
        .query_async(conn)
        .await;

    // XAUTOCLAIM returns [next_id, [[msg_id, fields], ...], [deleted_ids]]
    let messages = match result {
        Ok(redis::Value::Array(parts)) if parts.len() >= 2 => match parts.into_iter().nth(1) {
            Some(redis::Value::Array(msgs)) => msgs,
            _ => return,
        },
        Err(e) => {
            // Stream or group may not exist yet on first boot — not an error
            warn!("MAF worker XAUTOCLAIM skipped (stream may be new): {e}");
            return;
        }
        _ => return,
    };

    for msg in messages {
        let mut parts = match msg {
            redis::Value::Array(p) if p.len() == 2 => p.into_iter(),
            _ => continue,
        };
        let msg_id = match parts.next().and_then(|v| bulk_str(&v)) {
            Some(id) => id,
            None => continue,
        };
        let fields = match parts.next() {
            Some(redis::Value::Array(f)) => f,
            _ => continue,
        };
        if let Some(job) = parse_job(&fields) {
            info!("Reclaiming crashed MAF execution {}", job.execution_id);
            process_job(
                job,
                &msg_id,
                conn,
                db,
                http_client,
                observability,
                llm,
                hitl_store,
            )
            .await;
        }
    }
}
