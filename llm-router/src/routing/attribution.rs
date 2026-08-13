//! Flow attribution — which user conversation an LLM call belongs to.
//!
//! The router never sees the caller's identity on the wire: an agent's only
//! credential is its agent-identity JWT, and arbitrary agent frameworks do not
//! propagate `traceparent`. But the control plane is the sole ingress — it
//! proxies every A2A call and writes a `flows` row *before* forwarding
//! (`agent_proxy` / `a2a_dispatch`) — so the conversation state is already in
//! the same database this router queries.
//!
//! Resolution order:
//!
//! 1. **Traceparent** (precise): the agent forwarded W3C trace context; its
//!    trace id *is* the flow id. Works for any OTel-instrumented agent.
//! 2. **Active-flow fallback** (zero-cooperation): no trace context ⇒ look up
//!    the agent's currently-running flow. Exactly one candidate is the common
//!    case (one conversation per agent at a time); concurrent flows are
//!    disambiguated by matching the request's last user message against the
//!    candidate sessions' latest user message.
//!
//! The resolved flow drives both the usage row (per-user billing via
//! `flows.user_id`, session grouping) and the model-routing boundary signals.

use std::collections::HashMap;

use sqlx::PgPool;
use uuid::Uuid;

use super::Mode;

/// How the flow was found — recorded in the usage row's metadata so
/// attribution quality is auditable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttributionSource {
    /// The agent forwarded `traceparent`; the trace id named the flow directly.
    Traceparent,
    /// No trace context; matched the agent's running flow (sole candidate, or
    /// winner of the message-content disambiguation).
    ActiveFlow,
}

impl AttributionSource {
    pub fn as_label(self) -> &'static str {
        match self {
            Self::Traceparent => "traceparent",
            Self::ActiveFlow => "active_flow",
        }
    }
}

/// The flow an LLM call was attributed to, plus the billing/grouping context
/// it carries.
#[derive(Debug, Clone)]
pub struct FlowAttribution {
    pub flow_id: String,
    /// The chatting user (`flows.user_id`) — the one who pays, NOT the agent
    /// owner the JWT names.
    pub user_id: Option<Uuid>,
    /// Stable conversation key (`flows.metadata->>'context_id'`); the
    /// decision-cache/session grouping key.
    pub context_id: Option<String>,
    pub mode: Mode,
    pub source: AttributionSource,
}

/// A candidate row from the active-flow query.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FlowRow {
    flow_id: String,
    user_id: Option<Uuid>,
    context_id: Option<String>,
    mode: Option<String>,
}

impl FlowRow {
    fn into_attribution(self, source: AttributionSource) -> FlowAttribution {
        FlowAttribution {
            flow_id: self.flow_id,
            user_id: self.user_id,
            context_id: self.context_id,
            mode: self
                .mode
                .as_deref()
                .map(Mode::from_label)
                .unwrap_or(Mode::FreeFlowing),
            source,
        }
    }
}

/// Resolve the flow this LLM call belongs to. `trace_flow` is the trace id
/// parsed from the agent-forwarded `traceparent`, when present and well-formed.
///
/// Returns `None` when no flow can be named — the caller then falls back to
/// agent/owner-level attribution (the pre-fallback behaviour). All DB failures
/// are fail-soft: attribution must never break an LLM call.
pub async fn resolve(
    db: &PgPool,
    agent_id: &str,
    trace_flow: Option<String>,
    query: Option<&str>,
    window_secs: i64,
) -> Option<FlowAttribution> {
    if let Some(flow_id) = trace_flow {
        return trace_lookup(db, &flow_id).await;
    }
    active_flow_lookup(db, agent_id, query, window_secs).await
}

/// Traceparent path: the trace id is the flow id; fetch the billing context.
async fn trace_lookup(db: &PgPool, flow_id: &str) -> Option<FlowAttribution> {
    let row = sqlx::query_as::<_, (Option<Uuid>, Option<String>, Option<String>)>(
        "SELECT user_id, metadata->>'context_id', metadata->>'mode' FROM flows WHERE flow_id = $1",
    )
    .bind(flow_id)
    .fetch_optional(db)
    .await;
    match row {
        Ok(Some((user_id, context_id, mode))) => Some(
            FlowRow {
                flow_id: flow_id.to_string(),
                user_id,
                context_id,
                mode,
            }
            .into_attribution(AttributionSource::Traceparent),
        ),
        // An unknown trace id is not a platform flow — no attribution (the
        // caller still logs the raw flow id for grouping, as before).
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(
                target: "nasiko::llm_router::attribution",
                error = %e, %flow_id, "attribution: flow lookup failed"
            );
            None
        }
    }
}

