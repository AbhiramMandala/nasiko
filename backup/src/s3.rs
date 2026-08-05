use async_trait::async_trait;
use aws_config::{BehaviorVersion, Region};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::Credentials;
use bytes::Bytes;

use crate::BackupStore;
use crate::error::{BackupStoreError, Result, error_chain};

/// S3-compatible backup storage — the same client shape as
/// `ee/multi-tenant/src/kubeconfig_store.rs::KubeconfigStore` and
/// `oss/oci/src/storage.rs::S3Storage`. Constructed once per backup target:
/// the platform's own managed bucket, or a tenant's customer-supplied
/// endpoint/bucket/credentials — both are just different constructor
/// arguments to the same type.
#[derive(Clone)]
pub struct S3BackupStore {
    client: Client,
    bucket: String,
}

impl S3BackupStore {
    pub async fn new(
        endpoint: Option<String>,
        region: String,
        access_key: String,
        secret_key: String,
        bucket: String,
        force_path_style: bool,
    ) -> Self {
        let creds = Credentials::new(&access_key, &secret_key, None, None, "nasiko-backup");
        let mut builder = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region))
            .credentials_provider(creds);
        if let Some(ep) = endpoint {
            builder = builder.endpoint_url(ep);
        }
        let sdk_config = builder.load().await;
        let s3_config = aws_sdk_s3::config::Builder::from(&sdk_config)
            .force_path_style(force_path_style)
            .build();
        let client = Client::from_conf(s3_config);
        ensure_bucket(&client, &bucket).await;
        Self { client, bucket }
    }
}

#[async_trait]
impl BackupStore for S3BackupStore {
    async fn put(&self, key: &str, data: Bytes) -> Result<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(data.into())
            .send()
            .await
            .map_err(|e| {
                BackupStoreError::Storage(format!(
                    "uploading backup object to s3://{}/{key}: {}",
                    self.bucket,
                    error_chain(&e)
                ))
            })?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Bytes> {
        let output = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| {
                BackupStoreError::Storage(format!(
                    "fetching backup object at s3://{}/{key}: {}",
                    self.bucket,
                    error_chain(&e)
                ))
            })?;
        let bytes = output.body.collect().await.map_err(|e| {
            BackupStoreError::Storage(format!(
                "reading backup object body at s3://{}/{key}: {}",
                self.bucket,
                error_chain(&e)
            ))
        })?;
        Ok(bytes.into_bytes())
    }

    async fn exists(&self, key: &str) -> Result<bool> {
        match self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(e) => {
                let service_error = e.into_service_error();
                if service_error.is_not_found() {
                    return Ok(false);
                }
                Err(BackupStoreError::Storage(format!(
                    "checking for a backup object at s3://{}/{key}: {}",
                    self.bucket,
                    error_chain(&service_error)
                )))
            }
        }
    }

    async fn delete(&self, key: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| {
                BackupStoreError::Storage(format!(
                    "deleting backup object at s3://{}/{key}: {}",
                    self.bucket,
                    error_chain(&e)
                ))
            })?;
        Ok(())
    }

    async fn delete_prefix(&self, prefix: &str) -> Result<()> {
        let mut continuation_token: Option<String> = None;
        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(prefix);
            if let Some(token) = &continuation_token {
                req = req.continuation_token(token);
            }
            let page = req.send().await.map_err(|e| {
                BackupStoreError::Storage(format!(
                    "listing objects under s3://{}/{prefix}: {}",
                    self.bucket,
                    error_chain(&e)
                ))
            })?;
            for object in page.contents() {
                let Some(key) = object.key() else { continue };
                self.client
                    .delete_object()
                    .bucket(&self.bucket)
                    .key(key)
                    .send()
                    .await
                    .map_err(|e| {
                        BackupStoreError::Storage(format!(
                            "deleting backup object at s3://{}/{key}: {}",
                            self.bucket,
                            error_chain(&e)
                        ))
                    })?;
            }
            if page.is_truncated().unwrap_or(false) {
                continuation_token = page.next_continuation_token().map(str::to_string);
            } else {
                return Ok(());
            }
        }
    }
}

