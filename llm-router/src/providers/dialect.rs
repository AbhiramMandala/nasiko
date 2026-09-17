//! How a registered endpoint speaks the OpenAI wire protocol.
//!
//! Custom (DB-registered) providers are reached through the OpenAI spoke, because
//! their request and response *bodies* are the OpenAI ones. What differs between
//! them is only the envelope: where the URL puts the model, which header carries the
//! credential, and whether a query string is required. [`ProviderDialect`] is that
//! envelope, so one client covers every OpenAI-shaped endpoint instead of a fork per
//! vendor.
//!
//! Three call sites share it — the provider client ([`super::OpenAiProvider`]), the
//! model-catalog sync ([`crate::routing::catalog`]) and the server's registration
//! probe — so an endpoint is described once and every path agrees on how to reach it.

/// Wire dialect of an OpenAI-shaped endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderDialect {
    /// Plain OpenAI-compatible (OpenAI itself, vLLM, DeepSeek, Together, a private
    /// gateway …): `POST {base}/chat/completions`, `Authorization: Bearer <key>`,
    /// `GET {base}/models`.
    OpenAi,
    /// Azure OpenAI's classic data plane. Three differences from the above, all in
    /// the envelope: the model is a **deployment** name carried in the path rather
    /// than only in the body, the credential is an `api-key` header (`Authorization:
    /// Bearer` there means an Entra ID token, not an API key), and every call needs
    /// an `?api-version=`.
    AzureOpenAi { api_version: String },
}

/// Stored `custom_providers.kind` for [`ProviderDialect::OpenAi`].
pub const KIND_OPENAI: &str = "openai";
/// Stored `custom_providers.kind` for [`ProviderDialect::AzureOpenAi`].
pub const KIND_AZURE_OPENAI: &str = "azure-openai";

/// The `api-version` used for the deployment *listing* only. Azure's data-plane
/// deployments list is an older surface than the inference API and was dropped from
/// the newer api-versions, so pinning the listing here keeps model discovery working
/// while the admin picks a current api-version for inference. A resource that no
/// longer answers it simply falls through to the manual model-list escape hatch.
pub const AZURE_DEPLOYMENTS_LIST_API_VERSION: &str = "2023-03-15-preview";

impl ProviderDialect {
    /// Build a dialect from the stored `kind` + `api_version` columns. An unknown
    /// kind degrades to [`ProviderDialect::OpenAi`] rather than failing the call:
    /// the column is CHECK-constrained, so a surprise here means a newer writer, and
    /// the OpenAI shape is the one every endpoint is most likely to answer.
    pub fn from_kind(kind: &str, api_version: Option<&str>) -> Self {
        match kind {
            KIND_AZURE_OPENAI => Self::AzureOpenAi {
                // The DB CHECK guarantees a version for this kind; the fallback only
                // covers a row written around it.
                api_version: api_version.unwrap_or("2024-10-21").to_string(),
            },
            _ => Self::OpenAi,
        }
    }

    /// The stored `custom_providers.kind` for this dialect.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::OpenAi => KIND_OPENAI,
            Self::AzureOpenAi { .. } => KIND_AZURE_OPENAI,
        }
    }

    /// Normalize an admin-entered base URL: drop a trailing slash, and for Azure also
    /// drop a trailing `/openai` so both `https://r.openai.azure.com` and
    /// `https://r.openai.azure.com/openai` (the form the portal shows) work — this
    /// dialect appends the `/openai` segment itself.
    pub fn normalize_base(&self, base: &str) -> String {
        let base = base.trim().trim_end_matches('/');
        match self {
            Self::OpenAi => base.to_string(),
            Self::AzureOpenAi { .. } => base
                .strip_suffix("/openai")
                .unwrap_or(base)
                .trim_end_matches('/')
                .to_string(),
        }
    }

    /// Chat-completions URL for `model` (a deployment name under Azure).
    pub fn chat_url(&self, base: &str, model: &str) -> String {
        self.deployment_url(base, model, "chat/completions")
    }

    /// Embeddings URL for `model` (a deployment name under Azure).
    pub fn embeddings_url(&self, base: &str, model: &str) -> String {
        self.deployment_url(base, model, "embeddings")
    }

    /// Model-listing URL. Azure has no `/models` listing of *deployments*, which is
    /// what our catalog needs (`/openai/models` lists what the region offers, not
    /// what this resource has deployed), so it lists deployments instead. Both answer
    /// `{"data": [{"id": …}]}`, which is the shape the catalog already parses.
    pub fn models_url(&self, base: &str) -> String {
        match self {
            Self::OpenAi => format!("{}/models", self.normalize_base(base)),
            Self::AzureOpenAi { .. } => format!(
                "{}/openai/deployments?api-version={AZURE_DEPLOYMENTS_LIST_API_VERSION}",
                self.normalize_base(base)
            ),
        }
    }

    /// Attach this dialect's credential header to a request.
    pub fn authorize(
        &self,
        req: reqwest::RequestBuilder,
        api_key: &str,
    ) -> reqwest::RequestBuilder {
        match self {
            Self::OpenAi => req.bearer_auth(api_key),
            Self::AzureOpenAi { .. } => req.header("api-key", api_key),
        }
    }

    /// A parameter this dialect's error body reports as unaccepted, beyond the OpenAI
    /// `{"error":{"param":…,"code":"unsupported_parameter"}}` shape the caller already
    /// handles. Azure rejects a param the api-version doesn't know with a plain
    /// message and no `param` field, so the field name is read out of the message.
    /// Feeds the same drop-and-retry path as the OpenAI shape.
    pub fn extra_droppable_param(&self, body: &str) -> Option<String> {
        match self {
            Self::OpenAi => None,
            Self::AzureOpenAi { .. } => {
                let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
                let message = parsed.get("error")?.get("message")?.as_str()?;
                azure_unrecognized_argument(message)
            }
        }
    }

    /// `{base}/openai/deployments/{model}/{suffix}?api-version=…` for Azure, plain
    /// `{base}/{suffix}` otherwise. Azure deployment names are limited to letters,
    /// digits, `-` and `_`, so they need no percent-encoding.
    fn deployment_url(&self, base: &str, model: &str, suffix: &str) -> String {
        let base = self.normalize_base(base);
        match self {
            Self::OpenAi => format!("{base}/{suffix}"),
            Self::AzureOpenAi { api_version } => {
                format!("{base}/openai/deployments/{model}/{suffix}?api-version={api_version}")
            }
        }
    }
}

