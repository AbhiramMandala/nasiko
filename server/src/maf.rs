use crate::auth::Claims;
use crate::state::AppState;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use nasiko_orchestrator::RouteRequest;
use nasiko_orchestrator::maf::{
    decomposer::DecomposerClient,
    llm::LlmClient,
    planner::{self, AgentInfo as PlannerAgentInfo},
    types::{MafDefinition, MafStep, StepResult},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// MAF routes, split into two rate-limit classes because their costs differ by
/// orders of magnitude — see the limiter definitions in `lib.rs`.
///
/// Both limiters are per-caller (`limit_by_user`), so one tenant cannot starve
/// another. Layering them here rather than on the whole `protected` router
/// keeps MAF's budget separate from unrelated endpoints.
pub fn router(
    run_limiter: crate::rate_limit::RateLimiter,
    read_limiter: crate::rate_limit::RateLimiter,
) -> Router<AppState> {
    // Expensive: each of these fans out to multiple LLM calls (and, for a run,
    // N agent HTTP calls on top). Left unlimited, one client could enqueue
    // workflow runs in a loop and bill the deployment for all of it.
    let expensive = Router::new()
        .route(
            "/maf/workflow/from-instruction",
            post(create_maf_from_instruction),
        )
        .route("/maf/generate", post(generate_maf))
        .route("/maf/workflow/{id}/run", post(run_workflow))
        .layer(axum::middleware::from_fn_with_state(
            run_limiter,
            crate::rate_limit::limit_by_user,
        ));

    // Cheap single-row reads plus CRUD. The budget here is deliberately loose:
    // `/maf/execution/{id}` and `/maf/execution/{id}/usage` are both polled by
    // the UI while a workflow runs, so a tight window would break normal use
    // rather than abuse.
    let standard = Router::new()
        .route("/maf/workflows", get(list_mafs).post(create_maf))
        // Static segment "result" wins over {id} in matchit so this route is unambiguous
        .route("/maf/workflow/result/{exec_id}", get(get_result))
        .route(
            "/maf/workflow/{id}",
            get(get_maf).put(update_maf).delete(delete_maf),
        )
        .route("/maf/workflow/{id}/executions", get(list_executions))
        .route("/maf/executions", get(list_all_executions))
        .route("/maf/execution/{id}", get(get_execution))
        .route("/maf/execution/{id}/usage", get(get_execution_usage))
        .layer(axum::middleware::from_fn_with_state(
            read_limiter,
            crate::rate_limit::limit_by_user,
        ));

    expensive.merge(standard)
}

// ─── Shared helpers ────────────────────────────────────────────────────────
//
// Every MAF response — success or error — is wrapped in the same envelope:
// {"data": <payload or null>, "status_code": <mirrors the real HTTP status>, "message": <human-readable>}
// so frontend code can parse one shape regardless of outcome.

fn parse_user_id(claims: &Claims) -> Option<Uuid> {
    claims.sub.parse().ok()
}

fn ok_json<T: Serialize>(status: StatusCode, data: T, message: &str) -> axum::response::Response {
    (
        status,
        Json(serde_json::json!({
            "data": data,
            "status_code": status.as_u16(),
            "message": message
        })),
    )
        .into_response()
}

fn err_json(status: StatusCode, message: &str) -> axum::response::Response {
    (
        status,
        Json(serde_json::json!({
            "data": serde_json::Value::Null,
            "status_code": status.as_u16(),
            "message": message
        })),
    )
        .into_response()
}

fn unauthorized() -> axum::response::Response {
    err_json(StatusCode::UNAUTHORIZED, "invalid or missing user identity")
}

fn internal_err(e: impl std::fmt::Display) -> axum::response::Response {
    err_json(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
}

fn not_found(resource: &str) -> axum::response::Response {
    err_json(StatusCode::NOT_FOUND, &format!("{resource} not found"))
}

fn forbidden(msg: &str) -> axum::response::Response {
    err_json(StatusCode::FORBIDDEN, msg)
}

fn bad_request(msg: &str) -> axum::response::Response {
    err_json(StatusCode::BAD_REQUEST, msg)
}

// ─── DB row types (JSONB cast to text in SQL) ──────────────────────────────

#[derive(Debug, sqlx::FromRow)]
struct MafRow {
    id: Uuid,
    user_id: Uuid,
    name: String,
    description: Option<String>,
    maf_json: String, // fetched via maf_json::text
    status: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    /// How many times this workflow has been run — COUNT(*) over maf_executions,
    /// computed on read rather than stored, so it can never drift out of sync.
    execution_count: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct ExecRow {
    id: Uuid,
    /// User-facing incremental id — globally sequential, cosmetic only.
    /// `id` (UUID) remains the real identifier used internally (A2A
    /// contextId, Redis job key); never used as a lookup key.
    execution_number: i64,
    maf_id: Option<Uuid>,
    user_id: Uuid,
    status: String,
    attempt_count: i32,
    max_attempts: i32,
    tokens_used: i64,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    duration_ms: Option<i64>,
    output: Option<String>,
    step_results: Option<String>, // fetched via step_results::text
    error: Option<String>,
    created_at: DateTime<Utc>,
}

/// Same shape as ExecRow, plus the parent workflow's current name/status —
/// fetched via LEFT JOIN so it's populated whether the workflow is active,
/// soft-deleted, or (defensively) its maf_id has gone missing entirely.
#[derive(Debug, sqlx::FromRow)]
struct ExecWithWorkflowRow {
    id: Uuid,
    execution_number: i64,
    maf_id: Option<Uuid>,
    user_id: Uuid,
    status: String,
    attempt_count: i32,
    max_attempts: i32,
    tokens_used: i64,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    duration_ms: Option<i64>,
    output: Option<String>,
    step_results: Option<String>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    workflow_name: Option<String>,
    /// "active" | "deleted", or None if the workflow row itself is gone.
    workflow_status: Option<String>,
}

// ─── Response types ────────────────────────────────────────────────────────

#[derive(Serialize)]
struct MafResponse {
    id: Uuid,
    user_id: Uuid,
    name: String,
    description: Option<String>,
    maf_json: serde_json::Value,
    status: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    execution_count: i64,
}

#[derive(Serialize)]
struct ExecResponse {
    id: Uuid,
    execution_number: i64,
    maf_id: Option<Uuid>,
    user_id: Uuid,
    status: String,
    attempt_count: i32,
    max_attempts: i32,
    tokens_used: i64,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    duration_ms: Option<i64>,
    output: Option<String>,
    step_results: Option<serde_json::Value>,
    error: Option<String>,
    created_at: DateTime<Utc>,
}

fn maf_row_to_response(row: MafRow) -> MafResponse {
    let maf_json = serde_json::from_str(&row.maf_json).unwrap_or(serde_json::Value::Null);
    MafResponse {
        id: row.id,
        user_id: row.user_id,
        name: row.name,
        description: row.description,
        maf_json,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        execution_count: row.execution_count,
    }
}

fn exec_row_to_response(row: ExecRow) -> ExecResponse {
    let step_results = row
        .step_results
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    ExecResponse {
        id: row.id,
        execution_number: row.execution_number,
        maf_id: row.maf_id,
        user_id: row.user_id,
        status: row.status,
        attempt_count: row.attempt_count,
        max_attempts: row.max_attempts,
        tokens_used: row.tokens_used,
        started_at: row.started_at,
        completed_at: row.completed_at,
        duration_ms: row.duration_ms,
        output: row.output,
        step_results,
        error: row.error,
        created_at: row.created_at,
    }
}

#[derive(Serialize)]
struct ExecWithWorkflowResponse {
    id: Uuid,
    execution_number: i64,
    maf_id: Option<Uuid>,
    user_id: Uuid,
    status: String,
    attempt_count: i32,
    max_attempts: i32,
    tokens_used: i64,
    started_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
    duration_ms: Option<i64>,
    output: Option<String>,
    step_results: Option<serde_json::Value>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    workflow_name: Option<String>,
    workflow_status: Option<String>,
}

fn exec_with_workflow_row_to_response(row: ExecWithWorkflowRow) -> ExecWithWorkflowResponse {
    let step_results = row
        .step_results
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    ExecWithWorkflowResponse {
        id: row.id,
        execution_number: row.execution_number,
        maf_id: row.maf_id,
        user_id: row.user_id,
        status: row.status,
        attempt_count: row.attempt_count,
        max_attempts: row.max_attempts,
        tokens_used: row.tokens_used,
        started_at: row.started_at,
        completed_at: row.completed_at,
        duration_ms: row.duration_ms,
        output: row.output,
        step_results,
        error: row.error,
        created_at: row.created_at,
        workflow_name: row.workflow_name,
        workflow_status: row.workflow_status,
    }
}

// ─── Request types ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CreateStepRequest {
    task_description: String,
    agent_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct CreateMafRequest {
    /// Optional name — if omitted, derived from the first task description.
    name: Option<String>,
    description: Option<String>,
    steps: Vec<CreateStepRequest>,
}

#[derive(Deserialize)]
struct UpdateStepRequest {
    step_index: i32,
    #[serde(default)]
    agent_id: Option<Uuid>,
    task_description: String,
}

// Serde helper: distinguishes absent (keep existing) from explicit null (clear the field).
// absent → field missing → outer Option is None → keep existing
// null   → field present but null → outer Option is Some(None) → set to NULL
// value  → field present with value → outer Option is Some(Some(v)) → set to v
mod nullable {
    use serde::{Deserialize, Deserializer};
    pub fn deserialize<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Ok(Some(Option::<T>::deserialize(d)?))
    }
}

#[derive(Deserialize)]
struct UpdateMafRequest {
    name: Option<String>,
    #[serde(default, deserialize_with = "nullable::deserialize")]
    description: Option<Option<String>>,
    steps: Option<Vec<UpdateStepRequest>>,
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}
fn default_limit() -> i64 {
    50
}

// ─── 1. GET /maf/workflows ─────────────────────────────────────────────────

async fn list_mafs(
    State(state): State<AppState>,
    claims: Claims,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(id) => id,
        None => return unauthorized(),
    };

    let rows = sqlx::query_as::<_, MafRow>(
        r#"SELECT m.id, m.user_id, m.name, m.description, m.maf_json::text AS maf_json,
                  m.status, m.created_at, m.updated_at,
                  (SELECT COUNT(*) FROM maf_executions e WHERE e.maf_id = m.id) AS execution_count
           FROM mafs m
           WHERE m.user_id = $1 AND m.status = 'active'
           ORDER BY m.created_at DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(user_id)
    .bind(q.limit)
    .bind(q.offset)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(data) => {
            let items: Vec<MafResponse> = data.into_iter().map(maf_row_to_response).collect();
            ok_json(
                StatusCode::OK,
                crate::Paginated::new(items),
                "Workflows retrieved successfully",
            )
        }
        Err(e) => internal_err(e),
    }
}

// ─── 2. POST /maf/workflows ────────────────────────────────────────────────

async fn create_maf(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<CreateMafRequest>,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(id) => id,
        None => return unauthorized(),
    };

    create_maf_from_steps(
        &state,
        &claims,
        user_id,
        req.name,
        req.description,
        req.steps,
    )
    .await
}

