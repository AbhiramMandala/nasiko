//! The one concrete [`crate::dispatcher::ResumeNotifier`] this milestone
//! ships: pushes a resolved decision into the paused agent by resolving its
//! live address via `ContainerRuntime::endpoint()` (the same primitive
//! `oss/server/src/agent_proxy.rs` and `a2a_dispatch.rs::resolve_endpoint`
//! already use) and making a fresh outbound A2A `SendMessage` call carrying
//! the row's `context_id`.
//!
//! There is no reusable event bus and no A2A push-notification support
//! anywhere in this codebase (confirmed in the M6 handoff investigation) —
//! the original `tools/call` HTTP response is long gone by the time a human
//! resolves a request, so this cannot "wake up" anything already listening.
//! It has to be a brand-new connection into the agent, exactly like this.

use std::sync::Arc;

use nasiko_runtime::{ContainerId, ContainerRuntime};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::dispatcher::{NotifyError, ResumeNotifier};
use crate::types::{HitlKind, HitlRequest};

pub struct RuntimeResumeNotifier {
    db: PgPool,
    runtime: Arc<dyn ContainerRuntime>,
    http_client: reqwest::Client,
}

impl RuntimeResumeNotifier {
    pub fn new(
        db: PgPool,
        runtime: Arc<dyn ContainerRuntime>,
        http_client: reqwest::Client,
    ) -> Self {
        Self {
            db,
            runtime,
            http_client,
        }
    }

    /// Resolve the agent's currently-reachable A2A endpoint. Mirrors
    /// `a2a_dispatch.rs::resolve_endpoint`'s live-runtime-first, stored-URL-
    /// fallback shape, simplified: this notifier only ever needs to *reach*
    /// the agent, not also flip `agents.status` — that bookkeeping belongs to
    /// the request-serving code path, not a background dispatcher.
    async fn resolve_agent_endpoint(&self, agent_id: Uuid) -> Result<String, NotifyError> {
        let row: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT transport_path, url FROM agents WHERE id = $1")
                .bind(agent_id)
                .fetch_optional(&self.db)
                .await
                .map_err(|e| NotifyError::EndpointResolution {
                    agent_id,
                    reason: format!("db lookup failed: {e}"),
                })?;

        let Some((transport_path, stored_url)) = row else {
            return Err(NotifyError::EndpointResolution {
                agent_id,
                reason: "no such agent".to_string(),
            });
        };

        // The A2A spec fixes no path — it must come from the agent's card,
        // never be assumed. See resolve_endpoint's identical reasoning.
        let path = match transport_path.as_deref() {
            None | Some("/") | Some("") => "",
            Some(p) => p,
        };

        let container_id = ContainerId::from_uuid(agent_id);
        if let Ok(live) = self.runtime.endpoint(&container_id).await {
            return Ok(format!("{}{path}", live.trim_end_matches('/')));
        }

        if let Some(url) = stored_url.filter(|u| !u.is_empty()) {
            return Ok(format!("{}{path}", url.trim_end_matches('/')));
        }

        Err(NotifyError::EndpointResolution {
            agent_id,
            reason: "no live or stored endpoint".to_string(),
        })
    }
}

#[async_trait::async_trait]
impl ResumeNotifier for RuntimeResumeNotifier {
    async fn notify(&self, request: &HitlRequest) -> Result<(), NotifyError> {
        let context_id = request
            .context_id
            .as_deref()
            .ok_or(NotifyError::MissingContextId(request.id))?;

        let endpoint = self.resolve_agent_endpoint(request.agent_id).await?;
        let message = build_resume_message(request);
        let body = nasiko_types::a2a::build_send_request(&message, Some(context_id));

        let response = self
            .http_client
            .post(&endpoint)
            .header("A2A-Version", "1.0")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let payload: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() || payload.get("error").is_some() {
            return Err(NotifyError::PeerError(format!("http {status}: {payload}")));
        }

        Ok(())
    }
}

