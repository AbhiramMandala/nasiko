//! Admin API for custom LLM providers (`custom_providers` table).
//!
//! An admin registers an OpenAI-compatible endpoint by Base URL + API key + default
//! model. On create the server chat-tests the endpoint, fetches its model list into
//! `provider_models` (reusing the LLM router's catalog sync — no second fetcher), and
//! the background catalog-sync loop keeps it fresh. The discovered models then flow
//! into the LLM config screen exactly like the built-in providers'.
//!
//! - `GET    /api/custom-providers`            — list (key masked). Any authenticated user.
//! - `GET    /api/custom-providers/{id}/models`— discovered models for the provider.
//! - `POST   /api/custom-providers`            — register (superuser).
//! - `PATCH  /api/custom-providers/{id}`       — update (superuser).
//! - `DELETE /api/custom-providers/{id}`       — soft delete, blocked if referenced (superuser).
//! - `POST   /api/custom-providers/{id}/sync`  — refresh the model list now (superuser).
//!
//! Encryption uses `SecretsCrypto::for_platform_settings()` — the same scope the LLM
//! router's resolver decrypts with — so a key stored here is readable on the dispatch
//! path with no key handoff.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use nasiko_secrets::SecretsCrypto;
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::Claims;
use crate::auth::rbac::require_superuser;
use crate::mcp::ApiResponse;
use crate::state::AppState;

/// Built-in provider labels a custom provider may never shadow — they route through
/// dedicated clients, so a custom row under one of these names would be unreachable
/// and would collide with the built-in dispatch path.
const RESERVED_LABELS: &[&str] = &["openai", "anthropic", "gemini"];

/// Upper bound on the chat-test probe so a slow/hung endpoint can't stall the request.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

pub fn router() -> Router<AppState> {
    // Mutations are superuser-only (platform-wide config), matching model_registry::router().
    let write = Router::new()
        .route("/custom-providers", post(create))
        .route(
            "/custom-providers/{id}",
            axum::routing::patch(update).delete(delete_provider),
        )
        .route("/custom-providers/{id}/sync", post(sync_now))
        .layer(middleware::from_fn(require_superuser));

    Router::new()
        .route("/custom-providers", get(list))
        .route("/custom-providers/{id}/models", get(list_models))
        .merge(write)
}

/// A provider row as returned to clients — never carries the api key.
#[derive(Serialize, sqlx::FromRow, ToSchema)]
pub(crate) struct ProviderView {
    pub id: Uuid,
    pub label: String,
    pub display_name: String,
    pub base_url: String,
    pub default_model: String,
    pub catalog_sync_enabled: bool,
    /// Whether an encrypted key is stored (the key itself is never returned).
    pub api_key_set: bool,
    pub last_sync_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_sync_status: Option<String>,
    pub last_sync_error: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

const VIEW_COLS: &str = "id, label, display_name, base_url, default_model, \
     catalog_sync_enabled, (encrypted_api_key <> '') AS api_key_set, \
     last_sync_at, last_sync_status, last_sync_error, created_at";

#[derive(Deserialize, ToSchema)]
pub(crate) struct CreateRequest {
    pub label: String,
    pub display_name: String,
    pub base_url: String,
    pub api_key: String,
    pub default_model: String,
    /// Model names to seed when automatic listing is unsupported (the escape hatch —
    /// see §4.1). Ignored when listing succeeds.
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default = "default_true")]
    pub catalog_sync_enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize, ToSchema)]
pub(crate) struct UpdateRequest {
    pub display_name: Option<String>,
    pub base_url: Option<String>,
    /// A new key rotates the stored credential; omitted ⇒ the existing key is kept.
    pub api_key: Option<String>,
    pub default_model: Option<String>,
    pub catalog_sync_enabled: Option<bool>,
}

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, msg.into()).into_response()
}

