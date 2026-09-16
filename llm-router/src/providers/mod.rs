//! Provider clients — the spokes of the hub.
//!
//! A [`ProviderClient`] takes the canonical IR + a [`ResolvedConfig`] and calls one
//! provider, returning IR. Per-provider impls (OpenAI / Anthropic / Gemini) land in
//! steps 4–6 and own the OpenAI⇄provider translation; the ordered fallback executor
//! lands in step 8. Errors are [`ProviderError`] (carrying retryability) and convert
//! to `GatewayError::Upstream` once fallbacks are exhausted.

use async_trait::async_trait;
use futures::stream::BoxStream;

use serde_json::Map;

use crate::config::GatewayConfig;
use crate::error::GatewayError;
use crate::ir::{
    ChatChunk, ChatRequest, ChatResponse, ChunkChoice, Delta, EmbeddingsRequest,
    EmbeddingsResponse, Usage,
};
use crate::resolver::ResolvedConfig;

/// Construct the provider client for a resolved config. Used by the handler and the
/// fallback executor. Built-in providers use their base URL from [`GatewayConfig`];
/// a custom (DB-registered) provider is OpenAI-compatible and uses the base URL
/// carried on the resolved config. A non-built-in provider with no `base_url` is a
/// server-side gap (500) — the resolver populates it for every registered custom
/// provider, so a missing one means the row was dropped mid-flight.
pub fn provider_for(
    resolved: &ResolvedConfig,
    http: &reqwest::Client,
    cfg: &GatewayConfig,
) -> Result<Box<dyn ProviderClient>, GatewayError> {
    match resolved.provider.as_str() {
        "openai" => Ok(Box::new(OpenAiProvider::new(
            http.clone(),
            cfg.openai_api_base.clone(),
        ))),
        "anthropic" => Ok(Box::new(AnthropicProvider::new(
            http.clone(),
            cfg.anthropic_api_base.clone(),
        ))),
        "gemini" => Ok(Box::new(GeminiProvider::new(
            http.clone(),
            cfg.gemini_api_base.clone(),
        ))),
        "openrouter" => Ok(Box::new(OpenRouterProvider::new(
            http.clone(),
            cfg.openrouter_api_base.clone(),
            cfg.openrouter_http_referer.clone(),
            cfg.openrouter_x_title.clone(),
        ))),
        other => match &resolved.base_url {
            // Custom providers speak the OpenAI wire shape at their own base URL.
            Some(base_url) => Ok(Box::new(OpenAiProvider::new(
                http.clone(),
                base_url.clone(),
            ))),
            None => Err(GatewayError::Internal(format!(
                "provider '{other}' has no base URL (unregistered custom provider?)"
            ))),
        },
    }
}

pub mod anthropic;
pub mod fallback;
pub mod gemini;
pub mod openai;
pub mod openrouter;
pub(crate) mod sse;

pub use anthropic::AnthropicProvider;
pub use gemini::GeminiProvider;
pub use openai::OpenAiProvider;
pub use openrouter::OpenRouterProvider;

/// Current unix time (seconds) for synthesized response `created` fields. Providers
/// that don't return a creation timestamp (Anthropic, Gemini) stamp one here.
pub(crate) fn now_unix() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Streaming chunk builders (shared by the translating spokes) ───────────────

/// A `chat.completion.chunk` carrying one incremental `delta`.
pub(crate) fn delta_chunk(id: &str, model: &str, delta: Delta) -> ChatChunk {
    ChatChunk {
        id: format!("chatcmpl-{id}"),
        object: "chat.completion.chunk".to_string(),
        created: Some(now_unix()),
        model: model.to_string(),
        choices: vec![ChunkChoice {
            index: 0,
            delta,
            finish_reason: None,
        }],
        usage: None,
        extra: Map::new(),
    }
}

/// A terminal chunk carrying only `finish_reason`.
pub(crate) fn finish_chunk(id: &str, model: &str, finish_reason: String) -> ChatChunk {
    ChatChunk {
        id: format!("chatcmpl-{id}"),
        object: "chat.completion.chunk".to_string(),
        created: Some(now_unix()),
        model: model.to_string(),
        choices: vec![ChunkChoice {
            index: 0,
            delta: Delta::default(),
            finish_reason: Some(finish_reason),
        }],
        usage: None,
        extra: Map::new(),
    }
}

