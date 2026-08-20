//! Export coding-agent turns to an OTLP/HTTP collector as GenAI spans.
//!
//! The payload is hand-built OTLP JSON rather than an SDK export: the CLI is
//! deliberately sync and tokio-free (`oss/docs/CLI_DESIGN.md`), and the JSON
//! encoding accepted by the OTLP HTTP receiver is stable and small enough to
//! emit directly.
//!
//! Attribute names are not free choices — they are what the read path already
//! looks for. `session.id` is how traces are grouped into a session
//! (`oss/observability/src/provider.rs:279`), and the `gen_ai.usage.*` keys are
//! read by `extract_token_attrs` / `extract_cache_token_attrs`
//! (`oss/observability/src/types.rs:109`). Change one here and the session
//! stops reporting tokens.

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

use super::model::{LlmCall, Turn};

/// OTLP span kinds (`opentelemetry.proto.trace.v1.Span.SpanKind`).
const SPAN_KIND_INTERNAL: u8 = 1;
const SPAN_KIND_CLIENT: u8 = 3;

/// Prompt text is truncated before export — a span attribute is not a place to
/// put an unbounded pasted file.
const MAX_PROMPT_CHARS: usize = 2000;

/// Everything needed to turn one session's turns into spans.
pub struct ExportContext<'a> {
    /// OTLP/HTTP base URL, e.g. `http://localhost:4318`.
    pub endpoint: &'a str,
    /// Resource `service.name` — must equal the agent's registered name.
    pub service_name: &'a str,
    /// Adapter-scoped server session id, exported as `session.id`.
    pub session_id: &'a str,
    /// Whether conversation content may be attached to spans.
    pub capture_content: bool,
}

/// Export turns as traces with a hook-budget-aware network timeout.
pub fn export_turns_with_timeout(
    ctx: &ExportContext<'_>,
    turns: &[Turn],
    timeout: Duration,
) -> Result<usize> {
    let spans: Vec<Value> = turns.iter().flat_map(|t| spans_for_turn(ctx, t)).collect();
    if spans.is_empty() {
        return Ok(0);
    }

    let count = spans.len();
    post_traces(ctx.endpoint, &payload(ctx.service_name, spans), timeout)?;
    Ok(count)
}

/// One trace per turn: a root span for the query, one child per LLM call.
fn spans_for_turn(ctx: &ExportContext<'_>, turn: &Turn) -> Vec<Value> {
    if turn.is_empty() {
        return Vec::new();
    }

    let trace_id = trace_id_for_turn(ctx.service_name, ctx.session_id, turn);
    let root_id = scoped_id(
        "root-span",
        ctx.service_name,
        ctx.session_id,
        &turn.uuid,
        16,
    );

    let mut spans = vec![root_span(ctx, turn, &trace_id, &root_id)];
    spans.extend(
        turn.calls
            .iter()
            .map(|call| call_span(ctx, call, &trace_id, &root_id)),
    );
    spans
}

/// The deterministic trace id used for a transcript turn.
///
/// Chat-message persistence uses the same id so the execution-history query
/// can link a completed user/assistant turn to its Tempo trace.
pub(super) fn trace_id_for_turn(service_name: &str, session_id: &str, turn: &Turn) -> String {
    scoped_id("trace", service_name, session_id, &turn.uuid, 32)
}

fn root_span(ctx: &ExportContext<'_>, turn: &Turn, trace_id: &str, span_id: &str) -> Value {
    let mut attributes = vec![
        string_attr("session.id", ctx.session_id),
        string_attr("agent.id", ctx.service_name),
        // Marks the root as the agent invocation, not an LLM call. The read
        // path counts only spans whose operation is `chat` (or absent) toward
        // latency percentiles, so tagging this keeps p50 per-LLM-call rather
        // than per-turn.
        string_attr("gen_ai.operation.name", "invoke_agent"),
    ];
    if ctx.capture_content {
        attributes.push(string_attr(
            "gen_ai.input.messages",
            &truncate(&turn.prompt, MAX_PROMPT_CHARS),
        ));
        if let Some(response) = &turn.response {
            attributes.push(string_attr(
                "gen_ai.output.messages",
                &truncate(response, MAX_PROMPT_CHARS),
            ));
        }
    }

    span(SpanFields {
        trace_id,
        span_id,
        parent_span_id: None,
        name: "coding_agent.turn",
        kind: SPAN_KIND_INTERNAL,
        started_at: turn.started_at,
        ended_at: turn.ended_at,
        attributes,
    })
}

