//! Tier registry — maps `(provider, tier)` to a concrete model id.
//!
//! Once the classifier picks a [`Tier`] and the resolver has fixed the destination
//! provider, this is where the two combine into the actual model to call.
//!
//! Two impls behind the [`TierRegistry`] seam:
//! - [`StaticTierRegistry`] — the hardcoded seed table (also the fallback layer).
//! - [`PgTierRegistry`] — reads the `model_registry` DB table, falling back to the
//!   static seeds on a missing row **or** a DB error. Correctness never depends on the
//!   table being present/reachable — an unseeded/unavailable registry degrades to the
//!   seeds, and an unknown provider degrades to `None` (which makes the router fall
//!   through to the configured/default model).
//!
//! The static seeds name **first-party** models (gpt-*, claude-*), so [`PgTierRegistry`]
//! applies them only when the provider's configured base URL is the canonical
//! first-party endpoint. An overridden base URL (e.g. `OPENAI_API_BASE` pointing at
//! DeepSeek, vLLM, or Ollama) means the upstream's model names are unknowable — the
//! seeds would be actively wrong — so the registry returns `None` and the router passes
//! the request's own model through. DB rows are always honored regardless: they are
//! explicit operator config (`PUT /api/model-registry`).

use async_trait::async_trait;
use sqlx::PgPool;

use crate::config::GatewayConfig;

use super::classifier::Tier;

impl Tier {
    /// The `model_registry.tier` SMALLINT value (1 = strongest … 3 = smallest).
    pub fn as_level(self) -> i16 {
        match self {
            Tier::Tier1 => 1,
            Tier::Tier2 => 2,
            Tier::Tier3 => 3,
        }
    }

    /// Inverse of [`Tier::as_level`]; `None` for out-of-range values.
    pub fn from_level(level: i16) -> Option<Tier> {
        match level {
            1 => Some(Tier::Tier1),
            2 => Some(Tier::Tier2),
            3 => Some(Tier::Tier3),
            _ => None,
        }
    }
}

/// Looks up the model for a `(provider, tier)` pair.
#[async_trait]
pub trait TierRegistry: Send + Sync {
    /// The model id for `(provider, tier)`, or `None` if this provider has no entry
    /// (caller falls through to the configured/default model).
    async fn model_for(&self, provider: &str, tier: Tier) -> Option<String>;
}

/// In-memory seed table — the S1 mapping, seeded with the agreed examples. Serves as both
/// a standalone registry and the fallback layer for [`PgTierRegistry`].
pub struct StaticTierRegistry;

impl StaticTierRegistry {
    /// The seeded model for `(provider, tier)`. Provider match is case-insensitive; model
    /// ids are returned exactly. `None` for providers with no seeded tiers.
    ///
    /// This is the source of truth the `model_registry` DB seed (migration 018) mirrors.
    pub fn seed(provider: &str, tier: Tier) -> Option<&'static str> {
        match provider.trim().to_ascii_lowercase().as_str() {
            "anthropic" => Some(match tier {
                Tier::Tier1 => "claude-opus-4-8",
                Tier::Tier2 => "claude-sonnet-4-6",
                Tier::Tier3 => "claude-haiku-4-5",
            }),
            "openai" => Some(match tier {
                Tier::Tier1 => "gpt-5.5",
                Tier::Tier2 => "gpt-5.4",
                Tier::Tier3 => "gpt-4o-mini",
            }),
            // Other providers (e.g. gemini) have no seeded tiers yet ⇒ fall through.
            _ => None,
        }
    }
}

#[async_trait]
impl TierRegistry for StaticTierRegistry {
    async fn model_for(&self, provider: &str, tier: Tier) -> Option<String> {
        let model = Self::seed(provider, tier).map(str::to_string);
        tracing::debug!(
            target: "nasiko::llm_router::registry",
            registry = "static-seed",
            provider = %provider,
            tier = ?tier,
            tier_level = tier.as_level(),
            model = ?model,
            "tier registry lookup (static seed table)"
        );
        model
    }
}

