use crate::types::ParseEnumError;

#[derive(Debug, thiserror::Error)]
pub enum HitlError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    /// A `hitl_requests` row didn't decode into `HitlRequest` — a `kind`/
    /// `origin`/`status`/`resume_status` column held a string outside the
    /// enum's known variants. The table's own CHECK constraints should make
    /// this unreachable; surfaced as an error rather than a panic in case a
    /// future migration ever adds a wire value this crate hasn't learned yet.
    #[error("corrupt hitl_requests row: {0}")]
    InvalidRow(#[from] ParseEnumError),
}

pub type Result<T> = std::result::Result<T, HitlError>;
