//! Model pricing.
//!
//! The single source of truth for pricing is the `model_pricing` DB table
//! (seeded at server boot from [`SEED_PRICING`], kept fresh by the LLM
//! router's pricing-sync loop). The server injects a DB-backed
//! [`PricingSource`] into [`crate::provider::TempoLokiProvider`]; the
//! [`StaticPricing`] table below is the fallback for models missing from the
//! DB, and the only hardcoded price list in the codebase.

use async_trait::async_trait;

/// USD prices per **million** tokens: `(input_per_1m, output_per_1m)`.
pub type PricePer1M = (f64, f64);

/// Unknown-model fallback: GPT-4o list price, so estimates are conservative
/// rather than zero.
pub const DEFAULT_PRICE_PER_1M: PricePer1M = (2.50, 10.00);

/// Resolves `(input, output)` USD prices per million tokens for a model.
///
/// OSS server impl: `DbPricing` (queries the `model_pricing` table, falls back
/// to [`StaticPricing`]). Return `None` when the model is unknown — callers
/// fall back to [`DEFAULT_PRICE_PER_1M`] and log a warning.
#[async_trait]
pub trait PricingSource: Send + Sync {
    async fn price_per_1m(&self, model: &str) -> Option<PricePer1M>;
}

/// Hardcoded fallback price list (published list prices as of 2025-07),
/// matched by normalized substring so date-stamped variants
/// (e.g. `gpt-4o-2024-11-20`) resolve to their base model.
pub struct StaticPricing;

#[async_trait]
impl PricingSource for StaticPricing {
    async fn price_per_1m(&self, model: &str) -> Option<PricePer1M> {
        static_price_per_1m(model)
    }
}

/// Substring-matched static price lookup, USD per million tokens.
pub fn static_price_per_1m(model: &str) -> Option<PricePer1M> {
    let m = model.to_lowercase();

    // Order matters: more specific names first.
    const TABLE: &[(&str, PricePer1M)] = &[
        // OpenAI
        ("gpt-4.1-nano", (0.10, 0.40)),
        ("gpt-4.1-mini", (0.40, 1.60)),
        ("gpt-4.1", (2.00, 8.00)),
        ("gpt-4o-mini", (0.15, 0.60)),
        ("gpt-4o", (2.50, 10.00)),
        ("gpt-4-turbo", (10.00, 30.00)),
        ("gpt-4-1106", (10.00, 30.00)),
        ("gpt-4-0125", (10.00, 30.00)),
        ("gpt-4", (30.00, 60.00)),
        ("gpt-3.5", (0.50, 1.50)),
        ("o3-mini", (1.10, 4.40)),
        ("o3", (10.00, 40.00)),
        ("o1-mini", (3.00, 12.00)),
        ("o1", (15.00, 60.00)),
        // Anthropic
        ("claude-opus-4", (15.00, 75.00)),
        ("claude-4-opus", (15.00, 75.00)),
        ("claude-sonnet-4", (3.00, 15.00)),
        ("claude-4-sonnet", (3.00, 15.00)),
        ("claude-3-5-sonnet", (3.00, 15.00)),
        ("claude-3.5-sonnet", (3.00, 15.00)),
        ("claude-3-5-haiku", (0.80, 4.00)),
        ("claude-3.5-haiku", (0.80, 4.00)),
        ("claude-haiku-4", (0.80, 4.00)),
        ("claude-3-opus", (15.00, 75.00)),
        ("claude-3-sonnet", (3.00, 15.00)),
        ("claude-3-haiku", (0.25, 1.25)),
        ("claude", (3.00, 15.00)),
        // Google
        ("gemini-2.5-pro", (1.25, 10.00)),
        ("gemini-2.5-flash", (0.15, 0.60)),
        ("gemini-2.0", (0.10, 0.40)),
        ("gemini-1.5-pro", (1.25, 5.00)),
        ("gemini-1.5-flash", (0.075, 0.30)),
        ("gemini", (0.50, 1.50)),
        // DeepSeek
        ("deepseek-v4-flash", (0.14, 0.28)),
        ("deepseek-chat", (0.14, 0.28)),
        ("deepseek-reasoner", (0.55, 2.19)),
        ("deepseek", (0.14, 0.28)),
        // Meta / open-weight hosted
        ("llama-3.3-70b", (0.59, 0.79)),
        ("llama3.3-70b", (0.59, 0.79)),
        ("llama", (0.20, 0.20)),
        ("mistral", (0.20, 0.20)),
        ("mixtral", (0.20, 0.20)),
    ];

    TABLE
        .iter()
        .find(|(name, _)| m.contains(name))
        .map(|(_, price)| *price)
}

