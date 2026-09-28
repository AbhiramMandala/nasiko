//! The price book: where rates come from, and the offline table behind them.

use async_trait::async_trait;
use chrono::{DateTime, Utc};

/// Unknown-model fallback, so an estimate is conservative rather than absent.
/// A missing price must never become a zero cost: zero reads as "this call was
/// free", which is indistinguishable from a real free call.
pub const DEFAULT_INPUT_PER_1M: f64 = 2.50;
pub const DEFAULT_OUTPUT_PER_1M: f64 = 10.00;

/// One price row. Input and output are always present — in `model_pricing` both
/// columns are `NOT NULL`, so a row either has them or does not exist. Only the
/// cache pair can be absent, and it is absent for 81% of the live book.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PriceRow {
    pub input_per_1m: f64,
    pub output_per_1m: f64,
    pub cache_read_per_1m: Option<f64>,
    pub cache_creation_per_1m: Option<f64>,
    pub cache_creation_1h_per_1m: Option<f64>,
}

impl PriceRow {
    pub fn cache_pair(&self) -> Option<(f64, f64)> {
        self.cache_read_per_1m.zip(self.cache_creation_per_1m)
    }
}

/// How authoritative a book's answers are, for recording provenance on a quote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BookTier {
    /// Kept current by the pricing sync — a looked-up rate.
    Synced,
    /// Compiled-in list prices — a reasonable rate, but not a looked-up one.
    Offline,
}

/// A source of model rates.
///
/// Implementations are searched in order by [`crate::quote`], which merges their
/// answers field by field — a row that carries input and output but no cache
/// prices contributes what it has and lets the next source supply the rest.
#[async_trait]
pub trait PriceBook: Send + Sync {
    /// Rates for an exact `(provider, model)` pair in effect at `at`.
    async fn exact(&self, provider: &str, model: &str, at: DateTime<Utc>) -> Option<PriceRow>;

    /// Rates for a model name alone, whoever serves it.
    async fn by_model(&self, model: &str, at: DateTime<Utc>) -> Option<PriceRow>;

    /// Whether this book's answers count as looked up or as a fallback.
    fn tier(&self) -> BookTier {
        BookTier::Synced
    }
}

/// Published list rates, matched by normalized substring. The offline baseline:
/// a failed or never-run pricing sync leaves this intact.
pub struct StaticPriceBook;

#[async_trait]
impl PriceBook for StaticPriceBook {
    async fn exact(&self, _provider: &str, model: &str, _at: DateTime<Utc>) -> Option<PriceRow> {
        static_row(model)
    }

    async fn by_model(&self, model: &str, _at: DateTime<Utc>) -> Option<PriceRow> {
        static_row(model)
    }

    fn tier(&self) -> BookTier {
        BookTier::Offline
    }
}