/// Shared by `create_maf` (caller gives steps directly) and
/// `create_maf_from_instruction` (steps come from decomposing one sentence).
/// Resolves any step lacking an `agent_id` via the routing engine, then
/// persists the resulting `MafDefinition` as a new `mafs` row.
async fn create_maf_from_steps(
    state: &AppState,
    claims: &Claims,
    user_id: Uuid,
    name: Option<String>,
    description: Option<String>,
    steps: Vec<CreateStepRequest>,
) -> axum::response::Response {
    if steps.is_empty() {
        return bad_request("steps must not be empty");
    }

    // Resolve any steps that lack an agent_id via the routing engine
    let mut resolved_steps: Vec<MafStep> = Vec::with_capacity(steps.len());
    for (idx, step) in steps.into_iter().enumerate() {
        if step.task_description.trim().is_empty() {
            return bad_request(&format!("step {idx}: task_description is required"));
        }
        // The task description is user-authored prose, so it stays out of
        // `info!` — these lines ship to Loki, where anyone with dashboard
        // access can read them. Length is the part that's useful for
        // diagnosing a routing miss; the text itself is available at `debug`.
        tracing::info!(
            step = idx,
            task_description_len = step.task_description.len(),
            has_explicit_agent = step.agent_id.is_some(),
            "maf create: resolving step"
        );
        tracing::debug!(step = idx, task_description = %step.task_description);
        let step_start = std::time::Instant::now();

        let (agent_id, agent_name, agent_endpoint) = if let Some(aid) = step.agent_id {
            // Caller provided an agent — must be reachable by this caller (owner ∪
            // public ∪ user/team/dept grant per edition) before we accept it into a
            // workflow step. Same "not found" response for both missing and
            // inaccessible agents — matches a2a_dispatch.rs's enumeration-safe
            // pattern (a non-grantee can't distinguish "doesn't exist" from
            // "exists but you can't use it").
            if !crate::acl::can_access_agent(state, claims, aid).await {
                return forbidden(&format!("agent {aid} not found"));
            }
            match fetch_agent_info(&state.db, aid).await {
                Ok(Some((name, url))) => (aid, name, url),
                Ok(None) => return forbidden(&format!("agent {aid} not found")),
                Err(e) => return internal_err(e),
            }
        } else {
            // Auto-assign via routing engine
            let route_req = RouteRequest {
                query: step.task_description.clone(),
                session_id: Uuid::new_v4().to_string(),
                user_id,
                file_parts: vec![],
            };
            // A routed agent is only usable if it actually has an endpoint. An
            // agent row with an empty `url` (registered but never deployed, or
            // a seed whose URL was never backfilled) used to hard-fail the
            // whole request with a 400, which is what made *every* workflow
            // uncreatable on such a fleet. Treat it exactly like a routing
            // failure and fall through to the catalog fallback below.
            let routed = match state.routing_engine.route(route_req, &state.db).await {
                Ok(result) => match result.agent.url {
                    Some(endpoint) if !endpoint.is_empty() => {
                        Some((result.agent.id, result.agent.name, endpoint))
                    }
                    _ => None,
                },
                Err(_) => None,
            };

            match routed {
                Some(agent) => agent,
                None => {
                    // The routing engine only considers status='running' agents.
                    // Fall back to any agent registered by this user that has a valid URL,
                    // picking the one whose name/description best matches the task description.
                    let catalog = match fetch_user_agents(&state.db, user_id).await {
                        Ok(v) => v,
                        Err(e) => return internal_err(e),
                    };
                    let query_lower = step.task_description.to_lowercase();
                    let best = catalog
                        .into_iter()
                        .filter(|a| a.url.as_deref().is_some_and(|u| !u.is_empty()))
                        .max_by_key(|a| {
                            let haystack =
                                format!("{} {}", a.name, a.description.as_deref().unwrap_or(""))
                                    .to_lowercase();
                            query_lower
                                .split_whitespace()
                                .filter(|w| haystack.contains(*w))
                                .count()
                        });
                    match best {
                        Some(a) => (a.id, a.name, a.url.unwrap_or_default()),
                        None => {
                            return bad_request(&format!(
                                "step {idx}: no deployed agent is available to run this step. \
                                 Deploy at least one agent (a registered agent with no running \
                                 container has no endpoint to call) before creating a workflow."
                            ));
                        }
                    }
                }
            }
        };

        tracing::info!(
            step = idx,
            agent_name = %agent_name,
            elapsed_ms = step_start.elapsed().as_millis() as u64,
            "maf create: step resolved"
        );

        resolved_steps.push(MafStep {
            step_id: Uuid::new_v4(),
            step_index: idx as i32,
            agent_id,
            agent_name,
            agent_endpoint,
            task_description: step.task_description,
        });
    }

    // Derive name from first task description if not provided
    let name = name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            resolved_steps[0]
                .task_description
                .chars()
                .take(60)
                .collect()
        });

    let maf_def = MafDefinition {
        description: None, // generated by the runtime planner on each execution
        steps: resolved_steps,
        output_generation: None, // generated by the runtime planner on each execution
    };
    let maf_json = serde_json::to_value(&maf_def).unwrap_or_default();
    let maf_json_str = maf_json.to_string();
    let description = description
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let row = sqlx::query_as::<_, MafRow>(
        r#"INSERT INTO mafs (user_id, name, description, maf_json)
           VALUES ($1, $2, $3, $4::jsonb)
           RETURNING id, user_id, name, description, maf_json::text AS maf_json,
                     status, created_at, updated_at, 0::bigint AS execution_count"#,
    )
    .bind(user_id)
    .bind(&name)
    .bind(description)
    .bind(&maf_json_str)
    .fetch_one(&state.db)
    .await;

    match row {
        Ok(r) => {
            tracing::info!(maf_id = %r.id, name = %r.name, "maf create: workflow persisted");
            ok_json(
                StatusCode::CREATED,
                maf_row_to_response(r),
                "Workflow created successfully",
            )
        }
        Err(e) => internal_err(e),
    }
}

