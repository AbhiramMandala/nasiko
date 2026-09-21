use serde::{Deserialize, Serialize};
use sqlx::PgPool;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// The `chat_messages.metadata` key marking a row as an orchestrator refusal,
/// which keeps it out of the next turn's reasoning context.
///
/// Exported because the **writer lives in another crate** (`nasiko_server`'s
/// `usage_meta::insert_assistant_message`) while the only reader is the SQL in
/// [`SessionHistory::fetch`]. The two were independent string literals, so a
/// typo or a rename on either side would have silently stopped the filter
/// matching — and the symptom is not an error, it is the live bug this tag
/// exists to prevent quietly coming back: refusals re-enter the prompt and the
/// session teaches itself to keep refusing. `the_filter_reads_the_key_the_writer_writes`
/// pins the SQL against this constant.
pub const REFUSAL_METADATA_KEY: &str = "orchestrator_refusal";

/// The history query. A `const` rather than an inline literal so the test below
/// can assert it actually mentions [`REFUSAL_METADATA_KEY`].
const FETCH_HISTORY_SQL: &str = "SELECT role, content FROM chat_messages \
     WHERE session_id = $1 \
       AND NOT COALESCE((metadata->>'orchestrator_refusal')::boolean, false) \
     ORDER BY timestamp DESC LIMIT $2";

#[derive(Debug, Clone, Default)]
pub struct SessionHistory {
    pub messages: Vec<ChatMessage>,
}

impl SessionHistory {
    pub async fn fetch(session_id: &str, pool: &PgPool, limit: usize) -> Self {
        // Take the LATEST `limit` messages, then restore chronological order —
        // `ORDER BY timestamp ASC LIMIT n` would pin the window to the oldest
        // messages and never advance in long sessions.
        // Rows tagged `orchestrator_refusal` are excluded from reasoning context
        // on purpose. A refusal is persisted so the human still sees it in the
        // transcript, but feeding it back as prior assistant output teaches the
        // model that refusing is what this conversation does — observed live as a
        // session that refused once and then refused every following turn,
        // including ones a deployed agent plainly covered. The row stays in
        // `chat_messages`; it just never becomes part of the next turn's prompt.
        // Nothing here writes that tag: it is set by whatever policy produced the
        // refusal, and with no policy configured no row ever carries it.
        let mut messages: Vec<ChatMessage> =
            sqlx::query_as::<_, (String, String)>(FETCH_HISTORY_SQL)
                .bind(session_id)
                .bind(limit as i64)
                .fetch_all(pool)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|(role, content)| ChatMessage { role, content })
                .collect();
        messages.reverse();

        Self { messages }
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    /// Map to LLM-format messages (role + content pairs).
    pub fn to_llm_messages(&self) -> Vec<LlmMessage> {
        self.messages
            .iter()
            .map(|m| LlmMessage {
                role: m.role.clone(),
                content: m.content.clone(),
            })
            .collect()
    }

    /// Flat text of all messages — used as Stage 2 embedding input for re-ranking.
    pub fn summary_text(&self) -> String {
        self.messages
            .iter()
            .map(|m| format!("{}: {}", m.role, m.content))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Build the full query string: history context + current message.
    pub fn with_current_query(&self, query: &str) -> String {
        if self.is_empty() {
            query.to_string()
        } else {
            format!("{}\n\nCurrent message: {}", self.summary_text(), query)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: String,
}

#[cfg(test)]
mod refusal_tag_tests {
    use super::*;

    /// The writer of this tag is in another crate. Nothing but this assertion
    /// ties the two spellings together, and a mismatch fails silently — the
    /// filter simply stops matching and refusals flow back into the prompt.
    #[test]
    fn the_filter_reads_the_key_the_writer_writes() {
        assert!(
            FETCH_HISTORY_SQL.contains(REFUSAL_METADATA_KEY),
            "the history query must filter on `{REFUSAL_METADATA_KEY}`: {FETCH_HISTORY_SQL}"
        );
    }
}
