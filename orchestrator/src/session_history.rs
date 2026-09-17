use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::context_selection::ContextSelectionStrategy;
use crate::pacms_selector::PacmsSelector;
use crate::vector_store::{VectorStore, cosine_similarity};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// One user query paired with the assistant's reply that followed it, in a
/// session's chronological message stream. This is the candidate unit for
/// the `topk` context-selection strategy (`SessionHistory::fetch_topk`).
#[derive(Debug, Clone)]
pub struct MessagePair {
    pub query: String,
    pub answer: String,
}

#[derive(Debug, Clone, Default)]
pub struct SessionHistory {
    pub messages: Vec<ChatMessage>,
}

/// Per-call tuning knobs for [`SessionHistory::fetch_context`], bundled so
/// the dispatcher's argument count stays reasonable. Built for callers by
/// `ContextTiers::resolve` — nothing outside this crate constructs one, so
/// the operator-configured tier table is the only way in.
pub(crate) struct ContextFetchConfig {
    /// Candidate window both embedding-backed strategies draw from: the pool
    /// `fetch_pacms` selects a budget-fitting subset of, and the pool
    /// `fetch_topk` pairs up and ranks. Ignored by `LastK`, which is sized by
    /// `lastk_limit` alone.
    pub pool_size: usize,
    /// `fetch_pacms`'s token budget, already resolved from the user's
    /// `PacmsBudgetLevel` tier (ignored by `TopK`/`LastK`).
    pub token_budget: usize,
    /// `fetch_pacms`'s mandatory-recent window (ignored by `TopK`/`LastK`).
    pub mandatory_recent: usize,
    /// Number of most-relevant pairs `fetch_topk` keeps — resolved from the
    /// same `PacmsBudgetLevel` tier as `token_budget` above, via
    /// `PacmsBudgetLevel::k` (ignored by `Pacms`).
    pub topk_count: usize,
    /// Recency window for the standalone `LastK` strategy, and for `TopK`'s
    /// fallback when embeddings are unavailable or the session has no
    /// pairs — same tier-derived value as `topk_count` (ignored by `Pacms`).
    pub lastk_limit: usize,
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

    /// Dispatch to the user's selected context-selection strategy.
    ///
    /// `TopK` falls back to plain recency (`fetch`, sized by
    /// `cfg.lastk_limit`) if embeddings are unavailable or the session has
    /// no complete pairs yet — the same "a transient failure degrades to
    /// recency instead of breaking the request" contract `fetch_pacms`
    /// already has via its own internal `select_lastk` fallback.
    pub(crate) async fn fetch_context(
        strategy: ContextSelectionStrategy,
        session_id: &str,
        pool: &PgPool,
        vector_store: &VectorStore,
        query: &str,
        cfg: &ContextFetchConfig,
    ) -> Self {
        match strategy {
            ContextSelectionStrategy::Pacms => {
                Self::fetch_pacms(
                    session_id,
                    pool,
                    vector_store,
                    query,
                    cfg.pool_size,
                    cfg.token_budget,
                    cfg.mandatory_recent,
                )
                .await
            }
            ContextSelectionStrategy::TopK => {
                let history = Self::fetch_topk(
                    session_id,
                    pool,
                    query,
                    vector_store,
                    cfg.topk_count,
                    cfg.pool_size,
                )
                .await;
                if history.is_empty() {
                    Self::fetch(session_id, pool, cfg.lastk_limit).await
                } else {
                    history
                }
            }
            ContextSelectionStrategy::LastK => Self::fetch(session_id, pool, cfg.lastk_limit).await,
        }
    }

    /// Fetch the `top_k` message pairs most relevant to `query`, ranked by
    /// cosine similarity of their (query + answer) embedding to the query's
    /// embedding — most relevant first. Unlike `fetch`/`fetch_pacms`, the
    /// result is *not* restored to chronological order, and there is no
    /// token budget or mandatory-recent floor: this is a faithful port of
    /// the plain top-k-by-relevance baseline.
    ///
    /// Returns an empty history if the session has no complete pairs, or if
    /// embedding fails for any reason (disabled vector store, API error,
    /// mismatched response) — `fetch_context` falls back to `fetch` for the
    /// `TopK` strategy when this happens.
    pub async fn fetch_topk(
        session_id: &str,
        pool: &PgPool,
        query: &str,
        vector_store: &VectorStore,
        top_k: usize,
        pool_size: usize,
    ) -> Self {
        let pairs = Self::fetch_pairs(session_id, pool, pool_size).await;
        if pairs.is_empty() {
            return Self::default();
        }

        // Embed query+answer concatenated per pair, so a pair scores as
        // relevant if either half matches the current query.
        let pair_texts: Vec<String> = pairs
            .iter()
            .map(|p| format!("{} {}", p.query, p.answer))
            .collect();

        // One call for the query, one batched call for every pair.
        let query_embedding = vector_store.embed(query).await;
        let pair_embeddings = vector_store.embed_batch(&pair_texts).await;

        let (query_embedding, pair_embeddings) = match (query_embedding, pair_embeddings) {
            (Ok(q), Ok(p)) => (q, p),
            (Err(e), _) | (_, Err(e)) => {
                tracing::warn!(%e, "top-k context selection failed — embeddings unavailable");
                return Self::default();
            }
        };

        Self {
            messages: rank_pairs(&pairs, &pair_embeddings, &query_embedding, top_k),
        }
    }