#[derive(Deserialize)]
struct FromInstructionRequest {
    /// The full compound sentence, e.g. "translate hello to japanese then
    /// email to jordan" — handed to the decomposer as-is.
    instruction: String,
}

// ─── 2b. POST /maf/workflow/from-instruction ───────────────────────────────
//
// Splits one compound instruction into atomic sub-queries via the external
// decomposer service (MODEL_API_URL/MODEL_APIKEY), then creates the workflow
// exactly like `create_maf` — same routing-engine auto-assign per step, same
// persisted `mafs.maf_json` shape. No LLM planner involved.

async fn create_maf_from_instruction(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<FromInstructionRequest>,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(id) => id,
        None => return unauthorized(),
    };

    if req.instruction.trim().is_empty() {
        return bad_request("instruction is required");
    }

    let decomposer_url = match &state.config.decomposer_api_url {
        Some(u) => u.clone(),
        None => {
            return err_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "MODEL_API_URL is not configured on this server",
            );
        }
    };
    let decomposer = DecomposerClient::new(
        state.http_client.clone(),
        decomposer_url,
        state.config.decomposer_api_key.clone(),
    );

    // Same reasoning as the per-step log in `create_maf_from_steps`: the raw
    // instruction is user content and does not belong in `info!`.
    tracing::info!(
        instruction_len = req.instruction.len(),
        "maf create: decomposing instruction"
    );
    tracing::debug!(instruction = %req.instruction, "maf create: instruction text");
    let decompose_start = std::time::Instant::now();
    let sub_queries = match decomposer.decompose(&req.instruction).await {
        Ok(qs) => qs,
        Err(e) => {
            // A failed dependency is a warning, not routine info. The error
            // carries the decomposer's response body, which can echo the
            // submitted query back — so it stays at `warn` where it is
            // actionable, rather than being emitted on every request.
            tracing::warn!(
                elapsed_ms = decompose_start.elapsed().as_millis() as u64,
                error = %e,
                "maf create: decomposer failed"
            );
            return err_json(StatusCode::SERVICE_UNAVAILABLE, &format!("decomposer: {e}"));
        }
    };
    tracing::info!(
        elapsed_ms = decompose_start.elapsed().as_millis() as u64,
        sub_query_count = sub_queries.len(),
        "maf create: decomposer returned sub-queries"
    );
    tracing::debug!(sub_queries = ?sub_queries, "maf create: sub-query text");

    let steps = sub_queries
        .into_iter()
        .map(|task_description| CreateStepRequest {
            task_description,
            agent_id: None,
        })
        .collect();

    create_maf_from_steps(&state, &claims, user_id, None, Some(req.instruction), steps).await
}

