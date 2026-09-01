//! MCP JSON-RPC handlers for the aggregating gateway.
//!
//! Permission enforcement is two-layer, in order: Layer 1 — can the caller reach
//! this connector at all (owner/grant/composio); Layer 2 — is the tool allowed
//! for this agent. Composio meta-tools are never filtered at list; per-toolkit
//! enforcement happens here at `tools/call` via slug→connector resolution.

use serde_json::{Value, json};
use uuid::Uuid;

use crate::aggregator;
use crate::error::McpError;
use crate::permissions::{self, PermissionContext, ToolAccess, toolkit_from_composio_slug};
use crate::provider::generic::DEFAULT_CALL_TIMEOUT;
use crate::router;
use crate::session::{self, ResolvedSession};
use crate::state::McpState;
use crate::types::{ConnectorUnusable, MCPServerConfig, PROTOCOL_VERSION, ServerType, codes};

fn ok(req_id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": req_id, "result": result })
}

fn err(req_id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": req_id, "error": { "code": code, "message": message.into() } })
}

/// Like [`err`] but carries a `data` object (e.g. the human-readable connector
/// name, so the route layer's approval flow event stays readable — id-based tool
/// prefixes are otherwise opaque).
fn err_data(req_id: &Value, code: i64, message: impl Into<String>, data: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": req_id, "error": { "code": code, "message": message.into(), "data": data } })
}

/// Build a JSON-RPC error object (for the route layer's identity failures).
pub fn rpc_error(req_id: &Value, code: i64, message: impl Into<String>) -> Value {
    err(req_id, code, message)
}

/// Full JSON-RPC dispatch for the agent-facing gateway. Returns `None` for a
/// notification (a request with no `id`).
pub async fn handle_request(
    state: &McpState,
    user_id: Uuid,
    agent_id: Uuid,
    body: &Value,
    traceparent: Option<&str>,
) -> Option<Value> {
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");

    let Some(req_id) = body.get("id").cloned() else {
        tracing::debug!(method, "mcp notification");
        return None;
    };

    match method {
        "initialize" => return Some(handle_initialize(&req_id)),
        "ping" => return Some(json!({ "jsonrpc": "2.0", "id": req_id, "result": {} })),
        _ => {}
    }

    let perms = match permissions::load_permission_context(state, agent_id).await {
        Ok(p) => p,
        Err(e) => return Some(err(&req_id, e.json_rpc_code(), e.to_json_rpc().message)),
    };
    let resolved = match session::resolve_session(state, user_id).await {
        Ok(r) => r,
        Err(e) => return Some(err(&req_id, e.json_rpc_code(), e.to_json_rpc().message)),
    };

    let result = match method {
        "tools/list" => {
            handle_tools_list(
                state,
                user_id,
                &req_id,
                &resolved.servers,
                &resolved.connected_toolkits,
                &perms,
                traceparent,
            )
            .await
        }
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            handle_tools_call(
                state,
                user_id,
                &req_id,
                &params,
                &resolved,
                &perms,
                traceparent,
            )
            .await
        }
        other => err(
            &req_id,
            codes::METHOD_NOT_FOUND,
            format!("Method not found: {other}"),
        ),
    };
    Some(result)
}

/// `initialize` — gateway capability handshake.
pub fn handle_initialize(req_id: &Value) -> Value {
    ok(
        req_id,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "MCP Gateway", "version": "1.0.0" },
        }),
    )
}

/// `tools/list` — aggregate, namespace, permission-filter, merge.
pub async fn handle_tools_list(
    state: &McpState,
    user_id: Uuid,
    req_id: &Value,
    servers: &[MCPServerConfig],
    connected_toolkits: &[String],
    perms: &PermissionContext,
    traceparent: Option<&str>,
) -> Value {
    match aggregator::aggregate_tools(
        state,
        user_id,
        servers,
        connected_toolkits,
        perms,
        traceparent,
    )
    .await
    {
        Ok(tools) => ok(req_id, json!({ "tools": tools })),
        Err(e) => err(req_id, e.json_rpc_code(), e.to_json_rpc().message),
    }
}

