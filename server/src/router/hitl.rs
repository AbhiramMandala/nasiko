//! HITL human-facing API (`docs/HITL_IMPLEMENTATION_PLAN.md` §11): `GET /api/hitl/pending`,
//! `GET /api/hitl/{id}`, `POST /api/hitl/{id}/resolve`, `POST /api/hitl/{id}/cancel`,
//! `GET /api/hitl/{id}/stream`.

use std::convert::Infallible;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use utoipa::ToSchema;
use uuid::Uuid;

use nasiko_hitl::{
    HitlAction, HitlIdentity, HitlKind, HitlRequest, HitlStatus, ResolveOutcome, ResumeStatus,
    authorize_hitl_action,
};

use crate::auth::Claims;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/hitl/pending", get(list_pending))
        .route("/hitl/{id}", get(get_one))
        .route("/hitl/{id}/resolve", post(resolve))
        .route("/hitl/{id}/cancel", post(cancel))
        .route("/hitl/{id}/stream", get(stream_one))
}

/// Covers every `HitlKind`'s resolve shape: `answer` for `input_required`, `auth_action` for
/// `auth_required`'s two-click start/confirm, `decision`/`scope`/`note` for `tool_approval`'s
/// approve-once/approve-session/reject. `message` is unused — reserved, not yet part of any kind's
/// contract.
#[derive(Deserialize, ToSchema)]
pub(crate) struct HitlResolveRequest {
    answer: Option<String>,
    auth_action: Option<String>,
    decision: Option<String>,
    scope: Option<String>,
    /// Free-form, audit-only note from the human — stored verbatim in `human_response` for
    /// `tool_approval`, never interpreted by this handler.
    note: Option<String>,
    #[allow(dead_code)]
    message: Option<String>,
}

fn identity(claims: &Claims) -> Result<HitlIdentity, (StatusCode, &'static str)> {
    let user_id = claims.user_uuid()?;
    Ok(HitlIdentity {
        user_id,
        is_superuser: claims.is_superuser,
    })
}

fn allowed_actions(kind: HitlKind) -> &'static [&'static str] {
    match kind {
        HitlKind::InputRequired => &["answer", "cancel"],
        HitlKind::AuthRequired => &["start_auth", "confirm_auth", "cancel"],
        HitlKind::ToolApproval => &["approve", "reject", "cancel"],
    }
}

/// §11's response shape. `resume_state` is never included — `HitlRequest` isn't `Serialize` for
/// exactly this reason, so this DTO is the only path an API response can take.
fn to_response(row: &HitlRequest) -> Value {
    json!({
        "id": row.id,
        "kind": row.kind.as_str(),
        "status": row.status.as_str(),
        "resume_status": row.resume_status.as_str(),
        "question": row.question,
        "human_response": row.human_response,
        "execution": {
            "origin": row.origin.as_str(),
            "agent_id": row.agent_id,
            "context_id": row.context_id,
            "chat_session_id": row.chat_session_id,
            "maf_execution_id": row.maf_execution_id,
            "maf_step_index": row.maf_step_index,
        },
        "allowed_actions": allowed_actions(row.kind),
        "expires_at": row.expires_at,
        "created_at": row.created_at,
        "resolved_at": row.resolved_at,
    })
}

