//! Native OpenAI Responses forwarding for Codex and other Responses clients.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use serde_json::{Value, json};

use super::chat::{RoutedRequest, authenticate_request, resolve_routed_request};
use crate::LlmRouterCtx;
use crate::error::GatewayError;
use crate::ir::Usage;
use crate::providers::fallback;
use crate::resolver::{PgRegistry, RegistryStore, RequestHint};
use crate::usage::{self, UsageRecord};

const MAX_INSPECTION_BYTES: usize = 1024 * 1024;
const REQUEST_HEADERS: &[&str] = &[
    "x-codex-turn-state",
    "x-codex-turn-metadata",
    "x-codex-beta-features",
    "x-codex-installation-id",
    "x-codex-window-id",
    "x-codex-parent-thread-id",
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-openai-subagent",
    "x-codex-routing-hint",
    "x-oai-attestation",
    "x-openai-internal-codex-responses-lite",
    "x-responsesapi-include-timing-metrics",
    "openai-beta",
    "traceparent",
    "tracestate",
];
const RESPONSE_HEADERS: &[&str] = &[
    "retry-after",
    "x-request-id",
    "x-oai-request-id",
    "cf-ray",
    "x-codex-turn-state",
    "openai-model",
    "openai-processing-ms",
    "x-reasoning-included",
    "x-models-etag",
];

pub async fn responses(
    State(ctx): State<LlmRouterCtx>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let store = PgRegistry::new(ctx.db.clone());
    match responses_core(&ctx, &store, &headers, body).await {
        Ok(response) => response,
        Err(error) => gateway_error_response(error),
    }
}

fn gateway_error_response(error: GatewayError) -> Response {
    let status = error.status();
    let code = error_code(&error);
    let message = if matches!(error, GatewayError::Internal(_)) {
        tracing::error!(error = %error, "Responses handler internal error");
        "Internal server error".to_string()
    } else {
        error.to_string()
    };
    responses_error(status, message, code)
}

async fn responses_core(
    ctx: &LlmRouterCtx,
    store: &dyn RegistryStore,
    headers: &HeaderMap,
    mut body: Value,
) -> Result<Response, GatewayError> {
    let (agent_id, owner_id) = authenticate_request(headers, &ctx.cfg)?;
    let (requested_model, stream, query) = {
        let object = body.as_object().ok_or_else(|| {
            GatewayError::BadRequest("Responses request must be a JSON object".into())
        })?;
        (
            object
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            object
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            latest_user_text(object.get("input")),
        )
    };
    let routed = resolve_routed_request(
        ctx,
        store,
        headers,
        agent_id,
        owner_id,
        RequestHint {
            provider: Some("openai"),
            model: requested_model.as_deref(),
        },
        query,
    )
    .await?;
    if routed.resolved.provider != "openai" {
        return Err(GatewayError::BadRequest(format!(
            "Responses routing currently supports only provider 'openai'; resolved provider was '{}'",
            routed.resolved.provider
        )));
    }

    validate_fallbacks(&routed)?;
    let object = body.as_object_mut().expect("Responses body was validated");
    object.insert("model".into(), Value::String(routed.resolved.model.clone()));
    if let Some(temperature) = routed.resolved.temperature {
        object.insert("temperature".into(), json!(temperature));
    }
    if let Some(max_tokens) = routed.resolved.max_tokens {
        object.insert("max_output_tokens".into(), json!(max_tokens));
    }

    let attempts = fallback::build_attempts(&routed.resolved, &ctx.cfg);
    let mut last_response = None;
    let mut last_error = None;
    for attempt in attempts {
        body.as_object_mut()
            .expect("Responses body was validated")
            .insert("model".into(), Value::String(attempt.model.clone()));
        let started = Instant::now();
        let mut guard = AttemptGuard::new(ctx, &routed, &attempt, started, stream);
        let mut request = ctx
            .http
            .post(format!(
                "{}/responses",
                ctx.cfg.openai_api_base.trim_end_matches('/')
            ))
            .bearer_auth(&attempt.api_key)
            .json(&body);
        request = forward_request_headers(request, headers);
        let upstream = match request.send().await {
            Ok(upstream) => upstream,
            Err(error) => {
                guard.fail("send", &error);
                let retryable = is_retryable_transport_error(&error);
                let error = GatewayError::Upstream(error.to_string());
                if retryable {
                    last_error = Some(error);
                    continue;
                }
                return Err(error);
            }
        };
        let status = upstream.status();
        if !status.is_success() {
            guard.fail_status(status.as_u16());
            let response = passthrough_error(upstream).await?;
            if status.as_u16() == 429 || status.is_server_error() {
                last_response = Some(response);
                continue;
            }
            return Ok(response);
        }
        let status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK);
        return if stream {
            guard.disarm();
            stream_response(ctx, upstream, routed, attempt.model, started, status)
        } else {
            nonstream_response(ctx, upstream, routed, attempt.model, started, status, guard).await
        };
    }
    last_response.map(Ok).unwrap_or_else(|| {
        Err(last_error.unwrap_or_else(|| GatewayError::Upstream("no Responses attempts".into())))
    })
}

fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout()
}

fn validate_fallbacks(routed: &RoutedRequest) -> Result<(), GatewayError> {
    for fallback in &routed.resolved.fallback_models {
        if let Some((provider, _)) = fallback.split_once('/')
            && provider != "openai"
        {
            return Err(GatewayError::BadRequest(format!(
                "Responses fallback '{fallback}' is unsupported: cross-provider fallbacks are not allowed"
            )));
        }
    }
    Ok(())
}

fn forward_request_headers(
    mut request: reqwest::RequestBuilder,
    headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    for name in REQUEST_HEADERS {
        if let Some(value) = headers.get(*name) {
            request = request.header(*name, value);
        }
    }
    request
}

async fn nonstream_response(
    ctx: &LlmRouterCtx,
    upstream: reqwest::Response,
    routed: RoutedRequest,
    model: String,
    started: Instant,
    status: StatusCode,
    mut guard: AttemptGuard,
) -> Result<Response, GatewayError> {
    let headers = upstream.headers().clone();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            guard.fail("body_read", &error);
            return Err(GatewayError::Upstream(error.to_string()));
        }
    };
    let parsed = serde_json::from_slice::<Value>(&bytes).ok();
    let details = parsed
        .as_ref()
        .and_then(|value| response_usage(value.get("usage")));
    guard.disarm();
    log_response_usage(ctx, routed, model, started, false, details);
    build_success_response(status, &headers, Body::from(bytes))
}

fn stream_response(
    ctx: &LlmRouterCtx,
    upstream: reqwest::Response,
    routed: RoutedRequest,
    model: String,
    started: Instant,
    status: StatusCode,
) -> Result<Response, GatewayError> {
    let headers = upstream.headers().clone();
    let state = Arc::new(Mutex::new(None));
    let guard = ResponsesUsageGuard {
        ctx: ctx.clone(),
        routed: Some((routed, model)),
        started,
        state: Arc::clone(&state),
    };
    let bytes = upstream.bytes_stream();
    let stream = async_stream::stream! {
        let _guard = guard;
        let mut inspector = SseInspector::new(Arc::clone(&state));
        futures::pin_mut!(bytes);
        while let Some(next) = bytes.next().await {
            match next {
                Ok(chunk) => {
                    inspector.push(&chunk);
                    yield Ok::<Bytes, std::io::Error>(chunk);
                }
                Err(error) => {
                    tracing::warn!(error = %error, "Responses upstream stream failed midstream");
                    yield Err(std::io::Error::other(error));
                    return;
                }
            }
        }
        inspector.finish();
    };
    build_success_response(status, &headers, Body::from_stream(stream))
}

fn build_success_response(
    status: StatusCode,
    upstream_headers: &reqwest::header::HeaderMap,
    body: Body,
) -> Result<Response, GatewayError> {
    let mut builder = Response::builder().status(status);
    for name in [CONTENT_TYPE, CACHE_CONTROL] {
        if let Some(value) = upstream_headers.get(&name) {
            builder = builder.header(name, value);
        }
    }
    builder = copy_response_headers(builder, upstream_headers);
    builder.body(body).map_err(|error| {
        GatewayError::Internal(format!("failed to build Responses response: {error}"))
    })
}

