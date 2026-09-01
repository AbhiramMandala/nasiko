use aws_config::{BehaviorVersion, Region};
use aws_sdk_s3::{
    Client, config::Credentials, error::ProvideErrorMetadata, presigning::PresigningConfig,
};
use nasiko_runtime::{BlobStore, BlobStoreError};
use std::time::Duration;

/// Renders an S3 failure with the detail needed to act on it.
///
/// `SdkError`'s own `Display` is only a category — "service error", "dispatch
/// failure" — so a plain `e.to_string()` collapses a wrong `S3_SECRET_KEY` into
/// an undiagnosable "storage error". The code that names the actual fault
/// (`SignatureDoesNotMatch`, `InvalidAccessKeyId`, `AccessDenied`,
/// `NoSuchBucket`) lives in the error metadata and the transport cause sits
/// further down the source chain. Both matter once the bucket can be a managed
/// service the operator wired up by hand, where credentials and endpoint are the
/// likeliest things to be wrong. Only the log carries this — the `/v2` response
/// body stays generic, since a registry client is not the audience.
fn s3_error<E>(err: &E) -> String
where
    E: ProvideErrorMetadata + std::error::Error,
{
    let mut out = String::new();
    if let Some(code) = err.code() {
        out.push_str(code);
        out.push_str(": ");
    }
    out.push_str(&err.to_string());
    let mut source = err.source();
    while let Some(cause) = source {
        out.push_str(": ");
        out.push_str(&cause.to_string());
        source = cause.source();
    }
    out
}

#[derive(Clone)]
pub struct S3Storage {
    client: Client,
    bucket: String,
}

impl S3Storage {
    pub async fn new(
        endpoint: Option<String>,
        region: String,
        access_key: String,
        secret_key: String,
        bucket: String,
        force_path_style: bool,
    ) -> std::result::Result<Self, anyhow::Error> {
        let creds = Credentials::new(&access_key, &secret_key, None, None, "registry");
        let region = Region::new(region);

        let mut builder = aws_config::defaults(BehaviorVersion::latest())
            .region(region)
            .credentials_provider(creds);

        if let Some(ep) = endpoint {
            builder = builder.endpoint_url(ep);
        }

        let sdk_config = builder.load().await;
        let s3_config = aws_sdk_s3::config::Builder::from(&sdk_config)
            .force_path_style(force_path_style)
            .build();

        let client = Client::from_conf(s3_config);
        Ok(Self { client, bucket })
    }

    /// Construct from S3_* environment variables (including
    /// `S3_FORCE_PATH_STYLE`, see [`force_path_style_from_env`]).
    pub async fn from_env(bucket: String) -> Self {
        let endpoint = std::env::var("S3_ENDPOINT").ok();
        let region = std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".into());
        let access_key = std::env::var("S3_ACCESS_KEY").unwrap_or_else(|_| "nasiko".into());
        let secret_key = std::env::var("S3_SECRET_KEY").unwrap_or_default();

        Self::new(
            endpoint,
            region,
            access_key,
            secret_key,
            bucket,
            force_path_style_from_env(),
        )
        .await
        .expect("failed to create S3 client")
    }

    pub fn blob_key(digest: &str) -> String {
        format!("blobs/{}", digest.replace(':', "/"))
    }
}

#[async_trait::async_trait]
impl BlobStore for S3Storage {
    async fn put_blob(&self, digest: &str, data: bytes::Bytes) -> Result<i64, BlobStoreError> {
        let key = Self::blob_key(digest);
        let size = data.len() as i64;
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .body(data.into())
            .send()
            .await
            .map_err(|e| BlobStoreError::Backend(s3_error(&e)))?;
        Ok(size)
    }

    async fn get_blob(&self, digest: &str) -> Result<bytes::Bytes, BlobStoreError> {
        let key = Self::blob_key(digest);
        let resp = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
            // A missing object is "not found", not a storage failure. Collapsing
            // both into `Backend` made a pull of an absent blob a 500, where the
            // Distribution Spec requires 404 — and disagreed with `blob_size`,
            // which already reports absence as `NotFound`, so HEAD and GET on the
            // same missing digest answered differently.
            .map_err(|e| {
                let msg = s3_error(&e);
                if e.into_service_error().is_no_such_key() {
                    BlobStoreError::NotFound(format!("blob {digest} not found"))
                } else {
                    BlobStoreError::Backend(msg)
                }
            })?;
        let data = resp
            .body
            .collect()
            .await
            .map_err(|e| BlobStoreError::Backend(e.to_string()))?;
        Ok(data.into_bytes())
    }