// ─── 3. GET /maf/workflow/{id} ─────────────────────────────────────────────

async fn get_maf(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    claims: Claims,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    match fetch_maf(&state.db, id).await {
        Ok(Some(row)) if row.user_id == user_id => ok_json(
            StatusCode::OK,
            maf_row_to_response(row),
            "Workflow retrieved successfully",
        ),
        Ok(Some(_)) => forbidden("not owned by caller"),
        Ok(None) => not_found("workflow"),
        Err(e) => internal_err(e),
    }
}

// ─── 4. PUT /maf/workflow/{id} ─────────────────────────────────────────────

async fn update_maf(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    claims: Claims,
    Json(req): Json<UpdateMafRequest>,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    let existing = match fetch_maf(&state.db, id).await {
        Ok(Some(r)) if r.user_id == user_id => r,
        Ok(Some(_)) => return forbidden("not owned by caller"),
        Ok(None) => return not_found("workflow"),
        Err(e) => return internal_err(e),
    };

    // Build new maf_json if steps are being replaced
    let new_maf_json_str = if let Some(steps) = req.steps {
        if steps.is_empty() {
            return bad_request("steps must not be empty");
        }

        let mut resolved: Vec<MafStep> = Vec::with_capacity(steps.len());
        for (idx, step) in steps.iter().enumerate() {
            if step.task_description.trim().is_empty() {
                return bad_request(&format!(
                    "step {}: task_description is required",
                    step.step_index
                ));
            }

            let (agent_id, name, endpoint) = if let Some(aid) = step.agent_id {
                // Same access check as create_maf — a caller-supplied agent_id must
                // be reachable by this caller before it's accepted into a step.
                if !crate::acl::can_access_agent(&state, &claims, aid).await {
                    return forbidden(&format!("agent {aid} not found"));
                }
                match fetch_agent_info(&state.db, aid).await {
                    Ok(Some((n, u))) => (aid, n, u),
                    Ok(None) => return forbidden(&format!("agent {aid} not found")),
                    Err(e) => return internal_err(e),
                }
            } else {
                // Auto-assign via routing engine (same logic as create_maf)
                let route_req = RouteRequest {
                    query: step.task_description.clone(),
                    session_id: Uuid::new_v4().to_string(),
                    user_id,
                    file_parts: vec![],
                };
                match state.routing_engine.route(route_req, &state.db).await {
                    Ok(result) => {
                        let ep = result.agent.url.unwrap_or_default();
                        if ep.is_empty() {
                            return bad_request(&format!(
                                "step {idx}: auto-assigned agent '{}' has no endpoint",
                                result.agent.name
                            ));
                        }
                        (result.agent.id, result.agent.name, ep)
                    }
                    Err(_) => {
                        let catalog = match fetch_user_agents(&state.db, user_id).await {
                            Ok(v) => v,
                            Err(e) => return internal_err(e),
                        };
                        let query_lower = step.task_description.to_lowercase();
                        let best = catalog
                            .into_iter()
                            .filter(|a| a.url.as_deref().is_some_and(|u| !u.is_empty()))
                            .max_by_key(|a| {
                                let haystack = format!(
                                    "{} {}",
                                    a.name,
                                    a.description.as_deref().unwrap_or("")
                                )
                                .to_lowercase();
                                query_lower
                                    .split_whitespace()
                                    .filter(|w| haystack.contains(*w))
                                    .count()
                            });
                        match best {
                            Some(a) => (a.id, a.name, a.url.unwrap_or_default()),
                            None => {
                                return bad_request(&format!(
                                    "step {idx}: no agents available. Register at least one agent in the Agents page."
                                ));
                            }
                        }
                    }
                }
            };

            resolved.push(MafStep {
                step_id: Uuid::new_v4(),
                step_index: step.step_index,
                agent_id,
                agent_name: name,
                agent_endpoint: endpoint,
                task_description: step.task_description.clone(),
            });
        }
        // Preserve description and output_generation from the existing maf_json when replacing steps
        let existing_def: MafDefinition =
            serde_json::from_str(&existing.maf_json).unwrap_or(MafDefinition {
                description: None,
                steps: vec![],
                output_generation: None,
            });
        let def = MafDefinition {
            description: existing_def.description,
            steps: resolved,
            output_generation: existing_def.output_generation,
        };
        serde_json::to_value(&def).unwrap_or_default().to_string()
    } else {
        existing.maf_json.clone()
    };

    let new_name = req.name.as_deref().map(str::trim).unwrap_or(&existing.name);
    // Some(None) = explicit null in JSON → clear; Some(Some(v)) = new value; None = absent → keep
    let new_description: Option<&str> = match &req.description {
        Some(inner) => inner.as_deref(),
        None => existing.description.as_deref(),
    };

    let row = sqlx::query_as::<_, MafRow>(
        r#"UPDATE mafs
           SET name = $1, description = $2, maf_json = $3::jsonb, updated_at = now()
           WHERE id = $4 AND status = 'active'
           RETURNING id, user_id, name, description, maf_json::text AS maf_json,
                     status, created_at, updated_at,
                     (SELECT COUNT(*) FROM maf_executions e WHERE e.maf_id = mafs.id) AS execution_count"#,
    )
    .bind(new_name)
    .bind(new_description)
    .bind(&new_maf_json_str)
    .bind(id)
    .fetch_optional(&state.db)
    .await;

    match row {
        Ok(Some(r)) => ok_json(
            StatusCode::OK,
            maf_row_to_response(r),
            "Workflow updated successfully",
        ),
        Ok(None) => not_found("workflow"),
        Err(e) => internal_err(e),
    }
}

