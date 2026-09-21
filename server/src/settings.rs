use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    // Write route requires admin role — the middleware is applied here so the
    // state is available when the router is merged into the app.
    let write_settings = Router::new().route("/settings", axum::routing::put(update_settings));

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
}

async fn get_settings(State(state): State<AppState>, _claims: Claims) -> impl IntoResponse {
    let row = sqlx::query_as::<_, Settings>(
        r#"SELECT
            router_model, default_provider, max_flow_depth,
            max_flow_fan_out, max_flow_tokens, flow_timeout_secs,
            registry_url, catalog_tabs
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
    claims: Claims,
    Json(body): Json<SettingsUpdate>,
) -> impl IntoResponse {
    let identity: nasiko_auth::Identity = claims.into();
    if !state.auth.can_manage_users(&identity).await {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "requires admin role"})),
        )
            .into_response();
    }
    let result = sqlx::query_as::<_, Settings>(
        r#"INSERT INTO settings (
               id, router_model, default_provider, max_flow_depth, max_flow_fan_out,
               max_flow_tokens, flow_timeout_secs, registry_url, catalog_tabs
           )
           VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             router_model = EXCLUDED.router_model,
             default_provider = EXCLUDED.default_provider,
             max_flow_depth = EXCLUDED.max_flow_depth,
             max_flow_fan_out = EXCLUDED.max_flow_fan_out,
             max_flow_tokens = EXCLUDED.max_flow_tokens,
             flow_timeout_secs = EXCLUDED.flow_timeout_secs,
             registry_url = EXCLUDED.registry_url,
             catalog_tabs = EXCLUDED.catalog_tabs
           RETURNING
             router_model, default_provider, max_flow_depth, max_flow_fan_out,
             max_flow_tokens, flow_timeout_secs, registry_url, catalog_tabs"#,
    )
    .bind(&body.router_model)
    .bind(&body.default_provider)
    .bind(body.max_flow_depth)
    .bind(body.max_flow_fan_out)
    .bind(body.max_flow_tokens)
    .bind(body.flow_timeout_secs)
    .bind(&body.registry_url)
    .bind(&body.catalog_tabs)
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