/// Creates the bucket if it doesn't exist yet — best-effort, mirroring
/// `KubeconfigStore`'s `ensure_bucket`: managed deployments normally
/// pre-create the bucket and may deny `CreateBucket` outright, and a
/// customer-provided bucket is very likely pre-existing and access-limited.
async fn ensure_bucket(client: &Client, bucket: &str) {
    match client.create_bucket().bucket(bucket).send().await {
        Ok(_) => tracing::info!(bucket, "created the backup storage bucket"),
        Err(e) => {
            let service_error = e.into_service_error();
            if service_error.is_bucket_already_exists()
                || service_error.is_bucket_already_owned_by_you()
            {
                return;
            }
            tracing::warn!(
                bucket,
                error = %error_chain(&service_error),
                "could not ensure the backup bucket exists — backups will fail unless it was pre-created"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end against the local rustfs/MinIO started by `just infra` —
    /// hermetic in CI only insofar as that stack is up; skipped otherwise via
    /// the same `S3_*` env convention `oss/oci`'s tests use.
    async fn store_from_env() -> Option<S3BackupStore> {
        let endpoint = std::env::var("S3_ENDPOINT").ok()?;
        let bucket = format!("nasiko-backup-test-{}", uuid::Uuid::new_v4().simple());
        Some(
            S3BackupStore::new(
                Some(endpoint),
                std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
                std::env::var("S3_ACCESS_KEY").unwrap_or_else(|_| "nasiko".into()),
                std::env::var("S3_SECRET_KEY").unwrap_or_default(),
                bucket,
                true,
            )
            .await,
        )
    }

    #[tokio::test]
    async fn put_get_exists_delete_round_trip() {
        let Some(store) = store_from_env().await else {
            eprintln!("skipping: S3_ENDPOINT not set (run `just infra` for a local target)");
            return;
        };

        let key = "tenant-backups/test-cluster/pg.dump";
        assert!(!store.exists(key).await.unwrap());

        store
            .put(key, Bytes::from_static(b"dump-bytes"))
            .await
            .unwrap();
        assert!(store.exists(key).await.unwrap());
        assert_eq!(
            store.get(key).await.unwrap(),
            Bytes::from_static(b"dump-bytes")
        );

        store.delete(key).await.unwrap();
        assert!(!store.exists(key).await.unwrap());
    }

    #[tokio::test]
    async fn get_of_missing_key_is_an_error() {
        let Some(store) = store_from_env().await else {
            eprintln!("skipping: S3_ENDPOINT not set (run `just infra` for a local target)");
            return;
        };
        assert!(store.get("does/not/exist").await.is_err());
    }

    #[tokio::test]
    async fn delete_prefix_removes_every_object_under_it_and_nothing_else() {
        let Some(store) = store_from_env().await else {
            eprintln!("skipping: S3_ENDPOINT not set (run `just infra` for a local target)");
            return;
        };

        let prefix = "tenant-backups/cluster-x";
        store
            .put(&format!("{prefix}/pg.dump"), Bytes::from_static(b"a"))
            .await
            .unwrap();
        store
            .put(&format!("{prefix}/nasiko/blob1"), Bytes::from_static(b"b"))
            .await
            .unwrap();
        store
            .put(
                &format!("{prefix}/nasiko-artifacts/blob2"),
                Bytes::from_static(b"c"),
            )
            .await
            .unwrap();
        let sibling = "tenant-backups/cluster-y/pg.dump";
        store.put(sibling, Bytes::from_static(b"d")).await.unwrap();

        store.delete_prefix(prefix).await.unwrap();

        assert!(!store.exists(&format!("{prefix}/pg.dump")).await.unwrap());
        assert!(
            !store
                .exists(&format!("{prefix}/nasiko/blob1"))
                .await
                .unwrap()
        );
        assert!(
            !store
                .exists(&format!("{prefix}/nasiko-artifacts/blob2"))
                .await
                .unwrap()
        );
        assert!(
            store.exists(sibling).await.unwrap(),
            "a sibling cluster's backup must survive another cluster's deletion"
        );
        store.delete(sibling).await.unwrap();
    }
}
