//! Control-plane registration and external chat-turn persistence.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

use super::agents::Agent;
use super::model::Turn;
use super::otlp;
use super::state::SessionLock;

pub fn register_agent(agent: Agent) -> Result<bool> {
    let spec = agent.spec();
    let client = crate::api::Client::from_active_cluster()?;
    client.post_json_allow_conflict(
        "/agents",
        &json!({
            "name": spec.agent_name,
            "display_name": spec.display_name,
            "description": format!("Local {} sessions, reported by the Nasiko CLI", spec.display_name),
            "version": "1.0.0",
            "tags": ["local", "coding-agent"],
            "metadata": {"source": "nasiko-cli-integration", "integration_id": spec.id},
        }),
    )
}

pub fn ensure_session(session_id: &str, agent_name: &str, timeout: Duration) -> Result<()> {
    let client = crate::api::Client::from_active_cluster_with_timeout(timeout)
        .context("cannot read nasiko config for server connection")?;
    client
        .post_json_allow_ok(
            "/observability/session/ensure",
            &json!({"session_id": session_id, "agent_name": agent_name}),
        )
        .context("failed to call ensure-session endpoint")?;
    Ok(())
}

pub fn persist_turns(
    session_id: &str,
    agent_name: &str,
    turns: &[Turn],
    session_state: &SessionLock,
    deadline: Instant,
    timeout_for: impl Fn(Instant) -> Result<Duration>,
) -> Result<()> {
    let path = format!("/chat/sessions/{session_id}/external-turns");
    for turn in turns {
        let client = crate::api::Client::from_active_cluster_with_timeout(timeout_for(deadline)?)
            .context("cannot read nasiko config for server connection")?;
        let body = external_turn_body(session_id, agent_name, turn)
            .context("incomplete turn reached external-turn upload")?;
        client
            .post_external_turn(&path, &turn.uuid, &body)
            .context("failed to persist external turn")?;
        session_state.mark_uploaded(std::slice::from_ref(&turn.uuid))?;
    }
    Ok(())
}

fn external_turn_body(session_id: &str, agent_name: &str, turn: &Turn) -> Option<Value> {
    let response = turn.response.as_ref()?;
    let final_call = turn.calls.last()?;
    let all_models_agree = turn
        .calls
        .iter()
        .all(|call| call.model == turn.calls[0].model);
    let model = if all_models_agree {
        &turn.calls[0].model
    } else {
        &final_call.model
    };
    let input = turn.calls.iter().fold(0_u64, |total, call| {
        total
            .saturating_add(call.input_tokens)
            .saturating_add(call.cache_read_tokens)
            .saturating_add(call.cache_creation_tokens)
    });
    let output = turn.calls.iter().fold(0_u64, |total, call| {
        total.saturating_add(call.output_tokens)
    });
    let duration_ms = turn.calls.iter().fold(0_i64, |total, call| {
        total.saturating_add((call.ended_at - call.started_at).num_milliseconds().max(0))
    });
    Some(json!({
        "turn_id": turn.uuid,
        "user_content": &turn.prompt,
        "assistant_content": response,
        "assistant_usage": {
            "input_tokens": input.min(i32::MAX as u64) as i32,
            "output_tokens": output.min(i32::MAX as u64) as i32,
            "model": model,
            "duration_ms": duration_ms.min(i32::MAX as i64) as i32,
            "trace_id": otlp::trace_id_for_turn(agent_name, session_id, turn),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::super::model::LlmCall;
    use super::*;
    use chrono::{DateTime, Utc};

    fn turn(models: &[&str]) -> Turn {
        let start = "2026-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let end = "2026-01-01T00:00:02Z".parse::<DateTime<Utc>>().unwrap();
        Turn {
            uuid: "turn".into(),
            prompt: "prompt".into(),
            response: Some("response".into()),
            started_at: start,
            ended_at: end,
            calls: models
                .iter()
                .enumerate()
                .map(|(index, model)| LlmCall {
                    uuid: format!("call-{index}"),
                    provider: "provider".into(),
                    model: (*model).into(),
                    input_tokens: 2,
                    output_tokens: 3,
                    cache_read_tokens: 5,
                    cache_creation_tokens: 7,
                    started_at: start,
                    ended_at: end,
                })
                .collect(),
        }
    }

    #[test]
    fn aggregates_all_call_usage_and_duration() {
        let body = external_turn_body("claude:s", "claude-code", &turn(&["m", "m"])).unwrap();
        assert_eq!(body["assistant_usage"]["input_tokens"], 28);
        assert_eq!(body["assistant_usage"]["output_tokens"], 6);
        assert_eq!(body["assistant_usage"]["duration_ms"], 4000);
        assert_eq!(body["assistant_usage"]["model"], "m");
    }

    #[test]
    fn mixed_models_use_the_final_call_model() {
        let body =
            external_turn_body("claude:s", "claude-code", &turn(&["first", "final"])).unwrap();
        assert_eq!(body["assistant_usage"]["model"], "final");
    }

    #[test]
    fn persisted_trace_id_is_agent_scoped() {
        let turn = turn(&["m"]);
        let claude = external_turn_body("claude:s", "claude-code", &turn).unwrap();
        let open = external_turn_body("opencode:s", "opencode", &turn).unwrap();
        assert_ne!(
            claude["assistant_usage"]["trace_id"],
            open["assistant_usage"]["trace_id"]
        );
    }

    #[test]
    fn chat_persistence_always_keeps_conversation_content() {
        let body = external_turn_body("claude:s", "claude-code", &turn(&["m"])).unwrap();
        assert_eq!(body["user_content"], "prompt");
        assert_eq!(body["assistant_content"], "response");
    }

    #[test]
    fn user_only_turn_cannot_be_persisted() {
        let mut incomplete = turn(&["m"]);
        incomplete.response = None;
        assert!(external_turn_body("claude:s", "claude-code", &incomplete).is_none());
    }
}
