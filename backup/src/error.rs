use thiserror::Error;

#[derive(Debug, Error)]
pub enum BackupStoreError {
    #[error("object not found: {0}")]
    NotFound(String),

    #[error("storage error: {0}")]
    Storage(String),
}

pub type Result<T> = std::result::Result<T, BackupStoreError>;

/// The full source chain, not just the top-level `Display` — the AWS SDK's
/// `SdkError` renders as a bare "service error", and the actual cause
/// (`NoSuchBucket`, connection refused, …) lives in the chain below it.
/// Mirrors `ee/multi-tenant/src/kubeconfig_store.rs`'s `error_chain`.
pub(crate) fn error_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut source = e.source();
    while let Some(inner) = source {
        s.push_str(": ");
        s.push_str(&inner.to_string());
        source = inner.source();
    }
    s
}