fn call_span(ctx: &ExportContext<'_>, call: &LlmCall, trace_id: &str, parent_id: &str) -> Value {
    let attributes = vec![
        string_attr("session.id", ctx.session_id),
        string_attr("agent.id", ctx.service_name),
        string_attr("gen_ai.operation.name", "chat"),
        string_attr("gen_ai.system", &call.provider),
        string_attr("gen_ai.request.model", &call.model),
        string_attr("gen_ai.response.model", &call.model),
        int_attr("gen_ai.usage.input_tokens", call.input_tokens),
        int_attr("gen_ai.usage.output_tokens", call.output_tokens),
        int_attr(
            "gen_ai.usage.cache_read_input_tokens",
            call.cache_read_tokens,
        ),
        int_attr(
            "gen_ai.usage.cache_creation_input_tokens",
            call.cache_creation_tokens,
        ),
    ];

    span(SpanFields {
        trace_id,
        span_id: &scoped_id(
            "call-span",
            ctx.service_name,
            ctx.session_id,
            &call.uuid,
            16,
        ),
        parent_span_id: Some(parent_id),
        name: &format!("chat {}", call.model),
        kind: SPAN_KIND_CLIENT,
        started_at: call.started_at,
        ended_at: call.ended_at,
        attributes,
    })
}

// ─── OTLP JSON encoding ──────────────────────────────────────────────────────

/// Fields of a single OTLP span, grouped so `span` takes one argument.
struct SpanFields<'a> {
    trace_id: &'a str,
    span_id: &'a str,
    parent_span_id: Option<&'a str>,
    name: &'a str,
    kind: u8,
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
    attributes: Vec<Value>,
}

fn span(fields: SpanFields<'_>) -> Value {
    json!({
        "traceId": fields.trace_id,
        "spanId": fields.span_id,
        "parentSpanId": fields.parent_span_id.unwrap_or(""),
        "name": fields.name,
        "kind": fields.kind,
        "startTimeUnixNano": unix_nanos(fields.started_at),
        "endTimeUnixNano": unix_nanos(fields.ended_at),
        "attributes": fields.attributes,
        "status": {},
    })
}

fn payload(service_name: &str, spans: Vec<Value>) -> Value {
    json!({
        "resourceSpans": [{
            "resource": {
                "attributes": [
                    string_attr("service.name", service_name),
                    string_attr("agent.id", service_name),
                ]
            },
            "scopeSpans": [{
                "scope": { "name": "nasiko-cli" },
                "spans": spans,
            }]
        }]
    })
}

fn post_traces(endpoint: &str, payload: &Value, timeout: Duration) -> Result<()> {
    let url = format!("{}/v1/traces", endpoint.trim_end_matches('/'));
    let agent = ureq::Agent::new_with_config(
        ureq::config::Config::builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .build(),
    );
    let mut response = agent
        .post(&url)
        .header("Content-Type", "application/json")
        .send_json(payload)
        .with_context(|| format!("cannot reach OTLP collector at {url}"))?;

    let status = response.status().as_u16();
    if status >= 400 {
        let body = response.body_mut().read_to_string().unwrap_or_default();
        bail!("HTTP {status} from {url}: {body}");
    }
    Ok(())
}

fn string_attr(key: &str, value: &str) -> Value {
    json!({ "key": key, "value": { "stringValue": value } })
}

/// OTLP JSON encodes 64-bit ints as strings to survive JSON number limits.
fn int_attr(key: &str, value: u64) -> Value {
    json!({ "key": key, "value": { "intValue": value.to_string() } })
}

fn unix_nanos(at: DateTime<Utc>) -> String {
    at.timestamp_nanos_opt().unwrap_or(0).to_string()
}

