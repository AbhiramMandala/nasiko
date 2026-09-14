use sqlx::PgPool;
use uuid::Uuid;

/// A user's chosen conversation-history context-selection strategy. Mirrors
/// the Postgres `context_selection_strategy` enum (migration 0013) —
/// deriving `sqlx::Type` lets sqlx decode the column directly instead of
/// treating it as TEXT.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, sqlx::Type,
)]
#[sqlx(type_name = "context_selection_strategy", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum ContextSelectionStrategy {
    /// Budget-aware, coverage-diversified selection (`SessionHistory::fetch_pacms`).
    /// Falls back to a token-budget-limited recency selection internally if
    /// embeddings fail.
    #[default]
    Pacms,
    /// Pure cosine-similarity ranking over query/answer pairs, no token
    /// budget (`SessionHistory::fetch_topk`). Falls back to plain recency
    /// (`SessionHistory::fetch`) if embeddings fail or the session has no pairs.
    TopK,
    /// Plain recency, no embeddings at all (`SessionHistory::fetch`).
    LastK,
}

impl ContextSelectionStrategy {
    /// Look up a user's persisted preference. Falls back to `Pacms` (the
    /// column default) if the row is missing or the query fails — a lookup
    /// hiccup must never block a chat request.
    pub async fn for_user(pool: &PgPool, user_id: Uuid) -> Self {
        sqlx::query_scalar::<_, Self>("SELECT context_selection_strategy FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
    }
}
