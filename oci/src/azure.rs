//! Azure Blob Storage as a [`BlobStore`].
//!
//! Azure exposes no S3-compatible API, so an Azure deployment that wants a
//! managed object store — rather than self-hosting RustFS/MinIO on a disk it
//! also has to run — needs the native protocol. This is that backend.
//!
//! Built on `object_store` rather than a second Azure SDK, deliberately: the
//! crate is already a dependency (the K8s build-context path uses its S3
//! backend), and its `Signer` impl for `MicrosoftAzure` produces Service SAS
//! URLs — the Azure equivalent of an S3 presigned URL — so the one operation
//! that would otherwise need hand-rolled request signing comes for free.

use std::time::Duration;

use bytes::Bytes;
use nasiko_runtime::{BlobStore, BlobStoreError};
use object_store::{ObjectStore, azure::MicrosoftAzureBuilder, path::Path, signer::Signer};

/// Renders an `object_store` failure with the detail needed to act on it,
/// mirroring `storage::s3_error`.
///
/// The top-level `Display` of an `object_store::Error` is usually the generic
/// operation wrapper; the status code and Azure's own error text sit in the
/// source chain. On a store the operator wired up by hand, that chain is the
/// difference between "storage error" and "your account key is wrong".
fn azure_error(context: &str, err: &object_store::Error) -> String {
    let mut out = format!("{context}: {err}");
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        out.push_str(": ");
        out.push_str(&cause.to_string());
        source = cause.source();
    }
    out
}

/// Absence must stay absence across the seam, whatever the backend calls it.
fn map_err(context: &str, err: object_store::Error) -> BlobStoreError {
    match err {
        object_store::Error::NotFound { .. } => BlobStoreError::NotFound(azure_error(context, &err)),
        other => BlobStoreError::Backend(azure_error(context, &other)),
    }
}

#[derive(Clone)]
pub struct AzureBlobStorage {
    store: std::sync::Arc<object_store::azure::MicrosoftAzure>,
    account: String,
    container: String,
}

impl AzureBlobStorage {
    /// `endpoint` is only for emulators (Azurite) and sovereign clouds; leave
    /// it unset for public Azure, where the account name determines the host.
    pub fn new(
        account: String,
        access_key: String,
        container: String,
        endpoint: Option<String>,
    ) -> Result<Self, anyhow::Error> {
        let mut builder = MicrosoftAzureBuilder::new()
            .with_account(&account)
            .with_access_key(&access_key)
            .with_container_name(&container);

        if let Some(ep) = endpoint.as_deref().filter(|e| !e.is_empty()) {
            // Plaintext is allowed only for an emulator on loopback — the
            // account key is a bearer credential and must not cross a network
            // in the clear. Mirrors the chart's same rule for S3 endpoints.
            let allow_http = ep.starts_with("http://");
            builder = builder.with_endpoint(ep.to_owned()).with_allow_http(allow_http);
        }

        let store = builder.build().map_err(|e| {
            anyhow::anyhow!(
                "invalid Azure Blob configuration for account '{account}', container \
                 '{container}': {e}. Check AZURE_STORAGE_ACCOUNT and \
                 AZURE_STORAGE_ACCESS_KEY."
            )
        })?;

        Ok(Self {
            store: std::sync::Arc::new(store),
            account,
            container,
        })
    }

    /// Reads the same `AZURE_STORAGE_*` names the Azure CLI and SDKs use, so an
    /// operator's existing environment works unchanged.
    pub fn from_env(container: String) -> Result<Self, anyhow::Error> {
        let account = std::env::var("AZURE_STORAGE_ACCOUNT").map_err(|_| {
            anyhow::anyhow!(
                "STORAGE_PROVIDER=azure-blob requires AZURE_STORAGE_ACCOUNT (the storage \
                 account name, e.g. `nasikoprod`)."
            )
        })?;
        let access_key = std::env::var("AZURE_STORAGE_ACCESS_KEY").map_err(|_| {
            anyhow::anyhow!(
                "STORAGE_PROVIDER=azure-blob requires AZURE_STORAGE_ACCESS_KEY (an account \
                 access key: `az storage account keys list --account-name <acct>`)."
            )
        })?;
        let endpoint = std::env::var("AZURE_STORAGE_ENDPOINT").ok();
        Self::new(account, access_key, container, endpoint)
    }