/// `tools/call` — route, enforce two-layer permissions, forward to the backend.
pub async fn handle_tools_call(
    state: &McpState,
    user_id: Uuid,
    req_id: &Value,
    params: &Value,
    resolved: &ResolvedSession,
    perms: &PermissionContext,
    traceparent: Option<&str>,
) -> Value {
    let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let mut arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    let (server, original) = match router::route_tool(tool_name, &resolved.servers) {
        Ok(pair) => pair,
        Err(e) => {
            if let Some((connector_id, info)) =
                router::unusable_reason_for_prefix(tool_name, &resolved.unusable_connectors)
                && info.reason == ConnectorUnusable::AuthRequired
            {
                return handle_auth_required(
                    state,
                    user_id,
                    req_id,
                    perms.agent_id,
                    connector_id,
                    &info.name,
                    traceparent,
                )
                .await;
            }
            return err(req_id, codes::INVALID_PARAMS, e.to_string());
        }
    };

    // ── Generic MCP tool: Layer 1 (reachability) then Layer 2 (decide) ─────
    if server.kind == ServerType::Mcp {
        match state
            .authorizer
            .can_access_connector(&state.db, user_id, server.connector_id)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                return err(
                    req_id,
                    codes::TOOL_BLOCKED,
                    format!("Connector for '{tool_name}' is not available."),
                );
            }
            Err(e) => return err(req_id, e.json_rpc_code(), e.to_json_rpc().message),
        }
        // Same decision `tools/list` filters on — a connector disabled for this
        // agent denies the call even though Layer 1 (owner/grant) still passes.
        match perms.decide(server.connector_id, &original) {
            ToolAccess::Denied => {
                return err(
                    req_id,
                    codes::TOOL_BLOCKED,
                    format!("Tool '{tool_name}' is blocked or disabled for this agent."),
                );
            }
            ToolAccess::Ask => {
                match resolve_tool_approval_retry(
                    state,
                    user_id,
                    perms.agent_id,
                    server.connector_id,
                    &original,
                    traceparent,
                )
                .await
                {
                    RetryOutcome::Proceed => {}
                    RetryOutcome::Denied => {
                        return err(
                            req_id,
                            codes::TOOL_BLOCKED,
                            format!(
                                "Tool '{tool_name}' was denied by the user. Do not retry this call."
                            ),
                        );
                    }
                    RetryOutcome::AskAgain => {
                        return ask_with_hitl_request(
                            state,
                            user_id,
                            perms.agent_id,
                            server.connector_id,
                            &original,
                            &server.name,
                            req_id,
                            traceparent,
                        )
                        .await;
                    }
                }
            }
            ToolAccess::Allowed => {}
        }
    }

    // ── Composio DIRECT tool call: enforce per-toolkit permission ───────────
    // A direct toolkit tool (e.g. GMAIL_SEND_EMAIL) resolves to its connector and
    // is subject to the same decide() as any other tool. Previously only the two
    // batch meta-tools below were checked, so a direct call bypassed enforcement
    // entirely (Round 3). Cross-toolkit meta-tools (COMPOSIO_SEARCH_TOOLS,
    // MANAGE_CONNECTIONS, MULTI_EXECUTE_TOOL) resolve to toolkit "composio", which
    // maps to no connector — they skip this block and are handled below / passed
    // through, exactly as before.
    if server.kind == ServerType::Composio
        && let Some(&cid) = resolved
            .toolkit_to_connector
            .get(&toolkit_from_composio_slug(tool_name))
    {
        match perms.decide(cid, tool_name) {
            ToolAccess::Denied => {
                return err(
                    req_id,
                    codes::TOOL_BLOCKED,
                    format!("Tool '{tool_name}' is blocked or disabled for this agent."),
                );
            }
            ToolAccess::Ask => {
                match resolve_tool_approval_retry(
                    state,
                    user_id,
                    perms.agent_id,
                    cid,
                    tool_name,
                    traceparent,
                )
                .await
                {
                    RetryOutcome::Proceed => {}
                    RetryOutcome::Denied => {
                        return err(
                            req_id,
                            codes::TOOL_BLOCKED,
                            format!(
                                "Tool '{tool_name}' was denied by the user. Do not retry this call."
                            ),
                        );
                    }
                    RetryOutcome::AskAgain => {
                        return ask_with_hitl_request(
                            state,
                            user_id,
                            perms.agent_id,
                            cid,
                            tool_name,
                            "composio",
                            req_id,
                            traceparent,
                        )
                        .await;
                    }
                }
            }
            ToolAccess::Allowed => {}
        }
    }

    // ── Composio meta-tool interception (per-toolkit → connector) ───────────
    if tool_name == "COMPOSIO_MANAGE_CONNECTIONS"
        && let Some(requested) = arguments.get("toolkits").and_then(|v| v.as_array())
    {
        let requested: Vec<String> = requested
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        let blocked: Vec<String> = requested
            .iter()
            .filter(|tk| connector_disabled(resolved, perms, tk))
            .cloned()
            .collect();
        if !blocked.is_empty() {
            let allowed: Vec<String> = requested
                .iter()
                .filter(|tk| !blocked.contains(tk))
                .cloned()
                .collect();
            if allowed.is_empty() {
                return err(
                    req_id,
                    codes::TOOL_BLOCKED,
                    format!("Toolkit(s) are disabled for this agent: {blocked:?}."),
                );
            }
            arguments["toolkits"] = json!(allowed);
        }
    }

    if tool_name == "COMPOSIO_MULTI_EXECUTE_TOOL"
        && let Some(tools_arg) = arguments.get("tools").and_then(|v| v.as_array()).cloned()
        && !tools_arg.is_empty()
    {
        let mut allowed: Vec<Value> = Vec::new();
        let mut blocked_slugs: Vec<String> = Vec::new();
        // A previously resolved `tool_approval` decision found on retry
        // (M8) — rejected, so this slug fails outright rather than being
        // re-asked; tracked separately from `blocked_slugs` since the
        // message ("denied by the user") is distinguishable from a
        // `Stance::Block`/disabled-connector denial.
        let mut denied_slugs: Vec<String> = Vec::new();
        // (connector_id, slug) — the connector id is kept alongside each
        // asked slug so a pending `tool_approval` row can be persisted per
        // tool below; the message text still renders as a bare slug list.
        let mut ask_tools: Vec<(Uuid, String)> = Vec::new();

        for t in &tools_arg {
            let slug = t.get("tool_slug").and_then(|v| v.as_str()).unwrap_or("");
            if slug.is_empty() {
                allowed.push(t.clone());
                continue;
            }
            let toolkit = toolkit_from_composio_slug(slug);
            match resolved.toolkit_to_connector.get(&toolkit) {
                Some(&cid) => match perms.decide(cid, slug) {
                    ToolAccess::Denied => blocked_slugs.push(slug.to_string()),
                    ToolAccess::Ask => {
                        match resolve_tool_approval_retry(
                            state,
                            user_id,
                            perms.agent_id,
                            cid,
                            slug,
                            traceparent,
                        )
                        .await
                        {
                            RetryOutcome::Proceed => allowed.push(t.clone()),
                            RetryOutcome::Denied => denied_slugs.push(slug.to_string()),
                            RetryOutcome::AskAgain => ask_tools.push((cid, slug.to_string())),
                        }
                    }
                    ToolAccess::Allowed => allowed.push(t.clone()),
                },
                None => allowed.push(t.clone()),
            }
        }

        if allowed.is_empty()
            && (!blocked_slugs.is_empty() || !denied_slugs.is_empty() || !ask_tools.is_empty())
        {
            if !ask_tools.is_empty() {
                let mut hitl_request_ids = Vec::with_capacity(ask_tools.len());
                for (cid, slug) in &ask_tools {
                    if let Some(id) = create_tool_approval_id(
                        state,
                        user_id,
                        perms.agent_id,
                        *cid,
                        slug,
                        traceparent,
                    )
                    .await
                    {
                        hitl_request_ids.push(id);
                    }
                }
                let ask_slugs: Vec<&String> = ask_tools.iter().map(|(_, s)| s).collect();
                return err_data(
                    req_id,
                    codes::TOOL_ASK,
                    format!("Tool(s) require user approval for this agent: {ask_slugs:?}."),
                    json!({ "server": "composio", "hitl_request_ids": hitl_request_ids }),
                );
            }
            if blocked_slugs.is_empty() {
                return err(
                    req_id,
                    codes::TOOL_BLOCKED,
                    format!("Tool(s) were denied by the user. Do not retry: {denied_slugs:?}."),
                );
            }
            if denied_slugs.is_empty() {
                return err(
                    req_id,
                    codes::TOOL_BLOCKED,
                    format!("All requested tools are blocked for this agent: {blocked_slugs:?}."),
                );
            }
            return err(
                req_id,
                codes::TOOL_BLOCKED,
                format!(
                    "All requested tools are blocked or were denied for this agent: \
                     blocked={blocked_slugs:?}, denied={denied_slugs:?}."
                ),
            );
        }
        if !blocked_slugs.is_empty() || !denied_slugs.is_empty() || !ask_tools.is_empty() {
            let ask_slugs: Vec<&String> = ask_tools.iter().map(|(_, s)| s).collect();
            tracing::info!(user = %user_id, agent = %perms.agent_id, ?blocked_slugs, ?denied_slugs, ?ask_slugs, forwarding = allowed.len(), "partial composio multi-execute filter");
            arguments["tools"] = json!(allowed);
        }
    }

    tracing::info!(tool = %tool_name, forwarded_as = %original, kind = ?server.kind, "routing tool call");

    match state
        .providers
        .mcp
        .call_tool(
            server,
            req_id,
            &original,
            &arguments,
            DEFAULT_CALL_TIMEOUT,
            traceparent,
        )
        .await
    {
        Ok(response) if server.kind == ServerType::Composio && response.get("error").is_some() => {
            match resolved
                .toolkit_to_connector
                .get(&toolkit_from_composio_slug(tool_name))
            {
                // Meta-tool (COMPOSIO_SEARCH_TOOLS/MANAGE_CONNECTIONS/...) or
                // an unmapped toolkit — nothing to check against.
                None => response,
                Some(&connector_id) => {
                    detect_composio_auth_required(
                        state,
                        user_id,
                        req_id,
                        perms.agent_id,
                        connector_id,
                        traceparent,
                        response,
                    )
                    .await
                }
            }
        }
        Ok(response) => response,
        Err(e) => {
            // Self-heal: an uploaded_build connector's container can move
            // (restart/redeploy/reboot) between build time and this call. On
            // a connection-level failure (not an application-level MCP
            // error), ask the refresher for the container's current live
            // address and retry exactly once before giving up — mirrors this
            // gateway's own existing precedent for the structurally
            // identical Composio-connection staleness problem (refresh only
            // on-demand, never on every request).
            if server.trusted
                && is_connection_level_failure(&e)
                && let Some(new_url) = state.endpoint_refresher.refresh(server.connector_id).await
            {
                tracing::info!(server = %server.name, connector_id = %server.connector_id, "endpoint stale — retrying tool call against refreshed address");
                let mut refreshed = server.clone();
                refreshed.url = new_url;
                match state
                    .providers
                    .mcp
                    .call_tool(
                        &refreshed,
                        req_id,
                        &original,
                        &arguments,
                        DEFAULT_CALL_TIMEOUT,
                        traceparent,
                    )
                    .await
                {
                    Ok(response) => return response,
                    Err(e2) => {
                        tracing::warn!(server = %server.name, tool = %original, error = %e2, "backend tool call failed again after endpoint refresh");
                        return err(
                            req_id,
                            codes::INTERNAL_ERROR,
                            format!("Backend '{}' failed to execute '{}'", server.name, original),
                        );
                    }
                }
            }
            tracing::warn!(server = %server.name, tool = %original, error = %e, "backend tool call failed");
            err(
                req_id,
                codes::INTERNAL_ERROR,
                format!("Backend '{}' failed to execute '{}'", server.name, original),
            )
        }
    }
}