fn internal(context: &str, e: impl std::fmt::Display) -> Response {
    tracing::error!(%e, "custom_providers: {context}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

/// Validate a provider label: 2–40 chars, lowercase alphanumeric with internal
/// hyphens (mirrors the SQL CHECK), and not a reserved built-in name. Returns the
/// normalized label or a client-facing error message.
fn validate_label(raw: &str) -> Result<String, String> {
    let label = raw.trim().to_ascii_lowercase();
    let bytes = label.as_bytes();
    let shaped = (2..=40).contains(&label.len())
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && bytes.first().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.last().is_some_and(|b| b.is_ascii_alphanumeric());
    if !shaped {
        return Err("label must be 2–40 chars: lowercase letters, digits, internal hyphens".into());
    }
    if RESERVED_LABELS.contains(&label.as_str()) {
        return Err(format!("'{label}' is a reserved built-in provider name"));
    }
    Ok(label)
}

/// Chat-test the endpoint with one tiny `POST /chat/completions`. `GET /models`
/// answering proves nothing about chat, and a later parse error is non-retryable
/// (hard 500), so a failed test is a create-time 400. Returns a client-facing reason
/// on failure.
async fn probe_chat(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<(), String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let resp = http
        .post(&url)
        .bearer_auth(api_key)
        .timeout(PROBE_TIMEOUT)
        .json(&json!({
            "model": model,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 1,
        }))
        .send()
        .await
        .map_err(|e| format!("chat test request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "chat test returned {status}: {}",
            body_snippet(&body)
        ));
    }
    // The reply must parse as a JSON object carrying `choices` (the OpenAI shape our
    // provider client relies on) — a 200 with an unparseable body would otherwise
    // surface later as a non-retryable 500.
    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(v) if v.get("choices").is_some() => Ok(()),
        Ok(_) => Err("chat test reply did not contain `choices` (not OpenAI-compatible)".into()),
        Err(e) => Err(format!("chat test reply was not valid JSON: {e}")),
    }
}

/// First 200 chars of an upstream error body, for a client-facing message.
fn body_snippet(body: &str) -> String {
    body.chars().take(200).collect()
}

/// List all active custom providers (keys masked). Any authenticated user, so the
/// LLM config screen can populate its provider selector.
pub(crate) async fn list(State(state): State<AppState>, _claims: Claims) -> Response {
    let rows = sqlx::query_as::<_, ProviderView>(&format!(
        "SELECT {VIEW_COLS} FROM custom_providers WHERE deleted_at IS NULL ORDER BY display_name"
    ))
    .fetch_all(&state.db)
    .await;
    match rows {
        Ok(r) => ApiResponse::ok(json!(r), "Custom providers retrieved").into_response(),
        Err(e) => internal("list", e),
    }
}

/// The discovered models for one provider (from `provider_models`, keyed by label).
pub(crate) async fn list_models(
    State(state): State<AppState>,
    _claims: Claims,
    Path(id): Path<Uuid>,
) -> Response {
    let label: Option<(String,)> = match sqlx::query_as(
        "SELECT label FROM custom_providers WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal("list_models label lookup", e),
    };
    let Some((label,)) = label else {
        return err(StatusCode::NOT_FOUND, "no such custom provider");
    };
    let models: Result<Vec<(String,)>, _> =
        sqlx::query_as("SELECT model FROM provider_models WHERE provider = $1 ORDER BY model")
            .bind(&label)
            .fetch_all(&state.db)
            .await;
    match models {
        Ok(rows) => {
            let models: Vec<String> = rows.into_iter().map(|(m,)| m).collect();
            ApiResponse::ok(json!({ "models": models }), "Models retrieved").into_response()
        }
        Err(e) => internal("list_models", e),
    }
}

