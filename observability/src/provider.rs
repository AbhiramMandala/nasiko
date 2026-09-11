use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};

use crate::error::ObservabilityError;
use crate::loki::{LokiClient, parse_trace_logs};
use crate::pricing::{CostBreakdown, PricingSource, compute_cost};
use crate::tempo::{TempoClient, TraceSearchResult};
use crate::types::{
    AgentFinOps, AgentStats, Session, SessionDetails, Span, SpanDetails, TraceDetails,
    TraceSummary, extract_token_attrs, latency_percentiles,
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

    /// Like [`Self::agent_finops`], additionally restricted to spans whose
    /// model attribute matches `model`. Additive trait method (default
    /// delegates to `agent_finops` when `model` is `None`) so implementors
    /// that don't override it — including any wrapper that doesn't know
    /// about model filtering yet — keep compiling and silently ignore the
    /// filter rather than failing. Callers MUST check for that: an override
    /// that can't honor a `Some(model)` filter returns `BadRequest` instead
    /// of silently returning unfiltered data.
    async fn agent_finops_filtered(
        &self,
        agent_id: &str,
        model: Option<&str>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<AgentFinOps, ObservabilityError> {
        match model {
            None => self.agent_finops(agent_id, start, end).await,
            Some(_) => Err(ObservabilityError::BadRequest(
                "model filtering not supported by this observability provider".into(),
            )),
        }
    }

    /// Like [`Self::count_user_traces`], additionally restricted by model.
    /// Same additive/default-delegates pattern as [`Self::agent_finops_filtered`].
    async fn count_user_traces_filtered(
        &self,
        agent_id: &str,
        model: Option<&str>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<usize, ObservabilityError> {
        match model {
            None => self.count_user_traces(agent_id, start, end).await,
            Some(_) => Err(ObservabilityError::BadRequest(
                "model filtering not supported by this observability provider".into(),
            )),
        }
    }

    /// Cross-agent spend bucketed by hour or day over `[start, end)`, honoring
    /// the full requested range (not the single-search 168h Tempo limit — see
    /// [`chunk_tempo_range`]). Optionally scoped to one agent and/or model.
    /// Backs the spend-over-time chart and the spend-concentration calendar.
    /// Default: not supported (empty result) — only [`TempoLokiProvider`]
    /// implements this today.
    async fn spend_timeseries(
        &self,
        _agent_id: Option<&str>,
        _model: Option<&str>,
        _start: DateTime<Utc>,
        _end: DateTime<Utc>,
        _bucket: TimeBucket,
    ) -> Result<Vec<SpendBucket>, ObservabilityError> {
        Ok(Vec::new())
    }

    /// Fetch a trace from the trace store and extract per-agent FinOps summary
    /// rows for the `trace_usage` materializer. Returns one row per agent that
    /// has token-bearing spans in the trace (multi-agent traces produce multiple
    /// rows). Returns empty when the trace has no token-bearing spans.
    ///
    /// Default: not supported — only [`TempoLokiProvider`] implements.
    async fn extract_trace_usage(
        &self,
        _trace_id: &str,
    ) -> Result<Vec<crate::types::TraceUsageRow>, ObservabilityError> {
        Ok(Vec::new())
    }

    /// Search for user-query traces across all agents in `[start, end)`.
    /// Used by the materializer to discover traces that need materialization.
    ///
    /// Default: empty — only [`TempoLokiProvider`] implements.
    async fn search_user_traces(
        &self,
        _start: DateTime<Utc>,
        _end: DateTime<Utc>,
        _limit: usize,
    ) -> Result<Vec<String>, ObservabilityError> {
        Ok(Vec::new())
    }
}

/// Granularity for [`ObservabilityProvider::spend_timeseries`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeBucket {
    Hour,
    Day,
}

impl TimeBucket {
    fn duration(self) -> Duration {
        match self {
            TimeBucket::Hour => Duration::hours(1),
            TimeBucket::Day => Duration::days(1),
        }
    }
}

/// One bucket of [`ObservabilityProvider::spend_timeseries`].
#[derive(Debug, Clone, Default)]
pub struct SpendBucket {
    pub bucket_start: DateTime<Utc>,
    pub spend_usd: f64,
    pub operations: usize,
    /// Highest-spend agent observed in this bucket, and its spend.
    pub top_agent_name: Option<String>,
    pub top_agent_spend_usd: Option<f64>,
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

/// Like [`agent_session_query`], additionally restricted to spans whose model
/// attribute matches `model`. Model may live under any of three attribute
/// names (see `extract_token_attrs`), so this ORs across all three within the
/// `&&`-ed span selector. Delegates to `agent_session_query` unchanged when
/// `model` is `None`, so the zero-filter case is byte-identical to today.
fn agent_session_model_query(agent_id: &str, model: Option<&str>) -> String {
    let base = agent_session_query(agent_id);
    match model {
        None => base,
        Some(m) => format!(
            r#"{base} && ({{span.gen_ai.request.model="{m}"}} || {{span.llm.request.model="{m}"}} || {{span.model="{m}"}})"#
        ),
    }
}

/// Split `[start, end)` into `<=168h` sub-windows, oldest first — Tempo's
/// documented single-search limit is a per-call constraint, not a data
/// limit, so honoring a longer caller-requested range means fanning out
/// multiple searches and unioning results rather than clamping (see
/// [`clamp_tempo_range`], which stays as the cheaper single-window behavior
/// for the per-agent KPI/attribution path).
pub fn chunk_tempo_range(
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
    const MAX_CHUNK: i64 = 168; // hours
    if end <= start {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let chunk_end = (cursor + Duration::hours(MAX_CHUNK)).min(end);
        chunks.push((cursor, chunk_end));
        cursor = chunk_end;
    }
    chunks
}

// ---------------------------------------------------------------------------
// TempoLokiProvider — OSS implementation
// ---------------------------------------------------------------------------

/// Resolves the session ↔ trace correlation from an external mapping.
///
/// Agents that aren't OTel-instrumented (or whose instrumentation doesn't tag
/// spans) never set `session.id`; the agent_proxy records the session_id ↔
/// trace_id pair when it forwards A2A requests. The server injects a
/// Postgres-backed implementation.
#[async_trait]
pub trait SessionIdResolver: Send + Sync {
    async fn session_for_trace(&self, trace_id: &str) -> Option<String>;

    /// Reverse lookup: all trace_ids recorded for a session, oldest first.
    /// Default: none — only resolvers backed by a real index override this.
    async fn traces_for_session(&self, _session_id: &str) -> Vec<String> {
        Vec::new()
    }

    /// Per-agent lookup: all trace_ids the index recorded for an agent (by
    /// name) in a window. Backs the finops/stats aggregations for agents that
    /// never set `session.id` on their spans, the same way
    /// `traces_for_session` backs session drill-down. Default: none.
    async fn traces_for_agent(
        &self,
        _agent_name: &str,
        _start: DateTime<Utc>,
        _end: DateTime<Utc>,
    ) -> Vec<String> {
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
        self.tempo
            .search(query, Some(start), Some(end), limit)
            .await
    }

    /// User-query traces for one agent: the Tempo `session.id` search, unioned
    /// with the proxy-recorded session ↔ trace index. Agents that don't run
    /// the Python auto-instrumentation patch never set `session.id` on their
    /// spans, so the TraceQL search alone misses every one of their user
    /// queries — the same gap `get_session` already covers per-session.
    async fn user_traces_for_agent(
        &self,
        agent_id: &str,
        model: Option<&str>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<TraceSearchResult>, ObservabilityError> {
        let mut results = self
            .search_traces(
                &agent_session_model_query(agent_id, model),
                start,
                end,
                limit,
            )
            .await?;
        // The index has no model dimension, so only merge it in for the
        // unfiltered case — a model filter must stay Tempo-search-derived
        // only, or it would silently reintroduce unfiltered rows.
        if model.is_none() {
            let indexed = self
                .session_resolver
                .traces_for_agent(agent_id, start, end)
                .await;
            if !indexed.is_empty() {
                let known: std::collections::HashSet<String> =
                    results.iter().map(|(id, _, _)| id.clone()).collect();
                results.extend(
                    indexed
                        .into_iter()
                        .filter(|id| !known.contains(id))
                        // Start/duration unknown until the trace is fetched.
                        .map(|id| (id, None, None)),
                );
                results.truncate(limit);
            }
        }
        Ok(results)
    }

    /// Fetch tokens/model/latency-p50 over up to
    /// [`TOKEN_AGGREGATION_TRACE_CAP`] traces.
    ///
    /// Uses chunked `join_all` (8-in-flight) to avoid stampeding Tempo —
    /// same pattern as `spend_timeseries_impl`. Bails early when too many
    /// consecutive fetches fail (stale index / compacted blocks).
    async fn aggregate_traces(&self, results: &[TraceSearchResult]) -> TraceAggregates {
        let mut agg = TraceAggregates::default();

        let ids: Vec<&str> = results
            .iter()
            .take(TOKEN_AGGREGATION_TRACE_CAP)
            .map(|(id, _, _)| id.as_str())
            .collect();

        let mut consecutive_failures = 0u32;
        const MAX_CONSECUTIVE_FAILURES: u32 = 16;

        'outer: for chunk in ids.chunks(8) {
            let fetches = chunk.iter().map(|id| self.tempo.get_trace(id));
            for result in futures::future::join_all(fetches).await {
                match result {
                    Ok(trace) => {
                        consecutive_failures = 0;
                        let (inp, out, m) = trace.token_totals();
                        let (cache_read, cache_creation) = trace.cache_token_totals();
                        agg.input += inp;
                        agg.output += out;
                        agg.cache_read += cache_read;
                        agg.cache_creation += cache_creation;
                        if agg.model.is_none() {
                            agg.model = m;
                        }
                    }
                    Err(e) => {
                        consecutive_failures += 1;
                        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                            tracing::warn!(
                                consecutive_failures,
                                "aborting trace aggregation — Tempo block data likely unavailable"
                            );
                            break 'outer;
                        }
                        tracing::debug!(error = %e, "token fetch failed");
                    }
                }
            }
        }
        agg
    }

    /// Real implementation behind `agent_finops`/`agent_finops_filtered`.
    async fn agent_finops_impl(
        &self,
        agent_id: &str,
        model: Option<&str>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<AgentFinOps, ObservabilityError> {
        let results = self
            .user_traces_for_agent(agent_id, model, start, end, 1000)
            .await?;

        let durations: Vec<u64> = results.iter().filter_map(|(_, _, d)| *d).collect();
        let (p50, _) = latency_percentiles(durations);
        let agg = self.aggregate_traces(&results).await;
        let cost = self.cost(agg.model.as_deref(), agg.input, agg.output).await;

        Ok(AgentFinOps {
            agent_id: agent_id.to_string(),
            operations: results.len(),
            is_capped: results.len() > TOKEN_AGGREGATION_TRACE_CAP,
            input_tokens: agg.input,
            output_tokens: agg.output,
            cache_read_tokens: agg.cache_read,
            cache_creation_tokens: agg.cache_creation,
            model_used: agg.model,
            latency_ms_p50: p50,
            cost,
        })
    }

    /// Cross-agent spend bucketed by hour/day, honoring the full requested
    /// range via `chunk_tempo_range` (fanned-out sub-searches, unioned)
    /// rather than the single-search 168h clamp. Buckets by each trace's
    /// start time; each trace is priced individually so mixed-model traces
    /// split correctly.
    async fn spend_timeseries_impl(
        &self,
        agent_id: Option<&str>,
        model: Option<&str>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        bucket: TimeBucket,
    ) -> Result<Vec<SpendBucket>, ObservabilityError> {
        let query = match agent_id {
            Some(id) => agent_session_model_query(id, model),
            None => match model {
                None => r#"{span.session.id != ""}"#.to_string(),
                Some(m) => format!(
                    r#"{{span.session.id != ""}} && ({{span.gen_ai.request.model="{m}"}} || {{span.llm.request.model="{m}"}} || {{span.model="{m}"}})"#
                ),
            },
        };

        let chunks = chunk_tempo_range(start, end);
        let searches = chunks
            .iter()
            .map(|(s, e)| self.tempo.search(&query, Some(*s), Some(*e), 1000));
        let chunk_results = futures::future::join_all(searches).await;

        let mut trace_ids: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for r in chunk_results.into_iter().flatten() {
            for (id, _, _) in r {
                if seen.insert(id.clone()) {
                    trace_ids.push(id);
                }
            }
        }

        // Bounded-concurrency trace fetch, chunked to 8-in-flight at a time —
        // same rationale as elsewhere in this provider: unbounded fan-out
        // would hammer Tempo. (Chunked `join_all` rather than
        // `stream::buffered`, which hits a higher-ranked-lifetime error
        // capturing `&self` across iterations.)
        let mut traces: Vec<_> = Vec::with_capacity(trace_ids.len());
        for chunk in trace_ids.chunks(8) {
            let fetches = chunk.iter().map(|id| self.tempo.get_trace(id));
            traces.extend(futures::future::join_all(fetches).await);
        }

        let bucket_seconds = bucket.duration().num_seconds();

        #[derive(Default)]
        struct BucketAcc {
            spend: f64,
            operations: usize,
            per_agent_spend: HashMap<String, f64>,
        }

        let mut buckets: HashMap<i64, BucketAcc> = HashMap::new();
        for trace in traces.into_iter().flatten() {
            let Some(started_at) = trace.started_at else {
                continue;
            };
            let (input, output, model_used) = trace.token_totals();
            if input == 0 && output == 0 {
                continue;
            }
            let cost = self.cost(model_used.as_deref(), input, output).await;
            // Acting agent: the service_name of the FIRST TOKEN-BEARING span,
            // not the trace's first span overall. A trace's first span is
            // typically the orchestrator's own root dispatch span (service
            // "nasiko-cp"), which never carries `gen_ai.usage.*` — the real
            // agent's LLM-call span is deeper in the tree. Using
            // `spans.first()` blindly attributed every orchestrator-routed
            // trace's spend to the orchestrator itself, not the downstream
            // agent that actually did the work (caught via real-infra
            // testing against a live orchestrator dispatch — a single-span
            // mock trace can't surface this, since first-span and
            // token-bearing-span are trivially the same thing there).
            let agent_name = trace
                .spans
                .iter()
                .find(|s| {
                    let (inp, out, _) = extract_token_attrs(&s.attributes);
                    inp > 0 || out > 0
                })
                .map(|s| s.service_name.clone())
                .filter(|n| !n.is_empty());

            let bucket_key = started_at.timestamp() / bucket_seconds;
            let acc = buckets.entry(bucket_key).or_default();
            acc.spend += cost.total_usd;
            acc.operations += 1;
            if let Some(name) = agent_name {
                *acc.per_agent_spend.entry(name).or_insert(0.0) += cost.total_usd;
            }
        }

        let mut out: Vec<SpendBucket> = buckets
            .into_iter()
            .map(|(key, acc)| {
                let top = acc
                    .per_agent_spend
                    .into_iter()
                    .max_by(|a, b| a.1.total_cmp(&b.1));
                SpendBucket {
                    bucket_start: DateTime::<Utc>::from_timestamp(key * bucket_seconds, 0)
                        .unwrap_or(start),
                    spend_usd: crate::pricing::round6(acc.spend),
                    operations: acc.operations,
                    top_agent_name: top.as_ref().map(|(n, _)| n.clone()),
                    top_agent_spend_usd: top.map(|(_, v)| crate::pricing::round6(v)),
                }
            })
            .collect();
        out.sort_by_key(|b| b.bucket_start);
        Ok(out)
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
}

/// Per-session accumulator used while grouping traces by `session.id`.
#[derive(Default)]
struct SessionAccum {
    trace_ids: Vec<String>,
    earliest_start: Option<DateTime<Utc>>,
    latest_end: Option<DateTime<Utc>>,
    total_input: u64,
    total_output: u64,
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
            let mut trace_model: Option<String> = None;
            let mut trace_span_durations: Vec<u64> = Vec::new();

            if let Ok(trace) = self.tempo.get_trace(&trace_id).await {
                for span in &trace.spans {
                    if session_key.is_none() {
                        session_key = span
                            .attributes
                            .get("session.id")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                    }
                    let (inp, out, model) = extract_token_attrs(&span.attributes);
                    if inp > 0 || out > 0 {
                        trace_input += inp;
                        trace_output += out;
                        if trace_model.is_none() {
                            trace_model = model;
                        }
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
            if entry.model_used.is_none() {
                entry.model_used = trace_model;
            }
            entry.span_durations.extend(trace_span_durations);
        }

        let mut sessions = Vec::with_capacity(by_session.len());
        for (session_id, acc) in by_session {
            let (p50, p99) = latency_percentiles(acc.span_durations);
            let cost = self
                .cost(acc.model_used.as_deref(), acc.total_input, acc.total_output)
                .await;
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
                model_used: acc.model_used,
                latency_ms_p50: p50,
                latency_ms_p99: p99,
                cost,
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
        let query = format!(r#"{{span.session.id="{session_id}"}}"#);
        let mut trace_results = self.search_traces(&query, start, end, 100).await?;

        // Agents that never set session.id on spans (anything not running the
        // Python auto-instrumentation patch): fall back to the proxy-recorded
        // session ↔ trace index.
        if trace_results.is_empty() {
            trace_results = self
                .session_resolver
                .traces_for_session(session_id)
                .await
                .into_iter()
                .map(|id| (id, None, None))
                .collect();
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
        let mut model_used: Option<String> = None;
        let mut latencies: Vec<u64> = Vec::new();
        let mut traces: Vec<TraceSummary> = Vec::new();

        for (trace_id, _, _) in &trace_results {
            let Ok(trace) = self.tempo.get_trace(trace_id).await else {
                continue;
            };
            // Resolver-sourced trace ids aren't bounded by the caller's time
            // window (the index has no TTL), so enforce it here.
            if trace.started_at.is_some_and(|s| s < start || s > end) {
                continue;
            }
            let Some(root_span) = find_root_span(&trace.spans) else {
                continue;
            };
            let root_span = root_span.clone();

            let (trace_input, trace_output, trace_model) = trace.token_totals();
            let (trace_cache_read, trace_cache_creation) = trace.cache_token_totals();
            total_input += trace_input;
            total_output += trace_output;
            total_cache_read += trace_cache_read;
            total_cache_creation += trace_cache_creation;
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

            let cost = self
                .cost(trace_model.as_deref(), trace_input, trace_output)
                .await;

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
                input_tokens: trace_input,
                output_tokens: trace_output,
                cache_read_tokens: trace_cache_read,
                cache_creation_tokens: trace_cache_creation,
                model_used: trace_model,
                duration_ms,
                cost,
                input_content,
                output_content,
            });
        }

        let avg = (!latencies.is_empty())
            .then(|| latencies.iter().sum::<u64>() as f64 / latencies.len() as f64);
        let (p50, p99) = latency_percentiles(latencies);
        let cost = self
            .cost(model_used.as_deref(), total_input, total_output)
            .await;

        Ok(SessionDetails {
            session_id: session_id.to_string(),
            traces,
            input_tokens: total_input,
            output_tokens: total_output,
            cache_read_tokens: total_cache_read,
            cache_creation_tokens: total_cache_creation,
            model_used,
            latency_ms_p50: p50,
            latency_ms_p99: p99,
            latency_ms_avg: avg,
            cost,
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

        let (input_tokens, output_tokens, model) = extract_token_attrs(&span.attributes);
        let cost = self
            .cost(model.as_deref(), input_tokens, output_tokens)
            .await;

        Ok(SpanDetails {
            span,
            input_content: content.as_ref().and_then(|c| c.input.clone()),
            output_content: content.and_then(|c| c.output),
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
            .user_traces_for_agent(agent_id, None, start, end, 1000)
            .await?;

        let durations: Vec<u64> = results.iter().filter_map(|(_, _, d)| *d).collect();
        let (p50, p99) = latency_percentiles(durations);
        let agg = self.aggregate_traces(&results).await;
        let cost = self.cost(agg.model.as_deref(), agg.input, agg.output).await;

        Ok(AgentStats {
            agent_id: agent_id.to_string(),
            trace_count: results.len(),
            is_capped: results.len() > TOKEN_AGGREGATION_TRACE_CAP,
            input_tokens: agg.input,
            output_tokens: agg.output,
            model_used: agg.model,
            latency_ms_p50: p50,
            latency_ms_p99: p99,
            cost,
            period_start: start,
        })
    }

    async fn agent_finops(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<AgentFinOps, ObservabilityError> {
        self.agent_finops_impl(agent_id, None, start, end).await
    }

    async fn agent_finops_filtered(
        &self,
        agent_id: &str,
        model: Option<&str>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<AgentFinOps, ObservabilityError> {
        self.agent_finops_impl(agent_id, model, start, end).await
    }

    async fn count_user_traces(
        &self,
        agent_id: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<usize, ObservabilityError> {
        let results = self
            .user_traces_for_agent(agent_id, None, start, end, 1000)
            .await?;
        Ok(results.len())
    }

    async fn count_user_traces_filtered(
        &self,
        agent_id: &str,
        model: Option<&str>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<usize, ObservabilityError> {
        let results = self
            .user_traces_for_agent(agent_id, model, start, end, 1000)
            .await?;
        Ok(results.len())
    }

    async fn spend_timeseries(
        &self,
        agent_id: Option<&str>,
        model: Option<&str>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        bucket: TimeBucket,
    ) -> Result<Vec<SpendBucket>, ObservabilityError> {
        self.spend_timeseries_impl(agent_id, model, start, end, bucket)
            .await
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

    async fn extract_trace_usage(
        &self,
        trace_id: &str,
    ) -> Result<Vec<crate::types::TraceUsageRow>, ObservabilityError> {
        use crate::types::extract_cache_token_attrs;

        let trace = self.tempo.get_trace(trace_id).await?;

        // Session ID from span attributes (shared across all agents in the trace).
        let session_id = trace.spans.iter().find_map(|s| {
            s.attributes
                .get("session.id")
                .and_then(|v| v.as_str())
                .filter(|sid| !sid.is_empty())
                .map(|sid| sid.to_string())
        });

        let started_at = trace.started_at.unwrap_or_else(Utc::now);
        let latency_ms = trace.duration_ms.map(|d| d as i64);

        // Group token-bearing and tool-call spans by agent (service_name).
        // Each agent that made LLM calls or tool calls in this trace gets its
        // own row — a multi-agent trace produces multiple rows.
        struct AgentAcc {
            input: u64,
            output: u64,
            cache_read: u64,
            cache_creation: u64,
            model: Option<String>,
            tool_calls: u32,
        }

        let mut by_agent: HashMap<String, AgentAcc> = HashMap::new();
        for span in &trace.spans {
            let (inp, out, model) = extract_token_attrs(&span.attributes);
            // gen_ai.operation.name = "call_tool" (GenAI semconv) or
            // openinference.span.kind = "TOOL" (OpenInference convention).
            let is_tool_call = span
                .attributes
                .get("gen_ai.operation.name")
                .and_then(|v| v.as_str())
                .map(|s| s == "call_tool")
                .unwrap_or(false)
                || span
                    .attributes
                    .get("openinference.span.kind")
                    .and_then(|v| v.as_str())
                    .map(|s| s.eq_ignore_ascii_case("tool"))
                    .unwrap_or(false);
            if inp == 0 && out == 0 && !is_tool_call {
                continue;
            }
            let name = &span.service_name;
            if name.is_empty() {
                continue;
            }
            let (cr, cc) = extract_cache_token_attrs(&span.attributes);
            let acc = by_agent.entry(name.clone()).or_insert(AgentAcc {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_creation: 0,
                model: None,
                tool_calls: 0,
            });
            acc.input += inp;
            acc.output += out;
            acc.cache_read += cr;
            acc.cache_creation += cc;
            if acc.model.is_none() {
                acc.model = model;
            }
            if is_tool_call {
                acc.tool_calls += 1;
            }
        }

        let mut rows = Vec::with_capacity(by_agent.len());
        for (agent_name, acc) in by_agent {
            let cost = self.cost(acc.model.as_deref(), acc.input, acc.output).await;
            rows.push(crate::types::TraceUsageRow {
                trace_id: trace_id.to_string(),
                agent_name,
                session_id: session_id.clone(),
                model: acc.model,
                provider: None, // populated by the materializer from model_pricing
                input_tokens: acc.input,
                output_tokens: acc.output,
                cache_read_tokens: acc.cache_read,
                cache_creation_tokens: acc.cache_creation,
                tool_call_count: acc.tool_calls,
                cost_usd: cost.total_usd,
                prompt_cost_usd: cost.prompt_usd,
                completion_cost_usd: cost.completion_usd,
                latency_ms,
                started_at,
            });
        }
        Ok(rows)
    }

    async fn search_user_traces(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<String>, ObservabilityError> {
        let chunks = chunk_tempo_range(start, end);
        let mut seen = std::collections::HashSet::new();
        let mut ids = Vec::new();

        for (s, e) in chunks {
            let results = self
                .tempo
                .search(r#"{span.session.id != ""}"#, Some(s), Some(e), limit)
                .await?;
            for (id, _, _) in results {
                if seen.insert(id.clone()) {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pricing::StaticPricing;
    use std::sync::Arc;

    // ── chunk_tempo_range ───────────────────────────────────────────────────

    #[test]
    fn chunk_tempo_range_empty_when_end_before_or_equal_start() {
        let t = Utc::now();
        assert!(chunk_tempo_range(t, t).is_empty(), "end == start");
        assert!(
            chunk_tempo_range(t, t - Duration::hours(1)).is_empty(),
            "end < start"
        );
    }

    #[test]
    fn chunk_tempo_range_single_chunk_under_168h() {
        let end = Utc::now();
        let start = end - Duration::hours(1);
        let chunks = chunk_tempo_range(start, end);
        assert_eq!(chunks, vec![(start, end)]);
    }

    #[test]
    fn chunk_tempo_range_single_chunk_at_exactly_168h() {
        let end = Utc::now();
        let start = end - Duration::hours(168);
        let chunks = chunk_tempo_range(start, end);
        assert_eq!(
            chunks,
            vec![(start, end)],
            "168h is the boundary, not over it"
        );
    }

    #[test]
    fn chunk_tempo_range_splits_just_over_168h_into_two() {
        let end = Utc::now();
        let start = end - Duration::hours(169);
        let chunks = chunk_tempo_range(start, end);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].0, start);
        assert_eq!(chunks[0].1, start + Duration::hours(168));
        assert_eq!(chunks[1].0, chunks[0].1, "chunks must be contiguous");
        assert_eq!(chunks[1].1, end, "last chunk must end exactly at `end`");
    }

    #[test]
    fn chunk_tempo_range_30_days_splits_into_five_chunks_with_short_tail() {
        // 30 days = 720h = 4*168 + 48 -> 4 full 168h chunks + one 48h tail.
        let end = Utc::now();
        let start = end - Duration::days(30);
        let chunks = chunk_tempo_range(start, end);
        assert_eq!(chunks.len(), 5);
        for c in &chunks[..4] {
            assert_eq!(c.1 - c.0, Duration::hours(168));
        }
        let tail = chunks[4];
        assert_eq!(tail.1 - tail.0, Duration::hours(48));
        assert_eq!(tail.1, end);
        // Contiguity end-to-end, and total coverage equals the input range.
        for w in chunks.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
        assert_eq!(chunks.first().unwrap().0, start);
    }

    // ── TraceQL query builders ──────────────────────────────────────────────

    #[test]
    fn agent_session_model_query_with_no_model_matches_agent_session_query_exactly() {
        assert_eq!(
            agent_session_model_query("my-agent", None),
            agent_session_query("my-agent"),
        );
    }

    #[test]
    fn agent_session_model_query_with_model_ands_in_an_or_group_over_three_attr_names() {
        let q = agent_session_model_query("my-agent", Some("gpt-4o"));
        assert!(q.starts_with(&agent_session_query("my-agent")));
        assert!(q.contains(r#"{span.gen_ai.request.model="gpt-4o"}"#));
        assert!(q.contains(r#"{span.llm.request.model="gpt-4o"}"#));
        assert!(q.contains(r#"{span.model="gpt-4o"}"#));
        // The three model predicates must be OR'd together, not AND'd — any
        // one of the three attribute names should be enough to match.
        assert!(q.contains(" || "));
        // ...and that OR group itself must be AND'd onto the base query, not
        // OR'd with it (an unscoped OR would match spans from ANY agent).
        assert!(q.contains(" && ("));
    }

    // ── is_capped / operations bookkeeping (mockito) ────────────────────────

    fn provider_against(base_url: &str) -> TempoLokiProvider {
        TempoLokiProvider::new(
            base_url.to_string(),
            "http://127.0.0.1:1".to_string(), // unused by the paths under test
            Arc::new(StaticPricing),
        )
    }

    fn search_response_with_n_traces(n: usize) -> serde_json::Value {
        let traces: Vec<_> = (0..n)
            .map(|i| {
                serde_json::json!({
                    "traceID": format!("trace-{i:04}"),
                    "startTimeUnixNano": "1700000000000000000",
                    "durationMs": 50,
                })
            })
            .collect();
        serde_json::json!({ "traces": traces })
    }

    #[tokio::test]
    async fn agent_finops_reports_is_capped_true_and_full_operation_count_beyond_the_trace_cap() {
        let mut server = mockito::Server::new_async().await;
        // 105 traces in the search result — over TOKEN_AGGREGATION_TRACE_CAP (100).
        let _search = server
            .mock("GET", "/api/search")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(search_response_with_n_traces(105).to_string())
            .create_async()
            .await;
        // Every individual trace fetch 404s — aggregate_traces must warn and
        // skip rather than fail the whole call, and it must still only
        // attempt up to the cap (this mock alone can't observe call count,
        // but a non-panicking, correctly-summarized result proves the cap is
        // respected without the token side blowing up).
        let _traces = server
            .mock("GET", mockito::Matcher::Regex(r"^/api/traces/.*$".into()))
            .with_status(404)
            .create_async()
            .await;

        let provider = provider_against(&server.url());
        let now = Utc::now();
        let finops = provider
            .agent_finops("busy-agent", now - Duration::hours(1), now)
            .await
            .expect("search succeeded even though every trace fetch 404s");

        assert_eq!(
            finops.operations, 105,
            "operations reflects the full search count"
        );
        assert!(finops.is_capped, "105 > 100-trace cap");
        assert_eq!(
            finops.input_tokens, 0,
            "no trace fetch succeeded, so no tokens"
        );
    }

    #[tokio::test]
    async fn agent_finops_reports_is_capped_false_under_the_trace_cap() {
        let mut server = mockito::Server::new_async().await;
        let _search = server
            .mock("GET", "/api/search")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(search_response_with_n_traces(3).to_string())
            .create_async()
            .await;
        let _traces = server
            .mock("GET", mockito::Matcher::Regex(r"^/api/traces/.*$".into()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                otlp_trace_json(
                    "busy-agent",
                    "1700000000000000000",
                    100,
                    50,
                    Some("gpt-4o-mini"),
                )
                .to_string(),
            )
            .create_async()
            .await;

        let provider = provider_against(&server.url());
        let now = Utc::now();
        let finops = provider
            .agent_finops("busy-agent", now - Duration::hours(1), now)
            .await
            .unwrap();

        assert_eq!(finops.operations, 3);
        assert!(!finops.is_capped);
        // 3 traces x 100 input / 50 output tokens each.
        assert_eq!(finops.input_tokens, 300);
        assert_eq!(finops.output_tokens, 150);
        // gpt-4o-mini: (0.15, 0.60) USD/1M — see pricing.rs's static table.
        let expected_cost = (300.0 / 1_000_000.0 * 0.15) + (150.0 / 1_000_000.0 * 0.60);
        assert!(
            (finops.cost.total_usd - expected_cost).abs() < 1e-9,
            "cost {} != expected {expected_cost}",
            finops.cost.total_usd
        );
    }

    #[tokio::test]
    async fn agent_finops_filtered_sends_the_model_predicate_and_none_falls_back_to_unfiltered() {
        let mut server = mockito::Server::new_async().await;
        let expected_unfiltered = agent_session_model_query("my-agent", None);
        let expected_filtered = agent_session_model_query("my-agent", Some("gpt-4o"));
        assert_ne!(expected_unfiltered, expected_filtered);

        let _unfiltered = server
            .mock("GET", "/api/search")
            .match_query(mockito::Matcher::UrlEncoded(
                "q".into(),
                expected_unfiltered.clone(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(search_response_with_n_traces(1).to_string())
            .create_async()
            .await;
        let _filtered = server
            .mock("GET", "/api/search")
            .match_query(mockito::Matcher::UrlEncoded(
                "q".into(),
                expected_filtered.clone(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(search_response_with_n_traces(2).to_string())
            .create_async()
            .await;
        let _traces = server
            .mock("GET", mockito::Matcher::Regex(r"^/api/traces/.*$".into()))
            .with_status(404)
            .create_async()
            .await;

        let provider = provider_against(&server.url());
        let now = Utc::now();
        let start = now - Duration::hours(1);

        let unfiltered = provider
            .agent_finops_filtered("my-agent", None, start, now)
            .await
            .unwrap();
        assert_eq!(
            unfiltered.operations, 1,
            "None routes through the unfiltered TraceQL"
        );

        let filtered = provider
            .agent_finops_filtered("my-agent", Some("gpt-4o"), start, now)
            .await
            .unwrap();
        assert_eq!(
            filtered.operations, 2,
            "Some(model) routes through the model-scoped TraceQL"
        );
    }

    // ── spend_timeseries bucketing + top-agent selection ────────────────────

    #[tokio::test]
    async fn spend_timeseries_buckets_by_hour_and_picks_the_highest_spender_per_bucket() {
        let mut server = mockito::Server::new_async().await;

        // Two traces in the SAME hour bucket (12:00-12:59 UTC on 2023-11-14),
        // from two different agents with different spend; one trace in the
        // NEXT hour bucket, from a third agent.
        // 1700000000 UTC = 2023-11-14T22:13:20Z; pick round numbers instead.
        let bucket0_start_nanos: i64 = 1_700_000_000_000_000_000; // arbitrary anchor
        let bucket0_ts = bucket0_start_nanos.to_string();
        let bucket1_ts = (bucket0_start_nanos + 3_600_000_000_000).to_string(); // +1h

        let search_body = serde_json::json!({
            "traces": [
                {"traceID": "t-cheap", "startTimeUnixNano": bucket0_ts, "durationMs": 10},
                {"traceID": "t-expensive", "startTimeUnixNano": bucket0_ts, "durationMs": 10},
                {"traceID": "t-next-hour", "startTimeUnixNano": bucket1_ts, "durationMs": 10},
            ]
        });
        let _search = server
            .mock("GET", "/api/search")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(search_body.to_string())
            .create_async()
            .await;

        let _t_cheap = server
            .mock("GET", "/api/traces/t-cheap")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                otlp_trace_json("cheap-agent", &bucket0_ts, 100, 100, Some("gpt-4o-mini"))
                    .to_string(),
            )
            .create_async()
            .await;
        let _t_expensive = server
            .mock("GET", "/api/traces/t-expensive")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                otlp_trace_json(
                    "expensive-agent",
                    &bucket0_ts,
                    1_000_000,
                    1_000_000,
                    Some("gpt-4o"),
                )
                .to_string(),
            )
            .create_async()
            .await;
        let _t_next_hour = server
            .mock("GET", "/api/traces/t-next-hour")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                otlp_trace_json("solo-agent", &bucket1_ts, 500, 500, Some("gpt-4o-mini"))
                    .to_string(),
            )
            .create_async()
            .await;

        let provider = provider_against(&server.url());
        let start =
            DateTime::<Utc>::from_timestamp(bucket0_start_nanos / 1_000_000_000 - 60, 0).unwrap();
        let end = start + Duration::hours(3);

        let buckets = provider
            .spend_timeseries(None, None, start, end, TimeBucket::Hour)
            .await
            .unwrap();

        assert_eq!(buckets.len(), 2, "two distinct hour buckets were populated");

        let b0 = &buckets[0];
        assert_eq!(b0.operations, 2, "two traces landed in the first bucket");
        assert_eq!(
            b0.top_agent_name.as_deref(),
            Some("expensive-agent"),
            "the far larger spend must win top_agent, not just the last-seen trace"
        );
        assert!(
            b0.top_agent_spend_usd.unwrap() > 1.0,
            "expensive-agent's 1M/1M gpt-4o tokens should cost multiple dollars"
        );
        assert!(
            b0.spend_usd > b0.top_agent_spend_usd.unwrap(),
            "bucket spend must include BOTH agents, not just the top one"
        );

        let b1 = &buckets[1];
        assert_eq!(b1.operations, 1);
        assert_eq!(b1.top_agent_name.as_deref(), Some("solo-agent"));

        // Buckets must come back sorted ascending by time.
        assert!(buckets[0].bucket_start < buckets[1].bucket_start);
    }

    #[tokio::test]
    async fn spend_timeseries_agent_scoped_uses_the_agent_session_query_not_the_global_one() {
        let mut server = mockito::Server::new_async().await;
        let expected_query = agent_session_model_query("one-agent", None);
        let _search = server
            .mock("GET", "/api/search")
            .match_query(mockito::Matcher::UrlEncoded("q".into(), expected_query))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(search_response_with_n_traces(0).to_string())
            .create_async()
            .await;

        let provider = provider_against(&server.url());
        let now = Utc::now();
        let buckets = provider
            .spend_timeseries(
                Some("one-agent"),
                None,
                now - Duration::hours(1),
                now,
                TimeBucket::Hour,
            )
            .await
            .unwrap();
        assert!(buckets.is_empty(), "no traces in the (empty) search result");
    }

    /// Regression test for a real bug caught only against live infra (a
    /// single-span mock trace can't reproduce it): an orchestrator-routed
    /// trace's FIRST batch/span is the orchestrator's own root dispatch span
    /// (no `gen_ai.usage.*`), with the real agent's token-bearing span
    /// deeper in the tree, in a SEPARATE resource batch. `top_agent` must
    /// resolve to the real agent, not the orchestrator.
    #[tokio::test]
    async fn spend_timeseries_attributes_spend_to_the_token_bearing_span_not_the_trace_root() {
        let mut server = mockito::Server::new_async().await;
        let ts = "1700000000000000000";
        let _search = server
            .mock("GET", "/api/search")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(search_response_with_n_traces(1).to_string())
            .create_async()
            .await;
        let _trace = server
            .mock("GET", mockito::Matcher::Regex(r"^/api/traces/.*$".into()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                serde_json::json!({
                    "batches": [
                        {
                            "resource": {"attributes": [
                                {"key": "service.name", "value": {"stringValue": "nasiko-cp"}},
                            ]},
                            "scopeSpans": [{"spans": [{
                                "spanId": "AAAAAAAAAAE=",
                                "name": "a2a.dispatch",
                                "kind": "SPAN_KIND_SERVER",
                                "startTimeUnixNano": ts,
                                "attributes": [
                                    {"key": "gen_ai.operation.name", "value": {"stringValue": "invoke_agent"}},
                                ],
                            }]}],
                        },
                        {
                            "resource": {"attributes": [
                                {"key": "service.name", "value": {"stringValue": "real-downstream-agent"}},
                            ]},
                            "scopeSpans": [{"spans": [{
                                "spanId": "AAAAAAAAAAI=",
                                "parentSpanId": "AAAAAAAAAAE=",
                                "name": "chat",
                                "kind": "SPAN_KIND_INTERNAL",
                                "startTimeUnixNano": ts,
                                "attributes": [
                                    {"key": "gen_ai.usage.input_tokens", "value": {"intValue": 500}},
                                    {"key": "gen_ai.usage.output_tokens", "value": {"intValue": 200}},
                                    {"key": "gen_ai.request.model", "value": {"stringValue": "gpt-4o-mini"}},
                                ],
                            }]}],
                        },
                    ],
                })
                .to_string(),
            )
            .create_async()
            .await;

        let provider = provider_against(&server.url());
        let start = DateTime::<Utc>::from_timestamp(1_700_000_000 - 60, 0).unwrap();
        let end = start + Duration::hours(2);
        let buckets = provider
            .spend_timeseries(None, None, start, end, TimeBucket::Hour)
            .await
            .unwrap();

        assert_eq!(buckets.len(), 1);
        assert_eq!(
            buckets[0].top_agent_name.as_deref(),
            Some("real-downstream-agent"),
            "must attribute to the token-bearing span's service, not the orchestrator root span"
        );
        assert!(buckets[0].spend_usd > 0.0);
    }

    /// Builds a minimal, valid OTLP JSON `/api/traces/{id}` response body with
    /// one span carrying `service.name` on the resource and GenAI token/model
    /// attributes on the span — enough for `token_totals()`/`extract_token_attrs`
    /// to resolve real numbers, matching the real Tempo wire shape exactly
    /// (verified against `tempo.rs`'s `OtlpTraceResponse`/`OtlpSpan` structs).
    fn otlp_trace_json(
        service_name: &str,
        start_time_unix_nano: &str,
        input_tokens: u64,
        output_tokens: u64,
        model: Option<&str>,
    ) -> serde_json::Value {
        let mut attributes = vec![
            serde_json::json!({"key": "gen_ai.usage.input_tokens", "value": {"intValue": input_tokens}}),
            serde_json::json!({"key": "gen_ai.usage.output_tokens", "value": {"intValue": output_tokens}}),
        ];
        if let Some(m) = model {
            attributes.push(
                serde_json::json!({"key": "gen_ai.request.model", "value": {"stringValue": m}}),
            );
        }
        serde_json::json!({
            "batches": [{
                "resource": {
                    "attributes": [
                        {"key": "service.name", "value": {"stringValue": service_name}},
                    ],
                },
                "scopeSpans": [{
                    "spans": [{
                        "spanId": "AAAAAAAAAAE=",
                        "name": "chat",
                        "kind": "SPAN_KIND_INTERNAL",
                        "startTimeUnixNano": start_time_unix_nano,
                        "attributes": attributes,
                    }],
                }],
            }],
        })
    }
}