/// A composio-routed call's response carried a JSON-RPC `error` — before
/// passing it straight through unchanged, check whether the specific
/// toolkit's own connection is why.
///
/// Composio aggregates every one of a user's connected toolkits into a
/// single shared Tool Router session (`composio_config`'s
/// `connector_id: Uuid::nil()` — see `session.rs`), so unlike a generic
/// connector, whose broken credential is caught before the call ever goes
/// out (`build_generic_servers`'s pre-check populates `unusable_connectors`
/// at `tools/list` time), a broken Composio toolkit can only ever be
/// detected once a call to it actually fails — there is no per-toolkit
/// session to pre-check. This re-verifies the specific toolkit's live
/// status via the same `check_connection_status` call
/// `connect.rs::handle_composio_callback` already uses, and — only if
/// Composio itself confirms the connection isn't ACTIVE, never by guessing
/// from the error's message text (undocumented and unverified against the
/// live Tool Router) — routes through the exact same `handle_auth_required`
/// (M3) a generic connector uses, so persistence, the resolve API, the
/// dispatcher, and auto-resolve-on-reconnect (`connect.rs`'s own ACTIVE
/// branch) are all unconditionally shared, never reimplemented for
/// Composio. Any other tool-level failure (bad arguments, a real backend
/// error, ...) or a connection this check can't resolve falls through to
/// the original, unmodified response — this only ever narrows what counts
/// as `AuthRequired`, never widens it.
async fn detect_composio_auth_required(
    state: &McpState,
    user_id: Uuid,
    req_id: &Value,
    agent_id: Uuid,
    connector_id: Uuid,
    traceparent: Option<&str>,
    original_response: Value,
) -> Value {
    let Some(provider) = &state.providers.composio else {
        return original_response;
    };
    let Ok(Some(connector)) = crate::repo::get_connector_by_id(&state.db, connector_id).await
    else {
        return original_response;
    };
    let Some(auth_config_id) = connector.auth_config_id.as_deref() else {
        return original_response;
    };
    let Ok(check) = provider
        .check_connection_status(&user_id.to_string(), auth_config_id)
        .await
    else {
        return original_response;
    };
    if check.status.eq_ignore_ascii_case("ACTIVE") {
        return original_response;
    }

    tracing::info!(
        connector = %connector.name, %connector_id, status = %check.status,
        "composio tool call failed and the connection is no longer active — treating as auth_required"
    );
    handle_auth_required(
        state,
        user_id,
        req_id,
        agent_id,
        connector_id,
        &connector.name,
        traceparent,
    )
    .await
}