    async fn presigned_get_url(
        &self,
        digest: &str,
        ttl_secs: u64,
    ) -> Result<String, BlobStoreError> {
        let key = Self::blob_key(digest);
        let config = PresigningConfig::expires_in(Duration::from_secs(ttl_secs))
            .map_err(|e| BlobStoreError::Backend(e.to_string()))?;
        let url = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .presigned(config)
            .await
            .map_err(|e| BlobStoreError::Backend(e.to_string()))?;
        Ok(url.uri().to_string())
    }

    async fn delete_blob(&self, digest: &str) -> Result<(), BlobStoreError> {
        let key = Self::blob_key(digest);
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
            .map_err(|e| BlobStoreError::Backend(s3_error(&e)))?;
        Ok(())
    }

    async fn blob_exists(&self, digest: &str) -> bool {
        let key = Self::blob_key(digest);
        self.client
            .head_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
            .is_ok()
    }

    async fn blob_size(&self, digest: &str) -> Result<i64, BlobStoreError> {
        let key = Self::blob_key(digest);
        let resp = self
            .client
            .head_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
            // Every HEAD failure reads as absence, including a rejected
            // credential — imprecise, but preserved verbatim from before the
            // trait seam so this refactor changes no status code. The detail
            // `s3_error` carries still names the real cause in the log.
            .map_err(|e| BlobStoreError::NotFound(s3_error(&e)))?;
        Ok(resp.content_length.unwrap_or(0))
    }

    async fn ensure_bucket(&self, skip_create: bool) -> std::result::Result<(), anyhow::Error> {
        let exists = self
            .client
            .head_bucket()
            .bucket(&self.bucket)
            .send()
            .await
            .is_ok();

        if exists {
            return Ok(());
        }

        if skip_create {
            anyhow::bail!(
                "S3 bucket '{}' not found. Create it first (skip_create=true).",
                self.bucket
            );
        }

        self.client
            .create_bucket()
            .bucket(&self.bucket)
            .send()
            .await?;
        tracing::info!("created S3 bucket: {}", self.bucket);
        Ok(())
    }
}

/// `S3_FORCE_PATH_STYLE`: path-style requests (`endpoint.com/bucket/key`),
/// defaulting **true** — RustFS/MinIO (every in-cluster install) require it,
/// so only an explicit `false`/`0` switches to virtual-hosted style. The
/// negative parse keeps a typo'd value from silently flipping the default
/// out from under existing stores.
pub fn force_path_style_from_env() -> bool {
    parse_force_path_style(std::env::var("S3_FORCE_PATH_STYLE").ok().as_deref())
}

fn parse_force_path_style(value: Option<&str>) -> bool {
    !matches!(value.map(str::trim), Some("false") | Some("0"))
}

#[cfg(test)]
mod tests {
    use super::parse_force_path_style;

    #[test]
    fn force_path_style_defaults_true_and_only_explicit_false_disables() {
        assert!(parse_force_path_style(None));
        assert!(parse_force_path_style(Some("true")));
        assert!(parse_force_path_style(Some("1")));
        assert!(parse_force_path_style(Some("garbage")));
        assert!(!parse_force_path_style(Some("false")));
        assert!(!parse_force_path_style(Some("0")));
    }
}

// ─── Backend selection ───────────────────────────────────────────────────────

/// Which object-storage protocol the platform speaks, from `STORAGE_PROVIDER`.
///
/// Defaults to S3 so every existing deployment keeps its behavior with no
/// values change; `azure-blob` is opt-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageProvider {
    /// Any S3-compatible store: RustFS, MinIO, real AWS S3, Nebius object storage.
    S3,
    /// Native Azure Blob Storage.
    AzureBlob,
}