/// Whether the built-in static tier seeds apply to each known provider. The seeds name
/// first-party models, so they only apply while the provider's base URL is the canonical
/// first-party endpoint; an overridden base URL means an OpenAI-compatible third party
/// whose model names we cannot know.
#[derive(Debug, Clone, Copy)]
struct CanonicalSeeds {
    openai: bool,
    anthropic: bool,
    gemini: bool,
}

impl CanonicalSeeds {
    fn from_config(cfg: &GatewayConfig) -> Self {
        let canonical = GatewayConfig::default();
        Self {
            openai: cfg.openai_api_base == canonical.openai_api_base,
            anthropic: cfg.anthropic_api_base == canonical.anthropic_api_base,
            gemini: cfg.gemini_api_base == canonical.gemini_api_base,
        }
    }

    /// Whether static seeds may be served for `provider` (already lowercased).
    /// Unknown providers have no static seeds, so the answer is irrelevant — `true`
    /// keeps the fallback path simple.
    fn applies_to(&self, provider: &str) -> bool {
        match provider {
            "openai" => self.openai,
            "anthropic" => self.anthropic,
            "gemini" => self.gemini,
            _ => true,
        }
    }
}

/// Postgres-backed registry reading the `model_registry` table, with the static seeds as a
/// fallback for missing rows and DB errors.
pub struct PgTierRegistry {
    db: PgPool,
    fallback: StaticTierRegistry,
    seeds: CanonicalSeeds,
}

impl PgTierRegistry {
    pub fn new(db: PgPool, cfg: &GatewayConfig) -> Self {
        Self {
            db,
            fallback: StaticTierRegistry,
            seeds: CanonicalSeeds::from_config(cfg),
        }
    }

    /// Static-seed fallback, gated on the provider still pointing at its canonical
    /// first-party endpoint.
    async fn static_fallback(&self, provider: &str, tier: Tier) -> Option<String> {
        if !self.seeds.applies_to(provider) {
            tracing::info!(
                target: "nasiko::llm_router::registry",
                provider = %provider, tier = ?tier,
                "tier registry: custom base URL for provider — built-in tier seeds skipped (first-party model names would be wrong); passing through the requested model"
            );
            return None;
        }
        self.fallback.model_for(provider, tier).await
    }
}