/// Register a custom provider. Superuser only.
pub(crate) async fn create(
    State(state): State<AppState>,
    claims: Claims,
    Json(body): Json<CreateRequest>,
) -> Response {
    // 1. Validate the name (shape + reserved), and the required fields.
    let label = match validate_label(&body.label) {
        Ok(l) => l,
        Err(msg) => return err(StatusCode::BAD_REQUEST, msg),
    };
    let display_name = body.display_name.trim();
    let base_url = body.base_url.trim().trim_end_matches('/');
    let default_model = body.default_model.trim();
    if display_name.is_empty() || base_url.is_empty() || default_model.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "display_name, base_url and default_model are required",
        );
    }
    if body.api_key.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "api_key is required");
    }

    // 2. Chat-test the endpoint with the chosen default model — a hard 400 on failure.
    if let Err(reason) =
        probe_chat(&state.http_client, base_url, &body.api_key, default_model).await
    {
        return err(
            StatusCode::BAD_REQUEST,
            format!("endpoint check failed: {reason}"),
        );
    }

    // 3. Store the row (encrypting the key under the platform-settings scope).
    let encrypted = SecretsCrypto::for_platform_settings().encrypt(body.api_key.trim());
    let created_by = match claims.user_uuid() {
        Ok(u) => u,
        Err((status, msg)) => return err(status, msg),
    };
    let inserted: Result<(Uuid,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO custom_providers \
           (label, display_name, base_url, encrypted_api_key, default_model, \
            catalog_sync_enabled, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(&label)
    .bind(display_name)
    .bind(base_url)
    .bind(&encrypted)
    .bind(default_model)
    .bind(body.catalog_sync_enabled)
    .bind(created_by)
    .fetch_one(&state.db)
    .await;

    let id = match inserted {
        Ok((id,)) => id,
        Err(sqlx::Error::Database(dbe)) if dbe.is_unique_violation() => {
            return err(
                StatusCode::CONFLICT,
                format!("provider '{label}' already exists"),
            );
        }
        Err(e) => return internal("create insert", e),
    };

    // 4. Fetch the model list (reusing the catalog sync). On success, validate the
    //    default model is one of them; on an unsupported listing, accept manual names.
    let discovered =
        match nasiko_llm_router::routing::catalog::sync_one(&state.db, &state.http_client, &label)
            .await
        {
            Ok(n) => n,
            Err(e) => {
                // The row exists but the catalog write failed — leave it; the sweep retries.
                tracing::warn!(%e, %label, "custom_providers: initial catalog sync failed");
                0
            }
        };

    let discovered = if discovered == 0 {
        // Listing unsupported/failed: seed any manually-entered model names so the
        // rest of the pipeline behaves identically.
        seed_manual_models(&state.db, &label, &body.models).await
    } else {
        // Listing succeeded: the default model must be one it actually serves.
        if !model_in_catalog(&state.db, &label, default_model).await {
            let _ = sqlx::query("DELETE FROM custom_providers WHERE id = $1")
                .bind(id)
                .execute(&state.db)
                .await;
            return err(
                StatusCode::BAD_REQUEST,
                format!("default_model '{default_model}' is not served by this endpoint"),
            );
        }
        discovered
    };

    ApiResponse::created(
        json!({ "id": id, "label": label, "discovered_models": discovered }),
        "Custom provider registered",
    )
    .into_response()
}

/// Write manually-entered model names into `provider_models`, returning how many were
/// stored. Used when the endpoint's `/models` listing is unsupported.
async fn seed_manual_models(db: &sqlx::PgPool, label: &str, models: &[String]) -> usize {
    let names: Vec<String> = models
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect();
    if names.is_empty() {
        return 0;
    }
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    match sqlx::query(
        "INSERT INTO provider_models (provider, model, last_seen_at) \
         SELECT $1, m, now() FROM unnest($2::text[]) AS m \
         ON CONFLICT (provider, model) DO UPDATE SET last_seen_at = now()",
    )
    .bind(label)
    .bind(&refs)
    .execute(db)
    .await
    {
        Ok(_) => names.len(),
        Err(e) => {
            tracing::warn!(%e, %label, "custom_providers: manual model seed failed");
            0
        }
    }
}

/// Whether `model` appears in the provider's live catalog.
async fn model_in_catalog(db: &sqlx::PgPool, label: &str, model: &str) -> bool {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM provider_models WHERE provider = $1 AND model = $2)",
    )
    .bind(label)
    .bind(model)
    .fetch_one(db)
    .await
    .unwrap_or(false)
}

