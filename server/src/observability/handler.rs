use crate::auth::Claims;
use crate::state::AppState;
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use nasiko_observability::ObservabilityError;
use serde::Deserialize;
use tracing::instrument;
use utoipa::IntoParams;

use super::service::{EnsureSessionOutcome, InsightsRequest, ObservabilityService};

// ─── Error mapping ────────────────────────────────────────────────────────────

fn obs_err(e: ObservabilityError) -> Response {
    match e {
        ObservabilityError::NotFound(msg) => {
            // `msg` here is a hand-authored, safe description (e.g. "span 'x' in
            // trace 'y'") — not a raw underlying error — so it's fine to return.
            (StatusCode::NOT_FOUND, msg).into_response()
        }
        ObservabilityError::BadRequest(msg) => {
            // `msg` is a hand-authored validation message (e.g. an invalid
            // query param) — safe to return so the caller can correct it.
            (StatusCode::BAD_REQUEST, msg).into_response()
        }
        ObservabilityError::Deserialization(_) => {
            tracing::error!(error = %e, "observability: failed to deserialize upstream response");
            (
                StatusCode::BAD_GATEWAY,
                "observability backend returned an invalid response",
            )
                .into_response()
        }
        other => {
            // Catches `Internal` and any future variants — these wrap raw
            // Tempo/Loki client/HTTP errors that must not reach the client.
            tracing::error!(error = %other, "observability request failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
        }
    }
}

fn svc(state: &AppState) -> ObservabilityService {
    ObservabilityService::from_state(state)
}

/// `get_finops_dashboard` degrades to a zeroed response when there's nothing
/// to query, but `get_agent_stats`/`get_session_details` ask about one
/// specific entity — there's no honest "zero" to fabricate, so surface a
/// clear, actionable status instead of letting the provider's connection
/// failure reach the client as an opaque `internal error`.
fn observability_unconfigured() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "observability backend not configured (set TEMPO_URL and LOKI_URL)",
    )
        .into_response()
}

// ─── Request params ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, IntoParams)]
pub struct SessionListParams {
    /// ISO-8601 window start (default: 7 days ago).
    pub start_time: Option<String>,
    /// Page size (default 25, max 100). Each row costs one trace-store lookup,
    /// so this bounds the request's real work — it is not just a display limit.
    pub limit: Option<i64>,
    /// Rows to skip, for offset paging (default 0).
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct AgentStatsParams {
    /// Optional — the service defaults to the last 24 hours, matching the
    /// other observe endpoints (the UI calls this with no params at all).
    pub start_time: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct FinopsParams {
    /// ISO-8601 window start (default: 30 days ago).
    pub start_time: Option<String>,
    /// ISO-8601 window end (default: now). Without it a past-month selection
    /// means "that month through today" rather than that month.
    pub end_time: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct AgentHoursParams {
    /// ISO-8601 window start (default: all-time; 30 days ago when `bucket` is set).
    pub start_time: Option<String>,
    /// ISO-8601 window end (default: now).
    pub end_time: Option<String>,
    /// Optional agent UUID — restricts the report to one agent.
    pub agent_id: Option<String>,
    /// Optional series granularity: "hour" | "day". Anything else is ignored.
    pub bucket: Option<String>,
}

// ─── 1. GET /v1/observability/session/list ────────────────────────────────────

/// List chat sessions (DB-authoritative, enriched from Tempo when available).
#[utoipa::path(
    get,
    path = "/api/observability/session/list",
    tag = "observability",
    params(SessionListParams),
    responses(
        (status = 200, description = "Sessions in the window", body = crate::observability::service::SessionListResponse),
        (status = 401, description = "Missing or invalid session"),
    ),
)]
#[instrument(skip(state))]
pub async fn get_all_sessions(
    State(state): State<AppState>,
    claims: Claims,
    Query(params): Query<SessionListParams>,
) -> impl IntoResponse {
    match svc(&state)
        .get_all_sessions(
            &claims.sub,
            None, // role gating handled by the EE observability provider, not the identity
            None,
            None,
            params.start_time.as_deref(),
            claims.is_superuser,
            params.limit,
            params.offset,
        )
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => obs_err(e),
    }
}

// ─── 1b. POST /v1/observability/session/ensure ──────────────────────────────

/// Request body for the ensure-session endpoint.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct EnsureSessionRequest {
    /// The coding agent's session id (e.g. a Claude Code session UUID).
    pub session_id: String,
    /// The agent name as registered in the `agents` table (e.g. "claude-code").
    pub agent_name: String,
}

