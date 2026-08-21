//! Hook-time parsing and durable capture. Network delivery belongs to `sync`.

use anyhow::{Result, bail};
use chrono::Utc;
use nasiko_types::{
    CODING_AGENT_EVENT_VERSION, CapturePolicy, CodingAgentEventV1, CodingAgentLlmCall,
    CodingAgentSession, CodingAgentSource, CodingAgentTurn, coding_agent_event_id,
    coding_agent_session_id,
};
use std::collections::HashSet;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::agents::Agent;
use super::model::Turn;
use super::queue::{self, QueueDestination, QueueRecord};
use super::state::{self, IntegrationState, SessionLock};

const REPORT_BUDGET: Duration = Duration::from_secs(9);

pub fn run(agent: Agent) -> Result<()> {
    let deadline = Instant::now() + REPORT_BUDGET;
    let raw = read_payload()?;
    let snapshot = agent.snapshot(&raw, deadline)?;
    let spec = agent.spec();
    let settings = IntegrationState::load()?;
    let Some(agent_state) = settings.get(spec.id) else {
        bail!(
            "{} is not installed — run: nasiko integration install {}",
            spec.display_name,
            spec.id
        );
    };
    let (cluster_name, cluster) = crate::config::active_cluster()?;
    let principal_id = cluster
        .token
        .as_deref()
        .and_then(crate::config::token_subject)
        .and_then(|subject| uuid::Uuid::parse_str(&subject).ok())
        .ok_or_else(|| anyhow::anyhow!("active cluster token has no valid user UUID subject"))?;
    let destination = QueueDestination {
        cluster_name,
        cluster_url: cluster.url,
        principal_id,
    };
    let lock = state::lock_session(
        spec.id,
        &snapshot.session_id,
        deadline.saturating_duration_since(Instant::now()),
    )?;
    let completed = complete_turns(&snapshot.turns);
    if completed.is_empty() {
        log(&format!(
            "session {} — no completed turns; deferred",
            snapshot.session_id
        ));
        return Ok(());
    }
    let progress = lock.progress()?;
    if progress.migrated_legacy_counts {
        log(&format!(
            "session {} — migrated legacy progress; replaying complete turns once",
            snapshot.session_id
        ));
    }
    let pending = pending_turns(&completed, &progress.captured_turn_ids);
    for turn in &pending {
        let record = QueueRecord::new(
            destination.clone(),
            canonical_event(
                spec.id,
                &agent_state.agent_name,
                &snapshot.session_id,
                turn,
                agent_state.capture_content,
            ),
        );
        queue_then_mark(&record, &lock)?;
    }
    drop(lock);

    if !pending.is_empty() {
        spawn_sync()?;
        log(&format!(
            "session {} — queued {} completed turn(s) for {}",
            snapshot.session_id,
            pending.len(),
            destination.cluster_name
        ));
    }
    Ok(())
}

fn canonical_event(
    agent_id: &str,
    agent_name: &str,
    source_session_id: &str,
    turn: &Turn,
    capture_content: bool,
) -> CodingAgentEventV1 {
    CodingAgentEventV1 {
        version: CODING_AGENT_EVENT_VERSION,
        event_id: coding_agent_event_id(agent_id, source_session_id, &turn.uuid),
        captured_at: turn.ended_at,
        source: CodingAgentSource {
            agent_id: agent_id.to_string(),
            agent_name: agent_name.to_string(),
        },
        session: CodingAgentSession {
            id: coding_agent_session_id(agent_id, source_session_id),
            source_id: source_session_id.to_string(),
        },
        turn: CodingAgentTurn {
            id: turn.uuid.clone(),
            prompt: capture_content.then(|| turn.prompt.clone()),
            response: capture_content.then(|| turn.response.clone()).flatten(),
            started_at: turn.started_at,
            ended_at: turn.ended_at,
            llm_calls: turn
                .calls
                .iter()
                .map(|call| CodingAgentLlmCall {
                    id: call.uuid.clone(),
                    provider: call.provider.clone(),
                    model: call.model.clone(),
                    input_tokens: call.input_tokens,
                    output_tokens: call.output_tokens,
                    cache_read_tokens: call.cache_read_tokens,
                    cache_creation_tokens: call.cache_creation_tokens,
                    started_at: call.started_at,
                    ended_at: call.ended_at,
                })
                .collect(),
        },
        capture_policy: if capture_content {
            CapturePolicy::Content
        } else {
            CapturePolicy::MetadataOnly
        },
    }
}