/// Update a custom provider. Superuser only. A provided `api_key` rotates the stored
/// credential; the resolver reads the row per request, so a rotation takes effect on
/// the next call with no restart.
pub(crate) async fn update(
    State(state): State<AppState>,
    _claims: Claims,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateRequest>,
) -> Response {
    // COALESCE keeps the existing value for any field left null; the key is
    // re-encrypted only when a new one is supplied.
    let encrypted = body
        .api_key
        .as_deref()
        .map(|k| SecretsCrypto::for_platform_settings().encrypt(k.trim()));
    let base_url = body
        .base_url
        .as_deref()
        .map(|b| b.trim().trim_end_matches('/').to_string());
    let result = sqlx::query(
        "UPDATE custom_providers SET \
           display_name = COALESCE($2, display_name), \
           base_url = COALESCE($3, base_url), \
           encrypted_api_key = COALESCE($4, encrypted_api_key), \
           default_model = COALESCE($5, default_model), \
           catalog_sync_enabled = COALESCE($6, catalog_sync_enabled) \
         WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(body.display_name.as_deref().map(str::trim))
    .bind(base_url)
    .bind(encrypted)
    .bind(body.default_model.as_deref().map(str::trim))
    .bind(body.catalog_sync_enabled)
    .execute(&state.db)
    .await;
    match result {
        Ok(r) if r.rows_affected() == 0 => err(StatusCode::NOT_FOUND, "no such custom provider"),
        Ok(_) => ApiResponse::ok(json!({ "id": id }), "Custom provider updated").into_response(),
        Err(e) => internal("update", e),
    }
}

/// Soft-delete a custom provider. Blocked (409) while any `llm_configs` row still
/// names it — a dangling provider name would make the resolver fail on the next call.
pub(crate) async fn delete_provider(
    State(state): State<AppState>,
    _claims: Claims,
    Path(id): Path<Uuid>,
) -> Response {
    let label: Option<(String,)> = match sqlx::query_as(
        "SELECT label FROM custom_providers WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal("delete label lookup", e),
    };
    let Some((label,)) = label else {
        return err(StatusCode::NOT_FOUND, "no such custom provider");
    };

    // Referential block: list the configs that still point at this provider.
    let refs: Vec<(String,)> = match sqlx::query_as(
        "SELECT name FROM llm_configs WHERE provider = $1 AND deleted_at IS NULL ORDER BY name",
    )
    .bind(&label)
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal("delete ref check", e),
    };
    if !refs.is_empty() {
        let names: Vec<String> = refs.into_iter().map(|(n,)| n).collect();
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "message": "provider is still referenced by LLM configs; repoint them first",
                "referencing_configs": names,
            })),
        )
            .into_response();
    }

    // Soft-delete the row and drop its catalog rows so the label stops appearing as a
    // phantom provider in the model dropdown.
    if let Err(e) = sqlx::query("UPDATE custom_providers SET deleted_at = now() WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await
    {
        return internal("delete soft-delete", e);
    }
    let _ = sqlx::query("DELETE FROM provider_models WHERE provider = $1")
        .bind(&label)
        .execute(&state.db)
        .await;
    ApiResponse::ok(json!({ "id": id }), "Custom provider deleted").into_response()
}

/// Refresh one provider's model list on demand. Superuser only.
pub(crate) async fn sync_now(
    State(state): State<AppState>,
    _claims: Claims,
    Path(id): Path<Uuid>,
) -> Response {
    let label: Option<(String,)> = match sqlx::query_as(
        "SELECT label FROM custom_providers WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal("sync label lookup", e),
    };
    let Some((label,)) = label else {
        return err(StatusCode::NOT_FOUND, "no such custom provider");
    };
    match nasiko_llm_router::routing::catalog::sync_one(&state.db, &state.http_client, &label).await
    {
        Ok(n) => {
            ApiResponse::ok(json!({ "discovered_models": n }), "Sync complete").into_response()
        }
        Err(e) => internal("sync", e),
    }
}