/// A tool call's connector needs the user to (re-)authenticate
/// (`ConnectorUnusable::AuthRequired`, from M1's credential-failure
/// plumbing) — persist a pending `hitl_requests` row (M2's store) and return
/// `codes::AUTH_REQUIRED` instead of the generic "connector not available"
/// error, so the agent (and, through it, the human) gets a distinguishable,
/// actionable signal instead of an indistinguishable dead end.
///
/// Deliberately does not build a fresh OAuth `auth_url` here (that's
/// `oauth::begin_authorization`, a side-effecting discovery/DCR call plus a
/// connector-row mutation — out of scope for detection) and does not push or
/// auto-retry anything (the resume dispatcher doesn't exist yet). The human
/// re-authenticates via the existing `POST /api/mcp/connect` flow; a future
/// milestone can enrich `question`/wire in the dispatcher without touching
/// this detection path.
async fn handle_auth_required(
    state: &McpState,
    user_id: Uuid,
    req_id: &Value,
    agent_id: Uuid,
    connector_id: Uuid,
    connector_name: &str,
    traceparent: Option<&str>,
) -> Value {
    let generic_error = || {
        err(
            req_id,
            codes::INVALID_PARAMS,
            format!(
                "Connector '{connector_name}' is not available for this agent. \
                 It may be disabled in the agent's permission settings."
            ),
        )
    };

    // No traceparent at all means nothing to correlate a resumable
    // conversation against — fall back to today's generic error rather than
    // persist a HITL row no future dispatcher could ever address.
    let Some(context_id) = session::resolve_context_id(state, traceparent).await else {
        tracing::warn!(
            connector = %connector_name, %connector_id,
            "auth_required detected but no traceparent to resolve a context_id from — falling back to generic error"
        );
        return generic_error();
    };

    let question = json!({
        "connector_id": connector_id,
        "connector": connector_name,
        "message": format!(
            "Authentication for connector '{connector_name}' is missing or no longer works. \
             A human must re-authenticate before this tool can be used again."
        ),
    });

    match nasiko_hitl::repo::create_pending_auth_required(
        &state.db,
        nasiko_hitl::NewAuthRequired {
            agent_id,
            owner_user_id: user_id,
            connector_id,
            context_id,
            question,
        },
    )
    .await
    {
        Ok(request) => err_data(
            req_id,
            codes::AUTH_REQUIRED,
            format!(
                "Authentication required for connector '{connector_name}'. A request has been \
                 recorded (id {}); ask the user to re-authenticate, then retry this tool.",
                request.id
            ),
            json!({ "connector": connector_name, "connector_id": connector_id, "hitl_request_id": request.id }),
        ),
        Err(e) => {
            tracing::error!(connector = %connector_name, %connector_id, error = %e, "failed to persist auth_required hitl request");
            generic_error()
        }
    }
}

/// Best-effort: persist a pending `tool_approval` row for one `(connector,
/// tool)` `Stance::Ask` decision (M2's store), returning its id. `None` when
/// there's no `traceparent` to resolve a `context_id` from (required by
/// `chk_hitl_tool_approval_identity`), or on a DB failure (logged) — either
/// way the caller still returns `TOOL_ASK`; persistence never changes the
/// ask/deny decision itself, only whether a row exists to resolve against
/// later. Shared by the single-tool ask path (`ask_with_hitl_request`) and
/// the `COMPOSIO_MULTI_EXECUTE_TOOL` batch-ask path, which persists one row
/// per asked tool.
async fn create_tool_approval_id(
    state: &McpState,
    user_id: Uuid,
    agent_id: Uuid,
    connector_id: Uuid,
    tool_name: &str,
    traceparent: Option<&str>,
) -> Option<Uuid> {
    let context_id = match session::resolve_context_id(state, traceparent).await {
        Some(id) => id,
        None => {
            tracing::warn!(
                tool = %tool_name, %connector_id,
                "tool_approval ask with no traceparent to resolve a context_id from — skipping hitl persistence"
            );
            return None;
        }
    };

    let question = json!({
        "connector_id": connector_id,
        "tool_name": tool_name,
        "message": format!("Tool '{tool_name}' requires user approval before it can run."),
    });

    match nasiko_hitl::repo::create_pending_tool_approval(
        &state.db,
        nasiko_hitl::NewToolApproval {
            agent_id,
            owner_user_id: user_id,
            connector_id,
            tool_name: tool_name.to_string(),
            context_id,
            question,
        },
    )
    .await
    {
        Ok(request) => Some(request.id),
        Err(e) => {
            tracing::error!(tool = %tool_name, %connector_id, error = %e, "failed to persist tool_approval hitl request");
            None
        }
    }
}

