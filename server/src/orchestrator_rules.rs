//! Organization-wide orchestrator guardrails: the delegation confidence bar and
//! the operator-authored rules injected into both orchestrators' system prompts.
//!
//! This module is the HTTP surface only. The read path both orchestrators share
//! — resolving defaults, gating on the toggle, formatting the prompt block —
//! lives in `nasiko_orchestrator::guardrails`, which sits low enough in the
//! dependency graph for the MAF selector to reach it too.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::IntoResponse,
    routing::get,
};
use nasiko_orchestrator::guardrails::{self, OrchestratorRule};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::Claims;
use crate::auth::rbac::require_superuser;
use crate::state::AppState;

// ── Rules CRUD ────────────────────────────────────────────────────────────────

/// Every rule is rendered into both orchestrators' system prompt on every
/// single request (`nasiko_orchestrator::guardrails::format_rules`), so an
/// unbounded rule set is an unbounded per-request cost, not just a large
/// settings table. Generous enough that no real operator hits it by accident;
/// low enough to bound the worst case.
const MAX_RULE_NAME_CHARS: usize = 50;
const MAX_RULE_DESCRIPTION_CHARS: usize = 500;
const MAX_RULES: i64 = 50;

#[derive(Debug, Deserialize)]
pub struct RuleUpsert {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub position: i32,
}

pub fn router() -> Router<AppState> {
    let writes = Router::new()
        .route("/orchestrator/rules", axum::routing::post(create_rule))
        .route(
            "/orchestrator/rules/{id}",
            axum::routing::put(update_rule).delete(delete_rule),
        )
        .layer(middleware::from_fn(require_superuser));

    Router::new()
        .route("/orchestrator/rules", get(list_rules))
        .merge(writes)
}

async fn list_rules(State(state): State<AppState>, _claims: Claims) -> impl IntoResponse {
    match guardrails::fetch_rules(&state.db).await {
        Ok(rules) => Json(rules).into_response(),
        Err(e) => {
            tracing::error!(%e, "list_rules: db error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

/// Reject blank name/description before they reach the prompt: an empty rule
/// renders as a dangling "- : " bullet in the orchestrator's system prompt,
/// which is noise the model has to reason past on every single request. Also
/// caps their length, for the same reason `MAX_RULES` caps the count.
fn validate(body: &RuleUpsert) -> Result<(), Response> {
    if body.name.trim().is_empty() || body.description.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "name and description are both required",
        )
            .into_response());
    }
    if body.name.trim().chars().count() > MAX_RULE_NAME_CHARS {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("name must be {MAX_RULE_NAME_CHARS} characters or fewer"),
        )
            .into_response());
    }
    if body.description.trim().chars().count() > MAX_RULE_DESCRIPTION_CHARS {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("description must be {MAX_RULE_DESCRIPTION_CHARS} characters or fewer"),
        )
            .into_response());
    }
    Ok(())
}

type Response = axum::response::Response;

async fn create_rule(
    State(state): State<AppState>,
    _claims: Claims,
    Json(body): Json<RuleUpsert>,
) -> impl IntoResponse {
    if let Err(resp) = validate(&body) {
        return resp;
    }
    match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orchestrator_rules")
        .fetch_one(&state.db)
        .await
    {
        Ok(count) if count >= MAX_RULES => {
            return (
                StatusCode::BAD_REQUEST,
                format!("at most {MAX_RULES} rules are allowed; delete one before adding another"),
            )
                .into_response();
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!(%e, "create_rule: db error counting existing rules");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    }
    let result = sqlx::query_as::<_, OrchestratorRule>(
        "INSERT INTO orchestrator_rules (name, description, position) \
         VALUES ($1, $2, $3) RETURNING id, name, description, position",
    )
    .bind(body.name.trim())
    .bind(body.description.trim())
    .bind(body.position)
    .fetch_one(&state.db)
    .await;

    match result {
        Ok(rule) => (StatusCode::CREATED, Json(rule)).into_response(),
        Err(e) => {
            tracing::error!(%e, "create_rule: db error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

async fn update_rule(
    State(state): State<AppState>,
    _claims: Claims,
    Path(id): Path<Uuid>,
    Json(body): Json<RuleUpsert>,
) -> impl IntoResponse {
    if let Err(resp) = validate(&body) {
        return resp;
    }
    let result = sqlx::query_as::<_, OrchestratorRule>(
        "UPDATE orchestrator_rules \
         SET name = $2, description = $3, position = $4, updated_at = now() \
         WHERE id = $1 RETURNING id, name, description, position",
    )
    .bind(id)
    .bind(body.name.trim())
    .bind(body.description.trim())
    .bind(body.position)
    .fetch_optional(&state.db)
    .await;

    match result {
        Ok(Some(rule)) => Json(rule).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "no such rule").into_response(),
        Err(e) => {
            tracing::error!(%e, "update_rule: db error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

async fn delete_rule(
    State(state): State<AppState>,
    _claims: Claims,
    Path(id): Path<Uuid>,
) -> impl IntoResponse {
    let result = sqlx::query("DELETE FROM orchestrator_rules WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await;

    match result {
        Ok(r) if r.rows_affected() == 0 => (StatusCode::NOT_FOUND, "no such rule").into_response(),
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!(%e, "delete_rule: db error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upsert(name: &str, description: &str) -> RuleUpsert {
        RuleUpsert {
            name: name.to_string(),
            description: description.to_string(),
            position: 0,
        }
    }

    #[test]
    fn a_normal_rule_is_valid() {
        assert!(validate(&upsert("No PII", "Never forward customer data.")).is_ok());
    }

    #[test]
    fn an_empty_name_is_rejected() {
        let err = validate(&upsert("", "some description")).unwrap_err();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn a_whitespace_only_name_is_rejected() {
        let err = validate(&upsert("   ", "some description")).unwrap_err();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn an_empty_description_is_rejected() {
        let err = validate(&upsert("a name", "")).unwrap_err();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn a_name_at_the_cap_is_valid() {
        let name = "a".repeat(MAX_RULE_NAME_CHARS);
        assert!(validate(&upsert(&name, "description")).is_ok());
    }

    #[test]
    fn a_name_over_the_cap_is_rejected() {
        let name = "a".repeat(MAX_RULE_NAME_CHARS + 1);
        let err = validate(&upsert(&name, "description")).unwrap_err();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn a_description_at_the_cap_is_valid() {
        let description = "a".repeat(MAX_RULE_DESCRIPTION_CHARS);
        assert!(validate(&upsert("name", &description)).is_ok());
    }

    #[test]
    fn a_description_over_the_cap_is_rejected() {
        let description = "a".repeat(MAX_RULE_DESCRIPTION_CHARS + 1);
        let err = validate(&upsert("name", &description)).unwrap_err();
        assert_eq!(err.status(), StatusCode::BAD_REQUEST);
    }
}