/// One offline entry: the name to match on, then input, output, cache-creation
/// and cache-read rates in USD per million tokens.
type ListPrice = (&'static str, f64, f64, Option<f64>, Option<f64>);

/// Substring-matched list prices. Order matters: more specific names first, so
/// `claude-opus-4` is not priced as the generic `claude`.
fn static_row(model: &str) -> Option<PriceRow> {
    const TABLE: &[ListPrice] = &[
        // Bedrock-hosted OpenAI. Must precede the bare OpenAI entries: the id
        // carries a vendor prefix but the rates are Bedrock's, not OpenAI's.
        ("openai.gpt-5.6-sol", 4.40, 22.00, Some(5.50), Some(0.44)),
        // OpenAI
        ("gpt-4.1-nano", 0.10, 0.40, None, None),
        ("gpt-4.1-mini", 0.40, 1.60, Some(0.0), Some(0.10)),
        ("gpt-4.1", 2.00, 8.00, Some(0.0), Some(0.50)),
        ("gpt-4o-mini", 0.15, 0.60, Some(0.0), Some(0.075)),
        ("gpt-4o", 2.50, 10.00, Some(0.0), Some(1.25)),
        ("gpt-4-turbo", 10.00, 30.00, None, None),
        ("gpt-4", 30.00, 60.00, None, None),
        ("gpt-3.5", 0.50, 1.50, None, None),
        ("o3-mini", 1.10, 4.40, None, None),
        ("o3", 10.00, 40.00, None, None),
        ("o1-mini", 3.00, 12.00, None, None),
        ("o1", 15.00, 60.00, None, None),
        // Anthropic. Claude 5 rates are carried forward from the equivalent
        // Claude 4 tier and are unverified — see oss/migrations/0006. They must
        // stay above the generic `claude` entry, which would price Opus as Sonnet.
        ("claude-opus-5", 15.00, 75.00, Some(18.75), Some(1.50)),
        ("claude-sonnet-5", 3.00, 15.00, Some(3.75), Some(0.30)),
        ("claude-opus-4", 15.00, 75.00, Some(18.75), Some(1.50)),
        ("claude-4-opus", 15.00, 75.00, Some(18.75), Some(1.50)),
        ("claude-sonnet-4", 3.00, 15.00, Some(3.75), Some(0.30)),
        ("claude-4-sonnet", 3.00, 15.00, Some(3.75), Some(0.30)),
        ("claude-haiku-4", 0.80, 4.00, Some(1.00), Some(0.08)),
        ("claude-3-5-sonnet", 3.00, 15.00, Some(3.75), Some(0.30)),
        ("claude-3.5-sonnet", 3.00, 15.00, Some(3.75), Some(0.30)),
        ("claude-3-5-haiku", 0.80, 4.00, Some(1.00), Some(0.08)),
        ("claude-3.5-haiku", 0.80, 4.00, Some(1.00), Some(0.08)),
        ("claude-3-opus", 15.00, 75.00, Some(18.75), Some(1.50)),
        ("claude-3-sonnet", 3.00, 15.00, None, None),
        ("claude-3-haiku", 0.25, 1.25, Some(0.30), Some(0.03)),
        ("claude", 3.00, 15.00, Some(3.75), Some(0.30)),
        // Google
        ("gemini-2.5-pro", 1.25, 10.00, None, None),
        ("gemini-2.5-flash", 0.15, 0.60, None, None),
        ("gemini-2.0", 0.10, 0.40, None, None),
        ("gemini-1.5-pro", 1.25, 5.00, None, None),
        ("gemini-1.5-flash", 0.075, 0.30, None, None),
        ("gemini", 0.50, 1.50, None, None),
        // DeepSeek
        ("deepseek-chat", 0.14, 0.28, Some(0.014), Some(0.014)),
        ("deepseek-reasoner", 0.55, 2.19, None, None),
        ("deepseek", 0.14, 0.28, None, None),
        // Open-weight hosted
        ("llama-3.3-70b", 0.59, 0.79, None, None),
        ("llama", 0.20, 0.20, None, None),
        ("mistral", 0.20, 0.20, None, None),
        ("mixtral", 0.20, 0.20, None, None),
    ];

    let name = model.to_lowercase();
    TABLE
        .iter()
        .find(|(candidate, ..)| name.contains(candidate))
        .map(|(_, input, output, creation, read)| PriceRow {
            input_per_1m: *input,
            output_per_1m: *output,
            cache_read_per_1m: *read,
            cache_creation_per_1m: *creation,
            cache_creation_1h_per_1m: None,
        })
}

/// The rates used when no book knows the model at all.
pub fn default_row() -> PriceRow {
    PriceRow {
        input_per_1m: DEFAULT_INPUT_PER_1M,
        output_per_1m: DEFAULT_OUTPUT_PER_1M,
        cache_read_per_1m: None,
        cache_creation_per_1m: None,
        cache_creation_1h_per_1m: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specific_claude_names_win_over_the_generic_entry() {
        let opus = static_row("claude-opus-4").expect("opus priced");
        assert_eq!(opus.input_per_1m, 15.00);
        let generic = static_row("claude-instant").expect("generic priced");
        assert_eq!(generic.input_per_1m, 3.00);
    }

    #[test]
    fn the_static_table_carries_cache_rates_for_the_main_families() {
        // This is what the DB's NULL cache columns get to inherit.
        assert_eq!(
            static_row("claude-3-5-sonnet").and_then(|r| r.cache_pair()),
            Some((0.30, 3.75))
        );
    }

    #[test]
    fn a_row_with_only_one_cache_rate_reports_no_usable_pair() {
        let row = PriceRow {
            input_per_1m: 1.0,
            output_per_1m: 2.0,
            cache_read_per_1m: Some(0.1),
            cache_creation_per_1m: None,
            cache_creation_1h_per_1m: None,
        };
        assert_eq!(row.cache_pair(), None);
    }

    #[test]
    fn the_default_row_is_never_zero() {
        let row = default_row();
        assert!(row.input_per_1m > 0.0 && row.output_per_1m > 0.0);
    }
}