/// OpenAI-style trailing usage chunk: empty `choices`, populated `usage`.
pub(crate) fn usage_chunk(id: &str, model: &str, usage: Usage) -> ChatChunk {
    ChatChunk {
        id: format!("chatcmpl-{id}"),
        object: "chat.completion.chunk".to_string(),
        created: Some(now_unix()),
        model: model.to_string(),
        choices: vec![],
        usage: Some(usage),
        extra: Map::new(),
    }
}

/// A failed provider call. `retryable` drives the fallback executor (step 8): retry on
/// transport/5xx faults, never on 4xx request-shape errors.
#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider returned {status}: {message}")]
    Status {
        status: u16,
        message: String,
        retryable: bool,
    },
    #[error("transport error: {0}")]
    Transport(String),
    #[error("response parse error: {0}")]
    Parse(String),
}

impl ProviderError {
    /// Whether this failure is worth retrying against a fallback model.
    pub fn retryable(&self) -> bool {
        match self {
            ProviderError::Status { retryable, .. } => *retryable,
            ProviderError::Transport(_) => true,
            ProviderError::Parse(_) => false,
        }
    }
}

impl From<ProviderError> for GatewayError {
    fn from(e: ProviderError) -> Self {
        GatewayError::Upstream(e.to_string())
    }
}

/// A single-provider client. Implementations translate the IR to the provider's wire
/// format, call it, and translate the result back to IR.
#[async_trait]
pub trait ProviderClient: Send + Sync {
    async fn chat(
        &self,
        req: &ChatRequest,
        cfg: &ResolvedConfig,
    ) -> Result<ChatResponse, ProviderError>;

    async fn chat_stream(
        &self,
        req: &ChatRequest,
        cfg: &ResolvedConfig,
    ) -> Result<BoxStream<'static, Result<ChatChunk, ProviderError>>, ProviderError>;

    async fn embeddings(
        &self,
        req: &EmbeddingsRequest,
        cfg: &ResolvedConfig,
    ) -> Result<EmbeddingsResponse, ProviderError>;

    /// If `err` is a "this model doesn't accept parameter X" rejection, return the IR
    /// parameter to drop so the executor can retry the *same* model without it. Returns
    /// `None` for any other error (transport, auth, quota, genuine bad request).
    ///
    /// This is the general seam for model/parameter capability mismatches: rather than
    /// maintaining a per-model table of unsupported params, we let the provider report
    /// the offending field from its own error body. Default: never droppable — providers
    /// that can recognize their param-rejection shape override this.
    fn droppable_param(&self, _err: &ProviderError) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryability_rules() {
        assert!(ProviderError::Transport("timeout".into()).retryable());
        assert!(!ProviderError::Parse("bad json".into()).retryable());
        assert!(
            ProviderError::Status {
                status: 503,
                message: "x".into(),
                retryable: true
            }
            .retryable()
        );
        assert!(
            !ProviderError::Status {
                status: 400,
                message: "x".into(),
                retryable: false
            }
            .retryable()
        );
    }

    #[test]
    fn converts_to_upstream_gateway_error() {
        let g: GatewayError = ProviderError::Transport("boom".into()).into();
        assert!(matches!(g, GatewayError::Upstream(_)));
        assert_eq!(g.status(), axum::http::StatusCode::BAD_GATEWAY);
    }

    fn resolved(provider: &str, base_url: Option<&str>) -> ResolvedConfig {
        ResolvedConfig {
            provider: provider.into(),
            model: "m".into(),
            litellm_model: format!("{provider}/m"),
            api_key: "k".into(),
            fallback_models: Vec::new(),
            temperature: None,
            max_tokens: None,
            has_llm_config: false,
            pinned_model: None,
            tier1_model: None,
            tier2_model: None,
            tier3_model: None,
            platform_paid: true,
            base_url: base_url.map(str::to_string),
            is_coding_agent: false,
        }
    }

    #[test]
    fn provider_for_custom_builds_against_overridden_base_url() {
        let http = reqwest::Client::new();
        let cfg = GatewayConfig::default();
        // A custom (non-built-in) provider with a base URL builds an OpenAI-compatible
        // client against that URL.
        assert!(provider_for(&resolved("my-gateway", Some("https://gw/v1")), &http, &cfg).is_ok());
        // ...but with no base URL it is a server-side gap (the resolver should have
        // populated it), surfaced as an Internal error rather than a mis-target.
        assert!(matches!(
            provider_for(&resolved("my-gateway", None), &http, &cfg),
            Err(GatewayError::Internal(_))
        ));
    }
}
