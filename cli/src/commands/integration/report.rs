//! Shared lock, export, and persistence pipeline for adapter snapshots.

use anyhow::{Result, bail};
use chrono::Utc;
use std::collections::HashSet;
use std::io::Read;
use std::time::{Duration, Instant};

use super::agents::Agent;
use super::control_plane;
use super::model::Turn;
use super::otlp::{self, ExportContext};
use super::state::{self, IntegrationState};

const REPORT_BUDGET: Duration = Duration::from_secs(9);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(2);
const CONTROL_PLANE_RESERVE: Duration = Duration::from_secs(4);

pub fn run(agent: Agent) -> Result<()> {
    let deadline = Instant::now() + REPORT_BUDGET;
    let raw = read_payload()?;
    let snapshot = agent.snapshot(&raw, deadline)?;
    let spec = agent.spec();
    let server_session_id = server_session_id(spec.id, &snapshot.session_id);
    let settings = IntegrationState::load()?;
    let Some(agent_state) = settings.get(spec.id) else {
        bail!(
            "{} is not installed — run: nasiko integration install {}",
            spec.display_name,
            spec.id
        );
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
    let pending_spans = pending_turns(&completed, &progress.exported_turn_ids);
    let pending_messages = pending_turns(&completed, &progress.uploaded_turn_ids);

    let context = ExportContext {
        endpoint: &agent_state.otlp_endpoint,
        service_name: &agent_state.agent_name,
        session_id: &server_session_id,
        capture_content: agent_state.capture_content,
    };
    for turn in &pending_spans {
        let reserve = if pending_messages.is_empty() {
            Duration::ZERO
        } else {
            CONTROL_PLANE_RESERVE
        };
        let Ok(timeout) = network_timeout_with_reserve(deadline, reserve) else {
            log(&format!(
                "session {} — report deadline reached; remaining spans deferred",
                snapshot.session_id
            ));
            break;
        };
        match otlp::export_turns_with_timeout(&context, std::slice::from_ref(turn), timeout) {
            Ok(spans) => {
                if let Err(error) = lock.mark_exported(std::slice::from_ref(&turn.uuid)) {
                    log(&format!(
                        "session {} turn {} — span progress write failed: {error}",
                        snapshot.session_id, turn.uuid
                    ));
                    break;
                }
                log(&format!(
                    "session {} turn {} — exported {spans} span(s)",
                    snapshot.session_id, turn.uuid
                ));
            }
            Err(error) => {
                log(&format!(
                    "session {} turn {} — span export failed: {error}",
                    snapshot.session_id, turn.uuid
                ));
                break;
            }
        }
    }

    if !pending_messages.is_empty() {
        let result = (|| {
            control_plane::ensure_session(
                &server_session_id,
                &agent_state.agent_name,
                network_timeout(deadline)?,
            )?;
            control_plane::persist_turns(
                &server_session_id,
                &agent_state.agent_name,
                &pending_messages,
                &lock,
                deadline,
                network_timeout,
            )
        })();
        match result {
            Ok(()) => log(&format!(
                "session {} — persisted {} external turn(s)",
                snapshot.session_id,
                pending_messages.len()
            )),
            Err(error) => log(&format!(
                "session {} — external turns deferred: {error}",
                snapshot.session_id
            )),
        }
    }
    Ok(())
}

fn server_session_id(agent_id: &str, raw_session_id: &str) -> String {
    format!("{agent_id}:{raw_session_id}")
}

fn complete_turns(turns: &[Turn]) -> Vec<Turn> {
    turns
        .iter()
        .filter(|turn| !turn.is_empty() && turn.response.is_some())
        .cloned()
        .collect()
}

fn pending_turns(turns: &[Turn], completed: &HashSet<String>) -> Vec<Turn> {
    turns
        .iter()
        .filter(|turn| !completed.contains(&turn.uuid))
        .cloned()
        .collect()
}

fn network_timeout(deadline: Instant) -> Result<Duration> {
    network_timeout_with_reserve(deadline, Duration::ZERO)
}

fn network_timeout_with_reserve(deadline: Instant, reserve: Duration) -> Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining <= reserve {
        bail!("report deadline reached");
    }
    Ok((remaining - reserve).min(NETWORK_TIMEOUT))
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
    fn span_and_message_progress_filter_independently() {
        let turns = [turn("a", true), turn("b", true)];
        assert_eq!(
            pending_turns(&turns, &HashSet::from(["a".to_string()]))[0].uuid,
            "b"
        );
        assert_eq!(
            pending_turns(&turns, &HashSet::from(["b".to_string()]))[0].uuid,
            "a"
        );
    }

    #[test]
    fn network_timeout_obeys_request_and_report_budgets() {
        assert!(
            network_timeout(Instant::now() + Duration::from_millis(50)).unwrap()
                <= Duration::from_millis(50)
        );
        assert_eq!(
            network_timeout(Instant::now() + Duration::from_secs(5)).unwrap(),
            NETWORK_TIMEOUT
        );
        assert!(
            network_timeout_with_reserve(
                Instant::now() + Duration::from_secs(3),
                CONTROL_PLANE_RESERVE
            )
            .is_err()
        );
    }

    #[test]
    fn server_session_ids_are_scoped_by_external_agent_id() {
        let claude_session = server_session_id("claude", "same");
        let opencode_session = server_session_id("opencode", "same");
        assert_eq!(claude_session, "claude:same");
        assert_eq!(opencode_session, "opencode:same");
        assert_ne!(claude_session, opencode_session);

        let turn = turn("same-turn", true);
        assert_ne!(
            otlp::trace_id_for_turn("claude-code", &claude_session, &turn),
            otlp::trace_id_for_turn("opencode", &opencode_session, &turn)
        );
    }
}
