//! Pricing sync from the Portkey models database (`github.com/Portkey-AI/models`,
//! MIT) — a community-maintained price book for 2,000+ models across 40+ providers,
//! served over a free, no-auth JSON API. Provider list endpoints don't expose pricing,
//! so without this the platform is stuck hand-seeding `model_pricing` rows that go
//! stale (the "stale by Friday" problem).
//!
//! For every provider with a platform key configured (same set as the model-catalog
//! sync), we resolve the upstream's Portkey slug — env override
//! `PORTKEY_PROVIDER_<LABEL>`, then a host mapping of the configured base URL
//! (`api.deepseek.com` → `deepseek`), then the label itself — fetch
//! `{PORTKEY_PRICING_BASE_URL}/pricing/{slug}.json`, and upsert into `model_pricing`
//! with real price history: a model whose prices changed gets its current row closed
//! (`effective_until`) and a new row opened; unchanged prices are left untouched, so a
//! sync is a no-op when nothing moved.
//!
//! Rows are written under the router's own provider label (e.g. `openai` even when the
//! upstream is DeepSeek) so exact `(provider, model)` cost lookups hit; the model-only
//! fallback keeps them visible to the other pricing paths. Curated seed rows stay as
//! the offline baseline — a failed sync changes nothing.
//!
//! Unit conversion: Portkey prices are **cents per token**; `model_pricing` is USD
//! per 1M tokens — multiply by 10,000.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;

use crate::config::GatewayConfig;

/// Upper bound on a pricing fetch.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// Default Portkey pricing API base (no auth required).
const DEFAULT_PRICING_BASE: &str = "https://configs.portkey.ai";

/// One model's converted prices, USD per 1M tokens. Cache columns are
/// both-or-neither (see [`ModelPrices::cache`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPrices {
    pub input_per_1m: f64,
    pub output_per_1m: f64,
    pub cache_creation_per_1m: Option<f64>,
    pub cache_read_per_1m: Option<f64>,
}

impl ModelPrices {
    /// From Portkey's `pay_as_you_go` object (cents per token). `None` when the
    /// required input/output prices are missing.
    fn from_pay_as_you_go(payg: &serde_json::Value) -> Option<Self> {
        let cents_to_usd_per_1m = |v: &serde_json::Value| {
            v.get("price")
                .and_then(|p| p.as_f64())
                .map(|c| c * 10_000.0)
        };
        let input = cents_to_usd_per_1m(payg.get("request_token")?)?;
        let output = cents_to_usd_per_1m(payg.get("response_token")?)?;
        Some(Self {
            input_per_1m: round4(input),
            output_per_1m: round4(output),
            ..Self::cache(
                cents_to_usd_per_1m(&payg["cache_write_input_token"]),
                cents_to_usd_per_1m(&payg["cache_read_input_token"]),
            )
        })
    }

    /// Cache prices are stored both-or-neither: the cost trigger dereferences
    /// `cache_read_price` whenever `cache_creation_price IS NOT NULL`, so a lone
    /// cache column would NULL-poison the whole cost. When only one side is priced,
    /// the other is set to 0 (the provider listed a cache price schedule; the missing
    /// side is free).
    fn cache(write: Option<f64>, read: Option<f64>) -> Self {
        let (creation, read) = match (write, read) {
            (None, None) => (None, None),
            (w, r) => (
                Some(round4(w.unwrap_or(0.0))),
                Some(round4(r.unwrap_or(0.0))),
            ),
        };
        Self {
            input_per_1m: 0.0,
            output_per_1m: 0.0,
            cache_creation_per_1m: creation,
            cache_read_per_1m: read,
        }
    }
}

