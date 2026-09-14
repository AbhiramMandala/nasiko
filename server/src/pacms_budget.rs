use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use nasiko_orchestrator::PacmsBudgetLevel;
use serde::{Deserialize, Serialize};

use crate::auth::Claims;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/me/pacms-budget",
        get(get_pacms_budget).patch(update_pacms_budget),
    )
}

#[derive(Debug, Serialize)]
struct PacmsBudgetResponse {
    level: PacmsBudgetLevel,
}

#[derive(Debug, Deserialize)]
struct PacmsBudgetUpdate {
    level: PacmsBudgetLevel,
}

async fn get_pacms_budget(State(state): State<AppState>, claims: Claims) -> impl IntoResponse {
    let user_id = match claims.user_uuid() {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let level = PacmsBudgetLevel::for_user(&state.db, user_id).await;
    Json(PacmsBudgetResponse { level }).into_response()
}

async fn update_pacms_budget(
    State(state): State<AppState>,
    claims: Claims,
    Json(body): Json<PacmsBudgetUpdate>,
) -> impl IntoResponse {
    let user_id = match claims.user_uuid() {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let result = sqlx::query("UPDATE users SET pacms_budget_level = $1 WHERE id = $2")
        .bind(body.level)
        .bind(user_id)
        .execute(&state.db)
        .await;

    match result {
        Ok(_) => Json(PacmsBudgetResponse { level: body.level }).into_response(),
        Err(e) => {
            tracing::error!(%e, "update_pacms_budget: db error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}