/// Outcome of checking whether an `Ask`-decision tool call has already been
/// resolved by a human, for M7's retry-matching lookup
/// ([`resolve_tool_approval_retry`]).
enum RetryOutcome {
    /// A session grant is active, or a previously approved `once`-scope
    /// request was atomically claimed — proceed with the tool call as if
    /// `Stance::Allow` had matched.
    Proceed,
    /// A previously rejected request was atomically claimed — fail the call
    /// outright instead of asking again.
    Denied,
    /// Nothing to resume against (no session grant, no unconsumed resolved
    /// row, or no `context_id` to look either up by) — ask, same as before M7.
    AskAgain,
}

/// M7's retry-matching lookup: called immediately after `perms.decide()`
/// returns `Ask`, before falling back to the normal ask-and-persist path.
/// Checks, in order: (1) an unexpired `mcp_session_tool_grants` row for this
/// exact `(agent_id, connector_id, tool_name, context_id)` tuple — reusable
/// for the rest of the conversation, never consumed; (2) failing that, an
/// atomic claim ([`nasiko_hitl::repo::claim_resolved_tool_approval`]) of the
/// most recent resolved, unconsumed row for the same tuple — single-use,
/// covers both an approved `once` retry and a rejected retry. A DB error at
/// either step degrades to `AskAgain` (logged) rather than failing the call
/// outright — the pre-M7 behavior (ask again) is always a safe fallback.
/// Takes a single `(connector_id, tool_name)` pair, so M8 reuses it unchanged
/// per-slug inside the `COMPOSIO_MULTI_EXECUTE_TOOL` batch loop, alongside its
/// two pre-existing single-tool call sites.
async fn resolve_tool_approval_retry(
    state: &McpState,
    user_id: Uuid,
    agent_id: Uuid,
    connector_id: Uuid,
    tool_name: &str,
    traceparent: Option<&str>,
) -> RetryOutcome {
    let Some(context_id) = session::resolve_context_id(state, traceparent).await else {
        return RetryOutcome::AskAgain;
    };

    // `session`-scope grants are keyed by the stable chat-session identity,
    // not the per-message trace context above (see
    // `repo::resolve_stable_session_context`'s own doc comment for the full
    // reasoning) — `once`-scope claiming below deliberately keeps using
    // `context_id` unchanged.
    let session_context_id = match nasiko_hitl::repo::resolve_stable_session_context(
        &state.db, user_id, agent_id,
    )
    .await
    {
        Ok(Some(session_id)) => session_id,
        Ok(None) => context_id.clone(),
        Err(e) => {
            tracing::warn!(
                %agent_id, %user_id, error = %e,
                "stable session lookup failed — falling back to trace context for session-grant matching"
            );
            context_id.clone()
        }
    };

    match nasiko_hitl::repo::has_active_session_grant(
        &state.db,
        agent_id,
        connector_id,
        tool_name,
        &session_context_id,
    )
    .await
    {
        Ok(true) => return RetryOutcome::Proceed,
        Ok(false) => {}
        Err(e) => {
            tracing::error!(
                %agent_id, %connector_id, tool = %tool_name, error = %e,
                "session grant lookup failed — falling back to ask"
            );
            return RetryOutcome::AskAgain;
        }
    }

    match nasiko_hitl::repo::claim_resolved_tool_approval(
        &state.db,
        agent_id,
        connector_id,
        tool_name,
        &context_id,
    )
    .await
    {
        Ok(Some(row)) => {
            let approved = row
                .human_response
                .as_ref()
                .and_then(|r| r.get("decision"))
                .and_then(Value::as_str)
                == Some("approve");
            if approved {
                RetryOutcome::Proceed
            } else {
                RetryOutcome::Denied
            }
        }
        Ok(None) => RetryOutcome::AskAgain,
        Err(e) => {
            tracing::error!(
                %agent_id, %connector_id, tool = %tool_name, error = %e,
                "tool_approval retry-claim failed — falling back to ask"
            );
            RetryOutcome::AskAgain
        }
    }
}

/// The single-tool `TOOL_ASK` response, enriched with a `hitl_request_id`
/// when persistence (`create_tool_approval_id`) succeeds. The response shape
/// and code are unchanged from before M4 when persistence doesn't happen —
/// `hitl_request_id` is purely additive in `data`.
#[allow(clippy::too_many_arguments)]
async fn ask_with_hitl_request(
    state: &McpState,
    user_id: Uuid,
    agent_id: Uuid,
    connector_id: Uuid,
    tool_name: &str,
    connector_label: &str,
    req_id: &Value,
    traceparent: Option<&str>,
) -> Value {
    let mut data = json!({ "server": connector_label });
    if let Some(id) = create_tool_approval_id(
        state,
        user_id,
        agent_id,
        connector_id,
        tool_name,
        traceparent,
    )
    .await
    {
        data["hitl_request_id"] = json!(id);
    }
    err_data(
        req_id,
        codes::TOOL_ASK,
        format!("Tool '{tool_name}' requires user approval. Grant access in the agent settings."),
        data,
    )
}

/// A connection-level failure (refused/timeout/DNS) — as opposed to an
/// application-level MCP error (a well-formed error response from a live
/// server) — is the only case worth refreshing the endpoint for; nothing else
/// indicates the address itself is stale.
fn is_connection_level_failure(e: &McpError) -> bool {
    matches!(e, McpError::Http(re) if re.is_connect() || re.is_timeout())
}