// ─── 5. DELETE /maf/workflow/{id} ─────────────────────────────────────────

async fn delete_maf(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    claims: Claims,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    // Ownership check before soft-delete — superuser may delete any workflow (same
    // owner-or-superuser convention as agent management elsewhere).
    match fetch_maf(&state.db, id).await {
        Ok(Some(row)) if row.user_id != user_id && !claims.is_superuser => {
            return forbidden("not owned by caller");
        }
        Ok(None) => return not_found("workflow"),
        Err(e) => return internal_err(e),
        Ok(Some(_)) => {}
    }

    match sqlx::query(
        "UPDATE mafs SET status = 'deleted', updated_at = now() WHERE id = $1 AND status = 'active'",
    )
    .bind(id)
    .execute(&state.db)
    .await
    {
        // 204 No Content can't legally carry a body, so a successful delete
        // now returns 200 with the same envelope as every other response.
        Ok(r) if r.rows_affected() > 0 => {
            ok_json(StatusCode::OK, serde_json::Value::Null, "Workflow deleted successfully")
        }
        Ok(_) => not_found("workflow"),
        Err(e) => internal_err(e),
    }
}

#[derive(Deserialize, Default)]
struct RunWorkflowRequest {
    /// Data for this run only — spliced into step 0's task description
    /// (see `nasiko_orchestrator::maf::executor::run_maf`) before planning,
    /// so the same saved workflow shape can be re-run with different input
    /// each time instead of baking content in at creation.
    #[serde(default)]
    content: Option<String>,
}

// ─── 6. POST /maf/workflow/{id}/run ───────────────────────────────────────

async fn run_workflow(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    claims: Claims,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    // Body is optional — existing callers post none at all, so an empty body
    // means "no run-time content", not a parse error.
    let content = if body.is_empty() {
        None
    } else {
        match serde_json::from_slice::<RunWorkflowRequest>(&body) {
            Ok(r) => r.content,
            Err(e) => return bad_request(&format!("invalid request body: {e}")),
        }
    };

    let maf = match fetch_maf(&state.db, id).await {
        Ok(Some(r)) if r.user_id == user_id => r,
        Ok(Some(_)) => return forbidden("not owned by caller"),
        Ok(None) => return not_found("workflow"),
        Err(e) => return internal_err(e),
    };

    // Re-check agent access at run time, not just at create/update time.
    //
    // `create_maf`/`update_maf` already gate every step's agent, but those
    // checks are only true as of the moment the workflow was saved. A grant
    // can be revoked, an agent's `is_public` flag flipped off, or the agent
    // soft-deleted at any point afterwards — and the saved workflow would keep
    // invoking it, because the run path never looked again. That turns a
    // stored workflow into a durable capability that outlives the permission
    // it was built on.
    //
    // Checked here rather than in the worker so the caller gets a synchronous
    // 403 instead of an execution row that fails asynchronously. Agent ids are
    // de-duplicated: a workflow may use the same agent in several steps, and
    // each check is a DB round trip.
    match serde_json::from_str::<MafDefinition>(&maf.maf_json) {
        Ok(def) => {
            let mut checked: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
            for step in &def.steps {
                if !checked.insert(step.agent_id) {
                    continue;
                }
                if !crate::acl::can_access_agent(&state, &claims, step.agent_id).await {
                    return forbidden(&format!(
                        "step {}: agent '{}' is no longer accessible to you",
                        step.step_index, step.agent_name
                    ));
                }
            }
        }
        // A workflow row whose JSON no longer parses can't be run at all, and
        // failing closed here is what keeps the ACL check from being
        // bypassable by storing malformed JSON.
        Err(e) => return bad_request(&format!("workflow definition is invalid: {e}")),
    }

    let max_attempts: i32 = std::env::var("MAF_MAX_ATTEMPTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);

    // Create execution record
    let (exec_id, exec_number): (Uuid, i64) = match sqlx::query_as(
        r#"INSERT INTO maf_executions (maf_id, user_id, status, max_attempts)
           VALUES ($1, $2, 'pending', $3)
           RETURNING id, execution_number"#,
    )
    .bind(id)
    .bind(user_id)
    .bind(max_attempts)
    .fetch_one(&state.db)
    .await
    {
        Ok(row) => row,
        Err(e) => return internal_err(e),
    };

    // Enqueue to Redis stream
    let mut redis_conn = match state.redis.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => return internal_err(format!("redis connection failed: {e}")),
    };

    let mut xadd = redis::cmd("XADD");
    xadd.arg("nasiko:maf:execute")
        .arg("*")
        .arg("execution_id")
        .arg(exec_id.to_string())
        .arg("maf_json")
        .arg(&maf.maf_json)
        .arg("user_id")
        .arg(user_id.to_string());
    // Omit the field entirely when there's no run-time content, rather than
    // writing an empty string — keeps worker.rs's parse_job()/Job.content
    // distinguishing "no content given" from "content given but empty".
    if let Some(content) = &content {
        xadd.arg("content").arg(content);
    }
    let enqueue: redis::RedisResult<String> = xadd.query_async(&mut redis_conn).await;

    if let Err(e) = enqueue {
        // Roll back the execution row so the caller knows it wasn't queued
        let _ = sqlx::query("DELETE FROM maf_executions WHERE id = $1")
            .bind(exec_id)
            .execute(&state.db)
            .await;
        return internal_err(format!("failed to enqueue job: {e}"));
    }

    // Fresh count including the execution just created, so the caller can
    // update its UI immediately without a separate re-fetch.
    let execution_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM maf_executions WHERE maf_id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);

    ok_json(
        StatusCode::ACCEPTED,
        serde_json::json!({
            "execution_id": exec_id,
            "execution_number": exec_number,
            "execution_count": execution_count,
        }),
        "Execution started successfully",
    )
}