    /// Pair up each `user` message with the `assistant` message that
    /// immediately follows it, over the latest `pool_size` messages.
    /// Unmatched trailing/leading messages (e.g. a query the assistant hasn't
    /// answered yet, or non user/assistant roles) are skipped.
    ///
    /// Bounded by the same `pool_size` window `fetch_pacms` draws from: this
    /// used to select the session's entire history with no `LIMIT` and embed
    /// every pair of it, so a long-running session grew both the query and
    /// the per-request embedding cost without limit.
    async fn fetch_pairs(session_id: &str, pool: &PgPool, pool_size: usize) -> Vec<MessagePair> {
        // Latest `pool_size` (DESC + LIMIT), then reversed back into
        // chronological order so the pairing below sees user→assistant
        // adjacency — `ORDER BY timestamp ASC LIMIT n` would pin the window to
        // the oldest messages and never advance, the same trap `fetch_raw`
        // documents.
        let mut messages: Vec<(String, String)> = sqlx::query_as::<_, (String, String)>(
            "SELECT role, content FROM chat_messages \
             WHERE session_id = $1 ORDER BY timestamp DESC LIMIT $2",
        )
        .bind(session_id)
        .bind(pool_size as i64)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        messages.reverse();

        let mut pairs = Vec::new();
        let mut i = 0;
        while i + 1 < messages.len() {
            let (role_a, content_a) = &messages[i];
            let (role_b, content_b) = &messages[i + 1];
            if role_a == "user" && role_b == "assistant" {
                pairs.push(MessagePair {
                    query: content_a.clone(),
                    answer: content_b.clone(),
                });
                i += 2; // consume both messages of the pair
            } else {
                i += 1; // not a user→assistant pair here — slide the window by one
            }
        }
        pairs
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

/// The pure selection core of `fetch_topk`: no I/O, so it can be exercised
/// with fabricated embeddings instead of a live embeddings endpoint. Scores
/// every pair by cosine similarity to `query_embedding`, sorts descending,
/// and flattens the top `top_k` pairs into `[user, assistant]` messages —
/// in similarity-rank order, not chronological order.
fn rank_pairs(
    pairs: &[MessagePair],
    pair_embeddings: &[Vec<f32>],
    query_embedding: &[f32],
    top_k: usize,
) -> Vec<ChatMessage> {
    let mut scored: Vec<(f32, &MessagePair)> = pairs
        .iter()
        .zip(pair_embeddings.iter())
        .map(|(pair, emb)| (cosine_similarity(query_embedding, emb), pair))
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    scored
        .into_iter()
        .take(top_k)
        .flat_map(|(_, pair)| {
            [
                ChatMessage {
                    role: "user".to_string(),
                    content: pair.query.clone(),
                },
                ChatMessage {
                    role: "assistant".to_string(),
                    content: pair.answer.clone(),
                },
            ]
        })
        .collect()
}

#[cfg(test)]
mod rank_pairs_tests {
    use super::*;

    fn pair(query: &str, answer: &str) -> MessagePair {
        MessagePair {
            query: query.to_string(),
            answer: answer.to_string(),
        }
    }

    #[test]
    fn ranks_by_similarity_not_recency() {
        // Oldest pair first in the input, but its embedding is closest to
        // the query — it must come out first, not last.
        let pairs = vec![
            pair("refund status", "processed yesterday"),
            pair("shipping estimate", "3-5 business days"),
            pair("login help", "reset your password"),
        ];
        let embeddings = vec![
            vec![1.0, 0.0], // "refund" — closest to the query below
            vec![0.0, 1.0], // "shipping" — orthogonal
            vec![0.5, 0.5], // "login" — partial overlap
        ];
        let query_embedding = vec![1.0, 0.0];

        let messages = rank_pairs(&pairs, &embeddings, &query_embedding, 2);

        assert_eq!(messages.len(), 4); // top_k=2 pairs * 2 messages each
        assert_eq!(messages[0].content, "refund status");
        assert_eq!(messages[1].content, "processed yesterday");
        // Second-ranked by cosine similarity is "login" (0.5,0.5), not the
        // chronologically-second "shipping" (0.0,1.0).
        assert_eq!(messages[2].content, "login help");
        assert_eq!(messages[3].content, "reset your password");
    }

    #[test]
    fn top_k_larger_than_pool_returns_everything() {
        let pairs = vec![pair("a", "b")];
        let embeddings = vec![vec![1.0, 0.0]];
        let messages = rank_pairs(&pairs, &embeddings, &[1.0, 0.0], 10);
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn empty_pool_returns_empty() {
        let messages = rank_pairs(&[], &[], &[1.0, 0.0], 5);
        assert!(messages.is_empty());
    }
}