/// model_pricing is DECIMAL(10,4) — round to 4dp so change detection compares what
/// would actually be stored (no churn from sub-4dp noise).
fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// Resolve the Portkey pricing slug for one of our provider labels: explicit env
/// override (`PORTKEY_PROVIDER_OPENAI=deepseek`), then a host mapping of the
/// configured base URL, then the label itself (correct for canonical endpoints).
fn portkey_slug(label: &str, api_base: &str) -> String {
    let env_key = format!("PORTKEY_PROVIDER_{}", label.to_ascii_uppercase());
    if let Ok(slug) = std::env::var(&env_key)
        && !slug.is_empty()
    {
        return slug;
    }
    let host = reqwest::Url::parse(api_base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default();
    match host.as_str() {
        "api.openai.com" => "openai",
        "api.deepseek.com" => "deepseek",
        "api.anthropic.com" => "anthropic",
        "generativelanguage.googleapis.com" => "google",
        "api.mistral.ai" => "mistral-ai",
        "api.groq.com" => "groq",
        "api.together.xyz" => "together-ai",
        "api.x.ai" => "x-ai",
        _ => label,
    }
    .to_string()
}

/// Fetch and convert one provider's price book. `None` on any failure (fail open —
/// existing pricing rows stay).
async fn fetch_price_book(
    http: &reqwest::Client,
    pricing_base: &str,
    slug: &str,
) -> Option<HashMap<String, ModelPrices>> {
    let url = format!("{pricing_base}/pricing/{slug}.json");
    let body: serde_json::Value = http
        .get(&url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| {
            tracing::warn!(
                target: "nasiko::llm_router::pricing_sync",
                slug = %slug, error = %e,
                "pricing sync: fetch failed — keeping existing pricing"
            );
            e
        })
        .ok()?
        .json()
        .await
        .map_err(|e| {
            tracing::warn!(
                target: "nasiko::llm_router::pricing_sync",
                slug = %slug, error = %e,
                "pricing sync: response parse failed — keeping existing pricing"
            );
            e
        })
        .ok()?;
    let map = body.as_object()?;
    let prices: HashMap<String, ModelPrices> = map
        .iter()
        .filter_map(|(model, entry)| {
            let payg = &entry["pricing_config"]["pay_as_you_go"];
            ModelPrices::from_pay_as_you_go(payg).map(|p| (model.clone(), p))
        })
        .collect();
    tracing::info!(
        target: "nasiko::llm_router::pricing_sync",
        slug = %slug, models = prices.len(),
        "pricing sync: fetched price book"
    );
    Some(prices)
}

/// Current active prices per model (latest effective row, any provider label — a
/// model whose seed row already matches needs no new row).
async fn current_prices(
    db: &PgPool,
    models: &[&str],
) -> Result<HashMap<String, ModelPrices>, sqlx::Error> {
    #[derive(sqlx::FromRow)]
    struct Row {
        model: String,
        input: f64,
        output: f64,
        cache_creation: Option<f64>,
        cache_read: Option<f64>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT DISTINCT ON (model)
                  model,
                  input_price_per_1m::float8 AS input,
                  output_price_per_1m::float8 AS output,
                  cache_creation_price_per_1m::float8 AS cache_creation,
                  cache_read_price_per_1m::float8 AS cache_read
           FROM model_pricing
           WHERE model = ANY($1::text[]) AND effective_until IS NULL
           ORDER BY model, effective_from DESC"#,
    )
    .bind(models)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.model,
                ModelPrices {
                    input_per_1m: r.input,
                    output_per_1m: r.output,
                    cache_creation_per_1m: r.cache_creation,
                    cache_read_per_1m: r.cache_read,
                },
            )
        })
        .collect())
}

/// Sync one provider label's price book into `model_pricing`, returning the number of
/// rows inserted (price changes + newly known models).
async fn sync_label(
    db: &PgPool,
    label: &str,
    book: &HashMap<String, ModelPrices>,
) -> Result<usize, sqlx::Error> {
    let models: Vec<&str> = book.keys().map(String::as_str).collect();
    let current = current_prices(db, &models).await?;
    let mut inserted = 0;
    for (model, new) in book {
        if current.get(model) == Some(new) {
            continue;
        }
        // Close this label's active row for the model (history), then open the new
        // one. Other labels' rows are left alone — model-only lookups order by
        // effective_from DESC, so this newer row wins.
        //
        // Both statements in one transaction, so a concurrent cost lookup never sees
        // the model with no active row. `now()` is the transaction timestamp, so the
        // closed row's `effective_until` equals the new row's `effective_from`
        // exactly — the point-in-time lookup in `calculate_token_cost` has no gap to
        // fall into. Per model rather than per label: a failure part-way through a
        // price book keeps the changes already applied instead of discarding them,
        // and no single transaction holds locks across ~2000 models.
        let mut tx = db.begin().await?;
        sqlx::query(
            "UPDATE model_pricing SET effective_until = now() \
             WHERE provider = $1 AND model = $2 AND effective_until IS NULL",
        )
        .bind(label)
        .bind(model)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO model_pricing \
             (provider, model, input_price_per_1m, output_price_per_1m, \
              cache_creation_price_per_1m, cache_read_price_per_1m, notes) \
             VALUES ($1, $2, $3, $4, $5, $6, 'portkey pricing sync')",
        )
        .bind(label)
        .bind(model)
        .bind(new.input_per_1m)
        .bind(new.output_per_1m)
        .bind(new.cache_creation_per_1m)
        .bind(new.cache_read_per_1m)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        inserted += 1;
    }
    Ok(inserted)
}