impl StorageProvider {
    /// Unknown values fail rather than silently falling back to S3: a typo'd
    /// provider that quietly used the wrong backend would surface as a pile of
    /// missing blobs long after startup.
    pub fn parse(value: &str) -> Result<Self, anyhow::Error> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "s3" => Ok(Self::S3),
            "azure-blob" | "azure_blob" | "azure" => Ok(Self::AzureBlob),
            other => anyhow::bail!(
                "unknown STORAGE_PROVIDER '{other}' — expected 's3' (default, any \
                 S3-compatible store) or 'azure-blob'"
            ),
        }
    }

    pub fn from_env() -> Result<Self, anyhow::Error> {
        Self::parse(&std::env::var("STORAGE_PROVIDER").unwrap_or_default())
    }
}

/// Flags configuration that names two backends at once.
///
/// Both credential sets present is not a preference to resolve, it is a
/// mistake: whichever one loses is silently ignored, and the operator learns
/// about it when the wrong store turns out to be empty. Returns the message to
/// fail with, or `None` when the config is coherent.
pub fn conflicting_storage_config(
    provider: StorageProvider,
    s3_endpoint_set: bool,
    azure_account_set: bool,
) -> Option<String> {
    match provider {
        StorageProvider::AzureBlob if s3_endpoint_set => Some(
            "STORAGE_PROVIDER=azure-blob but S3_ENDPOINT is also set. Only one object \
             store is used; remove the S3 settings (chart: `minio.external.endpoint`) \
             or switch STORAGE_PROVIDER back to s3."
                .to_owned(),
        ),
        StorageProvider::S3 if azure_account_set => Some(
            "AZURE_STORAGE_ACCOUNT is set but STORAGE_PROVIDER is not 'azure-blob', so \
             the Azure store would be ignored. Set STORAGE_PROVIDER=azure-blob (chart: \
             `minio.external.provider`) or remove the Azure settings."
                .to_owned(),
        ),
        _ => None,
    }
}

/// The composition-root factory: one call site shape for every backend.
///
/// Panics on a misconfiguration rather than degrading, matching the other
/// startup-critical seams (`SECRETS_ENCRYPTION_KEY`, the Postgres connect): a
/// control plane that boots with the wrong object store looks healthy and
/// loses artifacts.
pub async fn blob_store_from_env(bucket: String) -> std::sync::Arc<dyn BlobStore> {
    let provider = StorageProvider::from_env().unwrap_or_else(|e| panic!("{e}"));

    if let Some(msg) = conflicting_storage_config(
        provider,
        std::env::var("S3_ENDPOINT").is_ok_and(|v| !v.trim().is_empty()),
        std::env::var("AZURE_STORAGE_ACCOUNT").is_ok_and(|v| !v.trim().is_empty()),
    ) {
        panic!("{msg}");
    }

    match provider {
        StorageProvider::S3 => std::sync::Arc::new(S3Storage::from_env(bucket).await),
        StorageProvider::AzureBlob => std::sync::Arc::new(
            crate::azure::AzureBlobStorage::from_env(bucket).unwrap_or_else(|e| panic!("{e}")),
        ),
    }
}

#[cfg(test)]
mod provider_tests {
    use super::*;

    #[test]
    fn provider_defaults_to_s3_and_rejects_typos() {
        assert_eq!(StorageProvider::parse("").unwrap(), StorageProvider::S3);
        assert_eq!(StorageProvider::parse("s3").unwrap(), StorageProvider::S3);
        assert_eq!(
            StorageProvider::parse(" Azure-Blob ").unwrap(),
            StorageProvider::AzureBlob
        );
        let err = StorageProvider::parse("azureblob").unwrap_err().to_string();
        assert!(err.contains("unknown STORAGE_PROVIDER"), "{err}");
    }

    #[test]
    fn naming_two_backends_at_once_is_rejected_in_both_directions() {
        assert!(
            conflicting_storage_config(StorageProvider::AzureBlob, true, true)
                .unwrap()
                .contains("S3_ENDPOINT is also set")
        );
        assert!(
            conflicting_storage_config(StorageProvider::S3, true, true)
                .unwrap()
                .contains("would be ignored")
        );
        // Each backend configured alone is fine.
        assert!(conflicting_storage_config(StorageProvider::AzureBlob, false, true).is_none());
        assert!(conflicting_storage_config(StorageProvider::S3, true, false).is_none());
    }
}