#[async_trait]
impl TierRegistry for PgTierRegistry {
    async fn model_for(&self, provider: &str, tier: Tier) -> Option<String> {
        let key = provider.trim().to_ascii_lowercase();
        let row: Result<Option<(String,)>, sqlx::Error> =
            sqlx::query_as("SELECT model FROM model_registry WHERE provider = $1 AND tier = $2")
                .bind(&key)
                .bind(tier.as_level())
                .fetch_optional(&self.db)
                .await;
        match row {
            Ok(Some((model,))) => {
                tracing::info!(
                    target: "nasiko::llm_router::registry",
                    registry = "postgres:model_registry",
                    provider = %key, tier = ?tier, tier_level = tier.as_level(),
                    model = %model,
                    "tier registry lookup — resolved from DB model_registry table (tier→model override)"
                );
                Some(model)
            }
            // No configured row for this provider/tier ⇒ fall back to the seeds.
            Ok(None) => {
                tracing::debug!(
                    target: "nasiko::llm_router::registry",
                    provider = %key, tier = ?tier,
                    "tier registry lookup — no DB row for (provider, tier); falling back to static seed table"
                );
                self.static_fallback(&key, tier).await
            }
            Err(e) => {
                tracing::warn!(
                    target: "nasiko::llm_router::registry",
                    error = %e, provider = %key, tier = ?tier,
                    "model_registry read failed; using static seed fallback"
                );
                self.static_fallback(&key, tier).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_tiers_map_to_expected_models() {
        assert_eq!(
            StaticTierRegistry::seed("anthropic", Tier::Tier1),
            Some("claude-opus-4-8")
        );
        assert_eq!(
            StaticTierRegistry::seed("anthropic", Tier::Tier2),
            Some("claude-sonnet-4-6")
        );
        assert_eq!(
            StaticTierRegistry::seed("anthropic", Tier::Tier3),
            Some("claude-haiku-4-5")
        );
    }

    #[test]
    fn openai_tiers_map_to_expected_models() {
        assert_eq!(
            StaticTierRegistry::seed("openai", Tier::Tier1),
            Some("gpt-5.5")
        );
        assert_eq!(
            StaticTierRegistry::seed("OpenAI", Tier::Tier3),
            Some("gpt-4o-mini")
        );
    }

    #[test]
    fn unseeded_provider_is_none() {
        assert_eq!(StaticTierRegistry::seed("gemini", Tier::Tier1), None);
        assert_eq!(StaticTierRegistry::seed("cohere", Tier::Tier2), None);
    }

    #[test]
    fn tier_levels_are_stable() {
        assert_eq!(Tier::Tier1.as_level(), 1);
        assert_eq!(Tier::Tier2.as_level(), 2);
        assert_eq!(Tier::Tier3.as_level(), 3);
    }

    #[tokio::test]
    async fn static_registry_trait_delegates_to_seed() {
        let r = StaticTierRegistry;
        assert_eq!(
            r.model_for("anthropic", Tier::Tier1).await.as_deref(),
            Some("claude-opus-4-8")
        );
        assert_eq!(r.model_for("gemini", Tier::Tier1).await, None);
    }

    /// A registry whose DB always errors (lazy pool to a dead port), so `model_for`
    /// exercises the static-fallback path the canonical gate protects.
    fn unreachable_registry(cfg: &GatewayConfig) -> PgTierRegistry {
        let opts = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(200));
        let pool = opts
            .connect_lazy("postgres://localhost:1/unreachable")
            .unwrap();
        PgTierRegistry::new(pool, cfg)
    }

    #[tokio::test]
    async fn static_fallback_served_for_canonical_endpoints() {
        let r = unreachable_registry(&GatewayConfig::default());
        assert_eq!(
            r.model_for("openai", Tier::Tier2).await.as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            r.model_for("anthropic", Tier::Tier3).await.as_deref(),
            Some("claude-haiku-4-5")
        );
        assert_eq!(r.model_for("gemini", Tier::Tier1).await, None);
    }

    #[tokio::test]
    async fn static_fallback_skipped_for_custom_openai_endpoint() {
        // e.g. OPENAI_API_BASE=https://api.deepseek.com/v1 — the gpt-* seed names are
        // wrong for that upstream, so the registry must defer to the requested model.
        let cfg = GatewayConfig {
            openai_api_base: "https://api.deepseek.com/v1".into(),
            ..GatewayConfig::default()
        };
        let r = unreachable_registry(&cfg);
        assert_eq!(r.model_for("openai", Tier::Tier1).await, None);
        assert_eq!(r.model_for("openai", Tier::Tier2).await, None);
        assert_eq!(r.model_for("openai", Tier::Tier3).await, None);
        // Other providers are unaffected.
        assert_eq!(
            r.model_for("anthropic", Tier::Tier2).await.as_deref(),
            Some("claude-sonnet-4-6")
        );
    }

    #[tokio::test]
    async fn static_fallback_skipped_for_custom_anthropic_endpoint() {
        let cfg = GatewayConfig {
            anthropic_api_base: "http://localhost:11434/v1".into(),
            ..GatewayConfig::default()
        };
        let r = unreachable_registry(&cfg);
        assert_eq!(r.model_for("anthropic", Tier::Tier1).await, None);
        assert_eq!(
            r.model_for("openai", Tier::Tier2).await.as_deref(),
            Some("gpt-5.4")
        );
    }
}
