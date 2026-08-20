//! Agent-independent representation of one completed coding-agent session.

use chrono::{DateTime, Utc};

#[derive(Debug, Clone)]
pub struct LlmCall {
    pub uuid: String,
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct Turn {
    pub uuid: String,
    pub prompt: String,
    pub response: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub calls: Vec<LlmCall>,
}

impl Turn {
    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }
}

#[derive(Debug)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub turns: Vec<Turn>,
}
