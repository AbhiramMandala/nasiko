use thiserror::Error;

#[derive(Debug, Error)]
pub enum RouterError {
    #[error("no agents available")]
    NoAgentsAvailable,
    /// Agents exist and were considered, but none met the operator's confidence
    /// bar. Distinct from `NoAgentsAvailable` (an empty fleet) because the
    /// caller's remedy differs: deploy an agent vs. lower the bar or accept the
    /// refusal. Callers must NOT paper over this with a fallback pick — doing so
    /// reinstates exactly the "route to something, anything" behaviour the
    /// confidence bar exists to prevent.
    #[error("no agent met the {required}% confidence bar (best was {best:.0}%)")]
    NoSuitableAgent { best: f64, required: u8 },
    #[error("agent not found: {0}")]
    AgentNotFound(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("embedding error: {0}")]
    Embedding(String),
    #[error("selection failed: {0}")]
    Selection(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<crate::selector::SelectorError> for RouterError {
    fn from(e: crate::selector::SelectorError) -> Self {
        RouterError::Selection(e.to_string())
    }
}