async fn passthrough_error(upstream: reqwest::Response) -> Result<Response, GatewayError> {
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = upstream.headers().clone();
    let bytes = upstream.bytes().await.map_err(|error| {
        GatewayError::Upstream(format!("failed to read upstream error: {error}"))
    })?;
    let mut response = Response::builder().status(status);
    if let Some(content_type) = headers.get(CONTENT_TYPE) {
        response = response.header(CONTENT_TYPE, content_type);
    }
    response = copy_response_headers(response, &headers);
    response.body(Body::from(bytes)).map_err(|error| {
        GatewayError::Internal(format!("failed to proxy upstream error response: {error}"))
    })
}

fn copy_response_headers(
    mut builder: axum::http::response::Builder,
    headers: &reqwest::header::HeaderMap,
) -> axum::http::response::Builder {
    for name in RESPONSE_HEADERS {
        if let Some(value) = headers.get(*name) {
            builder = builder.header(*name, value);
        }
    }
    for (name, value) in headers {
        if name.as_str().starts_with("x-ratelimit-")
            || name.as_str().starts_with("x-codex-primary-")
            || name.as_str().starts_with("x-codex-secondary-")
        {
            builder = builder.header(name, value);
        }
    }
    builder
}

struct SseInspector {
    event: Vec<u8>,
    oversized: bool,
    separator_tail: Vec<u8>,
    state: Arc<Mutex<Option<ResponseUsage>>>,
}

impl SseInspector {
    fn new(state: Arc<Mutex<Option<ResponseUsage>>>) -> Self {
        Self {
            event: Vec::new(),
            oversized: false,
            separator_tail: Vec::new(),
            state,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        for &byte in chunk {
            if self.oversized {
                self.separator_tail.push(byte);
                if separator_len_at_end(&self.separator_tail).is_some() {
                    self.oversized = false;
                    self.separator_tail.clear();
                } else if self.separator_tail.len() > 3 {
                    self.separator_tail.remove(0);
                }
                continue;
            }

            self.event.push(byte);
            if let Some(separator_len) = separator_len_at_end(&self.event) {
                self.event.truncate(self.event.len() - separator_len);
                inspect_event(&self.event, &self.state);
                self.event.clear();
            } else if self.event.len() > MAX_INSPECTION_BYTES {
                tracing::warn!(
                    limit = MAX_INSPECTION_BYTES,
                    "Responses SSE event exceeded inspection limit; skipping event"
                );
                let keep_from = self.event.len().saturating_sub(3);
                self.separator_tail
                    .extend_from_slice(&self.event[keep_from..]);
                self.event.clear();
                self.oversized = true;
            }
        }
    }

    fn finish(&mut self) {
        if !self.oversized && !self.event.is_empty() {
            inspect_event(&self.event, &self.state);
        }
    }
}

fn separator_len_at_end(buffer: &[u8]) -> Option<usize> {
    if buffer.ends_with(b"\r\n\r\n") {
        Some(4)
    } else if buffer.ends_with(b"\n\n") {
        Some(2)
    } else {
        None
    }
}

fn inspect_event(event: &[u8], state: &Arc<Mutex<Option<ResponseUsage>>>) {
    let text = String::from_utf8_lossy(event);
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(&data) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("response.completed") {
        return;
    }
    let details = value
        .get("response")
        .and_then(|response| response_usage(response.get("usage")));
    if let Some(details) = details {
        *state.lock().unwrap_or_else(|error| error.into_inner()) = Some(details);
    }
}

#[derive(Clone)]
struct ResponseUsage {
    usage: Usage,
    cached_tokens: Option<i64>,
    reasoning_tokens: Option<i64>,
}

fn response_usage(value: Option<&Value>) -> Option<ResponseUsage> {
    let value = value?;
    Some(ResponseUsage {
        usage: Usage {
            prompt_tokens: value.get("input_tokens").and_then(Value::as_i64),
            completion_tokens: value.get("output_tokens").and_then(Value::as_i64),
            total_tokens: value.get("total_tokens").and_then(Value::as_i64),
        },
        cached_tokens: value
            .get("input_tokens_details")
            .and_then(|details| details.get("cached_tokens"))
            .and_then(Value::as_i64),
        reasoning_tokens: value
            .get("output_tokens_details")
            .and_then(|details| details.get("reasoning_tokens"))
            .and_then(Value::as_i64),
    })
}

struct ResponsesUsageGuard {
    ctx: LlmRouterCtx,
    routed: Option<(RoutedRequest, String)>,
    started: Instant,
    state: Arc<Mutex<Option<ResponseUsage>>>,
}

impl Drop for ResponsesUsageGuard {
    fn drop(&mut self) {
        let Some((routed, model)) = self.routed.take() else {
            return;
        };
        let details = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        log_response_usage(&self.ctx, routed, model, self.started, true, details);
    }
}

struct AttemptGuard {
    ctx: LlmRouterCtx,
    record: Option<UsageRecord>,
    started: Instant,
}

impl AttemptGuard {
    fn new(
        ctx: &LlmRouterCtx,
        routed: &RoutedRequest,
        attempt: &crate::resolver::ResolvedConfig,
        started: Instant,
        streaming: bool,
    ) -> Self {
        Self {
            ctx: ctx.clone(),
            started,
            record: Some(UsageRecord {
                owner_id: routed.owner_id.clone(),
                agent_id: routed.agent_id.clone(),
                operation_type: "direct_llm",
                provider: "openai".into(),
                model: attempt.model.clone(),
                usage: None,
                cached_tokens: None,
                reasoning_tokens: None,
                latency_ms: started.elapsed().as_millis() as i64,
                streaming,
                finish_reason: None,
                flow_id: routed.flow_id.clone(),
                platform_paid: attempt.platform_paid,
            }),
        }
    }