/// One pricing-sync pass over every configured provider. Returns rows inserted.
pub async fn sync_once(db: &PgPool, http: &reqwest::Client, cfg: &GatewayConfig) -> usize {
    let pricing_base = std::env::var("PORTKEY_PRICING_BASE_URL")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_PRICING_BASE.to_string());
    let mut inserted = 0;
    for (label, api_base) in super::catalog::priceable_providers(cfg) {
        let slug = portkey_slug(&label, &api_base);
        let Some(book) = fetch_price_book(http, &pricing_base, &slug).await else {
            continue;
        };
        match sync_label(db, &label, &book).await {
            Ok(n) => {
                inserted += n;
                tracing::info!(
                    target: "nasiko::llm_router::pricing_sync",
                    label = %label, slug = %slug, rows_inserted = n,
                    "pricing sync: provider price book applied"
                );
            }
            Err(e) => tracing::warn!(
                target: "nasiko::llm_router::pricing_sync",
                label = %label, error = %e,
                "pricing sync: DB write failed"
            ),
        }
    }
    inserted
}

/// Spawn the background pricing-sync loop: immediate sync at startup, then every
/// `PRICING_SYNC_INTERVAL_SECS` (default 24h — prices move slowly). Fail-open; never
/// panics, never blocks serving.
///
/// Takes the already-resolved [`GatewayConfig`] rather than re-reading the environment,
/// so the router's effective config is decided once at the composition root. Whether to
/// spawn at all is the caller's decision (`MODEL_PRICING_SYNC_ENABLED`) — this loop
/// reaches the network on its first tick.
pub fn spawn_sync(db: PgPool, http: reqwest::Client, cfg: Arc<GatewayConfig>) {
    let interval = Duration::from_secs(cfg.pricing_sync_interval_secs);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(interval);
        loop {
            // interval's first tick completes immediately → sync at startup.
            tick.tick().await;
            let inserted = sync_once(&db, &http, &cfg).await;
            tracing::info!(
                target: "nasiko::llm_router::pricing_sync",
                rows_inserted = inserted, interval_secs = interval.as_secs(),
                "pricing sync pass complete"
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn converts_cents_per_token_to_usd_per_1m() {
        // DeepSeek v4-flash as served by Portkey: 1.4e-05 ¢/tok in → $0.14/1M.
        let payg = json!({
            "request_token": {"price": 1.4e-05},
            "response_token": {"price": 2.8e-05},
            "cache_write_input_token": {"price": 0},
            "cache_read_input_token": {"price": 2.8e-07}
        });
        let p = ModelPrices::from_pay_as_you_go(&payg).unwrap();
        assert_eq!(p.input_per_1m, 0.14);
        assert_eq!(p.output_per_1m, 0.28);
        assert_eq!(p.cache_creation_per_1m, Some(0.0));
        assert_eq!(p.cache_read_per_1m, Some(0.0028));
    }

    #[test]
    fn missing_cache_prices_stay_null_unless_one_side_present() {
        let payg = json!({
            "request_token": {"price": 0.00025},
            "response_token": {"price": 0.001}
        });
        let p = ModelPrices::from_pay_as_you_go(&payg).unwrap();
        assert_eq!(p.cache_creation_per_1m, None);
        assert_eq!(p.cache_read_per_1m, None);

        // One-sided cache price: the other side becomes 0, never NULL (the cost
        // trigger dereferences read whenever creation IS NOT NULL).
        let payg = json!({
            "request_token": {"price": 0.00025},
            "response_token": {"price": 0.001},
            "cache_read_input_token": {"price": 0.000025}
        });
        let p = ModelPrices::from_pay_as_you_go(&payg).unwrap();
        assert_eq!(p.cache_creation_per_1m, Some(0.0));
        assert_eq!(p.cache_read_per_1m, Some(0.25));
    }

    #[test]
    fn missing_input_or_output_price_skips_the_model() {
        assert!(
            ModelPrices::from_pay_as_you_go(&json!({"response_token": {"price": 1}})).is_none()
        );
        assert!(ModelPrices::from_pay_as_you_go(&json!({})).is_none());
    }

    #[test]
    fn slug_resolution_prefers_env_then_host_then_label() {
        // Host mapping: DeepSeek behind the openai label.
        assert_eq!(
            portkey_slug("openai", "https://api.deepseek.com/v1"),
            "deepseek"
        );
        assert_eq!(
            portkey_slug("anthropic", "https://api.anthropic.com/v1"),
            "anthropic"
        );
        // Unknown host falls back to the label.
        assert_eq!(portkey_slug("openai", "http://localhost:9100/v1"), "openai");
        // Env override wins.
        unsafe { std::env::set_var("PORTKEY_PROVIDER_OPENAI", "azure-openai") };
        assert_eq!(
            portkey_slug("openai", "https://api.openai.com/v1"),
            "azure-openai"
        );
        unsafe { std::env::remove_var("PORTKEY_PROVIDER_OPENAI") };
    }
}
