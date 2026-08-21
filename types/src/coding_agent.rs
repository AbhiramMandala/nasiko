//! Versioned, transport-independent coding-agent telemetry events.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const CODING_AGENT_EVENT_VERSION: u32 = 1;
pub const CODING_AGENT_BATCH_MAX_EVENTS: usize = 100;
pub const CODING_AGENT_ID_MAX_BYTES: usize = 512;
pub const CODING_AGENT_NAME_MAX_BYTES: usize = 256;
pub const CODING_AGENT_CONTENT_MAX_BYTES: usize = 1_048_576;
pub const CODING_AGENT_LLM_CALLS_MAX: usize = 1_000;
const EVENT_NAMESPACE: Uuid = Uuid::from_u128(0xe8c6fef8_5fe4_4dc2_9b48_47466355ced7);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapturePolicy {
    MetadataOnly,
    Content,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodingAgentEventStatus {
    Accepted,
    Duplicate,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentEventBatchRequest {
    pub events: Vec<CodingAgentEventV1>,
}

impl CodingAgentEventBatchRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.events.is_empty() {
            return Err("events must not be empty".into());
        }
        if self.events.len() > CODING_AGENT_BATCH_MAX_EVENTS {
            return Err(format!(
                "events must contain at most {CODING_AGENT_BATCH_MAX_EVENTS} items"
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentEventResult {
    pub event_id: String,
    pub status: CodingAgentEventStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentEventBatchResponse {
    pub results: Vec<CodingAgentEventResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentSource {
    pub agent_id: String,
    pub agent_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentSession {
    /// Stable, source-scoped session identity used by Nasiko.
    pub id: String,
    /// Session identity supplied by the coding agent.
    pub source_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentLlmCall {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentTurn {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub llm_calls: Vec<CodingAgentLlmCall>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodingAgentEventV1 {
    pub version: u32,
    pub event_id: String,
    pub captured_at: DateTime<Utc>,
    pub source: CodingAgentSource,
    pub session: CodingAgentSession,
    pub turn: CodingAgentTurn,
    pub capture_policy: CapturePolicy,
}

impl CodingAgentEventV1 {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != CODING_AGENT_EVENT_VERSION {
            return Err(format!(
                "unsupported coding-agent event version {}",
                self.version
            ));
        }
        for (name, value) in [
            ("event_id", self.event_id.as_str()),
            ("source.agent_id", self.source.agent_id.as_str()),
            ("source.agent_name", self.source.agent_name.as_str()),
            ("session.id", self.session.id.as_str()),
            ("session.source_id", self.session.source_id.as_str()),
            ("turn.id", self.turn.id.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("{name} must not be empty"));
            }
            if value.len() > CODING_AGENT_ID_MAX_BYTES {
                return Err(format!(
                    "{name} must be at most {CODING_AGENT_ID_MAX_BYTES} bytes"
                ));
            }
        }
        if self.source.agent_name.len() > CODING_AGENT_NAME_MAX_BYTES {
            return Err(format!(
                "source.agent_name must be at most {CODING_AGENT_NAME_MAX_BYTES} bytes"
            ));
        }
        for (name, content) in [
            ("turn.prompt", self.turn.prompt.as_deref()),
            ("turn.response", self.turn.response.as_deref()),
        ] {
            if content.is_some_and(|content| content.len() > CODING_AGENT_CONTENT_MAX_BYTES) {
                return Err(format!(
                    "{name} must be at most {CODING_AGENT_CONTENT_MAX_BYTES} bytes"
                ));
            }
        }
        if self.turn.llm_calls.len() > CODING_AGENT_LLM_CALLS_MAX {
            return Err(format!(
                "turn.llm_calls must contain at most {CODING_AGENT_LLM_CALLS_MAX} items"
            ));
        }
        let expected = coding_agent_event_id(
            &self.source.agent_id,
            &self.session.source_id,
            &self.turn.id,
        );
        if self.event_id != expected {
            return Err("event_id does not match the stable source/session/turn identity".into());
        }
        if self.session.id
            != coding_agent_session_id(&self.source.agent_id, &self.session.source_id)
        {
            return Err("session.id does not match the stable source session identity".into());
        }
        if self.capture_policy == CapturePolicy::MetadataOnly
            && (self.turn.prompt.is_some() || self.turn.response.is_some())
        {
            return Err("metadata-only events must not contain prompt or response content".into());
        }
        if self.capture_policy == CapturePolicy::Content
            && (self
                .turn
                .prompt
                .as_deref()
                .is_none_or(|content| content.trim().is_empty())
                || self
                    .turn
                    .response
                    .as_deref()
                    .is_none_or(|content| content.trim().is_empty()))
        {
            return Err("content events must contain nonempty prompt and response content".into());
        }
        if self.turn.ended_at < self.turn.started_at {
            return Err("turn ended_at precedes started_at".into());
        }
        for call in &self.turn.llm_calls {
            for (name, value) in [
                ("turn.llm_calls[].id", call.id.as_str()),
                ("turn.llm_calls[].provider", call.provider.as_str()),
                ("turn.llm_calls[].model", call.model.as_str()),
            ] {
                if value.trim().is_empty() {
                    return Err(format!("{name} must not be empty"));
                }
                let max = if name == "turn.llm_calls[].id" {
                    CODING_AGENT_ID_MAX_BYTES
                } else {
                    CODING_AGENT_NAME_MAX_BYTES
                };
                if value.len() > max {
                    return Err(format!("{name} must be at most {max} bytes"));
                }
            }
            if call.ended_at < call.started_at {
                return Err("LLM call ended_at precedes started_at".into());
            }
        }
        Ok(())
    }
}

pub fn coding_agent_session_id(agent_id: &str, source_session_id: &str) -> String {
    format!("{agent_id}:{source_session_id}")
}

pub fn coding_agent_event_id(agent_id: &str, source_session_id: &str, turn_id: &str) -> String {
    let identity = format!(
        "v{CODING_AGENT_EVENT_VERSION}|{}:{agent_id}|{}:{source_session_id}|{}:{turn_id}",
        agent_id.len(),
        source_session_id.len(),
        turn_id.len()
    );
    Uuid::new_v5(&EVENT_NAMESPACE, identity.as_bytes()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn event() -> CodingAgentEventV1 {
        let at = Utc.timestamp_opt(1, 0).unwrap();
        CodingAgentEventV1 {
            version: CODING_AGENT_EVENT_VERSION,
            event_id: coding_agent_event_id("claude", "session", "turn"),
            captured_at: at,
            source: CodingAgentSource {
                agent_id: "claude".into(),
                agent_name: "claude-code".into(),
            },
            session: CodingAgentSession {
                id: coding_agent_session_id("claude", "session"),
                source_id: "session".into(),
            },
            turn: CodingAgentTurn {
                id: "turn".into(),
                prompt: None,
                response: None,
                started_at: at,
                ended_at: at,
                llm_calls: vec![],
            },
            capture_policy: CapturePolicy::MetadataOnly,
        }
    }

    #[test]
    fn event_ids_are_deterministic_and_identity_scoped() {
        let first = coding_agent_event_id("claude", "session", "turn");
        assert_eq!(first, coding_agent_event_id("claude", "session", "turn"));
        assert_ne!(first, coding_agent_event_id("opencode", "session", "turn"));
        assert_ne!(first, coding_agent_event_id("claude", "other", "turn"));
        assert_ne!(
            coding_agent_event_id("claude", "a\0b", "c"),
            coding_agent_event_id("claude", "a", "b\0c")
        );
        assert!(Uuid::parse_str(&first).is_ok());
    }

    #[test]
    fn session_ids_preserve_existing_stable_identity() {
        assert_eq!(coding_agent_session_id("claude", "abc"), "claude:abc");
    }

    #[test]
    fn batch_size_is_bounded() {
        assert!(
            CodingAgentEventBatchRequest { events: vec![] }
                .validate()
                .is_err()
        );
        let events = vec![event(); CODING_AGENT_BATCH_MAX_EVENTS + 1];
        assert!(CodingAgentEventBatchRequest { events }.validate().is_err());
    }

    #[test]
    fn semantic_field_sizes_and_call_count_are_bounded() {
        let mut oversized_id = event();
        oversized_id.turn.id = "x".repeat(CODING_AGENT_ID_MAX_BYTES + 1);
        assert!(oversized_id.validate().unwrap_err().contains("turn.id"));

        let mut oversized_content = event();
        oversized_content.capture_policy = CapturePolicy::Content;
        oversized_content.turn.prompt = Some("x".repeat(CODING_AGENT_CONTENT_MAX_BYTES + 1));
        oversized_content.turn.response = Some("response".into());
        assert!(
            oversized_content
                .validate()
                .unwrap_err()
                .contains("turn.prompt")
        );

        let mut too_many_calls = event();
        let at = too_many_calls.turn.started_at;
        too_many_calls.turn.llm_calls = (0..=CODING_AGENT_LLM_CALLS_MAX)
            .map(|index| CodingAgentLlmCall {
                id: index.to_string(),
                provider: "provider".into(),
                model: "model".into(),
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                started_at: at,
                ended_at: at,
            })
            .collect();
        assert!(too_many_calls.validate().unwrap_err().contains("llm_calls"));
    }
}
