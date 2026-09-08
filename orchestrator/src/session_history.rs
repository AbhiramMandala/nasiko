use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::pacms_selector::PacmsSelector;
use crate::vector_store::VectorStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct SessionHistory {
    pub messages: Vec<ChatMessage>,
}

impl SessionHistory {
    /// Take the LATEST `limit` messages, then restore chronological order —
    /// `ORDER BY timestamp ASC LIMIT n` would pin the window to the oldest
    /// messages and never advance in long sessions.
    async fn fetch_raw(session_id: &str, pool: &PgPool, limit: usize) -> Vec<ChatMessage> {
        let mut messages: Vec<ChatMessage> = sqlx::query_as::<_, (String, String)>(
            "SELECT role, content FROM chat_messages \
             WHERE session_id = $1 ORDER BY timestamp DESC LIMIT $2",
        )
        .bind(session_id)
        .bind(limit as i64)
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(role, content)| ChatMessage { role, content })
        .collect();
        messages.reverse();
        messages
    }

    pub async fn fetch(session_id: &str, pool: &PgPool, limit: usize) -> Self {
        Self {
            messages: Self::fetch_raw(session_id, pool, limit).await,
        }
    }

    /// PACMS-selected context: pulls a wider `pool_size` window of recent
    /// messages, then uses `PacmsSelector` to pick a `token_budget`-fitting,
    /// query-relevant, coverage-diversified subset instead of plain
    /// recency truncation — the most recent `mandatory_recent` messages in
    /// the pool are always kept, so the immediate thread is never dropped.
    ///
    /// Falls back to `select_lastk` (no embeddings) if selection fails (e.g.
    /// the embeddings API is down) so a transient failure degrades to the
    /// old recency behavior instead of breaking the request.
    pub async fn fetch_pacms(
        session_id: &str,
        pool: &PgPool,
        vector_store: &VectorStore,
        query: &str,
        pool_size: usize,
        token_budget: usize,
        mandatory_recent: usize,
    ) -> Self {
        let messages = Self::fetch_raw(session_id, pool, pool_size).await;
        if messages.is_empty() {
            return Self { messages };
        }

        let candidates: Vec<String> = messages
            .iter()
            .map(|m| format!("{}: {}", m.role, m.content))
            .collect();

        let n = candidates.len();
        let mandatory: HashSet<usize> = (n.saturating_sub(mandatory_recent)..n).collect();

        let selector = PacmsSelector::new(vector_store);
        let selected = match selector
            .select_pacms(&candidates, query, token_budget, Some(&mandatory))
            .await
        {
            Ok(idx) => idx,
            Err(e) => {
                tracing::warn!(%e, "PACMS context selection failed — falling back to recency selection");
                selector.select_lastk(&candidates, token_budget, Some(&mandatory))
            }
        };

        let mut selected = selected;
        selected.sort_unstable();
        let selected_set: HashSet<usize> = selected.iter().copied().collect();

        tracing::debug!(
            target: "pacms_context",
            session_id,
            query,
            selected_count = selected.len(),
            pool_size = n,
            "PACMS context selection for query — kept {}/{} pooled messages",
            selected.len(),
            n
        );
        for (i, m) in messages.iter().enumerate() {
            let kept = selected_set.contains(&i);
            tracing::debug!(
                target: "pacms_context",
                pool_index = i,
                kept,
                mandatory = mandatory.contains(&i),
                role = %m.role,
                content = %m.content,
                "{} [{i}] {}: {}",
                if kept { "KEPT" } else { "DROP" },
                m.role,
                m.content
            );
        }

        let messages: Vec<ChatMessage> = selected
            .into_iter()
            .filter_map(|i| messages.get(i).cloned())
            .collect();

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
