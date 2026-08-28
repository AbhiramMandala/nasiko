use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};

use crate::error::ObservabilityError;
use crate::loki::{LokiClient, parse_trace_logs};
use crate::pricing::{CostBreakdown, PricingSource, compute_cost, compute_cost_with_cache};
use crate::tempo::{TempoClient, TraceSearchResult};
use crate::types::{
    AgentFinOps, AgentStats, Session, SessionDetails, Span, SpanDetails, TokenUsage, TraceDetails,
    TraceSummary, extract_cache_token_attrs, extract_token_attrs, latency_percentiles,
};

// ---------------------------------------------------------------------------
// Trait
// ---------------------------------------------------------------------------

/// Abstracts access to distributed trace and log data.
///
/// Data model: a **session** (A2A contextId, `session.id` span attribute)
/// groups many **traces** — one per user query — each of which contains the
/// **spans** of every agent that participated in that query.
///
/// OSS impl: [`TempoLokiProvider`] — queries Tempo and Loki directly.
/// EE impl: `RbacObservabilityProvider` — wraps the OSS impl with RBAC filtering.
#[async_trait]
pub trait ObservabilityProvider: Send + Sync {
    /// List sessions for one agent, grouping its traces by `session.id`.
    /// Traces without `session.id` are infrastructure noise and skipped.
    async fn sessions_for_agent(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Session>, ObservabilityError>;

    /// Full drill-down for one session: one [`TraceSummary`] per user query.
    async fn get_session(
        &self,
        session_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<SessionDetails, ObservabilityError>;

    /// Fetch a full trace (one user query) with all spans.
    async fn get_trace(&self, trace_id: &str) -> Result<TraceDetails, ObservabilityError>;

    /// Fetch a single span, enriched with Loki prompt/completion content.
    ///
    /// `trace_id` is required because Tempo has no standalone span-search endpoint.
    async fn get_span(
        &self,
        trace_id: &str,
        span_id: &str,
    ) -> Result<SpanDetails, ObservabilityError>;

    /// Aggregate performance stats for one agent over the given window.
    async fn agent_stats(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<AgentStats, ObservabilityError>;

    /// Token/cost aggregation for one agent (FinOps dashboard row).
    async fn agent_finops(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<AgentFinOps, ObservabilityError>;

    /// Count user-query traces for an agent in a window (cheap: search only).
    async fn count_user_traces(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<usize, ObservabilityError>;

    /// Query raw log lines for an agent by Loki service name.
    /// Returns `(timestamp, log_line)` pairs sorted ascending.
    async fn query_logs(
        &self,
        service_name: &str,
        start: Option<DateTime<Utc>>,
        end: Option<DateTime<Utc>>,
        limit: usize,
    ) -> Result<Vec<(DateTime<Utc>, String)>, ObservabilityError>;

    /// Resolve a USD cost breakdown through the provider's pricing source.
    async fn cost(
        &self,
        model: Option<&str>,
        input_tokens: u64,
        output_tokens: u64,
    ) -> CostBreakdown;

    /// Resolve all four token classes. The default keeps third-party provider
    /// implementations source-compatible and prices cache tokens as input.
    async fn cost_with_cache(
        &self,
        model: Option<&str>,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
    ) -> CostBreakdown {
        self.cost(
            model,
            input_tokens + cache_read_tokens + cache_creation_tokens,
            output_tokens,
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// TraceQL helpers
// ---------------------------------------------------------------------------

/// Clamp start to at most 168 h before end (Tempo's max range).
pub fn clamp_tempo_range(start: DateTime<Utc>, end: DateTime<Utc>) -> DateTime<Utc> {
    let max_start = end - Duration::hours(168);
    if start < max_start { max_start } else { start }
}

/// TraceQL query covering all three locations where agent_id may be stored.
fn agent_query(agent_id: &str) -> String {
    format!(
        r#"{{span.agent.id="{0}"}} || {{resource.agent.id="{0}"}} || {{resource.service.name="{0}"}}"#,
        agent_id
    )
}

/// Like [`agent_query`] but restricted to traces that contain at least one
/// span with `session.id` set — i.e., user-facing request traces only,
/// excluding infrastructure traces (a2a-sdk remove_sink, dispatch loops, etc.).
fn agent_session_query(agent_id: &str) -> String {
    // Two separate span selectors joined by `&&` = trace-level AND.
    // `session.id` lives on the server's proxy/dispatch spans (service.name =
    // "nasiko"), while the agent's own spans carry service.name = agent name.
    // A single-selector `{A && B}` would require both on the *same* span and
    // always return zero results.
    format!(
        r#"{{span.session.id != ""}} && {{resource.service.name="{0}"}}"#,
        agent_id
    )
}

// ---------------------------------------------------------------------------
// TempoLokiProvider — OSS implementation
// ---------------------------------------------------------------------------

/// Resolves the session ↔ trace correlation from an external mapping.
///
/// Pre-built agents (deployed via `nasiko deploy`) don't carry the
/// sitecustomize.py patch and never set `session.id` on their spans; the
/// agent_proxy records the session_id ↔ trace_id pair when it forwards A2A
/// requests. The server injects a Postgres-backed implementation.
#[async_trait]
pub trait SessionIdResolver: Send + Sync {
    async fn session_for_trace(&self, trace_id: &str) -> Option<String>;

    /// Reverse lookup: all trace_ids recorded for a session, oldest first.
    /// Default: none — only resolvers backed by a real index override this.
    async fn traces_for_session(&self, _session_id: &str) -> Vec<String> {
        Vec::new()
    }
}

/// Default resolver: no external mapping.
pub struct NoSessionIdResolver;

#[async_trait]
impl SessionIdResolver for NoSessionIdResolver {
    async fn session_for_trace(&self, _trace_id: &str) -> Option<String> {
        None
    }
}

pub struct TempoLokiProvider {
    tempo: TempoClient,
    loki: LokiClient,
    pricing: Arc<dyn PricingSource>,
    session_resolver: Arc<dyn SessionIdResolver>,
}

/// How many traces to fully fetch when aggregating tokens for stats/finops.
const TOKEN_AGGREGATION_TRACE_CAP: usize = 100;
const SESSION_TRACE_PAGE_SIZE: usize = 100;
const SESSION_TRACE_SAFETY_CAP: usize = 2_000;

impl TempoLokiProvider {
    pub fn new(tempo_url: String, loki_url: String, pricing: Arc<dyn PricingSource>) -> Self {
        Self {
            tempo: TempoClient::new(tempo_url),
            loki: LokiClient::new(loki_url),
            pricing,
            session_resolver: Arc::new(NoSessionIdResolver),
        }
    }

    /// Attach a fallback trace_id → session_id resolver (e.g. Redis-backed).
    pub fn with_session_resolver(mut self, resolver: Arc<dyn SessionIdResolver>) -> Self {
        self.session_resolver = resolver;
        self
    }

    async fn search_traces(
        &self,
        query: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<TraceSearchResult>, ObservabilityError> {
        let start = clamp_tempo_range(start, end);
        let results = self
            .tempo
            .search(query, Some(start), Some(end), limit)
            .await?;

        // Traces may live in Tempo's WAL but not yet flushed to searchable
        // blocks — a time-bounded search misses them. Retry without time
        // params to include the WAL, then filter client-side.
        if results.is_empty() {
            let unbounded = self.tempo.search(query, None, None, limit).await?;
            if !unbounded.is_empty() {
                tracing::debug!(
                    query,
                    bounded = 0,
                    unbounded = unbounded.len(),
                    "search_traces: fell back to unbounded query (WAL-only traces)"
                );
                return Ok(unbounded);
            }
        }

        Ok(results)
    }

    async fn search_session_traces(
        &self,
        query: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<(Vec<TraceSearchResult>, bool), ObservabilityError> {
        let start = clamp_tempo_range(start, end);
        let mut page_end = end;
        let mut traces = Vec::new();
        let mut seen = HashSet::new();
        let mut first_page = true;

        loop {
            let mut page = self
                .tempo
                .search(query, Some(start), Some(page_end), SESSION_TRACE_PAGE_SIZE)
                .await?;
            if first_page && page.is_empty() {
                // Include traces still in Tempo's WAL, where a bounded search
                // can briefly return nothing immediately after export.
                page = self
                    .tempo
                    .search(query, None, None, SESSION_TRACE_PAGE_SIZE)
                    .await?;
            }
            first_page = false;
            let page_was_full = page.len() == SESSION_TRACE_PAGE_SIZE;
            let next_end = older_search_boundary(&page);

            append_unique_traces(&mut traces, &mut seen, page);

            if traces.len() > SESSION_TRACE_SAFETY_CAP {
                traces.truncate(SESSION_TRACE_SAFETY_CAP);
                return Ok((traces, true));
            }
            if !page_was_full {
                return Ok((traces, false));
            }

            let Some(next_end) = next_end.filter(|next| *next >= start && *next < page_end) else {
                // A full page without a usable timestamp cannot be advanced
                // safely. Preserve the data and report it as incomplete.
                return Ok((traces, true));
            };
            page_end = next_end;
        }
    }

    /// Fetch tokens/model/latency-p50 over up to
    /// [`TOKEN_AGGREGATION_TRACE_CAP`] traces.
    async fn aggregate_traces(&self, results: &[TraceSearchResult]) -> TraceAggregates {
        let mut agg = TraceAggregates::default();

        for (trace_id, _, _) in results.iter().take(TOKEN_AGGREGATION_TRACE_CAP) {
            match self.tempo.get_trace(trace_id).await {
                Ok(trace) => {
                    let (usage, m) = trace.usage_totals();
                    agg.input += usage.input_tokens;
                    agg.output += usage.output_tokens;
                    agg.cache_read += usage.cache_read_tokens;
                    agg.cache_creation += usage.cache_creation_tokens;
                    agg.cost.add_assign(self.trace_cost(&trace).await);
                    if agg.model.is_none() {
                        agg.model = m;
                    }
                }
                Err(e) => {
                    tracing::warn!(trace_id, error = %e, "token fetch failed");
                }
            }
        }
        agg
    }

    async fn trace_cost(&self, trace: &TraceDetails) -> CostBreakdown {
        let mut cost = CostBreakdown::default();
        let mut seen = HashSet::new();
        for span in &trace.spans {
            if !seen.insert(&span.span_id) {
                continue;
            }
            let (input, output, model) = extract_token_attrs(&span.attributes);
            let (cache_read, cache_creation) = extract_cache_token_attrs(&span.attributes);
            if input == 0 && output == 0 && cache_read == 0 && cache_creation == 0 {
                continue;
            }
            cost.add_assign(
                compute_cost_with_cache(
                    self.pricing.as_ref(),
                    model.as_deref(),
                    input,
                    output,
                    cache_read,
                    cache_creation,
                )
                .await,
            );
        }
        cost
    }

    async fn span_usage_and_cost(
        &self,
        trace: &TraceDetails,
        span: &Span,
    ) -> (TokenUsage, CostBreakdown) {
        if span.name == "coding_agent.turn" {
            return (trace.usage_totals().0, self.trace_cost(trace).await);
        }

        let (input_tokens, output_tokens, model) = extract_token_attrs(&span.attributes);
        let (cache_read_tokens, cache_creation_tokens) =
            extract_cache_token_attrs(&span.attributes);
        let usage = TokenUsage {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            total_tokens: input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens,
        };
        let cost = self
            .cost_with_cache(
                model.as_deref(),
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
            )
            .await;
        (usage, cost)
    }
}

/// Token totals accumulated across a set of traces by `aggregate_traces`.
#[derive(Default)]
struct TraceAggregates {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    model: Option<String>,
    cost: CostBreakdown,
}

/// Tempo search has no cursor. Its time bounds are whole epoch seconds, so move
/// to the final nanosecond of the second before the oldest result. This avoids
/// re-reading the inclusive boundary while trace-ID dedupe handles any backend
/// overlap between pages.
fn older_search_boundary(page: &[TraceSearchResult]) -> Option<DateTime<Utc>> {
    let oldest = page
        .iter()
        .filter_map(|(_, started_at, _)| *started_at)
        .min()?;
    DateTime::from_timestamp(oldest.timestamp().checked_sub(1)?, 999_999_999)
}

fn append_unique_traces(
    traces: &mut Vec<TraceSearchResult>,
    seen: &mut HashSet<String>,
    page: Vec<TraceSearchResult>,
) {
    for trace in page {
        if seen.insert(trace.0.clone()) {
            traces.push(trace);
        }
    }
}

fn session_query(session_id: &str) -> String {
    // TraceQL string literals use JSON-compatible escaping. Serializing the
    // value keeps quotes, backslashes, and control characters inside the
    // selector instead of allowing them to become TraceQL syntax.
    let literal = serde_json::to_string(session_id).expect("serializing a string cannot fail");
    format!("{{span.session.id={literal}}}")
}

fn trace_matches_session(trace: &TraceDetails, session_id: &str, resolver_sourced: bool) -> bool {
    let mut seen_spans = HashSet::new();
    let mut has_session_id = false;

    for span in &trace.spans {
        if !seen_spans.insert(&span.span_id) {
            continue;
        }
        let Some(value) = span.attributes.get("session.id").and_then(|v| v.as_str()) else {
            continue;
        };
        has_session_id = true;
        if value == session_id {
            return true;
        }
    }

    // Proxy-recorded resolver IDs are the authority for agents that do not
    // emit session.id. A conflicting emitted value is never accepted.
    resolver_sourced && !has_session_id
}

/// Per-session accumulator used while grouping traces by `session.id`.
#[derive(Default)]
struct SessionAccum {
    trace_ids: Vec<String>,
    earliest_start: Option<DateTime<Utc>>,
    latest_end: Option<DateTime<Utc>>,
    total_input: u64,
    total_output: u64,
    total_cache_read: u64,
    total_cache_creation: u64,
    cost: CostBreakdown,
    model_used: Option<String>,
    span_durations: Vec<u64>,
}

#[async_trait]
impl ObservabilityProvider for TempoLokiProvider {
    async fn sessions_for_agent(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<Session>, ObservabilityError> {
        let results = self
            .search_traces(&agent_query(agent_id), start, end, 100)
            .await?;

        let mut by_session: HashMap<String, SessionAccum> = HashMap::new();

        for (trace_id, started_at, duration_ms) in results {
            let mut session_key: Option<String> = None;
            let mut trace_input = 0u64;
            let mut trace_output = 0u64;
            let mut trace_cache_read = 0u64;
            let mut trace_cache_creation = 0u64;
            let mut trace_cost = CostBreakdown::default();
            let mut trace_model: Option<String> = None;
            let mut trace_span_durations: Vec<u64> = Vec::new();

            if let Ok(trace) = self.tempo.get_trace(&trace_id).await {
                let mut seen_spans = HashSet::new();
                for span in &trace.spans {
                    if !seen_spans.insert(&span.span_id) {
                        continue;
                    }
                    if session_key.is_none() {
                        session_key = span
                            .attributes
                            .get("session.id")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                    }
                    let (inp, out, model) = extract_token_attrs(&span.attributes);
                    let (cache_read, cache_creation) = extract_cache_token_attrs(&span.attributes);
                    if inp > 0 || out > 0 || cache_read > 0 || cache_creation > 0 {
                        trace_input += inp;
                        trace_output += out;
                        trace_cache_read += cache_read;
                        trace_cache_creation += cache_creation;
                        if trace_model.is_none() {
                            trace_model = model.clone();
                        }
                        trace_cost.add_assign(
                            compute_cost_with_cache(
                                self.pricing.as_ref(),
                                model.as_deref(),
                                inp,
                                out,
                                cache_read,
                                cache_creation,
                            )
                            .await,
                        );
                    }
                    let op = span
                        .attributes
                        .get("gen_ai.operation.name")
                        .and_then(|v| v.as_str());
                    if matches!(op, None | Some("chat"))
                        && let Some(d) = span.duration_ms
                    {
                        trace_span_durations.push(d);
                    }
                }
            }

            // Fallback: for pre-built agents that never set session.id on
            // spans, resolve trace_id → session_id via the injected resolver
            // (agent_proxy records the mapping when forwarding A2A requests).
            if session_key.is_none() {
                session_key = self.session_resolver.session_for_trace(&trace_id).await;
            }

            // Skip traces with no session association — a2a-sdk infrastructure
            // traces (event queue cleanup, dispatch loops, etc.), not user queries.
            let Some(key) = session_key else { continue };

            let end_time = started_at
                .zip(duration_ms)
                .map(|(s, d)| s + Duration::milliseconds(d as i64));

            let entry = by_session.entry(key).or_default();
            entry.trace_ids.push(trace_id);
            if let Some(s) = started_at {
                entry.earliest_start = Some(entry.earliest_start.map_or(s, |p| p.min(s)));
            }
            if let Some(e) = end_time {
                entry.latest_end = Some(entry.latest_end.map_or(e, |p| p.max(e)));
            }
            entry.total_input += trace_input;
            entry.total_output += trace_output;
            entry.total_cache_read += trace_cache_read;
            entry.total_cache_creation += trace_cache_creation;
            entry.cost.add_assign(trace_cost);
            if entry.model_used.is_none() {
                entry.model_used = trace_model;
            }
            entry.span_durations.extend(trace_span_durations);
        }

        let mut sessions = Vec::with_capacity(by_session.len());
        for (session_id, acc) in by_session {
            let (p50, p99) = latency_percentiles(acc.span_durations);
            let duration_ms = match (acc.earliest_start, acc.latest_end) {
                (Some(s), Some(e)) => Some((e - s).num_milliseconds().max(0) as u64),
                _ => None,
            };

            sessions.push(Session {
                session_id,
                agent_id: agent_id.to_string(),
                trace_ids: acc.trace_ids,
                started_at: acc.earliest_start,
                ended_at: acc.latest_end,
                duration_ms,
                input_tokens: acc.total_input,
                output_tokens: acc.total_output,
                cache_read_tokens: acc.total_cache_read,
                cache_creation_tokens: acc.total_cache_creation,
                model_used: acc.model_used,
                latency_ms_p50: p50,
                latency_ms_p99: p99,
                cost: acc.cost,
            });
        }

        sessions.sort_by_key(|s| std::cmp::Reverse(s.started_at));
        Ok(sessions)
    }

    async fn get_session(
        &self,
        session_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<SessionDetails, ObservabilityError> {
        let query = session_query(session_id);
        let (mut trace_results, mut has_more_traces) =
            self.search_session_traces(&query, start, end).await?;
        let mut resolver_sourced = false;

        // Agents that never set session.id on spans (anything not running the
        // Python auto-instrumentation patch): fall back to the proxy-recorded
        // session ↔ trace index.
        if trace_results.is_empty() {
            resolver_sourced = true;
            trace_results = self
                .session_resolver
                .traces_for_session(session_id)
                .await
                .into_iter()
                .map(|id| (id, None, None))
                .collect();
        }

        if trace_results.len() > SESSION_TRACE_SAFETY_CAP {
            trace_results.truncate(SESSION_TRACE_SAFETY_CAP);
            has_more_traces = true;
        }

        if trace_results.is_empty() {
            return Err(ObservabilityError::NotFound(format!(
                "session '{session_id}'"
            )));
        }

        let mut total_input = 0u64;
        let mut total_output = 0u64;
        let mut total_cache_read = 0u64;
        let mut total_cache_creation = 0u64;
        let mut total_cost = CostBreakdown::default();
        let mut model_used: Option<String> = None;
        let mut latencies: Vec<u64> = Vec::new();
        let mut traces: Vec<TraceSummary> = Vec::new();
        let trace_count = trace_results.len();
        let mut trace_fetch_failed = false;

        for (trace_id, _, _) in &trace_results {
            let trace = match self.tempo.get_trace(trace_id).await {
                Ok(trace) => trace,
                Err(error) => {
                    trace_fetch_failed = true;
                    tracing::warn!(trace_id, %error, "session trace fetch failed");
                    continue;
                }
            };
            if !trace_matches_session(&trace, session_id, resolver_sourced) {
                trace_fetch_failed = true;
                tracing::warn!(
                    trace_id,
                    session_id,
                    resolver_sourced,
                    "session trace did not match requested session"
                );
                continue;
            }
            // Resolver-sourced trace ids aren't bounded by the caller's time
            // window (the index has no TTL), so enforce it here.
            if trace.started_at.is_some_and(|s| s < start || s > end) {
                trace_fetch_failed = true;
                continue;
            }
            let Some(root_span) = find_root_span(&trace.spans) else {
                trace_fetch_failed = true;
                continue;
            };
            let root_span = root_span.clone();

            let (trace_usage, trace_model) = trace.usage_totals();
            total_input += trace_usage.input_tokens;
            total_output += trace_usage.output_tokens;
            total_cache_read += trace_usage.cache_read_tokens;
            total_cache_creation += trace_usage.cache_creation_tokens;
            if model_used.is_none() {
                model_used = trace_model.clone();
            }

            // Fetch Loki prompt/completion content for the root span, best-effort.
            let content = match trace.spans.first().map(|s| s.service_name.clone()) {
                Some(svc) if !svc.is_empty() => self
                    .loki
                    .get_trace_logs(&svc, trace_id, trace.started_at, trace.ended_at)
                    .await
                    .map(parse_trace_logs)
                    .unwrap_or_default()
                    .remove(&root_span.span_id),
                _ => None,
            };

            let duration_ms = root_span.duration_ms;
            if let Some(d) = duration_ms.filter(|&d| d > 0) {
                latencies.push(d);
            }

            let cost = self.trace_cost(&trace).await;
            total_cost.add_assign(cost);

            // Content precedence: Loki events, then GenAI semconv span attributes
            // recorded directly on the root span (gen_ai.input/output.messages).
            let attr_content = |key: &str| {
                root_span
                    .attributes
                    .get(key)
                    .and_then(|v| v.as_str())
                    .map(String::from)
            };
            let input_content = content
                .as_ref()
                .and_then(|c| c.input.clone())
                .or_else(|| attr_content("gen_ai.input.messages"));
            let output_content = content
                .and_then(|c| c.output)
                .or_else(|| attr_content("gen_ai.output.messages"));

            traces.push(TraceSummary {
                trace_id: trace_id.clone(),
                root_span,
                input_tokens: trace_usage.input_tokens,
                output_tokens: trace_usage.output_tokens,
                cache_read_tokens: trace_usage.cache_read_tokens,
                cache_creation_tokens: trace_usage.cache_creation_tokens,
                model_used: trace_model,
                duration_ms,
                cost,
                input_content,
                output_content,
            });
        }

        let (p50, p99) = latency_percentiles(latencies);
        let metrics_complete = !has_more_traces && !trace_fetch_failed;

        Ok(SessionDetails {
            session_id: session_id.to_string(),
            traces,
            trace_count,
            input_tokens: total_input,
            output_tokens: total_output,
            cache_read_tokens: total_cache_read,
            cache_creation_tokens: total_cache_creation,
            model_used,
            latency_ms_p50: metrics_complete.then_some(p50).flatten(),
            latency_ms_p99: metrics_complete.then_some(p99).flatten(),
            has_more_traces,
            metrics_complete,
            cost: total_cost,
        })
    }

    async fn get_trace(&self, trace_id: &str) -> Result<TraceDetails, ObservabilityError> {
        self.tempo.get_trace(trace_id).await
    }

    async fn get_span(
        &self,
        trace_id: &str,
        span_id: &str,
    ) -> Result<SpanDetails, ObservabilityError> {
        let trace = self.tempo.get_trace(trace_id).await?;
        let span = trace
            .spans
            .iter()
            .find(|s| s.span_id == span_id)
            .ok_or_else(|| {
                ObservabilityError::NotFound(format!("span '{span_id}' in trace '{trace_id}'"))
            })?
            .clone();

        // Best-effort Loki fetch. service_name comes from resource.service.name;
        // fall back to the code.namespace span attribute when unset.
        let svc = if span.service_name.is_empty() {
            span.attributes
                .get("code.namespace")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        } else {
            span.service_name.clone()
        };

        let content = if svc.is_empty() {
            None
        } else {
            // Pad the window so slight clock skew doesn't exclude logs.
            let start = trace.started_at.map(|t| t - Duration::minutes(1));
            let end = trace.ended_at.map(|t| t + Duration::minutes(1));
            match self.loki.get_trace_logs(&svc, trace_id, start, end).await {
                Ok(lines) => parse_trace_logs(lines).remove(span_id),
                Err(e) => {
                    tracing::debug!(svc, trace_id, error = %e, "loki fetch failed");
                    None
                }
            }
        };

        let (token_usage, cost) = self.span_usage_and_cost(&trace, &span).await;

        Ok(SpanDetails {
            span,
            input_content: content.as_ref().and_then(|c| c.input.clone()),
            output_content: content.and_then(|c| c.output),
            token_usage,
            cost,
        })
    }

    async fn agent_stats(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<AgentStats, ObservabilityError> {
        let results = self
            .search_traces(&agent_session_query(agent_id), start, end, 1000)
            .await?;

        let durations: Vec<u64> = results.iter().filter_map(|(_, _, d)| *d).collect();
        let (p50, p99) = latency_percentiles(durations);
        let agg = self.aggregate_traces(&results).await;

        Ok(AgentStats {
            agent_id: agent_id.to_string(),
            trace_count: results.len(),
            input_tokens: agg.input,
            output_tokens: agg.output,
            cache_read_tokens: agg.cache_read,
            cache_creation_tokens: agg.cache_creation,
            model_used: agg.model,
            latency_ms_p50: p50,
            latency_ms_p99: p99,
            cost: agg.cost,
            period_start: start,
        })
    }

    async fn agent_finops(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<AgentFinOps, ObservabilityError> {
        let results = self
            .search_traces(&agent_session_query(agent_id), start, end, 1000)
            .await?;

        let durations: Vec<u64> = results.iter().filter_map(|(_, _, d)| *d).collect();
        let (p50, _) = latency_percentiles(durations);
        let agg = self.aggregate_traces(&results).await;

        Ok(AgentFinOps {
            agent_id: agent_id.to_string(),
            operations: results.len(),
            input_tokens: agg.input,
            output_tokens: agg.output,
            cache_read_tokens: agg.cache_read,
            cache_creation_tokens: agg.cache_creation,
            model_used: agg.model,
            latency_ms_p50: p50,
            cost: agg.cost,
        })
    }

    async fn count_user_traces(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<usize, ObservabilityError> {
        let results = self
            .search_traces(&agent_session_query(agent_id), start, end, 1000)
            .await?;
        Ok(results.len())
    }

    async fn query_logs(
        &self,
        service_name: &str,
        start: Option<DateTime<Utc>>,
        end: Option<DateTime<Utc>>,
        limit: usize,
    ) -> Result<Vec<(DateTime<Utc>, String)>, ObservabilityError> {
        let query = format!(r#"{{service_name="{service_name}"}}"#);
        self.loki.query_range(&query, start, end, limit).await
    }

    async fn cost(
        &self,
        model: Option<&str>,
        input_tokens: u64,
        output_tokens: u64,
    ) -> CostBreakdown {
        compute_cost(self.pricing.as_ref(), model, input_tokens, output_tokens).await
    }

    async fn cost_with_cache(
        &self,
        model: Option<&str>,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_creation_tokens: u64,
    ) -> CostBreakdown {
        compute_cost_with_cache(
            self.pricing.as_ref(),
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_creation_tokens,
        )
        .await
    }
}

/// Root span: one whose parent is absent from the trace.
pub fn find_root_span(spans: &[Span]) -> Option<&Span> {
    let ids: std::collections::HashSet<&str> = spans.iter().map(|s| s.span_id.as_str()).collect();
    spans.iter().find(|s| {
        s.parent_span_id
            .as_ref()
            .map(|p| !ids.contains(p.as_str()))
            .unwrap_or(true)
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use chrono::{Duration, TimeZone, Utc};

    use crate::pricing::StaticPricing;

    use super::{
        Span, TempoLokiProvider, TraceDetails, append_unique_traces, older_search_boundary,
        session_query, trace_matches_session,
    };

    fn trace_with_sessions(values: &[(&str, Option<&str>)]) -> TraceDetails {
        let spans = values
            .iter()
            .map(|(span_id, session_id)| {
                let mut attributes = HashMap::new();
                if let Some(session_id) = session_id {
                    attributes.insert("session.id".into(), serde_json::json!(session_id));
                }
                Span {
                    span_id: (*span_id).into(),
                    parent_span_id: None,
                    name: "test".into(),
                    started_at: Utc.with_ymd_and_hms(2026, 8, 19, 12, 0, 0).unwrap(),
                    ended_at: None,
                    duration_ms: None,
                    service_name: "test".into(),
                    kind: 1,
                    status_code: 0,
                    status_message: String::new(),
                    attributes,
                    events: vec![],
                }
            })
            .collect();
        TraceDetails {
            trace_id: "trace-1".into(),
            spans,
            started_at: None,
            ended_at: None,
            duration_ms: None,
        }
    }

    fn model_span(
        span_id: &str,
        parent_span_id: Option<&str>,
        model: &str,
        usage: (u64, u64, u64, u64),
    ) -> Span {
        let mut span = trace_with_sessions(&[(span_id, None)]).spans.remove(0);
        span.parent_span_id = parent_span_id.map(str::to_owned);
        span.name = format!("chat {model}");
        span.attributes
            .insert("gen_ai.request.model".into(), serde_json::json!(model));
        span.attributes.insert(
            "gen_ai.usage.input_tokens".into(),
            serde_json::json!(usage.0),
        );
        span.attributes.insert(
            "gen_ai.usage.output_tokens".into(),
            serde_json::json!(usage.1),
        );
        span.attributes.insert(
            "gen_ai.usage.cache_read_input_tokens".into(),
            serde_json::json!(usage.2),
        );
        span.attributes.insert(
            "gen_ai.usage.cache_creation_input_tokens".into(),
            serde_json::json!(usage.3),
        );
        span
    }

    #[tokio::test]
    async fn mixed_model_trace_costs_each_span_with_its_own_rates() {
        let provider = TempoLokiProvider::new(
            "http://tempo.invalid".into(),
            "http://loki.invalid".into(),
            std::sync::Arc::new(StaticPricing),
        );
        let trace = TraceDetails {
            trace_id: "mixed".into(),
            spans: vec![
                model_span("gpt", None, "gpt-4o", (1_000_000, 0, 0, 0)),
                model_span(
                    "claude",
                    None,
                    "claude-sonnet-4",
                    (0, 1_000_000, 1_000_000, 1_000_000),
                ),
            ],
            started_at: None,
            ended_at: None,
            duration_ms: None,
        };

        let cost = provider.trace_cost(&trace).await;
        assert_eq!(cost.prompt_usd, 2.5);
        assert_eq!(cost.completion_usd, 15.0);
        assert_eq!(cost.cache_read_usd, 0.3);
        assert_eq!(cost.cache_creation_usd, 3.75);
        assert_eq!(cost.total_usd, 21.55);
    }

    #[tokio::test]
    async fn coding_agent_root_is_aggregate_and_child_is_per_call() {
        let provider = TempoLokiProvider::new(
            "http://tempo.invalid".into(),
            "http://loki.invalid".into(),
            std::sync::Arc::new(StaticPricing),
        );
        let mut root = trace_with_sessions(&[("root", None)]).spans.remove(0);
        root.name = "coding_agent.turn".into();
        let child = model_span("child", Some("root"), "claude-sonnet-4", (10, 5, 2, 3));
        let zero = model_span("zero", Some("root"), "gpt-4o", (0, 0, 0, 0));
        let trace = TraceDetails {
            trace_id: "turn".into(),
            spans: vec![root.clone(), child.clone(), zero.clone()],
            started_at: None,
            ended_at: None,
            duration_ms: None,
        };

        let (root_usage, root_cost) = provider.span_usage_and_cost(&trace, &root).await;
        let (child_usage, child_cost) = provider.span_usage_and_cost(&trace, &child).await;
        let (zero_usage, zero_cost) = provider.span_usage_and_cost(&trace, &zero).await;

        assert_eq!(root_usage.total_tokens, 20);
        assert_eq!(root_cost, child_cost);
        assert_eq!(child_usage.total_tokens, 20);
        assert_eq!(zero_usage.total_tokens, 0);
        assert_eq!(zero_cost, Default::default());
    }

    #[test]
    fn session_query_escapes_traceql_string_literal() {
        let session_id = "quote\" backslash\\ newline\n";
        let query = session_query(session_id);
        let literal = query
            .strip_prefix("{span.session.id=")
            .and_then(|query| query.strip_suffix('}'))
            .unwrap();

        assert_eq!(serde_json::from_str::<String>(literal).unwrap(), session_id);
        assert_eq!(
            query,
            "{span.session.id=\"quote\\\" backslash\\\\ newline\\n\"}"
        );
    }

    #[test]
    fn injected_session_query_cannot_authorize_another_sessions_trace() {
        let payload = "attacker\"} || {true} || {span.session.id=\"victim";
        let query = session_query(payload);
        let literal = query
            .strip_prefix("{span.session.id=")
            .and_then(|query| query.strip_suffix('}'))
            .unwrap();
        let victim_trace = trace_with_sessions(&[("span-1", Some("victim"))]);

        assert_eq!(serde_json::from_str::<String>(literal).unwrap(), payload);
        assert!(!trace_matches_session(&victim_trace, payload, false));
        assert!(!trace_matches_session(&victim_trace, payload, true));
    }

    #[test]
    fn direct_and_resolver_session_matching_use_deduplicated_spans() {
        let direct = trace_with_sessions(&[("span-1", Some("requested"))]);
        let replay_conflict =
            trace_with_sessions(&[("span-1", Some("other")), ("span-1", Some("requested"))]);
        let missing = trace_with_sessions(&[("span-1", None)]);

        assert!(trace_matches_session(&direct, "requested", false));
        assert!(!trace_matches_session(&replay_conflict, "requested", false));
        assert!(!trace_matches_session(&missing, "requested", false));
        assert!(trace_matches_session(&missing, "requested", true));
    }

    #[test]
    fn session_search_boundary_moves_before_oldest_result_second() {
        let newest =
            Utc.with_ymd_and_hms(2026, 8, 19, 12, 0, 10).unwrap() + Duration::milliseconds(800);
        let oldest =
            Utc.with_ymd_and_hms(2026, 8, 19, 12, 0, 5).unwrap() + Duration::milliseconds(200);
        let page = vec![
            ("newest".into(), Some(newest), None),
            ("oldest".into(), Some(oldest), None),
        ];

        let boundary = older_search_boundary(&page).unwrap();

        assert_eq!(boundary.timestamp(), oldest.timestamp() - 1);
        assert!(boundary < oldest);
    }

    #[test]
    fn session_search_pages_dedupe_trace_ids_at_boundaries() {
        let at = Utc.with_ymd_and_hms(2026, 8, 19, 12, 0, 0).unwrap();
        let mut traces = Vec::new();
        let mut seen = HashSet::new();
        let first_page = (0..100)
            .map(|id| (format!("trace-{id}"), Some(at), None))
            .collect();
        let second_page = (99..199)
            .map(|id| (format!("trace-{id}"), Some(at), None))
            .collect();

        append_unique_traces(&mut traces, &mut seen, first_page);
        append_unique_traces(&mut traces, &mut seen, second_page);

        assert_eq!(traces.len(), 199);
        assert_eq!(traces.first().unwrap().0, "trace-0");
        assert_eq!(traces.last().unwrap().0, "trace-198");
    }
}
