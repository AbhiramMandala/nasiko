//! Background worker that materializes Tempo trace data into `trace_usage`.
//!
//! Periodically queries Tempo for recent user-query traces, extracts FinOps
//! metrics (tokens, model, cost, latency), and upserts them into Postgres.
//! The FinOps dashboard and spend endpoints then query `trace_usage` instead
//! of hitting Tempo live on every request.
//!
//! Each trace produces one row **per agent** that has token-bearing spans,
//! keyed by `(trace_id, agent_name)`. Multi-agent traces are correctly
//! split so each agent's spend is attributed independently.
//!
//! Pattern: same as `hours_meter` / catalog-sync — a polling loop with
//! `MissedTickBehavior::Skip`, fail-soft per tick, never panics.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use nasiko_observability::provider::SessionIdResolver;
use nasiko_observability::{ObservabilityProvider, TraceUsageRow};
use sqlx::PgPool;
use tokio::time::MissedTickBehavior;

/// Run the trace-usage materializer loop. Exits only on shutdown (task drop).
pub async fn run(
    db: PgPool,
    provider: Arc<dyn ObservabilityProvider>,
    session_resolver: Arc<dyn SessionIdResolver>,
    interval: Duration,
    overlap: Duration,
    batch_size: usize,
) {
    let mut tick = tokio::time::interval(interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    // Skip the immediate first tick to avoid startup load (same pattern as
    // the materialized-view refresh in state.rs).
    tick.tick().await;

    loop {
        tick.tick().await;
        if let Err(e) =
            materialize_once(&db, provider.as_ref(), session_resolver.as_ref(), overlap, batch_size)
                .await
        {
            tracing::warn!(error = %e, "trace_materializer: pass failed");
        }
    }
}

async fn materialize_once(
    db: &PgPool,
    provider: &dyn ObservabilityProvider,
    session_resolver: &dyn SessionIdResolver,
    overlap: Duration,
    batch_size: usize,
) -> Result<(), String> {
    let start = std::time::Instant::now();

    // 1. Read high-water mark.
    let high_water: DateTime<Utc> =
        sqlx::query_scalar("SELECT high_water FROM trace_usage_cursor WHERE id = 1")
            .fetch_one(db)
            .await
            .map_err(|e| format!("cursor read: {e}"))?;

    let now = Utc::now();
    let query_start =
        high_water - chrono::Duration::from_std(overlap).unwrap_or(chrono::Duration::seconds(600));

    // 2. Search Tempo for user-query traces in [query_start, now].
    let mut trace_ids: Vec<String> = provider
        .search_user_traces(query_start, now, 1000)
        .await
        .map_err(|e| format!("search: {e}"))?;

    // 3. Union with session_traces DB index (uninstrumented agents).
    let indexed: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT trace_id FROM session_traces \
         WHERE created_at >= $1 AND created_at <= $2 \
         ORDER BY trace_id \
         LIMIT 1000",
    )
    .bind(query_start)
    .bind(now)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    let mut seen: HashSet<String> = trace_ids.iter().cloned().collect();
    for id in indexed {
        if seen.insert(id.clone()) {
            trace_ids.push(id);
        }
    }

    if trace_ids.is_empty() {
        tracing::debug!("trace_materializer: no traces in window");
        return Ok(());
    }

    // 4. Fetch + extract each trace (8-in-flight bounded concurrency).
    //    Each trace may produce multiple rows (one per agent).
    let mut rows: Vec<TraceUsageRow> = Vec::new();
    let mut errors = 0usize;

    for chunk in trace_ids.chunks(batch_size.max(1)) {
        let fetches = chunk.iter().map(|id| provider.extract_trace_usage(id));
        for result in futures::future::join_all(fetches).await {
            match result {
                Ok(agent_rows) => rows.extend(agent_rows),
                Err(e) => {
                    errors += 1;
                    tracing::debug!(error = %e, "trace_materializer: trace fetch failed");
                }
            }
        }
    }

    if rows.is_empty() {
        tracing::debug!(
            traces_found = trace_ids.len(),
            errors,
            "trace_materializer: no token-bearing traces"
        );
        return Ok(());
    }

    // 5. Enrich each row: resolve agent_id, user_id, provider, backfill session_id.
    let mut upserted = 0usize;
    for row in &rows {
        // Resolve agent_id from agent_name.
        let agent_id: Option<uuid::Uuid> = sqlx::query_scalar(
            "SELECT id FROM agents WHERE name = $1 AND deleted_at IS NULL LIMIT 1",
        )
        .bind(&row.agent_name)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();

        // Backfill session_id from the DB index if the span didn't carry it.
        let session_id = match &row.session_id {
            Some(s) => Some(s.clone()),
            None => session_resolver.session_for_trace(&row.trace_id).await,
        };

        // Resolve user_id from the chat_session that owns this session_id.
        let user_id: Option<uuid::Uuid> = match &session_id {
            Some(sid) => sqlx::query_scalar(
                "SELECT user_id FROM chat_sessions WHERE session_id = $1 LIMIT 1",
            )
            .bind(sid)
            .fetch_optional(db)
            .await
            .ok()
            .flatten(),
            None => None,
        };

        // Derive provider from model_pricing (first active row for this model).
        let provider: Option<String> = match &row.model {
            Some(m) => sqlx::query_scalar(
                "SELECT provider FROM model_pricing \
                 WHERE model = $1 AND (effective_until IS NULL OR effective_until > now()) \
                 ORDER BY effective_from DESC LIMIT 1",
            )
            .bind(m)
            .fetch_optional(db)
            .await
            .ok()
            .flatten(),
            None => None,
        };

        // 6. Upsert into trace_usage (composite PK: trace_id, agent_name).
        let result = sqlx::query(
            r#"INSERT INTO trace_usage (
                   trace_id, agent_name, session_id, agent_id, user_id,
                   model, provider,
                   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                   cost_usd, prompt_cost_usd, completion_cost_usd,
                   latency_ms, started_at, materialized_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
               ON CONFLICT (trace_id, agent_name) DO UPDATE SET
                   session_id = COALESCE(EXCLUDED.session_id, trace_usage.session_id),
                   agent_id = COALESCE(EXCLUDED.agent_id, trace_usage.agent_id),
                   user_id = COALESCE(EXCLUDED.user_id, trace_usage.user_id),
                   model = EXCLUDED.model,
                   provider = COALESCE(EXCLUDED.provider, trace_usage.provider),
                   input_tokens = EXCLUDED.input_tokens,
                   output_tokens = EXCLUDED.output_tokens,
                   cache_read_tokens = EXCLUDED.cache_read_tokens,
                   cache_creation_tokens = EXCLUDED.cache_creation_tokens,
                   cost_usd = EXCLUDED.cost_usd,
                   prompt_cost_usd = EXCLUDED.prompt_cost_usd,
                   completion_cost_usd = EXCLUDED.completion_cost_usd,
                   latency_ms = EXCLUDED.latency_ms,
                   started_at = EXCLUDED.started_at,
                   materialized_at = now()"#,
        )
        .bind(&row.trace_id)
        .bind(&row.agent_name)
        .bind(&session_id)
        .bind(agent_id)
        .bind(user_id)
        .bind(&row.model)
        .bind(&provider)
        .bind(row.input_tokens as i64)
        .bind(row.output_tokens as i64)
        .bind(row.cache_read_tokens as i64)
        .bind(row.cache_creation_tokens as i64)
        .bind(row.cost_usd)
        .bind(row.prompt_cost_usd)
        .bind(row.completion_cost_usd)
        .bind(row.latency_ms)
        .bind(row.started_at)
        .execute(db)
        .await;

        match result {
            Ok(_) => upserted += 1,
            Err(e) => {
                tracing::warn!(
                    trace_id = %row.trace_id,
                    agent_name = %row.agent_name,
                    error = %e,
                    "trace_materializer: upsert failed"
                );
            }
        }
    }

    // 7. Advance the high-water mark to the latest started_at we materialized.
    if let Some(max_ts) = rows.iter().map(|r| r.started_at).max() {
        let _ = sqlx::query(
            "UPDATE trace_usage_cursor \
             SET high_water = GREATEST(high_water, $1), updated_at = now() \
             WHERE id = 1",
        )
        .bind(max_ts)
        .execute(db)
        .await;
    }

    let elapsed = start.elapsed();
    tracing::info!(
        traces_found = trace_ids.len(),
        agent_rows = rows.len(),
        upserted,
        errors,
        elapsed_ms = elapsed.as_millis() as u64,
        "trace_materializer: pass complete"
    );

    Ok(())
}