/// Deterministic lowercase hex id of `len` characters.
///
/// Deriving ids from the transcript's own uuids (rather than randomly) makes
/// re-export idempotent: the same turn always produces the same trace and span
/// ids, so a duplicate report overwrites instead of double-counting.
fn scoped_id(
    domain: &str,
    service_name: &str,
    session_id: &str,
    identity: &str,
    len: usize,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"nasiko-cli-integration-id-v1\0");
    hasher.update(domain.as_bytes());
    hasher.update(b"\0");
    hasher.update(service_name.as_bytes());
    hasher.update(b"\0");
    hasher.update(session_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(identity.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)[..len].to_string()
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> ExportContext<'static> {
        ExportContext {
            endpoint: "http://localhost:4318",
            service_name: "claude-code",
            session_id: "sess-1",
            capture_content: true,
        }
    }

    fn turn_with_one_call() -> Turn {
        let started_at = "2026-08-17T20:25:52.298Z".parse::<DateTime<Utc>>().unwrap();
        let ended_at = "2026-08-17T20:25:58.298Z".parse::<DateTime<Utc>>().unwrap();
        Turn {
            uuid: "u1".to_string(),
            prompt: "hello".to_string(),
            response: None,
            started_at,
            ended_at,
            calls: vec![LlmCall {
                uuid: "a1".to_string(),
                provider: "anthropic".to_string(),
                model: "claude-opus-5".to_string(),
                input_tokens: 2,
                output_tokens: 269,
                cache_read_tokens: 23392,
                cache_creation_tokens: 51273,
                started_at,
                ended_at,
            }],
        }
    }

    /// Read an attribute's value back out of a built span.
    fn attr<'a>(span: &'a Value, key: &str) -> Option<&'a Value> {
        span["attributes"]
            .as_array()?
            .iter()
            .find(|a| a["key"] == key)
            .map(|a| &a["value"])
    }

    #[test]
    fn builds_a_root_span_plus_one_span_per_call() {
        let spans = spans_for_turn(&context(), &turn_with_one_call());

        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0]["parentSpanId"], "");
        assert_eq!(spans[1]["parentSpanId"], spans[0]["spanId"]);
        assert_eq!(spans[0]["traceId"], spans[1]["traceId"]);
    }

    #[test]
    fn tags_every_span_with_the_session_id() {
        let spans = spans_for_turn(&context(), &turn_with_one_call());

        for span in &spans {
            assert_eq!(attr(span, "session.id").unwrap()["stringValue"], "sess-1");
        }
    }

    #[test]
    fn emits_token_counts_under_the_keys_the_read_path_reads() {
        let spans = spans_for_turn(&context(), &turn_with_one_call());
        let call = &spans[1];

        assert_eq!(
            attr(call, "gen_ai.usage.input_tokens").unwrap()["intValue"],
            "2"
        );
        assert_eq!(
            attr(call, "gen_ai.usage.output_tokens").unwrap()["intValue"],
            "269"
        );
        assert_eq!(
            attr(call, "gen_ai.usage.cache_read_input_tokens").unwrap()["intValue"],
            "23392"
        );
        assert_eq!(
            attr(call, "gen_ai.usage.cache_creation_input_tokens").unwrap()["intValue"],
            "51273"
        );
        assert_eq!(
            attr(call, "gen_ai.request.model").unwrap()["stringValue"],
            "claude-opus-5"
        );
    }

    #[test]
    fn marks_only_llm_calls_as_chat_operations() {
        let spans = spans_for_turn(&context(), &turn_with_one_call());

        assert_eq!(
            attr(&spans[0], "gen_ai.operation.name").unwrap()["stringValue"],
            "invoke_agent"
        );
        assert_eq!(
            attr(&spans[1], "gen_ai.operation.name").unwrap()["stringValue"],
            "chat"
        );
    }

    #[test]
    fn omits_prompt_text_when_content_capture_is_off() {
        let ctx = ExportContext {
            capture_content: false,
            ..context()
        };

        let spans = spans_for_turn(&ctx, &turn_with_one_call());

        assert!(attr(&spans[0], "gen_ai.input.messages").is_none());
        assert!(attr(&spans[0], "gen_ai.output.messages").is_none());
    }

    #[test]
    fn includes_prompt_and_response_when_content_capture_is_on() {
        let mut turn = turn_with_one_call();
        turn.response = Some("world".to_string());
        let spans = spans_for_turn(&context(), &turn);
        assert_eq!(
            attr(&spans[0], "gen_ai.input.messages").unwrap()["stringValue"],
            "hello"
        );
        assert_eq!(
            attr(&spans[0], "gen_ai.output.messages").unwrap()["stringValue"],
            "world"
        );
    }

    #[test]
    fn produces_well_formed_trace_and_span_ids() {
        let spans = spans_for_turn(&context(), &turn_with_one_call());
        let trace_id = spans[0]["traceId"].as_str().unwrap();
        let span_id = spans[0]["spanId"].as_str().unwrap();

        assert_eq!(trace_id.len(), 32);
        assert_eq!(span_id.len(), 16);
        assert!(trace_id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn derives_the_same_ids_for_the_same_turn() {
        let first = spans_for_turn(&context(), &turn_with_one_call());
        let second = spans_for_turn(&context(), &turn_with_one_call());

        assert_eq!(first[0]["traceId"], second[0]["traceId"]);
        assert_eq!(first[1]["spanId"], second[1]["spanId"]);
    }

    #[test]
    fn scopes_ids_by_session_and_domain() {
        let turn = turn_with_one_call();
        let other = ExportContext {
            session_id: "sess-2",
            ..context()
        };
        let first = spans_for_turn(&context(), &turn);
        let second = spans_for_turn(&other, &turn);

        assert_ne!(first[0]["traceId"], second[0]["traceId"]);
        assert_ne!(first[0]["spanId"], first[1]["spanId"]);
        assert_ne!(first[1]["spanId"], second[1]["spanId"]);
    }

    #[test]
    fn scopes_ids_by_agent_service() {
        let turn = turn_with_one_call();
        let other = ExportContext {
            service_name: "opencode",
            ..context()
        };
        assert_ne!(
            spans_for_turn(&context(), &turn)[0]["traceId"],
            spans_for_turn(&other, &turn)[0]["traceId"]
        );
    }

    #[test]
    fn skips_turns_that_billed_nothing() {
        let mut turn = turn_with_one_call();
        turn.calls.clear();

        assert!(spans_for_turn(&context(), &turn).is_empty());
    }

    #[test]
    fn truncates_an_overlong_prompt() {
        let long = "x".repeat(MAX_PROMPT_CHARS + 500);

        let truncated = truncate(&long, MAX_PROMPT_CHARS);

        assert_eq!(truncated.chars().count(), MAX_PROMPT_CHARS + 1);
    }

    #[test]
    fn names_the_resource_after_the_registered_agent() {
        let value = payload("claude-code", vec![]);
        let attrs = &value["resourceSpans"][0]["resource"]["attributes"];

        assert_eq!(attrs[0]["value"]["stringValue"], "claude-code");
    }
}