    fn fail(&mut self, stage: &'static str, error: &dyn std::fmt::Display) {
        if let Some(record) = &mut self.record {
            record.latency_ms = record.latency_ms.max(1);
            record.finish_reason = Some(format!("failed:{stage}"));
            tracing::warn!(stage, model = %record.model, error = %error, "Responses upstream attempt failed");
        }
    }

    fn fail_status(&mut self, status: u16) {
        if let Some(record) = &mut self.record {
            record.latency_ms = record.latency_ms.max(1);
            record.finish_reason = Some(format!("http:{status}"));
            tracing::warn!(status, model = %record.model, "Responses upstream attempt returned non-success status");
        }
    }

    fn disarm(&mut self) {
        self.record = None;
    }
}

impl Drop for AttemptGuard {
    fn drop(&mut self) {
        if let Some(mut record) = self.record.take() {
            record.latency_ms = record
                .latency_ms
                .max(self.started.elapsed().as_millis() as i64);
            usage::spawn_log(self.ctx.db.clone(), record);
        }
    }
}

fn log_response_usage(
    ctx: &LlmRouterCtx,
    routed: RoutedRequest,
    model: String,
    started: Instant,
    streaming: bool,
    details: Option<ResponseUsage>,
) {
    let cached_tokens = details.as_ref().and_then(|details| details.cached_tokens);
    let reasoning_tokens = details
        .as_ref()
        .and_then(|details| details.reasoning_tokens);
    usage::spawn_log(
        ctx.db.clone(),
        UsageRecord {
            owner_id: routed.owner_id,
            agent_id: routed.agent_id,
            operation_type: "direct_llm",
            provider: "openai".into(),
            model,
            usage: details.map(|details| details.usage),
            cached_tokens,
            reasoning_tokens,
            latency_ms: started.elapsed().as_millis() as i64,
            streaming,
            finish_reason: None,
            flow_id: routed.flow_id,
            platform_paid: routed.resolved.platform_paid,
        },
    );
}

fn latest_user_text(input: Option<&Value>) -> Option<String> {
    input
        .and_then(Value::as_array)?
        .iter()
        .rev()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|item| item.get("content"))
        .and_then(content_text)
}