/// True when a Composio toolkit maps to a connector that is disabled for the agent.
fn connector_disabled(
    resolved: &ResolvedSession,
    perms: &PermissionContext,
    toolkit: &str,
) -> bool {
    resolved
        .toolkit_to_connector
        .get(&toolkit.to_ascii_lowercase())
        .map(|cid| !perms.is_connector_enabled(*cid))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::config::McpConfig;
    use crate::permissions::PermissionRule;
    use crate::provider::{GenericMcpProvider, Providers};
    use crate::types::Stance;

    fn test_state() -> McpState {
        let db = sqlx::PgPool::connect_lazy("postgres://user:pass@127.0.0.1:1/db")
            .expect("lazy pool construction must not touch the network");
        let redis = redis::Client::open("redis://127.0.0.1:1/").expect("lazy redis client");
        McpState {
            db,
            redis,
            http_client: reqwest::Client::new(),
            guarded_http_client: reqwest::Client::new(),
            config: McpConfig {
                composio_api_key: None,
                composio_base_url: "http://localhost".to_string(),
                composio_webhook_secret: None,
                gateway_public_url: None,
                oauth_redirect_base_url: None,
                composio_callback_base_url: None,
                session_ttl_seconds: 60,
                perm_cache_ttl_seconds: 60,
                manifest_ttl_seconds: 60,
                toolcount_ttl_seconds: 3600,
                oauth_state_signing_key: "test".to_string(),
                description_model: "gpt-4o-mini".to_string(),
            },
            providers: Providers {
                composio: None,
                mcp: GenericMcpProvider::new(reqwest::Client::new(), reqwest::Client::new()),
            },
            authorizer: std::sync::Arc::new(crate::authorizer::OssConnectorAuthorizer),
            endpoint_refresher: std::sync::Arc::new(crate::endpoint_refresh::NoopEndpointRefresher),
            llm: nasiko_orchestrator::providers::LLMProvider::from_env(reqwest::Client::new()),
        }
    }

    /// A resolved session with one Composio backend at `url` and a single
    /// connected `gmail` toolkit mapped to `cid`.
    fn gmail_session(url: &str, cid: Uuid) -> ResolvedSession {
        ResolvedSession {
            servers: vec![MCPServerConfig {
                connector_id: Uuid::nil(),
                kind: ServerType::Composio,
                name: "composio".into(),
                url: url.into(),
                headers: HashMap::new(),
                transport: "streamable_http".into(),
                trusted: false,
            }],
            connected_toolkits: vec!["gmail".into()],
            toolkit_to_connector: HashMap::from([("gmail".to_string(), cid)]),
            unusable_connectors: HashMap::new(),
        }
    }

    /// `enabled` must be given explicitly — under the default-deny allowlist,
    /// a connector referenced only by `rules` (with no tool rule at all, e.g.
    /// a bare "this connector is on" case) can't be inferred from `rules`
    /// alone.
    fn perms(enabled: &[Uuid], rules: Vec<PermissionRule>) -> PermissionContext {
        PermissionContext {
            agent_id: Uuid::nil(),
            enabled_connectors: enabled.iter().copied().collect(),
            rules,
            hash: "h".into(),
        }
    }

    fn rule(cid: Uuid, pat: &str, stance: Stance) -> PermissionRule {
        PermissionRule {
            connector_id: cid,
            tool_pattern: pat.into(),
            stance,
        }
    }

    /// Layer-1 stub that always allows — the real `OssConnectorAuthorizer`
    /// hits `state.db`, which `test_state()`'s lazily-connected pool can't
    /// actually reach; tests exercising the generic-MCP (`ServerType::Mcp`)
    /// path need this instead.
    struct AllowAllAuthorizer;
    #[async_trait::async_trait]
    impl crate::authorizer::ConnectorAuthorizer for AllowAllAuthorizer {
        async fn can_access_connector(
            &self,
            _db: &sqlx::PgPool,
            _user_id: Uuid,
            _connector_id: Uuid,
        ) -> crate::error::Result<bool> {
            Ok(true)
        }
        async fn list_accessible_connectors(
            &self,
            _db: &sqlx::PgPool,
            _user_id: Uuid,
        ) -> crate::error::Result<Vec<crate::repo::McpConnector>> {
            Ok(vec![])
        }
        async fn list_accessible_mcp_connectors(
            &self,
            _db: &sqlx::PgPool,
            _user_id: Uuid,
        ) -> crate::error::Result<Vec<crate::repo::McpConnector>> {
            Ok(vec![])
        }
        async fn list_access_reasons(
            &self,
            _db: &sqlx::PgPool,
            _connector: &crate::repo::McpConnector,
        ) -> crate::error::Result<Vec<crate::types::AccessReason>> {
            Ok(vec![])
        }
        async fn list_org_grant_consumers(
            &self,
            _db: &sqlx::PgPool,
            _connector_id: Uuid,
        ) -> crate::error::Result<(
            Vec<crate::types::OrgGrantConsumer>,
            Vec<crate::types::OrgGrantConsumer>,
        )> {
            Ok((vec![], vec![]))
        }
    }

    /// Always refreshes to a fixed URL — a fake
    /// [`crate::endpoint_refresh::EndpointRefresher`] standing in for the
    /// real `ContainerRuntime`-backed one (`oss/server`'s
    /// `RuntimeEndpointRefresher`, not constructible from this crate).
    struct FakeRefresher(String);
    #[async_trait::async_trait]
    impl crate::endpoint_refresh::EndpointRefresher for FakeRefresher {
        async fn refresh(&self, _connector_id: Uuid) -> Option<String> {
            Some(self.0.clone())
        }
    }

    /// A resolved session with one generic MCP backend (`ServerType::Mcp`,
    /// `trusted`) at `url`, namespaced under `cid`'s connector prefix.
    fn mcp_session(url: &str, cid: Uuid, trusted: bool) -> ResolvedSession {
        ResolvedSession {
            servers: vec![MCPServerConfig {
                connector_id: cid,
                kind: ServerType::Mcp,
                name: "uploaded-server".into(),
                url: url.into(),
                headers: HashMap::new(),
                transport: "streamable_http".into(),
                trusted,
            }],
            connected_toolkits: vec![],
            toolkit_to_connector: HashMap::new(),
            unusable_connectors: HashMap::new(),
        }
    }

    /// A mockito server answering `POST /mcp` with a successful JSON-RPC
    /// response — the "refreshed, now-reachable" address a retry lands on.
    /// Uses a `localhost`-hostname URL, not mockito's raw `127.0.0.1` form,
    /// per Step 7's own established gotcha (the first attempt to fail
    /// against a loopback URL): reqwest/hyper's normal request path handles
    /// both equally for a real request (unlike the SSRF guard's custom
    /// `Resolve` trait, which only fires for hostnames) — matching that
    /// convention here regardless, for consistency with this crate's other
    /// tests.
    async fn spawn_ok_backend() -> (mockito::ServerGuard, String) {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/mcp")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#)
            .create_async()
            .await;
        let url = format!("http://localhost:{}/mcp", server.socket_address().port());
        (server, url)
    }

    // ── Step 13: endpoint self-heal on connection failure ────────────────────

    #[tokio::test]
    async fn trusted_backend_connection_failure_retries_against_refreshed_endpoint() {
        let (_guard, fresh_url) = spawn_ok_backend().await;
        let mut state = test_state();
        state.authorizer = std::sync::Arc::new(AllowAllAuthorizer);
        state.endpoint_refresher = std::sync::Arc::new(FakeRefresher(fresh_url));

        let cid = Uuid::new_v4();
        // Port 1 is a well-known refused-connection target — this is a
        // genuine connection-level failure, not an application error.
        let resolved = mcp_session("http://127.0.0.1:1/mcp", cid, true);
        let p = perms(&[cid], vec![]);
        let tool = format!("{}__echo", crate::types::connector_prefix(cid));

        let res = handle_tools_call(
            &state,
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": tool, "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;

        assert_eq!(
            res["result"]["ok"],
            json!(true),
            "must succeed after retrying against the refreshed endpoint: {res}"
        );
    }

    #[tokio::test]
    async fn untrusted_backend_connection_failure_never_retries() {
        // An external_url connector (trusted=false) must never trigger a
        // refresh, even if the refresher would happily hand back a working
        // URL — refresh only ever applies to uploaded_build connectors.
        let (_guard, fresh_url) = spawn_ok_backend().await;
        let mut state = test_state();
        state.authorizer = std::sync::Arc::new(AllowAllAuthorizer);
        state.endpoint_refresher = std::sync::Arc::new(FakeRefresher(fresh_url));

        let cid = Uuid::new_v4();
        let resolved = mcp_session("http://127.0.0.1:1/mcp", cid, false);
        let p = perms(&[cid], vec![]);
        let tool = format!("{}__echo", crate::types::connector_prefix(cid));

        let res = handle_tools_call(
            &state,
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": tool, "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;

        assert_eq!(
            res["error"]["code"],
            json!(codes::INTERNAL_ERROR),
            "must surface the original failure, never retry: {res}"
        );
    }

    // ── Round 3: direct Composio tool calls must be permission-enforced ──────

    #[tokio::test]
    async fn composio_direct_tool_with_block_rule_is_denied_before_backend() {
        // url points nowhere reachable — a Denied decision must return before any
        // backend call, so this must not hang or error on the network.
        let cid = Uuid::new_v4();
        let resolved = gmail_session("http://127.0.0.1:9/mcp", cid);
        let p = perms(&[cid], vec![rule(cid, "GMAIL_SEND_*", Stance::Block)]);
        let res = handle_tools_call(
            &test_state(),
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": "GMAIL_SEND_EMAIL", "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;
        assert_eq!(res["error"]["code"], json!(codes::TOOL_BLOCKED), "{res}");
    }

    #[tokio::test]
    async fn composio_direct_tool_on_disabled_connector_is_denied() {
        let cid = Uuid::new_v4();
        let resolved = gmail_session("http://127.0.0.1:9/mcp", cid);
        let p = perms(&[], vec![]); // never enabled for the agent
        let res = handle_tools_call(
            &test_state(),
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": "GMAIL_SEND_EMAIL", "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;
        assert_eq!(res["error"]["code"], json!(codes::TOOL_BLOCKED), "{res}");
    }

    #[tokio::test]
    async fn composio_direct_tool_with_ask_rule_returns_tool_ask() {
        let cid = Uuid::new_v4();
        let resolved = gmail_session("http://127.0.0.1:9/mcp", cid);
        let p = perms(&[cid], vec![rule(cid, "*", Stance::Ask)]);
        let res = handle_tools_call(
            &test_state(),
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": "GMAIL_SEND_EMAIL", "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;
        assert_eq!(res["error"]["code"], json!(codes::TOOL_ASK), "{res}");
        assert!(
            res["error"]["data"].get("hitl_request_id").is_none(),
            "no traceparent means no context_id to persist against — the response must not \
             claim a hitl_request_id that doesn't exist: {res}"
        );
    }

    #[tokio::test]
    async fn composio_allowed_direct_tool_reaches_backend() {
        let mut backend = mockito::Server::new_async().await;
        let hit = backend
            .mock("POST", "/mcp")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#)
            .expect(1)
            .create_async()
            .await;

        let cid = Uuid::new_v4();
        let resolved = gmail_session(&format!("{}/mcp", backend.url()), cid);
        let p = perms(&[cid], vec![]); // explicitly enabled, no tool rules
        let res = handle_tools_call(
            &test_state(),
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": "GMAIL_SEND_EMAIL", "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;
        assert_eq!(res["result"]["ok"], json!(true), "{res}");
        hit.assert_async().await;
    }

    #[tokio::test]
    async fn composio_cross_toolkit_metatool_is_not_caught_by_per_toolkit_check() {
        // COMPOSIO_SEARCH_TOOLS resolves to toolkit "composio" (no connector), so
        // even with the gmail connector disabled it must NOT be denied by the
        // per-toolkit check — it proceeds to the backend (meta-tools are not
        // connector-scoped; MANAGE_CONNECTIONS/MULTI_EXECUTE do their own filtering).
        let mut backend = mockito::Server::new_async().await;
        let hit = backend
            .mock("POST", "/mcp")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#)
            .expect(1)
            .create_async()
            .await;

        let cid = Uuid::new_v4();
        let resolved = gmail_session(&format!("{}/mcp", backend.url()), cid);
        let p = perms(&[], vec![]); // gmail not enabled — irrelevant to a meta-tool
        let res = handle_tools_call(
            &test_state(),
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": "COMPOSIO_SEARCH_TOOLS", "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;
        assert!(
            res.get("error").is_none(),
            "a cross-toolkit meta-tool must not be blocked by the per-toolkit check: {res}"
        );
        hit.assert_async().await;
    }

    // ─── M3: AuthRequired routing ───────────────────────────────────────────

    /// A resolved session with an empty `servers` list and one connector
    /// recorded as unusable — mirrors what `session::resolve_session`
    /// produces when a connector's credential is missing/expired/disabled.
    fn unusable_mcp_session(cid: Uuid, reason: ConnectorUnusable, name: &str) -> ResolvedSession {
        ResolvedSession {
            servers: vec![],
            connected_toolkits: vec![],
            toolkit_to_connector: HashMap::new(),
            unusable_connectors: HashMap::from([(
                cid,
                crate::types::UnusableConnector {
                    reason,
                    name: name.to_string(),
                },
            )]),
        }
    }

    #[tokio::test]
    async fn auth_required_without_traceparent_falls_back_to_generic_error() {
        // No traceparent means nothing to correlate a resumable conversation
        // against; `resolve_context_id` short-circuits before touching the
        // DB, so this stays hermetic even though `test_state()`'s pool can't
        // reach a real Postgres. Confirms the pre-M3 message/code survive
        // unchanged for this fallback.
        let cid = Uuid::new_v4();
        let resolved = unusable_mcp_session(cid, ConnectorUnusable::AuthRequired, "github");
        let p = perms(&[], vec![]);
        let tool = format!("{}__list_repos", crate::types::connector_prefix(cid));

        let res = handle_tools_call(
            &test_state(),
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": tool, "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;

        assert_eq!(res["error"]["code"], json!(codes::INVALID_PARAMS), "{res}");
        assert!(
            res["error"]["message"]
                .as_str()
                .unwrap()
                .contains("not available"),
            "must fall back to the original generic message: {res}"
        );
    }

    #[tokio::test]
    async fn non_auth_required_reason_never_takes_the_auth_required_branch() {
        // NotConfigured/MissingCredential must still produce today's generic
        // "not available" error — only AuthRequired gets the new handling.
        // A (well-formed but unresolvable) traceparent is deliberately
        // supplied here: if the reason gate in `handle_tools_call` were ever
        // loosened to match on `Some(_)` instead of `AuthRequired`
        // specifically, this would start touching `state.db` — and, since
        // `test_state()`'s pool can't reach a real Postgres, still degrade to
        // the same generic error (not crash), but the whole point of the
        // gate is to skip that DB work entirely for non-AuthRequired reasons.
        let cid = Uuid::new_v4();
        let resolved = unusable_mcp_session(cid, ConnectorUnusable::NotConfigured, "github");
        let p = perms(&[], vec![]);
        let tool = format!("{}__list_repos", crate::types::connector_prefix(cid));

        let res = handle_tools_call(
            &test_state(),
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": tool, "arguments": {} }),
            &resolved,
            &p,
            Some("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"),
        )
        .await;

        assert_eq!(res["error"]["code"], json!(codes::INVALID_PARAMS), "{res}");
    }

    // ─── M4: ToolApproval persistence ───────────────────────────────────────

    #[tokio::test]
    async fn generic_mcp_ask_without_traceparent_returns_tool_ask_without_hitl_id() {
        // Same "no context_id, no DB touch" guarantee as AuthRequired's own
        // fallback (this test would hang/error against test_state()'s
        // unreachable pool if the ask path unconditionally tried to
        // persist) — Layer 2's Ask decision must still return TOOL_ASK even
        // when there's nothing to persist against.
        let mut state = test_state();
        state.authorizer = std::sync::Arc::new(AllowAllAuthorizer);
        let cid = Uuid::new_v4();
        let resolved = mcp_session("http://127.0.0.1:9/mcp", cid, false);
        let p = perms(&[cid], vec![rule(cid, "*", Stance::Ask)]);
        let tool = format!("{}__echo", crate::types::connector_prefix(cid));

        let res = handle_tools_call(
            &state,
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": tool, "arguments": {} }),
            &resolved,
            &p,
            None,
        )
        .await;

        assert_eq!(res["error"]["code"], json!(codes::TOOL_ASK), "{res}");
        assert!(
            res["error"]["data"].get("hitl_request_id").is_none(),
            "no traceparent means nothing was persisted: {res}"
        );
    }

    #[tokio::test]
    async fn generic_mcp_block_and_allow_are_unaffected_by_m4() {
        // Preserve-existing-behavior guard: Denied and Allowed decisions
        // never touch the new persistence path at all (only `Ask` does).
        let mut state = test_state();
        state.authorizer = std::sync::Arc::new(AllowAllAuthorizer);
        let cid = Uuid::new_v4();
        let resolved = mcp_session("http://127.0.0.1:9/mcp", cid, false);
        let tool = format!("{}__echo", crate::types::connector_prefix(cid));

        let blocked = handle_tools_call(
            &state,
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": tool, "arguments": {} }),
            &resolved,
            &perms(&[cid], vec![rule(cid, "*", Stance::Block)]),
            None,
        )
        .await;
        assert_eq!(
            blocked["error"]["code"],
            json!(codes::TOOL_BLOCKED),
            "{blocked}"
        );

        let disabled = handle_tools_call(
            &state,
            Uuid::new_v4(),
            &json!(1),
            &json!({ "name": tool, "arguments": {} }),
            &resolved,
            &perms(&[], vec![]), // connector never enabled
            None,
        )
        .await;
        assert_eq!(
            disabled["error"]["code"],
            json!(codes::TOOL_BLOCKED),
            "{disabled}"
        );
    }
}
