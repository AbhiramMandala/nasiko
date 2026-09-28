//! Fire-and-forget usage logging to the `token_usage` table.
//!
//! Writes one row per LLM call, priced here in Rust through the platform's
//! single cost engine. Failures are logged and swallowed — usage logging must
//! never break or delay the response.
//!
//! Missing exact prices fall back through the shared engine. Pricing provenance
//! records inferred rates so estimates are distinguishable from matched prices.

use std::sync::Arc;

use chrono::Utc;
use nasiko_pricing::{PricingEngine, PromptConvention, RawUsage};
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
}

/// Spawn the usage write so it never blocks the response.
pub fn spawn_log(db: PgPool, pricing: Arc<PricingEngine>, record: UsageRecord) {
    tokio::spawn(async move {
        if let Err(e) = log_usage(db, pricing.as_ref(), record).await {
            tracing::warn!(error = %e, "llm_usage write failed (swallowed)");
        }
    });
}

/// Insert one priced `token_usage` row.
pub async fn log_usage(
    db: PgPool,
    pricing: &PricingEngine,
    record: UsageRecord,
) -> Result<(), String> {
    // token_usage.user_id is NOT NULL + FK to users(id); without a valid owner we
    // cannot write a row, so skip (best-effort logging must never surface an error).
    let Ok(owner) = Uuid::parse_str(&record.owner_id) else {
        tracing::debug!(owner_id = %record.owner_id, "skipping usage row: owner_id is not a uuid");
        return Ok(());
    };
    let agent = Uuid::parse_str(&record.agent_id).ok();
    let cache_details = record.usage.as_ref().and_then(|u| u.cache_creation.clone());
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

    // `normalize_openai_details` above has already made `prompt_tokens` disjoint
    // from the cache counts (it subtracts for OpenAI's nested block; Anthropic
    // reports them disjoint already, and the Gemini adapter subtracts at its own
    // mapping site). So the prompt count reaching the engine is fresh, and
    // declaring the convention here keeps that decision in one place rather than
    // re-deriving the provider's semantics a second time.
    let priced = pricing
        .price_with_context(
            Some(&record.provider),
            &record.model,
            RawUsage {
                input: input.unwrap_or(0).max(0) as u64,
                output: output.unwrap_or(0).max(0) as u64,
                cache_read: cache_read.unwrap_or(0).max(0) as u64,
                cache_creation: cache_creation.unwrap_or(0).max(0) as u64,
                total: total.map(|t| t.max(0) as u64),
            },
            PromptConvention::Exclusive,
            Utc::now(),
            nasiko_pricing::PricingContext {
                cache_creation_5m: cache_details
                    .as_ref()
                    .and_then(|c| c.ephemeral_5m_input_tokens)
                    .and_then(|n| u64::try_from(n).ok()),
                cache_creation_1h: cache_details
                    .as_ref()
                    .and_then(|c| c.ephemeral_1h_input_tokens)
                    .and_then(|n| u64::try_from(n).ok()),
                ..Default::default()
            },
        )
        .await;

    let metadata = serde_json::json!({
        "key_source": if record.platform_paid { "platform" } else { "user_secret" },
        "attribution": record.attribution_source.map(|s| s.as_label()),
        "pricing": priced.provenance(),
        "cache_creation": cache_details,
    });

    sqlx::query(
        r#"INSERT INTO token_usage
               (user_id, agent_id, operation_type, provider, model,
                input_tokens, output_tokens, total_tokens,
                cache_read_input_tokens, cache_creation_input_tokens,
                cached_tokens, reasoning_tokens,
                latency_ms, streaming, finish_reason, session_id, metadata,
                cost_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)"#,
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
    .bind(priced.cost.total_usd)
    .execute(&db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn saturating_i32(value: i64) -> i32 {
    value.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

#[cfg(test)]
mod tests {
    use super::saturating_i32;

    #[test]
    fn usage_values_saturate_without_wrapping() {
        assert_eq!(saturating_i32(i64::MAX), i32::MAX);
        assert_eq!(saturating_i32(i64::MIN), i32::MIN);
        assert_eq!(saturating_i32(42), 42);
    }
}