/// Fallback path: the agent's running flow(s) within the attribution window.
async fn active_flow_lookup(
    db: &PgPool,
    agent_id: &str,
    query: Option<&str>,
    window_secs: i64,
) -> Option<FlowAttribution> {
    let agent_uuid = Uuid::parse_str(agent_id).ok()?;
    // `flow_steps` covers sub-agents of an orchestrated flow: their LLM calls
    // belong to the flow they were invoked under, not a flow they root.
    let rows = sqlx::query_as::<_, (String, Option<Uuid>, Option<String>, Option<String>)>(
        "SELECT f.flow_id, f.user_id, f.metadata->>'context_id', f.metadata->>'mode' \
         FROM flows f \
         WHERE f.status = 'running' \
           AND f.created_at > now() - make_interval(secs => $2) \
           AND (f.root_agent_id = $1 OR EXISTS ( \
               SELECT 1 FROM flow_steps fs \
               WHERE fs.flow_id = f.flow_id AND fs.agent_id = $1)) \
         ORDER BY f.created_at DESC \
         LIMIT 10",
    )
    .bind(agent_uuid)
    .bind(window_secs)
    .fetch_all(db)
    .await;
    let candidates: Vec<FlowRow> = match rows {
        Ok(rows) => rows
            .into_iter()
            .map(|(flow_id, user_id, context_id, mode)| FlowRow {
                flow_id,
                user_id,
                context_id,
                mode,
            })
            .collect(),
        Err(e) => {
            tracing::warn!(
                target: "nasiko::llm_router::attribution",
                error = %e, %agent_id, "attribution: active-flow lookup failed"
            );
            return None;
        }
    };

    match candidates.len() {
        0 => None,
        // Sole running flow — the common case: exact attribution with no
        // cooperation from the agent.
        1 => Some(
            candidates
                .into_iter()
                .next()
                .expect("len checked")
                .into_attribution(AttributionSource::ActiveFlow),
        ),
        _ => {
            let chosen = disambiguate(db, candidates, query).await;
            tracing::info!(
                target: "nasiko::llm_router::attribution",
                %agent_id, flow_id = %chosen.flow_id,
                "attribution: multiple running flows — picked by message match or recency"
            );
            Some(chosen.into_attribution(AttributionSource::ActiveFlow))
        }
    }
}

/// Pick among concurrent flows for one agent. The LLM request almost always
/// embeds the user's query verbatim, so the candidate session whose latest
/// user message matches the request's last user message is the right flow.
/// No match (agent rewrote the query, non-chat LLM call) ⇒ most recent flow.
async fn disambiguate(db: &PgPool, candidates: Vec<FlowRow>, query: Option<&str>) -> FlowRow {
    // Candidates arrive sorted newest-first; index 0 is the recency fallback.
    let newest = || candidates.first().expect("non-empty").clone();
    let Some(query) = query.map(str::trim).filter(|q| !q.is_empty()) else {
        return newest();
    };
    let session_ids: Vec<&str> = candidates
        .iter()
        .filter_map(|c| c.context_id.as_deref())
        .collect();
    if session_ids.is_empty() {
        return newest();
    }
    let latest = sqlx::query_as::<_, (String, String)>(
        "SELECT DISTINCT ON (session_id) session_id, content \
         FROM chat_messages \
         WHERE session_id = ANY($1) AND role = 'user' \
         ORDER BY session_id, \"timestamp\" DESC",
    )
    .bind(&session_ids)
    .fetch_all(db)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!(
            target: "nasiko::llm_router::attribution",
            error = %e, "attribution: message-match query failed"
        );
        Vec::new()
    });
    let by_session: HashMap<String, String> = latest.into_iter().collect();
    pick_by_message(candidates, &by_session, query)
}

/// Pure decision: exactly one message-content match wins; otherwise the
/// newest candidate. Split from the DB fetch for testability.
fn pick_by_message(
    candidates: Vec<FlowRow>,
    latest_user_msg: &HashMap<String, String>,
    query: &str,
) -> FlowRow {
    let mut matches = candidates.iter().filter(|c| {
        c.context_id
            .as_deref()
            .and_then(|sid| latest_user_msg.get(sid))
            .is_some_and(|content| content.trim() == query)
    });
    match (matches.next(), matches.next()) {
        (Some(one), None) => one.clone(),
        // Zero or ambiguous matches: fall back to the newest candidate.
        _ => candidates.into_iter().next().expect("non-empty"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(flow_id: &str, context_id: Option<&str>) -> FlowRow {
        FlowRow {
            flow_id: flow_id.into(),
            user_id: None,
            context_id: context_id.map(str::to_string),
            mode: None,
        }
    }

    #[test]
    fn single_exact_message_match_wins_over_recency() {
        // Newest-first: flow-b is newer, but flow-a's session matches the query.
        let candidates = vec![row("flow-b", Some("ses-b")), row("flow-a", Some("ses-a"))];
        let msgs = HashMap::from([
            ("ses-a".to_string(), "hello there".to_string()),
            ("ses-b".to_string(), "something else".to_string()),
        ]);
        let picked = pick_by_message(candidates, &msgs, "hello there");
        assert_eq!(picked.flow_id, "flow-a");
    }

    #[test]
    fn no_match_falls_back_to_newest() {
        let candidates = vec![row("flow-b", Some("ses-b")), row("flow-a", Some("ses-a"))];
        let msgs = HashMap::from([("ses-a".to_string(), "unrelated".to_string())]);
        let picked = pick_by_message(candidates, &msgs, "hello there");
        assert_eq!(picked.flow_id, "flow-b");
    }

    #[test]
    fn ambiguous_match_falls_back_to_newest() {
        // Both sessions end with the same user message (e.g. "hi") — cannot
        // tell them apart, take the newest rather than guessing.
        let candidates = vec![row("flow-b", Some("ses-b")), row("flow-a", Some("ses-a"))];
        let msgs = HashMap::from([
            ("ses-a".to_string(), "hi".to_string()),
            ("ses-b".to_string(), "hi".to_string()),
        ]);
        let picked = pick_by_message(candidates, &msgs, "hi");
        assert_eq!(picked.flow_id, "flow-b");
    }

    #[test]
    fn match_is_trimmed_on_both_sides() {
        let candidates = vec![row("flow-b", Some("ses-b")), row("flow-a", Some("ses-a"))];
        let msgs = HashMap::from([("ses-a".to_string(), "  hello  ".to_string())]);
        let picked = pick_by_message(candidates, &msgs, "hello");
        assert_eq!(picked.flow_id, "flow-a");
    }
}