    /// Same digest→key mapping as the S3 backend, so the two are
    /// interchangeable for a given bucket layout and a migration is a plain
    /// object copy rather than a re-keying.
    fn blob_path(digest: &str) -> Path {
        Path::from(crate::storage::S3Storage::blob_key(digest))
    }

    /// The host a SAS URL will point at — named in errors because on a private
    /// deployment its reachability, and its private-DNS zone, is the thing
    /// most likely to be missing.
    fn host(&self) -> String {
        format!("{}.blob.core.windows.net/{}", self.account, self.container)
    }
}

#[async_trait::async_trait]
impl BlobStore for AzureBlobStorage {
    async fn put_blob(&self, digest: &str, data: Bytes) -> Result<i64, BlobStoreError> {
        let size = data.len() as i64;
        self.store
            .put(&Self::blob_path(digest), data.into())
            .await
            .map_err(|e| map_err(&format!("azure blob put {}", self.host()), e))?;
        Ok(size)
    }

    async fn get_blob(&self, digest: &str) -> Result<Bytes, BlobStoreError> {
        let res = self
            .store
            .get(&Self::blob_path(digest))
            .await
            .map_err(|e| match e {
                object_store::Error::NotFound { .. } => {
                    BlobStoreError::NotFound(format!("blob {digest} not found"))
                }
                other => BlobStoreError::Backend(azure_error(
                    &format!("azure blob get {}", self.host()),
                    &other,
                )),
            })?;
        res.bytes()
            .await
            .map_err(|e| map_err(&format!("azure blob read {}", self.host()), e))
    }

    async fn delete_blob(&self, digest: &str) -> Result<(), BlobStoreError> {
        self.store
            .delete(&Self::blob_path(digest))
            .await
            .map_err(|e| map_err(&format!("azure blob delete {}", self.host()), e))?;
        Ok(())
    }

    async fn blob_exists(&self, digest: &str) -> bool {
        self.store.head(&Self::blob_path(digest)).await.is_ok()
    }

    async fn blob_size(&self, digest: &str) -> Result<i64, BlobStoreError> {
        let meta = self
            .store
            .head(&Self::blob_path(digest))
            .await
            .map_err(|e| map_err(&format!("azure blob head {}", self.host()), e))?;
        Ok(meta.size as i64)
    }

    async fn presigned_get_url(
        &self,
        digest: &str,
        ttl_secs: u64,
    ) -> Result<String, BlobStoreError> {
        let url = self
            .store
            .signed_url(
                reqwest::Method::GET,
                &Self::blob_path(digest),
                Duration::from_secs(ttl_secs),
            )
            .await
            .map_err(|e| map_err(&format!("azure blob sign {}", self.host()), e))?;
        Ok(url.to_string())
    }

    /// Verify-only, never create.
    ///
    /// Creating a container needs rights over the storage account itself,
    /// which an external managed store deliberately does not grant the control
    /// plane — the same posture the external Postgres/Redis blocks take, where
    /// the resource is provisioned out of band and the platform is handed a
    /// scoped credential. So a missing container fails fast at startup with
    /// the command that fixes it, rather than surfacing later as an
    /// undiagnosable write failure.
    async fn ensure_bucket(&self, _skip_create: bool) -> Result<(), anyhow::Error> {
        // A list of one is the cheapest call that distinguishes "container
        // reachable and readable" from every failure mode, without needing an
        // object to exist.
        match self.store.list_with_delimiter(None).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let detail = azure_error("azure blob container check", &e);
                anyhow::bail!(
                    "Azure Blob container '{}' is not usable on account '{}': {detail}\n\
                     The control plane never creates containers — an external store is \
                     provisioned out of band. Create it and grant this key access:\n  \
                     az storage container create --account-name {} --name {}\n\
                     If the container does exist, this is almost always a rejected key \
                     (AZURE_STORAGE_ACCESS_KEY), a firewall rule on the storage account that \
                     does not admit the control plane, or a missing private-endpoint DNS \
                     record for {}.blob.core.windows.net.",
                    self.container,
                    self.account,
                    self.account,
                    self.container,
                    self.account
                )
            }
        }
    }
}