// ─── 7. GET /maf/workflow/result/{exec_id} ────────────────────────────────

async fn get_result(
    State(state): State<AppState>,
    Path(exec_id): Path<Uuid>,
    claims: Claims,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    match fetch_exec(&state.db, exec_id).await {
        Ok(Some(row)) if row.user_id == user_id => ok_json(
            StatusCode::OK,
            exec_row_to_response(row),
            "Execution result retrieved successfully",
        ),
        Ok(Some(_)) => forbidden("not owned by caller"),
        Ok(None) => not_found("execution"),
        Err(e) => internal_err(e),
    }
}

// ─── 8. GET /maf/workflow/{id}/executions ────────────────────────────────

async fn list_executions(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    claims: Claims,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    // Verify ownership of the MAF first
    match fetch_maf(&state.db, id).await {
        Ok(Some(r)) if r.user_id != user_id => return forbidden("not owned by caller"),
        Ok(None) => return not_found("workflow"),
        Err(e) => return internal_err(e),
        Ok(Some(_)) => {}
    }

    let rows = sqlx::query_as::<_, ExecRow>(
        r#"SELECT id, execution_number, maf_id, user_id, status, attempt_count, max_attempts, tokens_used,
                  started_at, completed_at, duration_ms, output,
                  step_results::text AS step_results, error, created_at
           FROM maf_executions
           WHERE maf_id = $1 AND user_id = $2
           ORDER BY created_at DESC
           LIMIT $3 OFFSET $4"#,
    )
    .bind(id)
    .bind(user_id)
    .bind(q.limit.min(50))
    .bind(q.offset)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(data) => {
            let items: Vec<ExecResponse> = data.into_iter().map(exec_row_to_response).collect();
            ok_json(
                StatusCode::OK,
                crate::Paginated::new(items),
                "Executions retrieved successfully",
            )
        }
        Err(e) => internal_err(e),
    }
}

// ─── 8b. GET /maf/executions ──────────────────────────────────────────────
// Every execution the caller has ever run, across every workflow — unlike
// list_executions (scoped to one workflow, and 404s once that workflow is
// deleted since it gates through fetch_maf's active-only check), this queries
// maf_executions directly by user_id, so a deleted workflow's runs still show
// up here. workflow_status tells the caller which ones are for workflows that
// no longer exist in the active list.

