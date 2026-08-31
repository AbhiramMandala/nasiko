//! Human-in-the-loop resolve API — `GET /api/hitl/pending`, `POST /api/hitl/{id}/resolve`.
//!
//! Thin Axum layer over `nasiko_hitl`'s plain-function store: extract identity, authorize by
//! `owner_user_id` (the sole rule for every `HitlKind`, per the HITL plan), call the store, shape
//! the response. Deliberately generic across `origin` — MCP's `mcp_tool` rows are the only ones
//! populated today, but nothing here is MCP-specific, so `direct_chat`/`orchestrator`/`maf` rows
//! (once those teams build against the same `hitl_requests` table) resolve through this same API.
//!
//! Out of scope here (left for later milestones, per the M5 brief): the resume dispatcher, any
//! automatic retry/push once a row resolves, session-scoped grants, and "allow once" retry
//! matching — this module only makes a persisted row's `pending -> resolved/rejected` transition
//! reachable by an authorized human. Nothing downstream reacts to that transition yet.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use nasiko_hitl::{HitlKind, HitlRequest, HitlStatus, ResolveDecision};

use crate::auth::Claims;
use crate::mcp::ApiResponse;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/hitl/pending", get(list_pending))
        .route("/hitl/{id}/resolve", post(resolve))
}

/// Response shape for a `hitl_requests` row. `HitlRequest` is deliberately not
/// `Serialize` (see its own doc comment — it's a DB row mirror, not a wire
/// type), so this is the seam that DTO is meant to force: `resume_state` (an
/// internal dispatcher field) and `resume_claimed_at`/`resume_dispatch_attempts`/
/// `resume_last_error` (dispatcher lease bookkeeping) are deliberately omitted.
#[derive(Debug, Serialize)]
struct HitlRequestView {
    id: Uuid,
    kind: &'static str,
    origin: &'static str,
    status: &'static str,
    agent_id: Uuid,
    owner_user_id: Uuid,
    resolved_by: Option<Uuid>,
    context_id: Option<String>,
    connector_id: Option<Uuid>,
    tool_name: Option<String>,
    question: serde_json::Value,
    human_response: Option<serde_json::Value>,
    created_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    resolved_at: Option<DateTime<Utc>>,
}

impl From<HitlRequest> for HitlRequestView {
    fn from(r: HitlRequest) -> Self {
        Self {
            id: r.id,
            kind: r.kind.as_str(),
            origin: r.origin.as_str(),
            status: r.status.as_str(),
            agent_id: r.agent_id,
            owner_user_id: r.owner_user_id,
            resolved_by: r.resolved_by,
            context_id: r.context_id,
            connector_id: r.connector_id,
            tool_name: r.tool_name,
            question: r.question,
            human_response: r.human_response,
            created_at: r.created_at,
            expires_at: r.expires_at,
            resolved_at: r.resolved_at,
        }
    }
}