/// Pull the first field name out of Azure's "Unrecognized request argument supplied:
/// max_completion_tokens" (and its plural, comma-separated form). One name per call is
/// enough — the executor drops it and retries, so a second unknown param is reported
/// again on the next attempt.
fn azure_unrecognized_argument(message: &str) -> Option<String> {
    // Matches both "…argument supplied:" and the plural "…arguments supplied:".
    if !message.contains("nrecognized request argument") {
        return None;
    }
    let tail = message.split_once("supplied:")?.1;
    let first = tail.split(',').next()?.trim();
    let name: String = first
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    (!name.is_empty()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn azure() -> ProviderDialect {
        ProviderDialect::AzureOpenAi {
            api_version: "2024-10-21".into(),
        }
    }

    #[test]
    fn openai_urls_are_the_plain_shape() {
        let d = ProviderDialect::OpenAi;
        assert_eq!(
            d.chat_url("https://gw.internal/v1", "llama-3.1-8b"),
            "https://gw.internal/v1/chat/completions"
        );
        assert_eq!(
            d.embeddings_url("https://gw.internal/v1/", "e5"),
            "https://gw.internal/v1/embeddings"
        );
        assert_eq!(
            d.models_url("https://gw.internal/v1"),
            "https://gw.internal/v1/models"
        );
    }

    #[test]
    fn azure_puts_the_deployment_in_the_path_with_an_api_version() {
        let d = azure();
        assert_eq!(
            d.chat_url("https://acme.openai.azure.com", "prod-gpt4o"),
            "https://acme.openai.azure.com/openai/deployments/prod-gpt4o/chat/completions?api-version=2024-10-21"
        );
        assert_eq!(
            d.embeddings_url("https://acme.openai.azure.com", "embed-3"),
            "https://acme.openai.azure.com/openai/deployments/embed-3/embeddings?api-version=2024-10-21"
        );
        assert_eq!(
            d.models_url("https://acme.openai.azure.com"),
            format!(
                "https://acme.openai.azure.com/openai/deployments?api-version={AZURE_DEPLOYMENTS_LIST_API_VERSION}"
            )
        );
    }

    #[test]
    fn azure_base_accepts_both_portal_forms() {
        let d = azure();
        for base in [
            "https://acme.openai.azure.com",
            "https://acme.openai.azure.com/",
            "https://acme.openai.azure.com/openai",
            "https://acme.openai.azure.com/openai/",
        ] {
            assert_eq!(
                d.normalize_base(base),
                "https://acme.openai.azure.com",
                "base {base}"
            );
        }
        // Only Azure strips `/openai` — an OpenAI-compatible endpoint may legitimately
        // be mounted at a path ending in it.
        assert_eq!(
            ProviderDialect::OpenAi.normalize_base("https://gw.internal/openai/"),
            "https://gw.internal/openai"
        );
    }

    #[test]
    fn from_kind_round_trips_and_degrades_to_openai() {
        assert_eq!(
            ProviderDialect::from_kind(KIND_AZURE_OPENAI, Some("2025-01-01-preview")),
            ProviderDialect::AzureOpenAi {
                api_version: "2025-01-01-preview".into()
            }
        );
        assert_eq!(
            ProviderDialect::from_kind(KIND_OPENAI, None),
            ProviderDialect::OpenAi
        );
        assert_eq!(
            ProviderDialect::from_kind("something-new", None),
            ProviderDialect::OpenAi
        );
        assert_eq!(azure().kind(), KIND_AZURE_OPENAI);
        assert_eq!(ProviderDialect::OpenAi.kind(), KIND_OPENAI);
    }

    #[test]
    fn azure_unknown_param_is_read_out_of_the_message() {
        let d = azure();
        let body = r#"{"error":{"code":"BadRequest","message":"Unrecognized request argument supplied: max_completion_tokens"}}"#;
        assert_eq!(
            d.extra_droppable_param(body).as_deref(),
            Some("max_completion_tokens")
        );
        // Plural form: one name per round is enough.
        let plural = r#"{"error":{"message":"Unrecognized request arguments supplied: stream_options, max_completion_tokens"}}"#;
        assert_eq!(
            d.extra_droppable_param(plural).as_deref(),
            Some("stream_options")
        );
        // Anything else is not a param rejection.
        assert_eq!(
            d.extra_droppable_param(r#"{"error":{"message":"quota exceeded"}}"#),
            None
        );
        assert_eq!(d.extra_droppable_param("not json"), None);
        // The plain dialect never uses this path.
        assert_eq!(ProviderDialect::OpenAi.extra_droppable_param(body), None);
    }
}
