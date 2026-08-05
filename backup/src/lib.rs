//! Generic, key-addressed object storage for tenant control-plane backups
//! (Postgres dumps, rustfs mirrors, encrypted secret bundles).
//!
//! Deliberately key-addressed like `ee/multi-tenant`'s `KubeconfigStore`, not
//! content-addressed like `oss/oci`'s `S3Storage` — a backup's identity is
//! "this tenant's stop at this time", not its content digest.
//!
//! One trait, one default implementation: every real deployment target today
//! (DO Spaces, AWS S3, rustfs, GCS via its S3-interop API, MinIO-family
//! self-hosted stores) speaks the same S3 protocol, so `S3BackupStore` covers
//! both "Nasiko-managed" and "customer-provided" storage — only the
//! constructor arguments differ. A second `BackupStore` impl is only needed
//! if a customer's storage genuinely isn't S3-compatible.

mod error;
mod s3;

pub use error::{BackupStoreError, Result};
pub use s3::S3BackupStore;

use async_trait::async_trait;
use bytes::Bytes;

#[async_trait]
pub trait BackupStore: Send + Sync {
    async fn put(&self, key: &str, data: Bytes) -> Result<()>;
    async fn get(&self, key: &str) -> Result<Bytes>;
    async fn exists(&self, key: &str) -> Result<bool>;
    async fn delete(&self, key: &str) -> Result<()>;
    /// Deletes every object whose key starts with `prefix` — a rustfs
    /// mirror lands as many objects under one `tenant-backups/{cluster_id}/`
    /// prefix, and TTL garbage collection needs to reclaim all of them, not
    /// just a single known key.
    async fn delete_prefix(&self, prefix: &str) -> Result<()>;
}