/// USD cost breakdown for a token count at a given price.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CostBreakdown {
    pub prompt_usd: f64,
    pub completion_usd: f64,
    pub total_usd: f64,
}

/// Compute a cost breakdown, resolving the price via `pricing` and falling
/// back to [`DEFAULT_PRICE_PER_1M`] (with a warning) for unknown models.
pub async fn compute_cost(
    pricing: &dyn PricingSource,
    model: Option<&str>,
    input_tokens: u64,
    output_tokens: u64,
) -> CostBreakdown {
    let model = model.unwrap_or("");
    let (in_p, out_p) = match pricing.price_per_1m(model).await {
        Some(p) => p,
        None => {
            if input_tokens > 0 || output_tokens > 0 {
                tracing::warn!(
                    model,
                    "no pricing found for model — using default fallback price"
                );
            }
            DEFAULT_PRICE_PER_1M
        }
    };
    let prompt = round6(input_tokens as f64 / 1_000_000.0 * in_p);
    let completion = round6(output_tokens as f64 / 1_000_000.0 * out_p);
    CostBreakdown {
        prompt_usd: prompt,
        completion_usd: completion,
        total_usd: round6(prompt + completion),
    }
}

pub(crate) fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

/// One curated seed row for `model_pricing` — USD per 1M tokens,
/// best-effort public list rates.
pub struct SeedPrice {
    pub provider: &'static str,
    pub model: &'static str,
    pub input_per_1m: f64,
    pub output_per_1m: f64,
    pub cache_creation_per_1m: Option<f64>,
    pub cache_read_per_1m: Option<f64>,
}

/// Declare a [`SeedPrice`] with less noise.
macro_rules! seed {
    ($provider:literal, $model:literal, $in:expr, $out:expr) => {
        SeedPrice {
            provider: $provider,
            model: $model,
            input_per_1m: $in,
            output_per_1m: $out,
            cache_creation_per_1m: None,
            cache_read_per_1m: None,
        }
    };
    ($provider:literal, $model:literal, $in:expr, $out:expr, $cw:expr, $cr:expr) => {
        SeedPrice {
            provider: $provider,
            model: $model,
            input_per_1m: $in,
            output_per_1m: $out,
            cache_creation_per_1m: Some($cw),
            cache_read_per_1m: Some($cr),
        }
    };
}

/// Curated seed rows for `model_pricing`: USD per 1M tokens, best-effort
/// public list rates. This is the offline baseline only: the LLM router's
/// pricing-sync loop (`oss/llm-router/src/routing/pricing_sync.rs`) refreshes
/// rows from the Portkey price book once provider keys are configured. VERIFY
/// against current provider pricing before relying on cost figures.
///
/// Deliberately code, not a migration: price updates ship with the binary
/// instead of requiring a new migration per price change.
pub const SEED_PRICING: &[SeedPrice] = &[
    seed!("openai", "gpt-4o", 2.50, 10.00),
    seed!("openai", "gpt-4o-mini", 0.15, 0.60),
    seed!("openai", "gpt-4.1", 2.00, 8.00),
    seed!("openai", "gpt-4.1-mini", 0.40, 1.60),
    seed!("openai", "gpt-4.1-nano", 0.10, 0.40),
    seed!("openai", "gpt-4-turbo", 10.00, 30.00),
    seed!("openai", "gpt-3.5-turbo", 0.50, 1.50),
    seed!("openai", "o1-preview", 15.00, 60.00),
    seed!("openai", "o1-mini", 3.00, 12.00),
    seed!("openai", "o3", 10.00, 40.00),
    seed!("openai", "o3-mini", 1.10, 4.40),
    seed!("openai", "text-embedding-3-small", 0.02, 0.00),
    seed!("openai", "text-embedding-3-large", 0.13, 0.00),
    seed!("anthropic", "claude-opus-4", 15.00, 75.00, 18.75, 1.50),
    seed!("anthropic", "claude-sonnet-4", 3.00, 15.00, 3.75, 0.30),
    seed!("anthropic", "claude-haiku-4", 0.80, 4.00, 1.00, 0.08),
    seed!("anthropic", "claude-3-5-sonnet", 3.00, 15.00),
    seed!("anthropic", "claude-3-5-haiku", 0.80, 4.00),
    seed!(
        "anthropic",
        "claude-3-5-sonnet-20241022",
        3.00,
        15.00,
        3.75,
        0.30
    ),
    seed!(
        "anthropic",
        "claude-3-5-haiku-20241022",
        0.80,
        4.00,
        1.00,
        0.08
    ),
    // `gemini`, not `google` — the router's provider label is what lands in
    // `token_usage.provider`, and `calculate_token_cost` matches (provider, model)
    // exactly, so a `google`-labelled row can never price a Gemini call.
    seed!("gemini", "gemini-2.5-pro", 1.25, 10.00),
    seed!("gemini", "gemini-2.5-flash", 0.15, 0.60),
    seed!("gemini", "gemini-1.5-pro", 1.25, 5.00),
    seed!("gemini", "gemini-1.5-flash", 0.075, 0.30),
    seed!("gemini", "gemini-2.0-flash", 0.10, 0.40),
    seed!("groq", "llama-3.3-70b-versatile", 0.59, 0.79),
    seed!("groq", "llama-3.1-8b-instant", 0.05, 0.08),
    seed!("deepseek", "deepseek-chat", 0.14, 0.28, 0.014, 0.014),
    seed!("deepseek", "deepseek-reasoner", 0.55, 2.19),
    seed!("deepseek", "deepseek-v4-flash", 0.14, 0.28),
    seed!("deepseek", "deepseek-v4-pro", 0.55, 2.19),
];