async fn list_all_executions(
    State(state): State<AppState>,
    claims: Claims,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    let rows = sqlx::query_as::<_, ExecWithWorkflowRow>(
        r#"SELECT e.id, e.execution_number, e.maf_id, e.user_id, e.status, e.attempt_count,
                  e.max_attempts, e.tokens_used, e.started_at, e.completed_at, e.duration_ms,
                  e.output, e.step_results::text AS step_results, e.error, e.created_at,
                  m.name AS workflow_name, m.status AS workflow_status
           FROM maf_executions e
           LEFT JOIN mafs m ON m.id = e.maf_id
           WHERE e.user_id = $1
           ORDER BY e.created_at DESC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(user_id)
    .bind(q.limit.min(50))
    .bind(q.offset)
    .fetch_all(&state.db)
    .await;

    match rows {
        Ok(data) => {
            let items: Vec<ExecWithWorkflowResponse> = data
                .into_iter()
                .map(exec_with_workflow_row_to_response)
                .collect();
            ok_json(
                StatusCode::OK,
                crate::Paginated::new(items),
                "Executions retrieved successfully",
            )
        }
        Err(e) => internal_err(e),
    }
}

// ─── 9. GET /maf/execution/{id} ──────────────────────────────────────────

async fn get_execution(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    claims: Claims,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    match fetch_exec(&state.db, id).await {
        Ok(Some(row)) if row.user_id == user_id => ok_json(
            StatusCode::OK,
            exec_row_to_response(row),
            "Execution retrieved successfully",
        ),
        Ok(Some(_)) => forbidden("not owned by caller"),
        Ok(None) => not_found("execution"),
        Err(e) => internal_err(e),
    }
}

// ─── 10. GET /maf/execution/{id}/usage ────────────────────────────────────
//
// Agent-side token and cost figures for one execution.
//
// These are deliberately NOT gathered while the workflow runs — see
// `nasiko_orchestrator::maf::executor::run_maf`. Agents flush their
// `gen_ai.usage` spans on a batch timer (~5s), so reading them inline meant
// every step sat idle for up to 10s producing a number that nothing in the
// run consumes. Instead each step records the trace id it ran under, the
// trace-usage materializer folds those spans into `trace_usage`, and this
// endpoint joins the two back together on demand.
//
// The consequence a caller must handle: usage lands *after* the execution
// does. `complete` reports whether there is anything left to wait for, so the
// UI can poll this endpoint on its own schedule and fill the numbers in when
// they arrive.

/// One step's agent usage, summed over every agent that reported spans under
/// that step's trace.
///
/// A MAF step is a single agent call, but that agent may itself fan out to
/// sub-agents on the same trace, and `trace_usage` stores one row per
/// `(trace_id, agent_name)`. Summing is what makes the figure the *step's*
/// true cost rather than just the entry agent's.
#[derive(sqlx::FromRow)]
struct TraceUsageRollup {
    trace_id: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    cost_usd: f64,
    /// Only set when every agent on the trace reported the same model —
    /// otherwise there is no single honest answer, so it stays null rather
    /// than arbitrarily picking one.
    model: Option<String>,
}

#[derive(Serialize)]
struct StepUsage {
    step_index: i32,
    agent_name: String,
    /// Null for a step that never got as far as its agent call.
    trace_id: Option<String>,
    /// False when this step's spans have not been materialized yet. Every
    /// figure below is zero in that case — a zero on an unresolved step means
    /// "not known yet", NOT "cost nothing". Callers must not sum across
    /// unresolved steps and present the result as a total.
    resolved: bool,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    model: Option<String>,
    cost_usd: f64,
    /// MAF's own planning / placeholder-fill / extraction tokens for this
    /// step. Unlike the agent figures these *are* metered inline and stored on
    /// the execution, so they are correct the moment the step finishes.
    maf_tokens: i64,
    latency_ms: i64,
}

#[derive(Serialize)]
struct UsageTotals {
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    /// input + output across resolved steps only.
    agent_tokens: i64,
    /// MAF's own reasoning tokens across all steps, plus planning and final
    /// synthesis — i.e. `maf_executions.tokens_used`.
    maf_tokens: i64,
    cost_usd: f64,
}

#[derive(Serialize)]
struct ExecutionUsageResponse {
    execution_id: Uuid,
    /// The execution's own status, so a caller polling only this endpoint can
    /// tell a still-running workflow from a finished one.
    status: String,
    /// Nothing further to wait for: either every step resolved, or the
    /// execution finished long enough ago that anything still missing is not
    /// coming (an agent that made no LLM calls at all never produces a
    /// `trace_usage` row, so this must be bounded by time, not just by count).
    complete: bool,
    /// False when the trace-usage materializer isn't running on this
    /// deployment — either no observability backend is configured
    /// (`TEMPO_URL` unset) or the sync is switched off
    /// (`TRACE_USAGE_SYNC_SECS=0`). Agent usage never arrives in that case and
    /// every step stays unresolved forever, so this distinguishes "this
    /// deployment doesn't collect it" from "not ready yet" — without it a
    /// polling client could not tell the two apart.
    usage_available: bool,
    unresolved_steps: usize,
    steps: Vec<StepUsage>,
    totals: UsageTotals,
}

async fn get_execution_usage(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    claims: Claims,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    let row = match fetch_exec(&state.db, id).await {
        Ok(Some(row)) if row.user_id == user_id => row,
        Ok(Some(_)) => return forbidden("not owned by caller"),
        Ok(None) => return not_found("execution"),
        Err(e) => return internal_err(e),
    };

    let step_results: Vec<StepResult> = row
        .step_results
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    // One batched lookup for every step's trace, rather than a query per step.
    let trace_ids: Vec<String> = step_results
        .iter()
        .filter_map(|s| s.trace_id.clone())
        .collect();

    let rollups: Vec<TraceUsageRollup> = if trace_ids.is_empty() {
        Vec::new()
    } else {
        match sqlx::query_as::<_, TraceUsageRollup>(
            r#"SELECT trace_id,
                      COALESCE(SUM(input_tokens), 0)::BIGINT          AS input_tokens,
                      COALESCE(SUM(output_tokens), 0)::BIGINT         AS output_tokens,
                      COALESCE(SUM(cache_read_tokens), 0)::BIGINT     AS cache_read_tokens,
                      COALESCE(SUM(cache_creation_tokens), 0)::BIGINT AS cache_creation_tokens,
                      COALESCE(SUM(cost_usd), 0)::DOUBLE PRECISION    AS cost_usd,
                      CASE WHEN COUNT(DISTINCT model) = 1 THEN MIN(model) END AS model
               FROM trace_usage
               WHERE trace_id = ANY($1)
               GROUP BY trace_id"#,
        )
        .bind(&trace_ids)
        .fetch_all(&state.db)
        .await
        {
            Ok(rows) => rows,
            Err(e) => return internal_err(e),
        }
    };

    let by_trace: std::collections::HashMap<&str, &TraceUsageRollup> =
        rollups.iter().map(|r| (r.trace_id.as_str(), r)).collect();

    let mut totals = UsageTotals {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        agent_tokens: 0,
        maf_tokens: row.tokens_used,
        cost_usd: 0.0,
    };

    let steps: Vec<StepUsage> = step_results
        .iter()
        .map(|s| {
            let usage = s.trace_id.as_deref().and_then(|t| by_trace.get(t).copied());
            match usage {
                Some(u) => {
                    totals.input_tokens += u.input_tokens;
                    totals.output_tokens += u.output_tokens;
                    totals.cache_read_tokens += u.cache_read_tokens;
                    totals.cache_creation_tokens += u.cache_creation_tokens;
                    totals.cost_usd += u.cost_usd;
                    StepUsage {
                        step_index: s.step_index,
                        agent_name: s.agent_name.clone(),
                        trace_id: s.trace_id.clone(),
                        resolved: true,
                        input_tokens: u.input_tokens,
                        output_tokens: u.output_tokens,
                        cache_read_tokens: u.cache_read_tokens,
                        cache_creation_tokens: u.cache_creation_tokens,
                        model: u.model.clone(),
                        cost_usd: u.cost_usd,
                        maf_tokens: s.tokens_used,
                        latency_ms: s.latency_ms,
                    }
                }
                None => StepUsage {
                    step_index: s.step_index,
                    agent_name: s.agent_name.clone(),
                    trace_id: s.trace_id.clone(),
                    resolved: false,
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    model: None,
                    cost_usd: 0.0,
                    maf_tokens: s.tokens_used,
                    latency_ms: s.latency_ms,
                },
            }
        })
        .collect();

    totals.agent_tokens = totals.input_tokens + totals.output_tokens;

    let unresolved_steps = steps.iter().filter(|s| !s.resolved).count();
    // Must mirror the condition the materializer is actually spawned under
    // (`state.rs`) — gating on the interval alone would report usage as
    // "coming" on a deployment with no observability backend at all.
    let usage_available =
        state.config.observability_enabled && state.config.trace_usage_sync_secs > 0;
    let terminal = matches!(row.status.as_str(), "success" | "failed");

    // Two full materializer passes after the run ended is the point past
    // which anything still missing isn't arriving — most often because the
    // step's agent made no LLM calls, which produces no `trace_usage` row at
    // all and would otherwise keep a polling client going forever.
    let grace = chrono::Duration::seconds((state.config.trace_usage_sync_secs as i64) * 2);
    let settled = row
        .completed_at
        .is_some_and(|finished| Utc::now() - finished > grace);

    let complete = !usage_available || (terminal && (unresolved_steps == 0 || settled));

    ok_json(
        StatusCode::OK,
        ExecutionUsageResponse {
            execution_id: row.id,
            status: row.status,
            complete,
            usage_available,
            unresolved_steps,
            steps,
            totals,
        },
        "Execution usage retrieved successfully",
    )
}

// ─── POST /maf/generate ───────────────────────────────────────────────────
// Takes a natural language description, uses LLM to plan the MAF steps
// (agent selection, prompt templates, to_extract labels, output_generation guidelines),
// and returns a ready-to-POST draft that the caller can review then create.

#[derive(Deserialize)]
struct GenerateMafRequest {
    description: String,
}

#[derive(Serialize)]
struct GeneratedStep {
    agent_id: Uuid,
    agent_name: String,
    task_description: String,
}

#[derive(Serialize)]
struct GenerateMafResponse {
    name: String,
    description: String,
    output_generation: String,
    steps: Vec<GeneratedStep>,
}

async fn generate_maf(
    State(state): State<AppState>,
    claims: Claims,
    Json(req): Json<GenerateMafRequest>,
) -> impl IntoResponse {
    let user_id = match parse_user_id(&claims) {
        Some(u) => u,
        None => return unauthorized(),
    };

    if req.description.trim().is_empty() {
        return bad_request("description is required");
    }

    // Build LLM client from config — require an API key
    let api_key = match &state.config.openai_api_key {
        Some(k) => k.clone(),
        None => {
            return err_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "OPENAI_API_KEY is not configured on this server",
            );
        }
    };
    let llm = LlmClient::new(
        state.http_client.clone(),
        api_key,
        state.config.openai_base_url.clone(),
        state.config.openai_model.clone(),
    );

    // Fetch all agents visible to this user
    let agent_rows = match fetch_user_agents(&state.db, user_id).await {
        Ok(a) => a,
        Err(e) => return internal_err(e),
    };

    if agent_rows.is_empty() {
        return bad_request(
            "no agents registered — register at least one agent before generating a MAF",
        );
    }

    let planner_agents: Vec<PlannerAgentInfo> = agent_rows
        .iter()
        .map(|a| PlannerAgentInfo {
            id: a.id,
            name: a.name.clone(),
            description: a.description.clone(),
        })
        .collect();

    match planner::plan_maf(&req.description, &planner_agents, &llm).await {
        Ok(plan) => {
            // Enrich steps with agent names for the response
            let steps: Vec<GeneratedStep> = plan
                .steps
                .into_iter()
                .map(|s| {
                    let name = agent_rows
                        .iter()
                        .find(|a| a.id == s.agent_id)
                        .map(|a| a.name.clone())
                        .unwrap_or_default();
                    GeneratedStep {
                        agent_id: s.agent_id,
                        agent_name: name,
                        task_description: s.task_description,
                    }
                })
                .collect();

            ok_json(
                StatusCode::OK,
                GenerateMafResponse {
                    name: plan.name,
                    description: plan.description,
                    output_generation: plan.output_generation,
                    steps,
                },
                "Workflow plan generated successfully",
            )
        }
        Err(e) => err_json(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("planning failed: {e}"),
        ),
    }
}