/// Ensure a `chat_sessions` row exists for an external coding agent session.
///
/// Called by the CLI after the first OTLP export for a session. Idempotent —
/// returns 200 whether the row was just created or already existed.
#[utoipa::path(
    post,
    path = "/api/observability/session/ensure",
    tag = "observability",
    request_body = EnsureSessionRequest,
    responses(
        (status = 200, description = "Session ensured (created or already existed)"),
        (status = 404, description = "Owned agent not found"),
        (status = 409, description = "Session already belongs to another user or agent"),
        (status = 401, description = "Missing or invalid session"),
    ),
)]
#[instrument(skip(state))]
pub async fn ensure_session(
    State(state): State<AppState>,
    claims: Claims,
    Json(body): Json<EnsureSessionRequest>,
) -> impl IntoResponse {
    match svc(&state)
        .ensure_session(&body.session_id, &body.agent_name, &claims.sub)
        .await
    {
        Ok(EnsureSessionOutcome::Created) => StatusCode::CREATED.into_response(),
        Ok(EnsureSessionOutcome::Existing) => StatusCode::OK.into_response(),
        Ok(EnsureSessionOutcome::Conflict) => (
            StatusCode::CONFLICT,
            "session belongs to another user or agent",
        )
            .into_response(),
        Err(e) => obs_err(e),
    }
}

// ─── 2. GET /v1/observability/session/{session_id} ────────────────────────────

/// Detail for one session: traces, token usage, and cost summary.
#[utoipa::path(
    get,
    path = "/api/observability/session/{session_id}",
    tag = "observability",
    params(
        ("session_id" = String, Path, description = "A2A context/session ID"),
    ),
    responses(
        (status = 200, description = "Session detail", body = crate::observability::service::SessionDetailResponse),
        (status = 404, description = "Session not found in the observability backend"),
    ),
)]
#[instrument(skip(state))]
pub async fn get_session_details(
    State(state): State<AppState>,
    claims: Claims,
    Path(session_id): Path<String>,
) -> impl IntoResponse {
    if let Err(error) = svc(&state)
        .authorize_session_access(&session_id, &claims.sub, claims.is_superuser)
        .await
    {
        return obs_err(error);
    }
    if !state.config.observability_enabled {
        return observability_unconfigured();
    }
    match svc(&state)
        .get_session_details(&session_id, &claims.sub, claims.is_superuser)
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => obs_err(e),
    }
}

// ─── 3. GET /v1/observability/trace/{trace_id} ───────────────────────────────

/// Detail for one trace: full span tree with per-span token/cost attribution.
#[utoipa::path(
    get,
    path = "/api/observability/trace/{trace_id}",
    tag = "observability",
    params(
        ("trace_id" = String, Path, description = "W3C trace ID (hex)"),
    ),
    responses(
        (status = 200, description = "Trace detail with span tree", body = crate::observability::service::TraceDetailResponse),
        (status = 404, description = "Trace not found"),
    ),
)]
#[instrument(skip(state))]
pub async fn get_trace_details(
    State(state): State<AppState>,
    claims: Claims,
    Path(trace_id): Path<String>,
) -> impl IntoResponse {
    match svc(&state)
        .get_trace_details(&trace_id, &claims.sub, claims.is_superuser)
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => obs_err(e),
    }
}

// ─── 4. GET /v1/observability/span/{trace_id}/{span_id} ──────────────────────

/// Detail for one span: attributes, input/output content, and cost.
#[utoipa::path(
    get,
    path = "/api/observability/span/{trace_id}/{span_id}",
    tag = "observability",
    params(
        ("trace_id" = String, Path, description = "W3C trace ID (hex)"),
        ("span_id" = String, Path, description = "Span ID (hex)"),
    ),
    responses(
        (status = 200, description = "Span detail", body = crate::observability::service::SpanDetailResponse),
        (status = 404, description = "Span not found in this trace"),
    ),
)]
#[instrument(skip(state))]
pub async fn get_span_details(
    State(state): State<AppState>,
    claims: Claims,
    Path((trace_id, span_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match svc(&state)
        .get_span_details(&trace_id, &span_id, &claims.sub, claims.is_superuser)
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => obs_err(e),
    }
}

// ─── 5. GET /v1/observability/agent/{agent_id}/stats ─────────────────────────

/// Trace/cost/latency stats for one agent (accepts a UUID or agent name).
#[utoipa::path(
    get,
    path = "/api/observability/agent/{agent_id}/stats",
    tag = "observability",
    params(
        ("agent_id" = String, Path, description = "Agent UUID or name"),
        AgentStatsParams,
    ),
    responses(
        (status = 200, description = "Agent stats", body = crate::observability::service::AgentStatsResponse),
        (status = 401, description = "Missing or invalid session"),
    ),
)]
#[instrument(skip(state))]
pub async fn get_agent_stats(
    State(state): State<AppState>,
    claims: Claims,
    Path(agent_id): Path<String>,
    Query(params): Query<AgentStatsParams>,
) -> impl IntoResponse {
    let Some((_resolved_id, tempo_ref)) =
        super::routes::resolve_accessible_agent(&state, &claims, &agent_id).await
    else {
        return (StatusCode::NOT_FOUND, "agent not found").into_response();
    };
    if !super::routes::agent_name_fully_accessible(&state, &claims, &tempo_ref).await {
        return (StatusCode::NOT_FOUND, "agent not found").into_response();
    }
    if !state.config.observability_enabled {
        return observability_unconfigured();
    }
    // Tempo's service.name is the agent name (the injector sets
    // OTEL_SERVICE_NAME to the container/agent name); accept a name or UUID
    // here (same contract as the logs endpoints) and query by name.
    match svc(&state)
        .get_agent_stats(&tempo_ref, params.start_time.as_deref())
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => obs_err(e),
    }
}

