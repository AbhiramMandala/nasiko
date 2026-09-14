use sqlx::PgPool;
use uuid::Uuid;

/// A user's chosen conversation-history tier. Mirrors the Postgres
/// `pacms_budget_level` enum (migration 0012) — deriving `sqlx::Type` lets
/// sqlx decode the column directly instead of treating it as TEXT.
///
/// The tier only names *which* level a user picked; the actual token counts
/// (`PACMS` strategy, via [`Self::tokens`]) and item counts (`TopK`/`LastK`
/// strategies, via [`Self::k`]) are both operator-configurable
/// (`Config.pacms_budget_low/medium/high` and `Config.context_k_low/medium/high`
/// respectively), so an operator can retune what "high" means per deployment
/// without touching user data.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, sqlx::Type,
)]
#[sqlx(type_name = "pacms_budget_level", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum PacmsBudgetLevel {
    Low,
    #[default]
    Medium,
    High,
}

impl PacmsBudgetLevel {
    /// Resolve this tier to a token count using the operator-configured values
    /// for each tier.
    pub fn tokens(&self, low: usize, medium: usize, high: usize) -> usize {
        match self {
            Self::Low => low,
            Self::Medium => medium,
            Self::High => high,
        }
    }

    /// Resolve this tier to an item count using the operator-configured
    /// values for each tier — the same tier `tokens()` reads, but for the
    /// `topk`/`lastk` context-selection strategies' pair/message count
    /// instead of PACMS's token budget.
    pub fn k(&self, low: usize, medium: usize, high: usize) -> usize {
        match self {
            Self::Low => low,
            Self::Medium => medium,
            Self::High => high,
        }
    }

    /// Look up a user's persisted preference. Falls back to `Medium` (the
    /// column default) if the row is missing or the query fails — a lookup
    /// hiccup must never block a chat request.
    pub async fn for_user(pool: &PgPool, user_id: Uuid) -> Self {
        sqlx::query_scalar::<_, Self>("SELECT pacms_budget_level FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .unwrap_or_default()
    }
}