fn queue_then_mark(record: &QueueRecord, lock: &SessionLock) -> Result<()> {
    ordered_commit(
        || queue::enqueue(record).map(|_| ()),
        || lock.mark_captured(std::slice::from_ref(&record.event.turn.id)),
    )
}

fn ordered_commit(
    enqueue: impl FnOnce() -> Result<()>,
    mark: impl FnOnce() -> Result<()>,
) -> Result<()> {
    enqueue()?;
    mark()
}

fn complete_turns(turns: &[Turn]) -> Vec<Turn> {
    turns
        .iter()
        .filter(|turn| !turn.is_empty() && turn.response.is_some())
        .cloned()
        .collect()
}

fn pending_turns(turns: &[Turn], captured: &HashSet<String>) -> Vec<Turn> {
    turns
        .iter()
        .filter(|turn| !captured.contains(&turn.uuid))
        .cloned()
        .collect()
}

fn spawn_sync() -> Result<()> {
    Command::new(std::env::current_exe()?)
        .args(["integration", "sync"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

fn read_payload() -> Result<String> {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw)?;
    Ok(raw)
}

fn log(message: &str) {
    println!("{} {message}", Utc::now().to_rfc3339());
}

#[cfg(test)]
mod tests {
    use super::super::model::LlmCall;
    use super::*;
    use chrono::{DateTime, Utc};
    use std::cell::Cell;

    fn turn(id: &str, complete: bool) -> Turn {
        let at = "2026-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        Turn {
            uuid: id.into(),
            prompt: "prompt".into(),
            response: complete.then(|| "response".into()),
            started_at: at,
            ended_at: at,
            calls: complete
                .then(|| LlmCall {
                    uuid: format!("call-{id}"),
                    provider: "provider".into(),
                    model: "model".into(),
                    input_tokens: 1,
                    output_tokens: 1,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    started_at: at,
                    ended_at: at,
                })
                .into_iter()
                .collect(),
        }
    }

    #[test]
    fn incomplete_history_does_not_block_later_complete_turns() {
        let turns = [turn("a", true), turn("b", false), turn("c", true)];
        assert_eq!(
            complete_turns(&turns)
                .iter()
                .map(|turn| turn.uuid.as_str())
                .collect::<Vec<_>>(),
            ["a", "c"]
        );
    }

    #[test]
    fn captured_progress_filters_completed_turns() {
        let turns = [turn("a", true), turn("b", true)];
        assert_eq!(
            pending_turns(&turns, &HashSet::from(["a".to_string()]))[0].uuid,
            "b"
        );
    }

    #[test]
    fn queue_failure_never_advances_the_watermark() {
        let marked = Cell::new(false);
        let result = ordered_commit(
            || Err(anyhow::anyhow!("disk full")),
            || {
                marked.set(true);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!marked.get());
    }

    #[test]
    fn canonical_identity_is_stable_and_content_policy_is_enforced() {
        let turn = turn("same-turn", true);
        let first = canonical_event("claude", "claude-code", "same", &turn, false);
        let second = canonical_event("claude", "claude-code", "same", &turn, false);
        assert_eq!(first.event_id, second.event_id);
        assert_eq!(first, second);
        assert_eq!(first.session.id, "claude:same");
        assert!(first.turn.prompt.is_none());
        assert!(first.turn.response.is_none());
        assert!(first.validate().is_ok());
        assert_ne!(
            first.event_id,
            canonical_event("opencode", "opencode", "same", &turn, false).event_id
        );
    }
}
