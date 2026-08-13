//! Flow attribution — which user conversation an LLM call belongs to.
//!
//! The router never sees the caller's identity on the wire: an agent's only
//! credential is its agent-identity JWT, which names the agent/owner but never
//! the *user* whose message triggered the call. Per-user attribution requires
//! the agent to propagate the W3C `traceparent` the platform injected on the
//! inbound A2A call — the one header OTel auto-instrumentation forwards for
//! free (Python/Node/Java/.NET), and a small manual injection for Rust/Go.
//!
//! Resolution order:
//!
//! 1. **Traceparent** (precise, the contract): the agent forwarded trace
//!    context; its trace id *is* the flow id. Required for correctness when
//!    the agent serves concurrent users.
//! 2. **Active-flow fallback** (best-effort, single-tenant only): no trace
//!    context ⇒ the agent's *sole* currently-running flow is unambiguous and
//!    safe to attribute. With **two or more** concurrent flows the wire cannot
//!    distinguish users, so we attribute NOTHING rather than risk billing the
//!    wrong user — correctness over coverage.
//!
//! The resolved flow drives both the usage row (per-user billing via
//! `flows.user_id`, session grouping) and the model-routing boundary signals.

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
/// Returns `None` when no flow can be named unambiguously — the caller then
/// falls back to agent/owner-level attribution (no user). All DB failures are
/// fail-soft: attribution must never break an LLM call, and must never guess a
/// user under concurrency.
pub async fn resolve(
    db: &PgPool,
    agent_id: &str,
    trace_flow: Option<String>,
    window_secs: i64,
) -> Option<FlowAttribution> {
    if let Some(flow_id) = trace_flow {
        return trace_lookup(db, &flow_id).await;
    }
    active_flow_lookup(db, agent_id, window_secs).await
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
        // Sole running flow for this agent — unambiguous: the caller must be that
        // flow's user. Safe to attribute.
        1 => Some(
            candidates
                .into_iter()
                .next()
                .expect("len checked")
                .into_attribution(AttributionSource::ActiveFlow),
        ),
        // Multiple concurrent users on one agent: the wire carries nothing that
        // distinguishes them (the JWT names only the agent), so ANY choice here —
        // recency, message-match — can bill the wrong user. Fail safe: attribute
        // nothing. The agent must propagate `traceparent` (one OTel line) for
        // per-user attribution under concurrency.
        _ => {
            tracing::warn!(
                target: "nasiko::llm_router::attribution",
                %agent_id,
                candidate_count = candidates.len(),
                "attribution: multiple active flows for this agent and no traceparent — \
                 refusing to guess the user (would risk mis-billing). Agent must forward \
                 traceparent (OTel auto-instrumentation) for per-user attribution under concurrency."
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flow_row_carries_billing_context_into_attribution() {
        let user = Uuid::new_v4();
        let row = FlowRow {
            flow_id: "f1".into(),
            user_id: Some(user),
            context_id: Some("ses_1".into()),
            mode: Some("free_flowing".into()),
        };
        let a = row.into_attribution(AttributionSource::ActiveFlow);
        assert_eq!(a.flow_id, "f1");
        assert_eq!(a.user_id, Some(user));
        assert_eq!(a.context_id.as_deref(), Some("ses_1"));
        assert_eq!(a.mode, Mode::FreeFlowing);
        assert_eq!(a.source, AttributionSource::ActiveFlow);
    }

    #[test]
    fn unknown_mode_label_defaults_to_free_flowing() {
        let row = FlowRow {
            flow_id: "f1".into(),
            user_id: None,
            context_id: None,
            mode: Some("bogus".into()),
        };
        assert_eq!(
            row.into_attribution(AttributionSource::Traceparent).mode,
            Mode::FreeFlowing
        );
    }

    // The concurrency safety property (refuse to guess among >1 active flow) is
    // in `active_flow_lookup`'s DB branch — exercised by the integration tests,
    // not unit-testable here without a database.
}
