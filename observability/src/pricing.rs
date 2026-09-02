//! Model pricing.
//!
//! The single source of truth for pricing is the `model_pricing` DB table
//! (seeded in `oss/migrations`). The server injects a DB-backed
//! [`PricingSource`] into [`crate::provider::TempoLokiProvider`]; the
//! [`StaticPricing`] table below is the fallback for models missing from the
//! DB, and the only hardcoded price list in the codebase.

use async_trait::async_trait;

/// USD prices per **million** tokens: `(input_per_1m, output_per_1m)`.
pub type PricePer1M = (f64, f64);

/// Optional cache-write/cache-read USD prices per million tokens.
pub type CachePricePer1M = (Option<f64>, Option<f64>);

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

    /// Resolves optional `(cache_creation, cache_read)` prices. Missing rates
    /// are conservatively priced as direct input by [`compute_cost_with_cache`].
    async fn cache_price_per_1m(&self, _model: &str) -> CachePricePer1M {
        (None, None)
    }
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

    async fn cache_price_per_1m(&self, model: &str) -> CachePricePer1M {
        static_cache_price_per_1m(model)
    }
}

/// Cache-write/cache-read static rates where known.
pub fn static_cache_price_per_1m(model: &str) -> CachePricePer1M {
    let m = model.to_lowercase();
    const TABLE: &[(&str, f64, f64)] = &[
        ("openai.gpt-5.6-sol", 5.50, 0.44),
        ("claude-opus-5", 18.75, 1.50),
        ("claude-sonnet-5", 3.75, 0.30),
        ("claude-opus-4", 18.75, 1.50),
        ("claude-4-opus", 18.75, 1.50),
        ("claude-sonnet-4", 3.75, 0.30),
        ("claude-4-sonnet", 3.75, 0.30),
        ("claude-3-5-sonnet", 3.75, 0.30),
        ("claude-3.5-sonnet", 3.75, 0.30),
        ("claude-3-5-haiku", 1.00, 0.08),
        ("claude-3.5-haiku", 1.00, 0.08),
        ("claude-haiku-4", 1.00, 0.08),
        ("deepseek-chat", 0.014, 0.014),
    ];

    TABLE
        .iter()
        .find(|(name, _, _)| m.contains(name))
        .map(|(_, creation, read)| (Some(*creation), Some(*read)))
        .unwrap_or((None, None))
}

/// Substring-matched static price lookup, USD per million tokens.
pub fn static_price_per_1m(model: &str) -> Option<PricePer1M> {
    let m = model.to_lowercase();

    // Order matters: more specific names first.
    const TABLE: &[(&str, PricePer1M)] = &[
        // OpenAI
        ("openai.gpt-5.6-sol", (4.40, 22.00)),
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
        // Anthropic. Claude 5 rates are carried forward from the equivalent
        // Claude 4 tier and are unverified — see
        // oss/migrations/0006_seed_model_pricing.sql. They must stay above
        // the generic "claude" entry, which would otherwise price Opus as
        // Sonnet.
        ("claude-opus-5", (15.00, 75.00)),
        ("claude-sonnet-5", (3.00, 15.00)),
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
    pub cache_read_usd: f64,
    pub cache_creation_usd: f64,
    pub total_usd: f64,
}

impl CostBreakdown {
    pub fn add_assign(&mut self, other: Self) {
        self.prompt_usd = round6(self.prompt_usd + other.prompt_usd);
        self.completion_usd = round6(self.completion_usd + other.completion_usd);
        self.cache_read_usd = round6(self.cache_read_usd + other.cache_read_usd);
        self.cache_creation_usd = round6(self.cache_creation_usd + other.cache_creation_usd);
        self.total_usd = round6(
            self.prompt_usd + self.completion_usd + self.cache_read_usd + self.cache_creation_usd,
        );
    }
}

/// Compute a cost breakdown, resolving the price via `pricing` and falling
/// back to [`DEFAULT_PRICE_PER_1M`] (with a warning) for unknown models.
pub async fn compute_cost(
    pricing: &dyn PricingSource,
    model: Option<&str>,
    input_tokens: u64,
    output_tokens: u64,
) -> CostBreakdown {
    compute_cost_with_cache(pricing, model, input_tokens, output_tokens, 0, 0).await
}

/// Compute direct input/output plus cache-read/cache-creation cost.
pub async fn compute_cost_with_cache(
    pricing: &dyn PricingSource,
    model: Option<&str>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
) -> CostBreakdown {
    let model = model.unwrap_or("");
    let (in_p, out_p) = match pricing.price_per_1m(model).await {
        Some(p) => p,
        None => {
            if input_tokens > 0
                || output_tokens > 0
                || cache_read_tokens > 0
                || cache_creation_tokens > 0
            {
                tracing::warn!(
                    model,
                    "no pricing found for model — using default fallback price"
                );
            }
            DEFAULT_PRICE_PER_1M
        }
    };
    let (cache_creation_p, cache_read_p) = pricing.cache_price_per_1m(model).await;
    let prompt = round6(input_tokens as f64 / 1_000_000.0 * in_p);
    let completion = round6(output_tokens as f64 / 1_000_000.0 * out_p);
    let cache_read = round6(cache_read_tokens as f64 / 1_000_000.0 * cache_read_p.unwrap_or(in_p));
    let cache_creation =
        round6(cache_creation_tokens as f64 / 1_000_000.0 * cache_creation_p.unwrap_or(in_p));
    CostBreakdown {
        prompt_usd: prompt,
        completion_usd: completion,
        cache_read_usd: cache_read,
        cache_creation_usd: cache_creation,
        total_usd: round6(prompt + completion + cache_read + cache_creation),
    }
}

pub(crate) fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
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

    #[test]
    fn gpt_5_6_sol_uses_bedrock_cache_rates() {
        assert_eq!(static_price_per_1m("openai.gpt-5.6-sol"), Some((4.4, 22.0)));
        assert_eq!(
            static_cache_price_per_1m("openai.gpt-5.6-sol"),
            (Some(5.5), Some(0.44))
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

    #[tokio::test]
    async fn compute_cost_prices_all_four_token_classes() {
        let cost = compute_cost_with_cache(
            &StaticPricing,
            Some("claude-sonnet-4"),
            1_000_000,
            1_000_000,
            1_000_000,
            1_000_000,
        )
        .await;
        assert_eq!(cost.prompt_usd, 3.0);
        assert_eq!(cost.completion_usd, 15.0);
        assert_eq!(cost.cache_read_usd, 0.3);
        assert_eq!(cost.cache_creation_usd, 3.75);
        assert_eq!(cost.total_usd, 22.05);
    }

    #[tokio::test]
    async fn missing_cache_rates_fall_back_to_input_rate() {
        let cost =
            compute_cost_with_cache(&StaticPricing, Some("gpt-4o"), 0, 0, 1_000_000, 1_000_000)
                .await;
        assert_eq!(cost.cache_read_usd, 2.5);
        assert_eq!(cost.cache_creation_usd, 2.5);
        assert_eq!(cost.total_usd, 5.0);
    }
}
