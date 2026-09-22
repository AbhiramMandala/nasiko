//! Fire-and-forget usage logging to the `token_usage` table.
//!
//! Writes one row per LLM call; the DB cost trigger fills `cost_usd` from
//! `model_pricing` (we leave it NULL). Failures are logged and swallowed — usage
//! logging must never break or delay the response.

use sqlx::PgPool;
use uuid::Uuid;

use crate::ir::Usage;
use crate::routing::attribution::AttributionSource;

/// One usage row to write.
pub struct UsageRecord {
    /// The billed identity: the chatting user (`flows.user_id`) when the call
    /// was attributed to a flow, else the agent owner from the JWT.
    pub owner_id: String,
    pub agent_id: String,
    /// `token_usage.operation_type`, e.g. `"direct_llm"` (chat) or `"embedding"`.
    pub operation_type: &'static str,
    pub provider: String,
    /// Bare provider-native model id (no prefix).
    pub model: String,
    pub usage: Option<Usage>,
    pub cached_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub latency_ms: i64,
    pub streaming: bool,
    pub finish_reason: Option<String>,
    /// The flow this call belongs to — named by the agent-forwarded
    /// `traceparent` (strict attribution rejects calls without one, so served
    /// calls always carry it). Written to `token_usage.session_id` — the same
    /// key the orchestrator uses — so per-message usage aggregates across the
    /// platform and its agents.
    pub flow_id: Option<String>,
    /// How `flow_id` was resolved; recorded in the row's metadata so
    /// attribution quality is auditable.
    pub attribution_source: Option<AttributionSource>,
    /// Whether the platform's key paid for this call (vs. the owner's own secret).
    pub platform_paid: bool,
    /// Pre-serialized `metadata.compress` block, or `None` when compression did not run.
    ///
    /// A `Value` rather than a typed struct so this module stays a pure DB concern and does not
    /// depend on the compression module's types. `None` leaves the row's metadata byte-identical
    /// to what it was before compression existed.
    pub compress_metadata: Option<serde_json::Value>,
}

/// Spawn the usage write so it never blocks the response.
pub fn spawn_log(db: PgPool, record: UsageRecord) {
    tokio::spawn(async move {
        if let Err(e) = log_usage(db, record).await {
            tracing::warn!(error = %e, "llm_usage write failed (swallowed)");
        }
    });
}

/// Insert one `token_usage` row. `cost_usd` is left NULL so the DB trigger computes it.
pub async fn log_usage(db: PgPool, record: UsageRecord) -> Result<(), String> {
    // token_usage.user_id is NOT NULL + FK to users(id); without a valid owner we
    // cannot write a row, so skip (best-effort logging must never surface an error).
    let Ok(owner) = Uuid::parse_str(&record.owner_id) else {
        tracing::debug!(owner_id = %record.owner_id, "skipping usage row: owner_id is not a uuid");
        return Ok(());
    };
    let agent = Uuid::parse_str(&record.agent_id).ok();
    let (input, output, total, cache_read, cache_creation) = match record.usage {
        Some(mut u) => {
            // Lift OpenAI's nested prompt_tokens_details.cached_tokens into the
            // flat cache_read field (Anthropic already sets it directly).
            u.normalize_openai_details();
            (
                u.prompt_tokens,
                u.completion_tokens,
                u.total_tokens,
                u.cache_read_input_tokens,
                u.cache_creation_input_tokens,
            )
        }
        None => (None, None, None, None, None),
    };

    let metadata = build_metadata(
        record.platform_paid,
        record.attribution_source,
        record.compress_metadata,
    );

    sqlx::query(
        r#"INSERT INTO token_usage
               (user_id, agent_id, operation_type, provider, model,
                input_tokens, output_tokens, total_tokens,
                cache_read_input_tokens, cache_creation_input_tokens,
                cached_tokens, reasoning_tokens,
                latency_ms, streaming, finish_reason, session_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)"#,
    )
    .bind(owner)
    .bind(agent)
    .bind(record.operation_type)
    .bind(&record.provider)
    .bind(&record.model)
    .bind(saturating_i32(input.unwrap_or(0)))
    .bind(saturating_i32(output.unwrap_or(0)))
    .bind(saturating_i32(total.unwrap_or(0)))
    .bind(saturating_i32(cache_read.unwrap_or(0)))
    .bind(saturating_i32(cache_creation.unwrap_or(0)))
    .bind(saturating_i32(
        record.cached_tokens.unwrap_or(cache_read.unwrap_or(0)),
    ))
    .bind(saturating_i32(record.reasoning_tokens.unwrap_or(0)))
    .bind(saturating_i32(record.latency_ms))
    .bind(record.streaming)
    .bind(record.finish_reason)
    .bind(record.flow_id)
    .bind(metadata)
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The row's `metadata` JSONB.
///
/// Extracted so the shape is assertable without a database — `token_usage.metadata` is read back
/// by `platform_paid_agent_usage` (`oss/server/src/router/usage_meta.rs`), so a change to
/// `key_source` here silently breaks flow billing.
fn build_metadata(
    platform_paid: bool,
    attribution_source: Option<AttributionSource>,
    compress: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut metadata = serde_json::json!({
        "key_source": if platform_paid { "platform" } else { "user_secret" },
        "attribution": attribution_source.map(|s| s.as_label()),
    });
    if let Some(compress) = compress {
        metadata["compress"] = compress;
    }
    metadata
}

fn saturating_i32(value: i64) -> i32 {
    value.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

#[cfg(test)]
mod tests {
    use super::{build_metadata, saturating_i32};

    #[test]
    fn usage_values_saturate_without_wrapping() {
        assert_eq!(saturating_i32(i64::MAX), i32::MAX);
        assert_eq!(saturating_i32(i64::MIN), i32::MIN);
        assert_eq!(saturating_i32(42), 42);
    }

    /// The zero-behaviour-change guard: with no compression, the row must be exactly what it was
    /// before `compress_metadata` existed.
    #[test]
    fn metadata_without_compression_is_unchanged() {
        assert_eq!(
            build_metadata(true, None, None),
            serde_json::json!({ "key_source": "platform", "attribution": null })
        );
        assert_eq!(
            build_metadata(false, None, None),
            serde_json::json!({ "key_source": "user_secret", "attribution": null })
        );
    }

    #[test]
    fn compression_stats_are_added_under_their_own_key() {
        let stats = serde_json::json!({ "applied": true, "bytes_in": 100, "bytes_out": 40 });
        let metadata = build_metadata(true, None, Some(stats.clone()));

        assert_eq!(metadata["compress"], stats);
        // The keys flow billing reads must survive alongside it.
        assert_eq!(metadata["key_source"], "platform");
        assert!(metadata.get("attribution").is_some());
    }
}
