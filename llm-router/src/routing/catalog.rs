//! Provider model catalog — the set of models each provider's configured endpoint
//! actually serves, discovered live from its `GET /models` listing endpoint and synced
//! into the `provider_models` table.
//!
//! This is the foundation of tier routing: the tier registry
//! ([`super::registry::PgTierRegistry`]) derives tier→model mappings from this catalog
//! (ranked by price as the strength signal) instead of any hardcoded model list, so
//! the router only ever routes among models the upstream supports — a custom
//! OpenAI-compatible endpoint (DeepSeek, vLLM, Ollama, …) is routed among *its own*
//! models with zero configuration.
//!
//! Sync semantics: for each provider with a platform API key configured, fetch the
//! model list, upsert every listed model, and delete rows the provider no longer
//! lists (the table is catalog-owned; operator tier overrides live in
//! `model_registry`). A failed fetch leaves existing rows untouched — stale data
//! beats no data.
//!
//! Gemini is skipped: its list endpoint has a different shape/auth and the router
//! has no Gemini tier routing today. Unknown/absent catalogs degrade to no tier
//! routing (the request's own model passes through), never to a wrong model.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;

use crate::config::GatewayConfig;

/// Upper bound on a `/models` fetch so a slow provider can't stall the sync loop.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Every provider label the router can actually route to, as `(label, API base URL)`,
/// gated on a configured platform key. Superset of [`listable_providers`]: the pricing
/// sync only needs the label and base URL (it queries Portkey, never the provider), so
/// it covers Gemini too — whereas the catalog sync can't, because Gemini's `ListModels`
/// answers `{"models": [{"name": …}]}` with a `?key=` credential rather than the
/// `{"data": [{"id": …}]}` + bearer shape [`fetch_models`] speaks.
pub(crate) fn priceable_providers(cfg: &GatewayConfig) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = listable_providers(cfg)
        .into_iter()
        .map(|(label, base, _key)| (label, base))
        .collect();
    if !cfg.platform_gemini_api_key.is_empty() {
        out.push(("gemini".to_string(), cfg.gemini_api_base.clone()));
    }
    out
}

/// The providers we know how to list models for: `(provider label, API base URL, key)`
/// resolved from the gateway config. Providers without a platform key are skipped —
/// no key means the router can't call that provider anyway.
///
/// Gemini is deliberately absent — see [`priceable_providers`] for why.
pub(crate) fn listable_providers(cfg: &GatewayConfig) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    if !cfg.platform_openai_api_key.is_empty() {
        // Any OpenAI-compatible endpoint (OpenAI, DeepSeek, vLLM, …) shares this shape.
        out.push((
            "openai".to_string(),
            cfg.openai_api_base.clone(),
            cfg.platform_openai_api_key.clone(),
        ));
    }
    if !cfg.platform_anthropic_api_key.is_empty() {
        out.push((
            "anthropic".to_string(),
            cfg.anthropic_api_base.clone(),
            cfg.platform_anthropic_api_key.clone(),
        ));
    }
    out
}

/// Both the OpenAI-compatible and Anthropic list endpoints answer
/// `{"data": [{"id": "<model>", …}, …]}`.
fn parse_models_response(body: &serde_json::Value) -> HashSet<String> {
    body.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|id| id.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Fetch one provider's model list. `None` on any failure — callers leave existing
/// rows untouched.
async fn fetch_models(
    http: &reqwest::Client,
    provider: &str,
    url: &str,
    api_key: &str,
) -> Option<HashSet<String>> {
    let req = http.get(url).timeout(FETCH_TIMEOUT);
    let req = match provider {
        "anthropic" => req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => req.bearer_auth(api_key),
    };
    let resp = req
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(
                target: "nasiko::llm_router::catalog",
                provider = %provider, error = %e,
                "model catalog sync: /models fetch failed — keeping existing rows"
            );
            e
        })
        .ok()?;
    if !resp.status().is_success() {
        tracing::warn!(
            target: "nasiko::llm_router::catalog",
            provider = %provider, status = %resp.status(),
            "model catalog sync: /models returned non-success — keeping existing rows"
        );
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    Some(parse_models_response(&body))
}

/// Replace one provider's catalog rows with `models` (upsert + delete-stale).
async fn sync_provider(
    db: &PgPool,
    provider: &str,
    models: &HashSet<String>,
) -> Result<(), sqlx::Error> {
    let models: Vec<&str> = models.iter().map(String::as_str).collect();
    sqlx::query(
        "INSERT INTO provider_models (provider, model, last_seen_at) \
         SELECT $1, m, now() FROM unnest($2::text[]) AS m \
         ON CONFLICT (provider, model) DO UPDATE SET last_seen_at = now()",
    )
    .bind(provider)
    .bind(&models)
    .execute(db)
    .await?;
    let deleted = sqlx::query(
        "DELETE FROM provider_models WHERE provider = $1 AND NOT (model = ANY($2::text[]))",
    )
    .bind(provider)
    .bind(&models)
    .execute(db)
    .await?
    .rows_affected();
    tracing::info!(
        target: "nasiko::llm_router::catalog",
        provider = %provider, listed = models.len(), stale_deleted = deleted,
        "model catalog sync: provider catalog updated"
    );
    Ok(())
}