// ─── DB helpers ────────────────────────────────────────────────────────────

async fn fetch_maf(db: &sqlx::PgPool, id: Uuid) -> Result<Option<MafRow>, sqlx::Error> {
    sqlx::query_as::<_, MafRow>(
        r#"SELECT m.id, m.user_id, m.name, m.description, m.maf_json::text AS maf_json,
                  m.status, m.created_at, m.updated_at,
                  (SELECT COUNT(*) FROM maf_executions e WHERE e.maf_id = m.id) AS execution_count
           FROM mafs m WHERE m.id = $1 AND m.status = 'active'"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn fetch_exec(db: &sqlx::PgPool, id: Uuid) -> Result<Option<ExecRow>, sqlx::Error> {
    sqlx::query_as::<_, ExecRow>(
        r#"SELECT id, execution_number, maf_id, user_id, status, attempt_count, max_attempts, tokens_used,
                  started_at, completed_at, duration_ms, output,
                  step_results::text AS step_results, error, created_at
           FROM maf_executions WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

async fn fetch_agent_info(
    db: &sqlx::PgPool,
    agent_id: Uuid,
) -> Result<Option<(String, String)>, sqlx::Error> {
    sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT name, url FROM agents WHERE id = $1 AND deleted_at IS NULL ORDER BY name",
    )
    .bind(agent_id)
    .fetch_optional(db)
    .await
    .map(|opt| opt.map(|(name, url)| (name, url.unwrap_or_default())))
}

#[derive(sqlx::FromRow)]
struct AgentInfo {
    id: Uuid,
    name: String,
    url: Option<String>,
    description: Option<String>,
}

async fn fetch_user_agents(
    db: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<Vec<AgentInfo>, sqlx::Error> {
    sqlx::query_as::<_, AgentInfo>(
        "SELECT id, name, url, description FROM agents WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY name",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}