fn content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let text = content
        .as_array()?
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn error_code(error: &GatewayError) -> &'static str {
    match error {
        GatewayError::MissingAuthHeader
        | GatewayError::JwtSecretNotConfigured
        | GatewayError::TokenExpired
        | GatewayError::InvalidToken(_)
        | GatewayError::MissingAgentId => "invalid_api_key",
        GatewayError::BadRequest(_) => "invalid_request_error",
        GatewayError::NoRegistryEntry(_)
        | GatewayError::SecretNotFound(_, _)
        | GatewayError::NoApiKey => "routing_configuration_error",
        GatewayError::Upstream(_) => "upstream_error",
        GatewayError::Internal(_) => "internal_error",
    }
}

fn responses_error(status: StatusCode, message: String, code: &'static str) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "message": message,
                "type": if status == StatusCode::UNAUTHORIZED {
                    "authentication_error"
                } else if status.is_server_error() {
                    "server_error"
                } else {
                    "invalid_request_error"
                },
                "param": Value::Null,
                "code": code,
            }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use jsonwebtoken::Algorithm;
    use sqlx::PgPool;
    use std::time::Duration;
    use uuid::Uuid;

    use crate::config::GatewayConfig;
    use crate::resolver::{AgentConfigResult, ConfigCache, LLMConfig};

    const AGENT: &str = "11111111-1111-1111-1111-111111111111";
    const OWNER: &str = "22222222-2222-2222-2222-222222222222";
    const SECRET: &str = "responses-secret";

    struct Store {
        provider: &'static str,
        fallback_models: Vec<String>,
    }

    impl Store {
        fn new(provider: &'static str) -> Self {
            Self {
                provider,
                fallback_models: Vec::new(),
            }
        }
    }

    #[async_trait]
    impl RegistryStore for Store {
        async fn fetch_llm_config(
            &self,
            _: Uuid,
        ) -> Result<Option<AgentConfigResult>, sqlx::Error> {
            Ok(Some(AgentConfigResult {
                config: Some(LLMConfig {
                    provider: self.provider.into(),
                    model: Some("resolved-model".into()),
                    fallback_models: self.fallback_models.clone(),
                    temperature: Some(0.2),
                    max_tokens: Some(4096),
                    api_key_secret_name: None,
                    pinned: false,
                    pinned_model: None,
                    tier1_model: None,
                    tier2_model: None,
                    tier3_model: None,
                }),
                agent_pinned_model: None,
            }))
        }

        async fn fetch_user_secret(&self, _: Uuid, _: &str) -> Result<Option<String>, sqlx::Error> {
            Ok(None)
        }
    }

    fn ctx(base: String) -> LlmRouterCtx {
        LlmRouterCtx {
            db: PgPool::connect_lazy("postgres://u:p@127.0.0.1:5999/none").unwrap(),
            http: reqwest::Client::new(),
            cfg: Arc::new(GatewayConfig {
                agent_jwt_secret: SECRET.into(),
                openai_api_base: base,
                platform_openai_api_key: "upstream-key".into(),
                platform_anthropic_api_key: "anthropic-key".into(),
                ..Default::default()
            }),
            cache: Arc::new(ConfigCache::new(Duration::from_secs(30))),
            router_cache: Arc::new(crate::routing::NoopCache),
            tier_registry: Arc::new(crate::routing::StaticTierRegistry),
            cell_store: Arc::new(crate::routing::InMemoryCellStore::new()),
        }
    }

    fn headers() -> HeaderMap {
        let token =
            crate::auth::mint_agent_token(AGENT, OWNER, SECRET, 3600, Algorithm::HS256).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        headers
    }

    async fn body(response: Response) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    #[tokio::test]
    async fn auth_is_required_before_upstream() {
        let response = responses(
            State(ctx("http://unused".into())),
            HeaderMap::new(),
            Json(json!({})),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let value: Value = serde_json::from_slice(&body(response).await).unwrap();
        assert_eq!(value["error"]["code"], "invalid_api_key");
    }

    #[tokio::test]
    async fn internal_error_details_are_not_exposed() {
        let response =
            gateway_error_response(GatewayError::Internal("database password leaked".into()));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let value: Value = serde_json::from_slice(&body(response).await).unwrap();
        assert_eq!(value["error"]["message"], "Internal server error");
        assert_eq!(value["error"]["type"], "server_error");
        assert_eq!(value["error"]["code"], "internal_error");
    }

    #[tokio::test]
    async fn nonstream_overrides_model_key_and_params_and_preserves_unknown_fields() {
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("POST", "/responses")
            .match_header("authorization", "Bearer upstream-key")
            .match_body(mockito::Matcher::PartialJson(json!({
                "model": "resolved-model",
                "temperature": 0.2,
                "max_output_tokens": 4096,
                "instructions": "keep",
                "reasoning": {"effort":"high"},
                "input": [{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
                "tools": [{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"start: /.+/"}}],
                "include": ["reasoning.encrypted_content"],
                "text": {"verbosity":"low"},
                "store": false,
                "custom": {"kept":true}
            })))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_header("x-request-id", "request-1")
            .with_header("x-oai-request-id", "oai-request-1")
            .with_header("cf-ray", "ray-1")
            .with_header("x-codex-primary-model", "primary-model")
            .with_header("x-codex-secondary-region", "secondary-region")
            .with_header("openai-model", "resolved-model")
            .with_header("x-ratelimit-remaining-requests", "9")
            .with_body(
                json!({
                    "id":"resp_1", "status":"completed", "output":[],
                    "usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5,
                        "input_tokens_details":{"cached_tokens":1},
                        "output_tokens_details":{"reasoning_tokens":1}}
                })
                .to_string(),
            )
            .create_async()
            .await;
        let response = responses_core(
            &ctx(server.url()), &Store::new("openai"), &headers(),
            json!({
                "model":"requested", "instructions":"keep",
                "input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}],
                "tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"start: /.+/"}}],
                "reasoning":{"effort":"high"}, "include":["reasoning.encrypted_content"],
                "text":{"verbosity":"low"}, "store":false, "custom":{"kept":true}
            }),
        ).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-request-id"], "request-1");
        assert_eq!(response.headers()["x-oai-request-id"], "oai-request-1");
        assert_eq!(response.headers()["cf-ray"], "ray-1");
        assert_eq!(response.headers()["x-codex-primary-model"], "primary-model");
        assert_eq!(
            response.headers()["x-codex-secondary-region"],
            "secondary-region"
        );
        assert_eq!(response.headers()["openai-model"], "resolved-model");
        assert_eq!(response.headers()["x-ratelimit-remaining-requests"], "9");
        let value: Value = serde_json::from_slice(&body(response).await).unwrap();
        assert_eq!(value["id"], "resp_1");
        request.assert_async().await;
    }

    #[tokio::test]
    async fn streaming_bytes_and_completed_usage_event_pass_through() {
        let mut server = mockito::Server::new_async().await;
        let sse = concat!(
            "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3,\"input_tokens_details\":{\"cached_tokens\":1},\"output_tokens_details\":{\"reasoning_tokens\":1}}}}\n\n"
        );
        let request = server
            .mock("POST", "/responses")
            .match_body(mockito::Matcher::PartialJson(
                json!({"stream":true,"model":"resolved-model"}),
            ))
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_header("x-codex-turn-state", "turn-state-1")
            .with_body(sse)
            .create_async()
            .await;
        let response = responses_core(
            &ctx(server.url()),
            &Store::new("openai"),
            &headers(),
            json!({"model":"requested","stream":true,"input":[]}),
        )
        .await
        .unwrap();
        assert_eq!(response.headers()[CONTENT_TYPE], "text/event-stream");
        assert_eq!(response.headers()["x-codex-turn-state"], "turn-state-1");
        assert_eq!(body(response).await, sse.as_bytes());
        request.assert_async().await;
    }

    #[tokio::test]
    async fn unsupported_provider_and_upstream_errors_are_explicit() {
        let error = responses_core(
            &ctx("http://unused".into()),
            &Store::new("anthropic"),
            &headers(),
            json!({"model":"requested","input":[]}),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("only provider 'openai'"));

        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/responses")
            .with_status(429)
            .with_header("content-type", "application/json")
            .with_header("retry-after", "3")
            .with_header("x-request-id", "request-error")
            .with_header("x-oai-request-id", "oai-request-error")
            .with_header("cf-ray", "ray-error")
            .with_header("x-codex-primary-error", "primary-error")
            .with_header("x-codex-secondary-error", "secondary-error")
            .with_header("x-codex-turn-state", "next-state")
            .with_header("x-ratelimit-reset-requests", "10ms")
            .with_body(r#"{"error":{"code":"rate_limit_exceeded","message":"slow down"}}"#)
            .create_async()
            .await;
        let response = responses_core(
            &ctx(server.url()),
            &Store::new("openai"),
            &headers(),
            json!({"model":"requested","input":[]}),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()["retry-after"], "3");
        assert_eq!(response.headers()["x-request-id"], "request-error");
        assert_eq!(response.headers()["x-oai-request-id"], "oai-request-error");
        assert_eq!(response.headers()["cf-ray"], "ray-error");
        assert_eq!(response.headers()["x-codex-primary-error"], "primary-error");
        assert_eq!(
            response.headers()["x-codex-secondary-error"],
            "secondary-error"
        );
        assert_eq!(response.headers()["x-codex-turn-state"], "next-state");
        assert_eq!(response.headers()["x-ratelimit-reset-requests"], "10ms");
        assert!(
            String::from_utf8(body(response).await)
                .unwrap()
                .contains("rate_limit_exceeded")
        );
    }

    #[tokio::test]
    async fn request_headers_use_a_strict_codex_allowlist() {
        let mut server = mockito::Server::new_async().await;
        let request = server
            .mock("POST", "/responses")
            .match_header("authorization", "Bearer upstream-key")
            .match_header("x-codex-turn-state", "turn-state")
            .match_header("x-codex-turn-metadata", "turn-metadata")
            .match_header("x-codex-installation-id", "installation")
            .match_header("session-id", "session")
            .match_header("thread-id", "thread")
            .match_header("x-client-request-id", "thread")
            .match_header("openai-project", mockito::Matcher::Missing)
            .match_header("x-api-key", mockito::Matcher::Missing)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"resp_headers","usage":{}}"#)
            .create_async()
            .await;
        let mut inbound = headers();
        inbound.insert("x-codex-turn-state", "turn-state".parse().unwrap());
        inbound.insert("x-codex-turn-metadata", "turn-metadata".parse().unwrap());
        inbound.insert("x-codex-installation-id", "installation".parse().unwrap());
        inbound.insert("session-id", "session".parse().unwrap());
        inbound.insert("thread-id", "thread".parse().unwrap());
        inbound.insert("x-client-request-id", "thread".parse().unwrap());
        inbound.insert("openai-project", "unsafe-project".parse().unwrap());
        inbound.insert("x-api-key", "unsafe-key".parse().unwrap());
        let response = responses_core(
            &ctx(server.url()),
            &Store::new("openai"),
            &inbound,
            json!({"model":"requested","input":[]}),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        request.assert_async().await;
    }

    #[tokio::test]
    async fn same_provider_fallback_retries_and_cross_provider_is_rejected() {
        let mut server = mockito::Server::new_async().await;
        let primary = server
            .mock("POST", "/responses")
            .match_body(mockito::Matcher::PartialJson(
                json!({"model":"resolved-model"}),
            ))
            .with_status(503)
            .with_body("unavailable")
            .create_async()
            .await;
        let fallback = server
            .mock("POST", "/responses")
            .match_body(mockito::Matcher::PartialJson(
                json!({"model":"gpt-fallback"}),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"resp_fallback","usage":{}}"#)
            .create_async()
            .await;
        let response = responses_core(
            &ctx(server.url()),
            &Store {
                provider: "openai",
                fallback_models: vec!["openai/gpt-fallback".into()],
            },
            &headers(),
            json!({"model":"requested","input":[]}),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        primary.assert_async().await;
        fallback.assert_async().await;

        let error = responses_core(
            &ctx(server.url()),
            &Store {
                provider: "openai",
                fallback_models: vec!["anthropic/claude-opus-4".into()],
            },
            &headers(),
            json!({"model":"requested","input":[]}),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("cross-provider"));
    }

    #[tokio::test]
    async fn fallback_retries_429_but_not_400() {
        let mut server = mockito::Server::new_async().await;
        let bad_request = server
            .mock("POST", "/responses")
            .match_body(mockito::Matcher::PartialJson(
                json!({"model":"resolved-model"}),
            ))
            .with_status(400)
            .with_body("bad request")
            .create_async()
            .await;
        let unused_fallback = server
            .mock("POST", "/responses")
            .match_body(mockito::Matcher::PartialJson(
                json!({"model":"gpt-fallback"}),
            ))
            .expect(0)
            .with_status(200)
            .create_async()
            .await;
        let store = Store {
            provider: "openai",
            fallback_models: vec!["openai/gpt-fallback".into()],
        };
        let response = responses_core(
            &ctx(server.url()),
            &store,
            &headers(),
            json!({"model":"requested","input":[]}),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        bad_request.assert_async().await;
        unused_fallback.assert_async().await;

        server.reset();
        let rate_limited = server
            .mock("POST", "/responses")
            .match_body(mockito::Matcher::PartialJson(
                json!({"model":"resolved-model"}),
            ))
            .with_status(429)
            .with_body("slow down")
            .create_async()
            .await;
        let fallback = server
            .mock("POST", "/responses")
            .match_body(mockito::Matcher::PartialJson(
                json!({"model":"gpt-fallback"}),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"id":"resp_fallback","usage":{}}"#)
            .create_async()
            .await;
        let response = responses_core(
            &ctx(server.url()),
            &store,
            &headers(),
            json!({"model":"requested","input":[]}),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        rate_limited.assert_async().await;
        fallback.assert_async().await;
    }

    #[tokio::test]
    async fn huge_malformed_sse_event_is_passed_through() {
        let mut server = mockito::Server::new_async().await;
        let sse = format!(
            "data: {{\"unterminated\":\"{}\"",
            "x".repeat(MAX_INSPECTION_BYTES + 1)
        );
        server
            .mock("POST", "/responses")
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(sse.clone())
            .create_async()
            .await;
        let response = responses_core(
            &ctx(server.url()),
            &Store::new("openai"),
            &headers(),
            json!({"model":"requested","stream":true,"input":[]}),
        )
        .await
        .unwrap();
        assert_eq!(body(response).await, sse.as_bytes());
    }

    #[test]
    fn oversized_sse_event_is_skipped_and_later_completion_is_inspected() {
        let state = Arc::new(Mutex::new(None));
        let mut inspector = SseInspector::new(Arc::clone(&state));
        let oversized = format!("data: {}", "x".repeat(MAX_INSPECTION_BYTES + 1));
        for chunk in oversized.as_bytes().chunks(8191) {
            inspector.push(chunk);
            assert!(inspector.event.len() <= MAX_INSPECTION_BYTES);
            assert!(inspector.separator_tail.len() <= 3);
        }
        inspector.push(b"\r\n");
        inspector.push(b"\r");
        inspector.push(b"\n");
        inspector.push(
            b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":2,\"output_tokens\":1,\"total_tokens\":3}}}\n",
        );
        inspector.push(b"\n");
        inspector.finish();

        let usage = state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
            .expect("completion usage should be captured");
        assert_eq!(usage.usage.total_tokens, Some(3));
    }

    #[tokio::test]
    async fn attempt_guard_can_be_disarmed_without_a_database() {
        let context = ctx("http://unused".into());
        let routed = RoutedRequest {
            agent_id: AGENT.into(),
            owner_id: OWNER.into(),
            resolved: crate::resolver::ResolvedConfig {
                provider: "openai".into(),
                model: "model".into(),
                litellm_model: "openai/model".into(),
                api_key: "key".into(),
                fallback_models: vec![],
                temperature: None,
                max_tokens: None,
                has_llm_config: true,
                pinned_model: None,
                tier1_model: None,
                tier2_model: None,
                tier3_model: None,
                platform_paid: true,
            },
            flow_id: None,
        };
        let mut guard =
            AttemptGuard::new(&context, &routed, &routed.resolved, Instant::now(), false);
        assert!(guard.record.is_some());
        guard.disarm();
        assert!(guard.record.is_none());
    }
}