/// Build a human-legible, kind-agnostic nudge from a resolved row's own
/// `question`/`human_response` — deliberately free-form (both columns are
/// untyped JSONB, per their own doc comments) rather than assuming an
/// MCP-specific schema, so this stays reusable for a future non-MCP origin.
fn build_resume_message(request: &HitlRequest) -> String {
    let label = request
        .tool_name
        .as_deref()
        .or_else(|| request.question.get("tool_name").and_then(Value::as_str))
        .unwrap_or("the previously blocked action");

    match request.kind {
        // `auth_required`/`mcp_tool` rows have no `tool_name` (the schema
        // only carries it for `tool_approval` — see `chk_hitl_mcp_auth_required_identity`
        // vs `chk_hitl_tool_approval_identity`), so `label` above is always
        // its generic fallback here — confirmed live: a real deployed agent,
        // forced to call some tool by this vague a nudge, called an
        // unrelated tool of its own instead of retrying the right one. Name
        // the connector instead — the one piece of real identity every
        // `auth_required` row's `question` does carry
        // (`handle_auth_required`'s own construction) — so the receiving
        // agent has an actual anchor instead of a placeholder that reads
        // like a real tool name but never is one.
        HitlKind::AuthRequired => {
            let connector = request
                .question
                .get("connector")
                .and_then(Value::as_str)
                .unwrap_or("the connector");
            format!(
                "Authentication for the `{connector}` connector has been completed. \
                 You may retry whichever tool call needed it now."
            )
        }
        HitlKind::ToolApproval => {
            let approved = request
                .human_response
                .as_ref()
                .and_then(|r| r.get("decision"))
                .and_then(Value::as_str)
                == Some("approve");
            if approved {
                format!(
                    "The user approved your request to use `{label}`. You may retry the tool call now."
                )
            } else {
                format!(
                    "The user denied your request to use `{label}`. Do not retry this tool call — \
                     inform the user or choose a different approach."
                )
            }
        }
        HitlKind::InputRequired => {
            "The user has responded to your request for input. Continue the task.".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{HitlOrigin, HitlStatus, ResumeStatus};
    use chrono::Utc;

    fn request(
        kind: HitlKind,
        human_response: Option<Value>,
        tool_name: Option<&str>,
    ) -> HitlRequest {
        request_with_question(kind, human_response, tool_name, serde_json::json!({}))
    }

    fn request_with_question(
        kind: HitlKind,
        human_response: Option<Value>,
        tool_name: Option<&str>,
        question: Value,
    ) -> HitlRequest {
        let now = Utc::now();
        HitlRequest {
            id: Uuid::new_v4(),
            kind,
            origin: HitlOrigin::McpTool,
            status: HitlStatus::Resolved,
            resume_status: ResumeStatus::NotStarted,
            agent_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            resolved_by: Some(Uuid::new_v4()),
            task_id: None,
            context_id: Some("ctx-1".to_string()),
            chat_session_id: None,
            maf_execution_id: None,
            maf_step_index: None,
            connector_id: Some(Uuid::new_v4()),
            tool_name: tool_name.map(str::to_string),
            arguments_hash: None,
            consumed_at: None,
            question,
            human_response,
            resume_state: serde_json::json!({}),
            resume_claimed_at: Some(now),
            resume_dispatch_attempts: 1,
            resume_last_error: None,
            created_at: now,
            updated_at: now,
            expires_at: None,
            resolved_at: Some(now),
        }
    }

    #[test]
    fn auth_required_message_names_the_connector_not_a_nonexistent_tool_name() {
        // `auth_required`/`mcp_tool` rows never have `tool_name` set (only
        // `tool_approval` rows do) — this must not fall back to the generic
        // placeholder when `question.connector` is available, the way a
        // real `handle_auth_required`-created row always has it.
        let req = request_with_question(
            HitlKind::AuthRequired,
            None,
            None,
            serde_json::json!({"connector": "github", "connector_id": Uuid::new_v4()}),
        );
        let msg = build_resume_message(&req);
        assert!(msg.contains("Authentication"));
        assert!(
            msg.contains("`github`"),
            "must name the actual connector, not a placeholder: {msg}"
        );
    }

    #[test]
    fn auth_required_message_falls_back_gracefully_with_no_connector_in_question() {
        let req = request(HitlKind::AuthRequired, None, None);
        let msg = build_resume_message(&req);
        assert!(msg.contains("Authentication"));
        assert!(msg.contains("the connector"));
    }

    #[test]
    fn tool_approval_approved_message_says_retry() {
        let req = request(
            HitlKind::ToolApproval,
            Some(serde_json::json!({"decision": "approve"})),
            Some("GITHUB_DELETE_REPO"),
        );
        let msg = build_resume_message(&req);
        assert!(msg.contains("approved"));
        assert!(msg.contains("retry"));
    }

    #[test]
    fn tool_approval_denied_message_says_do_not_retry() {
        let req = request(
            HitlKind::ToolApproval,
            Some(serde_json::json!({"decision": "reject"})),
            Some("GITHUB_DELETE_REPO"),
        );
        let msg = build_resume_message(&req);
        assert!(msg.contains("denied"));
        assert!(msg.contains("Do not retry"));
    }
}
