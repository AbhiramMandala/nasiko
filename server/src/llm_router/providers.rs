//! User-facing model catalog for the LLM router (`GET /api/llm-router/providers`).
//!
//! Backs a UI provider/model dropdown. Unlike the OpenAI-compat `/v1/models` egress
//! endpoint (a flat `{id, provider}` list for agent SDKs) and `/api/model-registry`
//! (admin tier→model config), this lists every `(provider, model)` the platform knows
//! — the union of what each endpoint actually **serves** (`provider_models`, synced
//! from its `GET /models`) and what carries a **currently-effective price**
//! (`model_pricing`) — so a served-but-unpriced model (a custom provider with no
//! Portkey price book) still appears, with null prices and `pricing_available: false`,
//! and a priced-but-unlisted provider (Gemini, whose `/models` shape the catalog sync
//! can't speak) is not dropped. No metadata beyond what the DB stores is invented.

use axum::{Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde::Serialize;
use serde_json::json;
use utoipa::ToSchema;

use crate::auth::Claims;
use crate::mcp::ApiResponse;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    // Read-only catalog; any authenticated user may list it (matches model_registry::list).
    Router::new().route("/llm-router/providers", get(list_providers))
}

/// The raw joined shape we read; `Decimal` prices are projected to `f64` for the
/// response (as [`crate::llm_router::model_registry`]'s neighbours and `DbPricing` do).
/// Every pricing column is optional: a `provider_models` row with no matching price
/// carries all-null prices.
#[derive(sqlx::FromRow)]
struct PricingRow {
    provider: String,
    model: String,
    input_price_per_1m: Option<Decimal>,
    output_price_per_1m: Option<Decimal>,
    cache_creation_price_per_1m: Option<Decimal>,
    cache_read_price_per_1m: Option<Decimal>,
    currency: Option<String>,
    notes: Option<String>,
    effective_from: Option<DateTime<Utc>>,
    effective_until: Option<DateTime<Utc>>,
}

/// One model within a provider group. Field names mirror the `model_pricing` columns;
/// prices are null when the model has no currently-effective price row.
#[derive(Serialize, ToSchema)]
pub(crate) struct ModelEntry {
    model: String,
    input_price_per_1m: Option<f64>,
    output_price_per_1m: Option<f64>,
    cache_creation_price_per_1m: Option<f64>,
    cache_read_price_per_1m: Option<f64>,
    currency: Option<String>,
    notes: Option<String>,
    effective_from: Option<DateTime<Utc>>,
    effective_until: Option<DateTime<Utc>>,
    /// Whether a currently-effective price row backs this model. `false` ⇒ the model is
    /// served but its cost is not tracked (shown as "cost not tracked" in the UI, not $0).
    pricing_available: bool,
}

/// A provider and its models, e.g. `{ "provider": "openai", "models": [...] }`.
#[derive(Serialize, ToSchema)]
pub(crate) struct ProviderCatalog {
    provider: String,
    /// UUID of the custom provider, if this is a DB-registered custom endpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_id: Option<uuid::Uuid>,
    /// Human-friendly name of the custom provider, if this is a DB-registered custom endpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    models: Vec<ModelEntry>,
}

/// `crate::mcp::ApiResponse` envelope around a list of [`ProviderCatalog`] groups.
#[derive(Serialize, ToSchema)]
#[allow(dead_code)]
pub(crate) struct ProviderCatalogEnvelope {
    data: Vec<ProviderCatalog>,
    status_code: u16,
    message: String,
}

