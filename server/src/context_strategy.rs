use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use nasiko_orchestrator::ContextSelectionStrategy;
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/me/context-strategy",
        get(get_context_strategy).patch(update_context_strategy),
    )
}

#[derive(Debug, Serialize)]
struct ContextStrategyResponse {
    strategy: ContextSelectionStrategy,
}

#[derive(Debug, Deserialize)]
struct ContextStrategyUpdate {
    strategy: ContextSelectionStrategy,
}

async fn get_context_strategy(State(state): State<AppState>, claims: Claims) -> impl IntoResponse {
    let user_id = match claims.user_uuid() {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let strategy = ContextSelectionStrategy::for_user(&state.db, user_id).await;
    Json(ContextStrategyResponse { strategy }).into_response()
}

async fn update_context_strategy(
    State(state): State<AppState>,
    claims: Claims,
    Json(body): Json<ContextStrategyUpdate>,
) -> impl IntoResponse {
    let user_id = match claims.user_uuid() {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let result = sqlx::query("UPDATE users SET context_selection_strategy = $1 WHERE id = $2")
        .bind(body.strategy)
        .bind(user_id)
        .execute(&state.db)
        .await;

    match result {
        Ok(_) => Json(ContextStrategyResponse {
            strategy: body.strategy,
        })
        .into_response(),
        Err(e) => {
            tracing::error!(%e, "update_context_strategy: db error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}
