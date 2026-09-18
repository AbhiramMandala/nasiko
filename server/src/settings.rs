use axum::{
    Json, Router, extract::State, http::StatusCode, middleware, response::IntoResponse,
    routing::get,
};
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::auth::rbac::require_superuser;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    let write_settings = Router::new()
        .route("/settings", axum::routing::put(update_settings))
        .layer(middleware::from_fn(require_superuser));

    Router::new()
        .route("/settings", get(get_settings))
        .merge(write_settings)
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Settings {
    pub router_model: Option<String>,
    pub default_provider: Option<String>,
    pub max_flow_depth: Option<i32>,
    pub max_flow_fan_out: Option<i32>,
    pub max_flow_tokens: Option<i64>,
    pub flow_timeout_secs: Option<i32>,
    pub registry_url: Option<String>,
    /// Comma-separated tag names pinning the agent-catalog tab list.
    /// Unset/empty → the UI derives tabs from the most common agent tags.
    pub catalog_tabs: Option<String>,
    /// Percentage (0-100) an agent match must reach before either orchestrator
    /// is allowed to delegate to it. NULL → `DEFAULT_MIN_CONFIDENCE`.
    pub orchestrator_min_confidence: Option<i32>,
    /// Master switch for the `orchestrator_rules` set. Off → no rules are
    /// injected into either orchestrator's system prompt.
    pub orchestrator_rules_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SettingsUpdate {
    pub router_model: Option<String>,
    pub default_provider: Option<String>,
    pub max_flow_depth: Option<i32>,
    pub max_flow_fan_out: Option<i32>,
    pub max_flow_tokens: Option<i64>,
    pub flow_timeout_secs: Option<i32>,
    pub registry_url: Option<String>,
    pub catalog_tabs: Option<String>,
    pub orchestrator_min_confidence: Option<i32>,
    pub orchestrator_rules_enabled: Option<bool>,
}

async fn get_settings(State(state): State<AppState>, _claims: Claims) -> impl IntoResponse {
    let row = sqlx::query_as::<_, Settings>(
        r#"SELECT
            router_model, default_provider, max_flow_depth,
            max_flow_fan_out, max_flow_tokens, flow_timeout_secs,
            registry_url, catalog_tabs,
            orchestrator_min_confidence, orchestrator_rules_enabled
        FROM settings LIMIT 1"#,
    )
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(s)) => Json(s).into_response(),
        Ok(None) => Json(Settings {
            router_model: Some("deepseek-v4-pro".into()),
            default_provider: Some("openai".into()),
            max_flow_depth: Some(5),
            max_flow_fan_out: Some(20),
            max_flow_tokens: Some(100000),
            flow_timeout_secs: Some(120),
            registry_url: None,
            catalog_tabs: None,
            orchestrator_min_confidence: Some(nasiko_orchestrator::DEFAULT_MIN_CONFIDENCE as i32),
            orchestrator_rules_enabled: Some(false),
        })
        .into_response(),
        Err(e) => {
            tracing::error!(%e, "get_settings: db error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

async fn update_settings(
    State(state): State<AppState>,
    _claims: Claims,
    Json(body): Json<SettingsUpdate>,
) -> impl IntoResponse {
    if let Some(c) = body.orchestrator_min_confidence
        && !(0..=100).contains(&c)
    {
        return (
            StatusCode::BAD_REQUEST,
            "orchestrator_min_confidence must be between 0 and 100",
        )
            .into_response();
    }

    let result = sqlx::query_as::<_, Settings>(
        r#"INSERT INTO settings (
               id, router_model, default_provider, max_flow_depth, max_flow_fan_out,
               max_flow_tokens, flow_timeout_secs, registry_url, catalog_tabs,
               orchestrator_min_confidence, orchestrator_rules_enabled
           )
           VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, false))
           ON CONFLICT (id) DO UPDATE SET
             router_model = EXCLUDED.router_model,
             default_provider = EXCLUDED.default_provider,
             max_flow_depth = EXCLUDED.max_flow_depth,
             max_flow_fan_out = EXCLUDED.max_flow_fan_out,
             max_flow_tokens = EXCLUDED.max_flow_tokens,
             flow_timeout_secs = EXCLUDED.flow_timeout_secs,
             registry_url = EXCLUDED.registry_url,
             catalog_tabs = EXCLUDED.catalog_tabs,
             orchestrator_min_confidence = EXCLUDED.orchestrator_min_confidence,
             orchestrator_rules_enabled = EXCLUDED.orchestrator_rules_enabled
           RETURNING
             router_model, default_provider, max_flow_depth, max_flow_fan_out,
             max_flow_tokens, flow_timeout_secs, registry_url, catalog_tabs,
             orchestrator_min_confidence, orchestrator_rules_enabled"#,
    )
    .bind(&body.router_model)
    .bind(&body.default_provider)
    .bind(body.max_flow_depth)
    .bind(body.max_flow_fan_out)
    .bind(body.max_flow_tokens)
    .bind(body.flow_timeout_secs)
    .bind(&body.registry_url)
    .bind(&body.catalog_tabs)
    .bind(body.orchestrator_min_confidence)
    .bind(body.orchestrator_rules_enabled)
    .fetch_one(&state.db)
    .await;

    match result {
        Ok(s) => Json(s).into_response(),
        Err(e) => {
            tracing::error!(%e, "update_settings: db error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}