/// One sync pass over every listable provider. Returns the number of providers
/// successfully synced.
pub async fn sync_once(db: &PgPool, http: &reqwest::Client, cfg: &GatewayConfig) -> usize {
    let mut synced = 0;
    for (provider, base, key) in listable_providers(cfg) {
        let url = format!("{base}/models");
        let Some(models) = fetch_models(http, &provider, &url, &key).await else {
            continue;
        };
        if models.is_empty() {
            tracing::warn!(
                target: "nasiko::llm_router::catalog",
                provider = %provider,
                "model catalog sync: provider listed zero models — keeping existing rows"
            );
            continue;
        }
        match sync_provider(db, &provider, &models).await {
            Ok(()) => synced += 1,
            Err(e) => tracing::warn!(
                target: "nasiko::llm_router::catalog",
                provider = %provider, error = %e,
                "model catalog sync: DB write failed"
            ),
        }
    }
    synced
}

/// Spawn the background catalog-sync loop: an immediate sync at startup, then every
/// `MODEL_CATALOG_SYNC_INTERVAL_SECS` (default 10 min). The task logs and continues on
/// failure; it never panics and never blocks serving.
///
/// Takes the already-resolved [`GatewayConfig`] rather than re-reading the environment,
/// so the router's effective config is decided once at the composition root. Whether to
/// spawn at all is the caller's decision (`MODEL_CATALOG_SYNC_ENABLED`) — this loop
/// reaches the network on its first tick.
pub fn spawn_sync(db: PgPool, http: reqwest::Client, cfg: Arc<GatewayConfig>) {
    let interval = Duration::from_secs(cfg.model_catalog_sync_interval_secs);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(interval);
        loop {
            // interval's first tick completes immediately → sync at startup.
            tick.tick().await;
            let synced = sync_once(&db, &http, &cfg).await;
            tracing::info!(
                target: "nasiko::llm_router::catalog",
                providers_synced = synced, interval_secs = interval.as_secs(),
                "model catalog sync pass complete"
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_and_anthropic_list_shape() {
        let body = serde_json::json!({
            "data": [
                {"id": "deepseek-v4-pro", "object": "model"},
                {"id": "deepseek-v4-flash", "object": "model"}
            ]
        });
        let models = parse_models_response(&body);
        assert!(models.contains("deepseek-v4-pro"));
        assert!(models.contains("deepseek-v4-flash"));
        assert!(!models.contains("gpt-5.4"));
    }

    #[test]
    fn parse_garbage_yields_empty_set() {
        assert!(parse_models_response(&serde_json::json!({"nope": 1})).is_empty());
        assert!(parse_models_response(&serde_json::json!(null)).is_empty());
    }

    #[test]
    fn listable_providers_require_platform_keys() {
        let cfg = GatewayConfig::default();
        assert!(listable_providers(&cfg).is_empty());

        let cfg = GatewayConfig {
            platform_openai_api_key: "sk-test".into(),
            openai_api_base: "https://api.deepseek.com/v1".into(),
            ..GatewayConfig::default()
        };
        let providers = listable_providers(&cfg);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].0, "openai");
        assert_eq!(providers[0].1, "https://api.deepseek.com/v1");
    }

    #[test]
    fn priceable_providers_add_gemini_but_listable_does_not() {
        let cfg = GatewayConfig {
            platform_gemini_api_key: "gk-test".into(),
            ..GatewayConfig::default()
        };
        // Gemini is priceable (Portkey knows it) but not listable (its /models
        // shape and credential differ from what `fetch_models` speaks).
        assert!(listable_providers(&cfg).is_empty());
        let priceable = priceable_providers(&cfg);
        assert_eq!(priceable.len(), 1);
        assert_eq!(priceable[0].0, "gemini");
        assert_eq!(priceable[0].1, cfg.gemini_api_base);
    }

    #[test]
    fn priceable_providers_is_empty_without_keys() {
        assert!(priceable_providers(&GatewayConfig::default()).is_empty());
    }

    #[test]
    fn priceable_providers_covers_every_configured_label() {
        let cfg = GatewayConfig {
            platform_openai_api_key: "sk-test".into(),
            platform_anthropic_api_key: "ak-test".into(),
            platform_gemini_api_key: "gk-test".into(),
            ..GatewayConfig::default()
        };
        let labels: Vec<String> = priceable_providers(&cfg)
            .into_iter()
            .map(|(label, _)| label)
            .collect();
        assert_eq!(labels, vec!["openai", "anthropic", "gemini"]);
    }
}