/// The caller's own pending HITL requests, newest first — regardless of `kind`/`origin`.
async fn list_pending(State(state): State<AppState>, claims: Claims) -> Response {
    let user_id = match claims.user_uuid() {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match nasiko_hitl::repo::list_pending_for(&state.db, user_id).await {
        Ok(rows) => {
            let views: Vec<HitlRequestView> = rows.into_iter().map(Into::into).collect();
            ApiResponse::ok(json!(views), "Pending HITL requests retrieved").into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, %user_id, "list_pending: hitl store error");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Decision {
    Approve,
    Reject,
}

/// The finalized three-action `tool_approval` dialog's two "allow" flavors —
/// `deny` needs no scope of its own, hence `Scope` is only ever read when
/// `decision = approve`. There is deliberately no `always`/permanent-allow
/// variant.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Scope {
    Once,
    Session,
}

#[derive(Debug, Deserialize)]
struct ResolveRequest {
    decision: Decision,
    /// Only meaningful when `decision = approve`; ignored for `reject`.
    /// Defaults to `once` when omitted, so existing callers that never send
    /// `scope` keep their prior single-use behavior unchanged. `session` is
    /// only valid for a `kind = tool_approval` request — the grant table it
    /// populates (`mcp_session_tool_grants`) has no meaning for `auth_required`.
    #[serde(default)]
    scope: Option<Scope>,
    /// Free-form, audit-only note from the human — stored verbatim in
    /// `human_response`, never interpreted by this handler.
    #[serde(default)]
    note: Option<String>,
}

/// Resolve (approve) or reject a pending request the caller owns.
///
/// Transitions `pending -> resolved`/`rejected` and, for an `approve` with
/// `scope=session` on a `tool_approval` request, additionally records a
/// `mcp_session_tool_grants` row (M7) so the agent's retry — and every
/// subsequent call to the same tool in the same conversation, until the
/// grant expires — can proceed without asking again. It does not itself
/// retry the paused tool call or push anything to the agent; that is the
/// resume dispatcher's job (M6, already wired) plus the retry-matching
/// lookup in `mcp-gateway`'s `handle_tools_call` (M7) that actually consumes
/// this resolution.
async fn resolve(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<Uuid>,
    Json(body): Json<ResolveRequest>,
) -> Response {
    let user_id = match claims.user_uuid() {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let existing = match nasiko_hitl::repo::get_by_id(&state.db, id).await {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "no such HITL request").into_response(),
        Err(e) => {
            tracing::error!(error = %e, %id, "resolve: hitl store error on lookup");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };

    if !nasiko_hitl::authorize_hitl_action(&existing, user_id) {
        return (
            StatusCode::FORBIDDEN,
            "you do not have permission to resolve this request",
        )
            .into_response();
    }

    if existing.status != HitlStatus::Pending {
        return (StatusCode::CONFLICT, "this request is no longer pending").into_response();
    }

    let scope = body.scope.unwrap_or(Scope::Once);
    if matches!(body.decision, Decision::Approve)
        && scope == Scope::Session
        && existing.kind != HitlKind::ToolApproval
    {
        return (
            StatusCode::BAD_REQUEST,
            "scope=session only applies to tool_approval requests",
        )
            .into_response();
    }

    let (decision, decision_label) = match body.decision {
        Decision::Approve => (ResolveDecision::Approve, "approve"),
        Decision::Reject => (ResolveDecision::Reject, "reject"),
    };
    let scope_label = matches!(body.decision, Decision::Approve).then(|| match scope {
        Scope::Once => "once",
        Scope::Session => "session",
    });
    let human_response =
        json!({ "decision": decision_label, "scope": scope_label, "note": body.note });

    match nasiko_hitl::repo::resolve(&state.db, id, decision, user_id, human_response).await {
        Ok(Some(row)) => {
            if matches!(body.decision, Decision::Approve) && scope == Scope::Session {
                grant_session_scope(&state, &row, user_id).await;
            }
            ApiResponse::ok(json!(HitlRequestView::from(row)), "Request resolved").into_response()
        }
        // Lost the race against a concurrent resolve — the pre-check above already
        // covers the common case; this is the atomic UPDATE's own guarantee.
        Ok(None) => (StatusCode::CONFLICT, "this request is no longer pending").into_response(),
        Err(e) => {
            tracing::error!(error = %e, %id, "resolve: hitl store error on update");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

/// Best-effort: record the `mcp_session_tool_grants` row an approved
/// `scope=session` decision promises. `connector_id`/`tool_name`/`context_id`
/// are guaranteed present by `chk_hitl_tool_approval_identity` for any
/// `kind=tool_approval` row, which the caller has already confirmed `row`
/// is. A failure here is logged but never turned into an error response —
/// the resolution itself already succeeded and is the authoritative outcome;
/// worst case the agent's retry finds no grant and gets asked again, which
/// is safe (never silently over-permissive), just not maximally convenient.
async fn grant_session_scope(state: &AppState, row: &HitlRequest, granted_by: Uuid) {
    let (Some(connector_id), Some(tool_name), Some(context_id)) = (
        row.connector_id,
        row.tool_name.clone(),
        row.context_id.clone(),
    ) else {
        tracing::error!(
            id = %row.id,
            "resolve: scope=session approved but tool_approval identity fields are missing — \
             this should be impossible under chk_hitl_tool_approval_identity"
        );
        return;
    };

    if let Err(e) = nasiko_hitl::repo::create_session_grant(
        &state.db,
        nasiko_hitl::NewSessionGrant {
            agent_id: row.agent_id,
            connector_id,
            tool_name,
            context_id,
            granted_by,
            hitl_request_id: Some(row.id),
        },
    )
    .await
    {
        tracing::error!(error = %e, id = %row.id, "resolve: failed to create session grant");
    }
}