/// Seed `model_pricing` from [`SEED_PRICING`] at server boot.
///
/// Gap-filling, never overwriting: a row is inserted only when the
/// `(provider, model)` pair has NO currently-active pricing row, so
/// operator-set prices and pricing-sync history always win and re-boots are
/// idempotent. Best-effort — a failure is logged, not fatal (cost falls back
/// to NULL / [`StaticPricing`]).
pub async fn seed_model_pricing(db: &sqlx::PgPool) {
    let mut inserted = 0u32;
    for row in SEED_PRICING {
        let res = sqlx::query(
            "INSERT INTO model_pricing \
             (provider, model, input_price_per_1m, output_price_per_1m, \
              cache_creation_price_per_1m, cache_read_price_per_1m, notes) \
             SELECT $1, $2, $3, $4, $5, $6, 'boot seed (static list)' \
             WHERE NOT EXISTS ( \
                 SELECT 1 FROM model_pricing \
                 WHERE provider = $1 AND model = $2 AND effective_until IS NULL \
             )",
        )
        .bind(row.provider)
        .bind(row.model)
        .bind(row.input_per_1m)
        .bind(row.output_per_1m)
        .bind(row.cache_creation_per_1m)
        .bind(row.cache_read_per_1m)
        .execute(db)
        .await;
        match res {
            Ok(done) => inserted += done.rows_affected() as u32,
            Err(e) => {
                tracing::warn!(provider = row.provider, model = row.model, error = %e, "model pricing seed failed (non-fatal)")
            }
        }
    }
    if inserted > 0 {
        tracing::info!(inserted, "model pricing seeded from static list");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_lookup_matches_substring() {
        assert_eq!(
            static_price_per_1m("gpt-4o-2024-11-20"),
            Some((2.50, 10.00))
        );
        assert_eq!(static_price_per_1m("GPT-4o-mini"), Some((0.15, 0.60)));
        assert_eq!(static_price_per_1m("deepseek-v4-flash"), Some((0.14, 0.28)));
        assert_eq!(static_price_per_1m("totally-unknown"), None);
    }

    #[test]
    fn specific_names_win_over_prefixes() {
        // gpt-4.1-nano must not match the bare gpt-4.1 entry
        assert_eq!(static_price_per_1m("gpt-4.1-nano"), Some((0.10, 0.40)));
        assert_eq!(
            static_price_per_1m("claude-3-5-haiku-20241022"),
            Some((0.80, 4.00))
        );
    }

    #[tokio::test]
    async fn compute_cost_known_model() {
        let cost = compute_cost(&StaticPricing, Some("gpt-4o"), 1_000_000, 1_000_000).await;
        assert_eq!(cost.prompt_usd, 2.50);
        assert_eq!(cost.completion_usd, 10.00);
        assert_eq!(cost.total_usd, 12.50);
    }

    #[tokio::test]
    async fn compute_cost_unknown_model_uses_default() {
        let cost = compute_cost(&StaticPricing, None, 1_000_000, 0).await;
        assert_eq!(cost.prompt_usd, DEFAULT_PRICE_PER_1M.0);
    }
}