async fn list_pending(State(state): State<AppState>, claims: Claims) -> Response {
    let identity = match identity(&claims) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    match state.hitl_store.list_pending_for(&identity).await {
        Ok(rows) => Json(json!({ "data": rows.iter().map(to_response).collect::<Vec<_>>() }))
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_one(State(state): State<AppState>, claims: Claims, Path(id): Path<Uuid>) -> Response {
    let identity = match identity(&claims) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    let row = match state.hitl_store.get(id).await {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "hitl request not found").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    // §11 is explicit that this is 403, not the 404-for-view convention used elsewhere in this
    // codebase for named/enumerable resources — `hitl_requests` ids are opaque UUIDs.
    if authorize_hitl_action(&identity, &row, HitlAction::View).is_err() {
        return (
            StatusCode::FORBIDDEN,
            "not authorized to view this HITL request",
        )
            .into_response();
    }
    Json(to_response(&row)).into_response()
}

async fn resolve(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<Uuid>,
    Json(payload): Json<HitlResolveRequest>,
) -> Response {
    let identity = match identity(&claims) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    let user_id = identity.user_id;

    let row = match state.hitl_store.get(id).await {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "hitl request not found").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    if authorize_hitl_action(&identity, &row, HitlAction::Resolve).is_err() {
        return (
            StatusCode::FORBIDDEN,
            "not authorized to resolve this HITL request",
        )
            .into_response();
    }
    // The finalized three-action dialog: allow once, allow for this session, deny — no `always`.
    // `scope` only matters on `approve`; defaults to `once` when omitted, so an existing caller
    // that never sends it keeps single-use behavior unchanged.
    if row.kind == HitlKind::ToolApproval {
        let approve = match payload.decision.as_deref() {
            Some("approve") => true,
            Some("reject") => false,
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "decision must be \"approve\" or \"reject\" for tool_approval",
                )
                    .into_response();
            }
        };
        let scope = match payload.scope.as_deref() {
            None | Some("once") => "once",
            Some("session") => "session",
            Some(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    "scope must be \"once\" or \"session\"",
                )
                    .into_response();
            }
        };

        let status = if approve {
            HitlStatus::Resolved
        } else {
            HitlStatus::Rejected
        };
        let human_response = json!({
            "decision": if approve { "approve" } else { "reject" },
            "scope": if approve { Some(scope) } else { None },
            "note": payload.note,
        });

        let outcome = match state
            .hitl_store
            .resolve(id, human_response, user_id, status)
            .await
        {
            Ok(outcome) => outcome,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        };

        let (row, already_resolved) = match outcome {
            ResolveOutcome::Applied(row) => {
                if approve && scope == "session" {
                    grant_session_scope(&state, &row, user_id).await;
                }
                // Best-effort latency optimization — the dispatcher's own poll loop is
                // the real delivery guarantee, same as the shared path below.
                let _ = state.hitl_resume_tx.try_send(());
                (row, false)
            }
            ResolveOutcome::AlreadyDecided(row) if row.status == HitlStatus::Expired => {
                return (
                    StatusCode::CONFLICT,
                    "this HITL request expired before it was answered",
                )
                    .into_response();
            }
            ResolveOutcome::AlreadyDecided(row) => (row, true),
        };

        let mut body = to_response(&row);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("already_resolved".to_string(), json!(already_resolved));
        }
        return Json(body).into_response();
    }
    if row.kind == HitlKind::InputRequired && payload.answer.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            "answer is required for input_required",
        )
            .into_response();
    }

    // §7/Phase 4: `auth_required` is a two-click flow — "start" only records that the human
    // began the external auth step (row stays `pending`, nothing is sent to the agent yet);
    // only "confirm" is treated as the human's decision that triggers a resume. Anything else
    // is rejected outright rather than silently sent to the agent as an unvalidated string.
    if row.kind == HitlKind::AuthRequired {
        match payload.auth_action.as_deref() {
            Some("start") => {
                let current = match state.hitl_store.record_auth_start(id).await {
                    Ok(Some(row)) => row,
                    // Already resolved/expired/canceled by the time this landed — report
                    // current state rather than erroring, matching resolve/cancel's own
                    // idempotent-success convention (§5).
                    Ok(None) => match state.hitl_store.get(id).await {
                        Ok(Some(row)) => row,
                        Ok(None) => {
                            return (StatusCode::NOT_FOUND, "hitl request not found")
                                .into_response();
                        }
                        Err(e) => {
                            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                                .into_response();
                        }
                    },
                    Err(e) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
                    }
                };
                return Json(to_response(&current)).into_response();
            }
            Some("confirm") => {} // falls through to the normal resolve path below
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "auth_action must be \"start\" or \"confirm\" for auth_required",
                )
                    .into_response();
            }
        }
    }

    let mut human_response = json!({});
    if row.kind == HitlKind::AuthRequired {
        // Only "confirm" reaches here (validated above). Intent, not proof — the agent's own
        // next response is what determines whether the external auth actually succeeded (§7).
        if let Some(obj) = human_response.as_object_mut() {
            obj.insert("auth_outcome".to_string(), json!("confirmed"));
        }
    } else if let (Some(obj), Some(answer)) = (human_response.as_object_mut(), &payload.answer) {
        obj.insert("answer".to_string(), json!(answer));
    }

    let outcome = match state
        .hitl_store
        .resolve(id, human_response, user_id, HitlStatus::Resolved)
        .await
    {
        Ok(outcome) => outcome,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let (row, already_resolved) = match outcome {
        ResolveOutcome::Applied(row) => {
            // Best-effort latency optimization — the dispatcher's own poll loop is the real
            // delivery guarantee (§ Phase 3 item 5).
            let _ = state.hitl_resume_tx.try_send(());
            (row, false)
        }
        // §11: 409 for resolve-after-expired — distinct from the idempotent-double-resolve 200
        // below, which is for a row someone (possibly this same caller) already answered.
        ResolveOutcome::AlreadyDecided(row) if row.status == HitlStatus::Expired => {
            return (
                StatusCode::CONFLICT,
                "this HITL request expired before it was answered",
            )
                .into_response();
        }
        ResolveOutcome::AlreadyDecided(row) => (row, true),
    };

    let mut body = to_response(&row);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("already_resolved".to_string(), json!(already_resolved));
    }
    Json(body).into_response()
}