// ─── 6. GET /v1/observability/finops/dashboard ───────────────────────────────

/// FinOps dashboard: per-agent cost/token rows plus fleet-wide summary.
#[utoipa::path(
    get,
    path = "/api/observability/finops/dashboard",
    tag = "observability",
    params(FinopsParams),
    responses(
        (status = 200, description = "FinOps dashboard data", body = crate::observability::service::FinopsDashboardResponse),
        (status = 401, description = "Missing or invalid session"),
    ),
)]
#[instrument(skip(state))]
pub async fn get_finops_dashboard(
    State(state): State<AppState>,
    claims: Claims,
    Query(params): Query<FinopsParams>,
) -> impl IntoResponse {
    let accessible_agent_ids = accessible_agent_ids(&state, &claims).await;
    match svc(&state)
        .get_finops_dashboard(
            &claims.sub,
            None, // role gating handled by the EE observability provider, not the identity
            None,
            None,
            params.start_time.as_deref(),
            params.end_time.as_deref(),
            accessible_agent_ids.as_deref(),
        )
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => obs_err(e),
    }
}

// ─── 7. POST /v1/observability/finops/insights ───────────────────────────────

/// LLM-generated cost insights from the caller-supplied FinOps KPI snapshot.
#[utoipa::path(
    post,
    path = "/api/observability/finops/insights",
    tag = "observability",
    request_body = crate::observability::service::InsightsRequest,
    responses(
        (status = 200, description = "Up to 3 insight bullet points", body = crate::observability::service::InsightsResponse),
        (status = 500, description = "LLM call failed"),
    ),
)]
#[instrument(skip(state, body))]
pub async fn get_finops_insights(
    State(state): State<AppState>,
    _claims: Claims,
    Json(body): Json<InsightsRequest>,
) -> impl IntoResponse {
    match svc(&state).get_finops_insights(&body).await {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => obs_err(e),
    }
}

// ─── 8. GET /v1/observability/finops/agent-hours ─────────────────────────────

/// Windowed replica-hours per agent (billing source of truth), optionally bucketed.
#[utoipa::path(
    get,
    path = "/api/observability/finops/agent-hours",
    tag = "observability",
    params(AgentHoursParams),
    responses(
        (status = 200, description = "Replica-hours report", body = crate::observability::service::AgentHoursResponse),
        (status = 400, description = "Malformed start_time/end_time/agent_id"),
    ),
)]
#[instrument(skip(state))]
pub async fn get_agent_hours(
    State(state): State<AppState>,
    claims: Claims,
    Query(params): Query<AgentHoursParams>,
) -> impl IntoResponse {
    if !claims.is_superuser
        && let Some(Ok(agent_id)) = params.agent_id.as_deref().map(str::parse)
        && !crate::acl::can_access_agent(&state, &claims, agent_id).await
    {
        return (StatusCode::NOT_FOUND, "agent not found").into_response();
    }
    let accessible_agent_ids = accessible_agent_ids(&state, &claims).await;
    match svc(&state)
        .get_agent_hours(
            params.start_time.as_deref(),
            params.end_time.as_deref(),
            params.agent_id.as_deref(),
            params.bucket.as_deref(),
            accessible_agent_ids.as_deref(),
        )
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => obs_err(e),
    }
}

async fn accessible_agent_ids(state: &AppState, claims: &Claims) -> Option<Vec<uuid::Uuid>> {
    if claims.is_superuser {
        return None;
    }

    let agent_ids: Vec<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM agents WHERE deleted_at IS NULL ORDER BY id")
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
    let mut accessible = Vec::new();
    for agent_id in agent_ids {
        if crate::acl::can_access_agent(state, claims, agent_id).await {
            accessible.push(agent_id);
        }
    }
    Some(accessible)
}
