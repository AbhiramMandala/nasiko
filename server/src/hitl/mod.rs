//! HITL resume dispatcher (`docs/HITL_IMPLEMENTATION_PLAN.md` §3.2, Phase 3). Delivers a human's
//! answer back onto the same A2A `taskId`/`contextId` the agent paused on. Shape mirrors
//! `agents/build_worker.rs`: poll/notify, atomically claim one row, execute in a panic-isolated
//! spawned task.

use std::time::Duration;

use futures::StreamExt;
use nasiko_hitl::{HitlOrigin, HitlRequest, NewHitlRequest};
use nasiko_types::a2a::StreamDisposition;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::router::a2a_dispatch::{build_pause_question, pause_kind, resolve_endpoint};
use crate::state::AppState;

/// Delivery attempts before a resume gives up and `resume_status` becomes the terminal `failed`
/// (§3.2) — a pre-flight failure (connection refused, DNS, timeout) releases the lease and
/// retries via the next poll until this cap is hit.
const MAX_RESUME_ATTEMPTS: i32 = 5;
/// How long a claim is honored before another dispatcher process may steal it (§3.2's exact
/// claim query, implemented in `HitlStore::claim_for_resume`).
const LEASE_SECS: i64 = 120;

/// Spawned once at server startup (`state.rs::from_config_with_db`), same as the build worker.
pub async fn run(state: AppState, mut notify: mpsc::Receiver<()>) {
    tracing::info!("hitl dispatcher: started");
    loop {
        tokio::select! {
            msg = notify.recv() => {
                if msg.is_none() {
                    // Sender was dropped — server is shutting down.
                    tracing::info!("hitl dispatcher: notification channel closed, exiting");
                    return;
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }

        match state.hitl_store.expire_stale().await {
            Ok(0) => {}
            Ok(n) => tracing::info!(count = n, "hitl dispatcher: expired stale pending rows"),
            Err(e) => tracing::error!(%e, "hitl dispatcher: expire_stale error"),
        }

        // Drain: keep claiming until the queue is empty, same pattern as build_worker.
        loop {
            let claimed = match state.hitl_store.claim_for_resume(LEASE_SECS).await {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(e) => {
                    tracing::error!(%e, "hitl dispatcher: claim error");
                    break;
                }
            };

            let state_clone = state.clone();
            match tokio::task::spawn(async move { deliver(state_clone, claimed).await }).await {
                Ok(()) => {}
                Err(e) if e.is_panic() => {
                    // The row's lease is still held; §3.2's MVP-scope note: a crash mid-window
                    // sticks visibly until Phase 9's recovery sweep ships — not silently lost.
                    tracing::error!("hitl dispatcher: delivery task panicked");
                }
                Err(_) => break, // task cancelled (server shutdown)
            }
        }
    }
}

async fn deliver(state: AppState, row: HitlRequest) {
    // `claim_for_resume` has no attempts cap of its own — a row only reaches this many attempts
    // by surviving past every prior attempt's own cap check without a clean completed/failed
    // outcome, i.e. the dispatcher process itself crashed mid-delivery on each one. A clean
    // HTTP/parse failure already self-terminates via `mark_resume_failed`'s cap check, so this
    // guard only ever fires for that crash case — surface it distinctly rather than retrying
    // forever.
    if row.resume_dispatch_attempts >= MAX_RESUME_ATTEMPTS {
        tracing::warn!(
            id = %row.id,
            attempts = row.resume_dispatch_attempts,
            "hitl dispatcher: giving up after repeated crash-interrupted attempts"
        );
        let _ = state.hitl_store.mark_resume_unknown(row.id).await;
        return;
    }
    if !matches!(row.origin, HitlOrigin::DirectChat | HitlOrigin::AgentProxy) {
        // Unreachable today — nothing creates orchestrator/maf/mcp_tool rows yet (Phases 6-8).
        // Defensive, not a real path.
        tracing::warn!(id = %row.id, origin = ?row.origin, "hitl dispatcher: unsupported origin");
        let _ = state
            .hitl_store
            .mark_resume_failed(
                row.id,
                "origin not yet supported by the resume dispatcher",
                0,
            )
            .await;
        return;
    }
    let (Some(task_id), Some(context_id)) = (row.task_id.clone(), row.context_id.clone()) else {
        let _ = state
            .hitl_store
            .mark_resume_failed(row.id, "row is missing task_id/context_id", 0)
            .await;
        return;
    };

    let agent_name: Option<String> = sqlx::query_scalar("SELECT name FROM agents WHERE id = $1")
        .bind(row.agent_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten();
    let Some(agent_name) = agent_name else {
        let _ = state
            .hitl_store
            .mark_resume_failed(row.id, "agent no longer exists", MAX_RESUME_ATTEMPTS)
            .await;
        return;
    };

    let endpoint = match resolve_endpoint(&state, &row.agent_id.to_string(), &agent_name).await {
        Ok(e) => e,
        Err(e) => {
            let _ = state
                .hitl_store
                .mark_resume_failed(row.id, &e, MAX_RESUME_ATTEMPTS)
                .await;
            return;
        }
    };

    let answer = answer_text(&row);
    let req_body = nasiko_types::a2a::build_stream_request_for_task(&answer, &context_id, &task_id);

    // Reused for the initial send and (non-streaming path only) the one-shot `message/send`
    // retry — same headers, same delegation token, different body.
    let build_req = |body: &nasiko_types::a2a::JsonRpcRequest| {
        let mut req = state
            .http_client
            .post(&endpoint)
            .header("A2A-Version", "1.0");
        if let Ok(jwt_secret) = std::env::var("JWT_SECRET")
            && let Ok(delegation_token) = nasiko_auth::jwt::mint_delegation_token(
                &jwt_secret,
                &row.owner_user_id.to_string(),
                &row.agent_id.to_string(),
            )
        {
            req = req.header("x-nasiko-agent-token", delegation_token);
        }
        req.json(body)
    };

    let response = match build_req(&req_body).send().await {
        Ok(r) => r,
        Err(e) => {
            // Pre-flight failure — never left Nasiko. Retried via the lease under the cap.
            let _ = state
                .hitl_store
                .mark_resume_failed(
                    row.id,
                    &format!("agent request failed: {e}"),
                    MAX_RESUME_ATTEMPTS,
                )
                .await;
            return;
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let _ = state
            .hitl_store
            .mark_resume_failed(row.id, &format!("agent HTTP {status}"), MAX_RESUME_ATTEMPTS)
            .await;
        return;
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let outcome = if content_type.contains("text/event-stream") {
        consume_sse_to_terminal(response).await
    } else {
        consume_json_to_terminal(response, &context_id, &task_id, &answer, &build_req).await
    };

    let Some((disposition, last_data, reply_text)) = outcome else {
        let _ = state
            .hitl_store
            .mark_resume_failed(
                row.id,
                "agent response could not be classified",
                MAX_RESUME_ATTEMPTS,
            )
            .await;
        return;
    };

    // Delivery succeeded — a response was received and classified — regardless of the agent's
    // own business outcome (§3.2: "peer confirmed receipt").
    let _ = state.hitl_store.mark_resume_completed(row.id).await;
    record_resume_trail(&state, &row, &agent_name, disposition).await;

    if disposition != StreamDisposition::Paused {
        // A follow-up pause (below) gets its own row and its own future resolution instead —
        // nothing final to show in chat history yet.
        persist_resume_reply(&state, &row, &context_id, reply_text).await;
    }

    if disposition == StreamDisposition::Paused {
        // Sequential HITL (§3.5): the resumed task paused again. New row, same task/context.
        let data = last_data.as_deref().unwrap_or("{}");
        let question = build_pause_question(data);
        let kind = pause_kind(data);
        let new_row = match row.origin {
            HitlOrigin::AgentProxy => NewHitlRequest::agent_proxy(
                kind,
                row.agent_id,
                row.owner_user_id,
                task_id,
                context_id,
                question,
            ),
            _ => NewHitlRequest::direct_chat(
                kind,
                row.agent_id,
                row.owner_user_id,
                task_id,
                context_id,
                question,
            ),
        };
        if let Err(e) = state.hitl_store.create(new_row).await {
            tracing::error!(id = %row.id, %e, "hitl dispatcher: failed to persist the follow-up pause");
        }
    }
}

/// The text sent back to the agent as the human's reply. `input_required` carries `answer`
/// directly; `auth_required` has no free-text answer — only a "confirm" resolve ever reaches the
/// dispatcher (a "start" resolve leaves the row `pending`, `router/hitl.rs::resolve`), so
/// `auth_outcome` is always `"confirmed"` by this point. The literal reply is `"authorized"`, not
/// a paraphrase — an agent's own `AuthRequired` pause message is free to tell the human to "reply
/// authorized" (`docs/HITL_REFERENCE_AGENT.md`'s documented convention), and a deterministic agent
/// may match that reply literally rather than semantically, so the platform must echo back exactly
/// the word it told the human to send. The agent determines the real outcome from its own next
/// response either way (§7's "intent ≠ success").
fn answer_text(row: &HitlRequest) -> String {
    let response = row.human_response.as_ref();
    if let Some(answer) = response
        .and_then(|r| r.get("answer"))
        .and_then(|v| v.as_str())
    {
        return answer.to_string();
    }
    match response
        .and_then(|r| r.get("auth_outcome"))
        .and_then(|v| v.as_str())
    {
        Some(_) => "authorized".to_string(),
        None => String::new(),
    }
}

/// Reads the agent's streaming reply to its first terminal or paused event — no client to relay
/// to, so unlike `agent_stream()` this only classifies, it doesn't yield SSE frames. Returns the
/// disposition, the raw `data:` payload of the event that produced it (used to extract a failure
/// message or build a follow-up pause's `question`), and the reply text accumulated across
/// *every* event seen, not just the terminal one — confirmed live that a real agent's answer
/// commonly arrives as `artifactUpdate` chunks classified `Continue`, with the terminal
/// `TASK_STATE_COMPLETED` event itself carrying no text at all; capturing only the terminal
/// event's own data would silently lose the reply for exactly that (common) case. Reuses
/// `agent_proxy.rs`'s own accumulation logic (`artifact_chunk_text`/`task_reply_text`/
/// `message_parts_text`) rather than re-deriving it. `None` only on a transport error mid-stream;
/// a stream that closes with no explicit terminal event is treated as `Completed`, mirroring
/// `agent_stream`'s own "stream closed" == done assumption for well-behaved agents.
async fn consume_sse_to_terminal(
    response: reqwest::Response,
) -> Option<(StreamDisposition, Option<String>, Option<String>)> {
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut last_data: Option<String> = None;
    let mut artifact_text = String::new();
    let mut terminal_text: Option<String> = None;

    while let Some(chunk) = byte_stream.next().await {
        let chunk = chunk.ok()?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim_end_matches('\r').to_string();
            buffer = buffer[line_end + 1..].to_string();

            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            last_data = Some(data.to_string());

            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                let result = event.get("result").unwrap_or(&event);
                if let Some(text) = crate::agent_proxy::artifact_chunk_text(result) {
                    artifact_text.push_str(&text);
                } else if let Some(text) = crate::agent_proxy::task_reply_text(result)
                    .or_else(|| crate::agent_proxy::message_parts_text(result))
                {
                    terminal_text = Some(text);
                }
            }

            let disposition = nasiko_types::a2a::classify_stream_disposition(data);
            if disposition != StreamDisposition::Continue {
                let reply_text = if !artifact_text.is_empty() {
                    Some(artifact_text)
                } else {
                    terminal_text
                };
                return Some((disposition, last_data, reply_text));
            }
        }
    }

    let reply_text = if !artifact_text.is_empty() {
        Some(artifact_text)
    } else {
        terminal_text
    };
    Some((StreamDisposition::Completed, last_data, reply_text))
}

/// Non-streaming (`message/send`-style) reply path. On a JSON-RPC `error`, retries once with
/// plain `message/send` (via `build_send_request_for_task`) — mirrors `a2a_dispatch.rs`'s own
/// dispatch-time fallback, which this originally lacked. Still `error` after the retry (or the
/// retry itself fails to send/parse) is treated as a failed delivery outcome, same as before.
async fn consume_json_to_terminal(
    response: reqwest::Response,
    context_id: &str,
    task_id: &str,
    answer: &str,
    build_req: impl Fn(&nasiko_types::a2a::JsonRpcRequest) -> reqwest::RequestBuilder,
) -> Option<(StreamDisposition, Option<String>, Option<String>)> {
    let mut body: serde_json::Value = response.json().await.ok()?;

    if body.get("error").is_some() {
        let retry_body =
            nasiko_types::a2a::build_send_request_for_task(answer, context_id, task_id);
        if let Ok(retry_response) = build_req(&retry_body).send().await
            && let Ok(retry_json) = retry_response.json::<serde_json::Value>().await
        {
            body = retry_json;
        }
    }

    let data = body.to_string();
    if body.get("error").is_some() {
        return Some((StreamDisposition::Failed, Some(data), None));
    }

    let disposition = match nasiko_types::a2a::classify_stream_disposition(&data) {
        StreamDisposition::Continue => StreamDisposition::Completed,
        other => other,
    };
    // Non-streaming replies are self-contained (no chunked artifactUpdate to accumulate across),
    // so `extract_text` on the whole body — same helper `agent_stream()`'s own non-streaming
    // branch uses — is enough here, unlike the streaming path above.
    let reply_text = nasiko_types::a2a::extract_text(body.get("result").unwrap_or(&body));
    Some((disposition, Some(data), reply_text))
}

/// Minimal observable trail for the resumed call — required by the plan's own Governing
/// Principle (§1: a `hitl_requests` row is "associated with, never a replacement for" the owning
/// subsystem's own durable state; for direct chat that's `flows`/`session_traces`. The agent's
/// actual reply text is a separate concern, handled by `persist_resume_reply` below —
/// deliberately not folded in here, since this function runs for every disposition and that one
/// only makes sense for a real terminal reply. Still not duplicated here: OTel span content
/// capture, token-usage summarization — presentation/telemetry polish, not correctness.
async fn record_resume_trail(
    state: &AppState,
    row: &HitlRequest,
    agent_name: &str,
    disposition: StreamDisposition,
) {
    let flow_id = Uuid::new_v4().to_string();

    let _ = sqlx::query(
        r#"INSERT INTO flows (flow_id, user_id, root_agent_id, root_agent_name, title, status, metadata)
           VALUES ($1, $2, $3, $4, $5, 'running', '{}'::jsonb)
           ON CONFLICT (flow_id) DO NOTHING"#,
    )
    .bind(&flow_id)
    .bind(row.owner_user_id)
    .bind(row.agent_id)
    .bind(agent_name)
    .bind("HITL resume")
    .execute(&state.db)
    .await;

    if let Some(context_id) = &row.context_id {
        let _ = sqlx::query(
            "INSERT INTO session_traces (session_id, trace_id, agent_id, agent_name) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (session_id, trace_id) DO NOTHING",
        )
        .bind(context_id)
        .bind(&flow_id)
        .bind(row.agent_id)
        .bind(agent_name)
        .execute(&state.db)
        .await;
    }

    let status = match disposition {
        StreamDisposition::Completed | StreamDisposition::Continue => "completed",
        StreamDisposition::Failed => "failed",
        StreamDisposition::Paused => "paused",
    };
    let _ = sqlx::query(
        r#"UPDATE flows SET status = $2,
           duration_ms = EXTRACT(EPOCH FROM (now() - created_at))::bigint * 1000,
           completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN now() ELSE completed_at END
           WHERE flow_id = $1"#,
    )
    .bind(&flow_id)
    .bind(status)
    .execute(&state.db)
    .await;
}

/// Persists the agent's final reply after a successful (non-`Paused`) resume into
/// `chat_messages`, so any caller — not just a future UI — can read what the agent actually
/// said, not just that delivery succeeded (`resume_status: completed` only ever meant "a valid
/// terminal response was received," never "here's what it was").
///
/// `agent_stream()`'s direct-chat branch never creates a `chat_sessions` row itself — only
/// `orchestrator_stream()`'s `ensure_orchestrator_chat_session` does, and only for the
/// routing-engine path. A session row for a direct-chat conversation exists today only if the
/// caller (e.g. the web UI, via its own `/api/chat/sessions/{id}/messages` call) separately made
/// one. Every request this dispatcher handles is a resume of an *existing* pause, so no such row
/// may exist at all — a bare `INSERT INTO chat_messages` would fail outright on the FK
/// (`chat_messages.session_id REFERENCES chat_sessions(session_id)`). The idempotent upsert below
/// mirrors `ensure_orchestrator_chat_session`'s exact pattern (`a2a_dispatch.rs`) and is safe
/// whether or not a session row already exists.
async fn persist_resume_reply(
    state: &AppState,
    row: &HitlRequest,
    context_id: &str,
    reply_text: Option<String>,
) {
    let Some(text) = reply_text.filter(|t| !t.is_empty()) else {
        return;
    };

    let _ = sqlx::query(
        "INSERT INTO chat_sessions (session_id, user_id, agent_id, agent_url, title) \
         VALUES ($1, $2, $3, '/api/orchestrator/a2a', 'New chat') \
         ON CONFLICT (session_id) DO NOTHING",
    )
    .bind(context_id)
    .bind(row.owner_user_id)
    .bind(row.agent_id)
    .execute(&state.db)
    .await;

    let _ = sqlx::query(
        "INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'assistant', $2)",
    )
    .bind(context_id)
    .bind(&text)
    .execute(&state.db)
    .await;
}