/// List every provider/model with a currently-effective `model_pricing` row,
/// grouped by provider. Backs the UI provider/model dropdown.
#[utoipa::path(
    get,
    path = "/api/llm-router/providers",
    tag = "llm-router",
    responses(
        (status = 200, description = "Currently-effective model catalog, grouped by provider", body = ProviderCatalogEnvelope),
        (status = 401, description = "Missing or invalid session"),
    ),
)]
pub(crate) async fn list_providers(
    State(state): State<AppState>,
    _claims: Claims,
) -> impl IntoResponse {
    // The union of served models (`provider_models`) and currently-effective priced
    // models (`model_pricing`). A served model with no price row shows with null
    // prices; a priced model that isn't in the catalog (e.g. Gemini) still shows.
    let rows = sqlx::query_as::<_, PricingRow>(
        r#"SELECT
               COALESCE(pm.provider, mp.provider) AS provider,
               COALESCE(pm.model, mp.model)       AS model,
               mp.input_price_per_1m, mp.output_price_per_1m,
               mp.cache_creation_price_per_1m, mp.cache_read_price_per_1m,
               mp.currency, mp.notes, mp.effective_from, mp.effective_until
           FROM provider_models pm
           FULL OUTER JOIN (
               SELECT DISTINCT ON (provider, model)
                   provider, model,
                   input_price_per_1m, output_price_per_1m,
                   cache_creation_price_per_1m, cache_read_price_per_1m,
                   currency, notes, effective_from, effective_until
               FROM model_pricing
               WHERE effective_from <= now()
                 AND (effective_until IS NULL OR effective_until > now())
               ORDER BY provider, model, effective_from DESC
           ) mp ON pm.provider = mp.provider AND pm.model = mp.model
           ORDER BY provider, model"#,
    )
    .fetch_all(&state.db)
    .await;

    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(%e, "list_providers: db error");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };

    // Registered custom providers are never hidden, even if their label collides with
    // a `HIDDEN_PROVIDERS` entry (e.g. an admin registers "deepseek").
    let custom_meta: std::collections::HashMap<String, (uuid::Uuid, String)> =
        match sqlx::query_as::<_, (uuid::Uuid, String, String)>(
            "SELECT id, label, display_name FROM custom_providers WHERE deleted_at IS NULL",
        )
        .fetch_all(&state.db)
        .await
        {
            Ok(rows) => rows
                .into_iter()
                .map(|(id, label, name)| (label, (id, name)))
                .collect(),
            Err(e) => {
                tracing::error!(%e, "list_providers: custom provider lookup failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
            }
        };
    let custom_labels: std::collections::HashSet<String> = custom_meta.keys().cloned().collect();

    ApiResponse::ok(
        json!(group_by_provider(rows, &custom_labels, &custom_meta)),
        "Providers retrieved successfully",
    )
    .into_response()
}

/// Collapse provider-ordered rows into per-provider groups. Relies on the query's
/// `ORDER BY provider` so each provider's rows arrive contiguously.
/// Normalize legacy provider names so the API returns a single canonical name.
fn normalize_provider(name: &str) -> &str {
    match name {
        "google" => "gemini",
        other => other,
    }
}

/// Providers hidden from the catalog until their router integration is ready. A
/// registered custom provider under one of these labels is exempt (see `custom_labels`).
const HIDDEN_PROVIDERS: &[&str] = &["groq", "deepseek"];

fn group_by_provider(
    rows: Vec<PricingRow>,
    custom_labels: &std::collections::HashSet<String>,
    custom_meta: &std::collections::HashMap<String, (uuid::Uuid, String)>,
) -> Vec<ProviderCatalog> {
    let mut out: Vec<ProviderCatalog> = Vec::new();
    for row in rows {
        let provider = normalize_provider(&row.provider).to_owned();
        // Hide built-in-but-unready providers, but never a registered custom provider.
        if HIDDEN_PROVIDERS.contains(&provider.as_str()) && !custom_labels.contains(&provider) {
            continue;
        }
        let input = row.input_price_per_1m.and_then(|d| d.to_f64());
        let output = row.output_price_per_1m.and_then(|d| d.to_f64());
        let entry = ModelEntry {
            model: row.model,
            // A price row provides both input and output; treat either present as priced.
            pricing_available: input.is_some() || output.is_some(),
            input_price_per_1m: input,
            output_price_per_1m: output,
            cache_creation_price_per_1m: row.cache_creation_price_per_1m.and_then(|d| d.to_f64()),
            cache_read_price_per_1m: row.cache_read_price_per_1m.and_then(|d| d.to_f64()),
            currency: row.currency,
            notes: row.notes,
            effective_from: row.effective_from,
            effective_until: row.effective_until,
        };
        if let Some(group) = out.iter_mut().find(|g| g.provider == provider) {
            group.models.push(entry);
        } else {
            let (provider_id, display_name) = custom_meta
                .get(&provider)
                .map(|(id, name)| (Some(*id), Some(name.clone())))
                .unwrap_or((None, None));
            out.push(ProviderCatalog {
                provider,
                provider_id,
                display_name,
                models: vec![entry],
            });
        }
    }
    out
}