/// Best-effort: record the `mcp_session_tool_grants` row an approved `scope=session` decision
/// promises. `connector_id`/`tool_name`/`context_id` are guaranteed present by
/// `chk_hitl_tool_approval_identity` for any `kind=tool_approval` row, which the caller has
/// already confirmed `row` is. A failure here is logged but never turned into an error response —
/// the resolution itself already succeeded and is the authoritative outcome; worst case the
/// agent's retry finds no grant and gets asked again, which is safe (never silently
/// over-permissive), just not maximally convenient.
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

/// Lets the row's owner withdraw a pending request they no longer want answered — e.g. they
/// abandoned the task, or the question no longer applies. No resume is triggered; the row simply
/// stops being `pending` and drops out of `list_pending_for`.
async fn cancel(State(state): State<AppState>, claims: Claims, Path(id): Path<Uuid>) -> Response {
    let identity = match identity(&claims) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };

    let row = match state.hitl_store.get(id).await {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "hitl request not found").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    if authorize_hitl_action(&identity, &row, HitlAction::Cancel).is_err() {
        return (
            StatusCode::FORBIDDEN,
            "not authorized to cancel this HITL request",
        )
            .into_response();
    }

    let outcome = match state.hitl_store.cancel(id, identity.user_id).await {
        Ok(outcome) => outcome,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let (row, already_canceled) = match outcome {
        ResolveOutcome::Applied(row) => (row, false),
        // Matches `resolve`'s own idempotency convention (§5): a lost double-cancel race is a
        // 200, never a 500 or a second no-op — but a row already `resolved` (answered, not
        // canceled) or `expired` before the cancel landed is a real conflict, not a race.
        ResolveOutcome::AlreadyDecided(row) if row.status != HitlStatus::Canceled => {
            return (
                StatusCode::CONFLICT,
                format!(
                    "this HITL request is already {}, not pending",
                    row.status.as_str()
                ),
            )
                .into_response();
        }
        ResolveOutcome::AlreadyDecided(row) => (row, true),
    };

    let mut body = to_response(&row);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("already_canceled".to_string(), json!(already_canceled));
    }
    Json(body).into_response()
}

/// True once nothing further will ever happen to this row without a brand-new request from
/// somewhere: either `status` itself is a dead end (no resume will ever be attempted), or the
/// resume that was attempted has itself reached one of its own terminal states.
fn is_terminal(row: &HitlRequest) -> bool {
    match row.status {
        HitlStatus::Pending | HitlStatus::Resolved => matches!(
            row.resume_status,
            ResumeStatus::Completed | ResumeStatus::Failed | ResumeStatus::DeliveryOutcomeUnknown
        ),
        HitlStatus::Rejected | HitlStatus::Expired | HitlStatus::Canceled => true,
    }
}

/// `GET /api/hitl/{id}/stream` — DB-poll-wrapped SSE, cloned from the existing
/// `deploy_status_sse`/`build_progress_sse` pattern (`oss/server/src/agents/upload.rs`,
/// `oss/server/src/build/routes.rs`): poll every 3s, emit an event only when `status`/
/// `resume_status`/`human_response` actually change, close once the row reaches a terminal state.
/// `human_response` is in the dedup key (not just the two status columns) because
/// `record_auth_start` writes into it without changing either status column — an `auth_required`
/// row's "start" step would otherwise never surface as its own event, only on the next unrelated
/// change or a fresh reconnect. The authorization check runs once up front — a 403 is a normal
/// HTTP response, not a stream — and every subsequent poll trusts that this connection is already
/// scoped to its owner.
async fn stream_one(
    State(state): State<AppState>,
    claims: Claims,
    Path(id): Path<Uuid>,
) -> Response {
    let identity = match identity(&claims) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    let row = match state.hitl_store.get(id).await {
        Ok(Some(row)) => row,
        Ok(None) => return (StatusCode::NOT_FOUND, "hitl request not found").into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    if authorize_hitl_action(&identity, &row, HitlAction::View).is_err() {
        return (
            StatusCode::FORBIDDEN,
            "not authorized to view this HITL request",
        )
            .into_response();
    }

    let hitl_store = state.hitl_store.clone();
    let stream = async_stream::stream! {
        let mut last: Option<(String, String, Option<String>)> = None;

        loop {
            let row = match hitl_store.get(id).await {
                Ok(Some(row)) => row,
                Ok(None) => {
                    yield Ok::<_, Infallible>(Event::default().data(
                        json!({ "status": "not_found" }).to_string(),
                    ));
                    break;
                }
                Err(e) => {
                    yield Ok(Event::default().event("error").data(
                        json!({ "error": e.to_string() }).to_string(),
                    ));
                    break;
                }
            };

            let key = (
                row.status.as_str().to_string(),
                row.resume_status.as_str().to_string(),
                row.human_response.as_ref().map(|v| v.to_string()),
            );
            if Some(&key) != last.as_ref() {
                yield Ok(Event::default().data(to_response(&row).to_string()));
                last = Some(key);
            }

            if is_terminal(&row) {
                break;
            }

            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}
