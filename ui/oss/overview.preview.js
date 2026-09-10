// Overview fixtures. The page reads only endpoints that already exist:
//   GET /api/observability/finops/dashboard          KPI strip · attributions
//   GET /api/observability/finops/spend-timeseries   agent activity · performance · spend
//   GET /api/llm-router/providers                    Provider dropdown
//   GET /api/org/units                               Org unit dropdown (EE)
//
// Every fixture function is self-contained. The preview tool `toString()`s each
// one and eval()s it in the page, so a function CANNOT reach a const declared
// at this module's top level — inline the data or it throws at run time.
//
// Two states, selected by the page URL so both are reachable without a second
// fixture file (see `scenarios` at the bottom):
//   /overview.html            populated fleet
//   /overview.html?empty=1    first run — total_agents: 0

export default {
  fetch: [
    [{ method: "GET", path: /^\/api\/observability\/finops\/dashboard/ }, () => {
      const empty = new URLSearchParams(globalThis.location.search).has("empty");
      const agents = empty ? [] : [
        { agent_id: "a-001", agent_name: "DevOps Engineer", total_cost: 1247.83, operations: 3842, avg_cost_per_operation: 0.32, prompt_tokens: 12200000, completion_tokens: 6200000, cache_read_tokens: 4100000, cache_creation_tokens: 900000, total_tokens: 18400000, avg_latency_ms: 2400, avg_latency_p95_ms: 5900, avg_latency_p99_ms: 9100, tool_call_count: 8420, version: "v4", container_hours: 128.5, is_capped: false },
        { agent_id: "a-002", agent_name: "Documentation Assistant", total_cost: 892.14, operations: 5217, avg_cost_per_operation: 0.17, prompt_tokens: 5400000, completion_tokens: 8700000, cache_read_tokens: 1200000, cache_creation_tokens: 300000, total_tokens: 14100000, avg_latency_ms: 1800, avg_latency_p95_ms: 4200, avg_latency_p99_ms: 6800, tool_call_count: 2110, version: "v2", container_hours: 96.2, is_capped: false },
        { agent_id: "a-003", agent_name: "Finance Analyst", total_cost: 2034.56, operations: 2156, avg_cost_per_operation: 0.94, prompt_tokens: 17800000, completion_tokens: 4900000, cache_read_tokens: 6300000, cache_creation_tokens: 1100000, total_tokens: 22700000, avg_latency_ms: 4100, avg_latency_p95_ms: 11200, avg_latency_p99_ms: 18400, tool_call_count: 6304, version: "v7", container_hours: 214.7, is_capped: true },
        { agent_id: "a-004", agent_name: "HR Assistant", total_cost: 436.29, operations: 6489, avg_cost_per_operation: 0.07, prompt_tokens: 4200000, completion_tokens: 3100000, cache_read_tokens: 800000, cache_creation_tokens: 200000, total_tokens: 7300000, avg_latency_ms: 1200, avg_latency_p95_ms: 2600, avg_latency_p99_ms: 3900, tool_call_count: 980, version: "v3", container_hours: 52.8, is_capped: false },
        { agent_id: "a-005", agent_name: "Research Agent", total_cost: 318.40, operations: 1204, avg_cost_per_operation: 0.26, prompt_tokens: 2900000, completion_tokens: 1400000, cache_read_tokens: 400000, cache_creation_tokens: 90000, total_tokens: 4300000, avg_latency_ms: 3100, avg_latency_p95_ms: 7400, avg_latency_p99_ms: 12100, tool_call_count: 3402, version: "v1", container_hours: 41.3, is_capped: false },
        { agent_id: "a-006", agent_name: "QA Agent", total_cost: 96.12, operations: 482, avg_cost_per_operation: 0.20, prompt_tokens: 900000, completion_tokens: 400000, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 1300000, avg_latency_ms: 890, avg_latency_p95_ms: 1900, avg_latency_p99_ms: 2700, tool_call_count: 0, version: "v2", container_hours: 18.9, is_capped: false },
        // No latency recorded at all — dropped from the ranking rather than
        // sorted to the top of a "slowest" list at zero.
        { agent_id: "a-007", agent_name: "Idle Agent", total_cost: 0, operations: 0, avg_cost_per_operation: 0, prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, avg_latency_ms: null, avg_latency_p95_ms: null, avg_latency_p99_ms: null, tool_call_count: 0, version: "v1", container_hours: 0, is_capped: false },
      ];

      const totalCost = agents.reduce((s, a) => s + a.total_cost, 0);
      const totalTokens = agents.reduce((s, a) => s + a.total_tokens, 0);
      const totalOps = agents.reduce((s, a) => s + a.operations, 0);
      const rated = agents.filter((a) => a.avg_latency_ms != null);
      const avgLatency = rated.length
        ? Math.round(rated.reduce((s, a) => s + a.avg_latency_ms * a.operations, 0)
          / Math.max(rated.reduce((s, a) => s + a.operations, 0), 1))
        : 0;
      const costPerOp = totalOps ? Math.round((totalCost / totalOps) * 1000) / 1000 : 0;
      const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
      const kv = (cur, prev) => ({ current: cur, previous: prev, change_pct: pct(cur, prev) });
      const activeAgents = agents.filter((a) => a.operations > 0).length;
      const totalToolCalls = agents.reduce((s, a) => s + a.tool_call_count, 0);
      const p95 = rated.length ? Math.round(rated.reduce((s, a) => s + a.avg_latency_p95_ms, 0) / rated.length) : 0;
      const p99 = rated.length ? Math.round(rated.reduce((s, a) => s + a.avg_latency_p99_ms, 0) / rated.length) : 0;
      // Top-5 by spend + an "Others" catchall — the server's own shape
      // (`SpendByAgentBreakdown`), pre-computed so no client aggregates it.
      const bySpend = [...agents].sort((a, b) => b.total_cost - a.total_cost);
      const slicePct = (v) => (totalCost ? Math.round((v / totalCost) * 10000) / 100 : 0);
      const others = bySpend.slice(5).reduce((s, a) => s + a.total_cost, 0);

      return {
        data: {
          kpis: {
            total_spend: { current: totalCost, previous: totalCost * 0.92, change_pct: pct(totalCost, totalCost * 0.92) },
            // `null` demonstrates the "no comparable baseline" em-dash chip.
            total_tokens: { current: totalTokens, previous: 0, change_pct: null },
            cost_per_operation: { current: costPerOp, previous: costPerOp * 0.95, change_pct: pct(costPerOp, costPerOp * 0.95) },
            avg_latency_ms: { current: avgLatency, previous: avgLatency * 1.06, change_pct: pct(avgLatency, avgLatency * 1.06) },
            // No baseline server-side: headcount, not a window measure.
            total_agents: kv(agents.length, 0),
            active_agents: kv(activeAgents, Math.max(activeAgents - 1, 0)),
            total_operations: kv(totalOps, Math.round(totalOps * 0.88)),
            total_tool_calls: kv(totalToolCalls, Math.round(totalToolCalls * 1.04)),
            latency_p95_ms: kv(p95, Math.round(p95 * 1.12)),
            latency_p99_ms: kv(p99, Math.round(p99 * 0.97)),
          },
          summary: {
            total_cost: totalCost,
            total_operations: totalOps,
            operations_last_24h: Math.round(totalOps * 0.08),
            average_cost: costPerOp,
            active_agents: activeAgents,
            total_agents: agents.length,
            total_container_hours: agents.reduce((s, a) => s + a.container_hours, 0),
          },
          agents,
          token_usage: {
            total_tokens: totalTokens,
            prompt_tokens: agents.reduce((s, a) => s + a.prompt_tokens, 0),
            completion_tokens: agents.reduce((s, a) => s + a.completion_tokens, 0),
            cache_read_tokens: agents.reduce((s, a) => s + a.cache_read_tokens, 0),
            cache_creation_tokens: agents.reduce((s, a) => s + a.cache_creation_tokens, 0),
            avg_tokens_per_operation: totalOps ? Math.round(totalTokens / totalOps) : 0,
          },
          attributions: { view: "agent", rows: agents, total: agents.length },
          spend_by_agent: {
            slices: [
              ...bySpend.slice(0, 5).map((a) => ({
                agent_name: a.agent_name, spend_usd: a.total_cost, pct: slicePct(a.total_cost),
              })),
              ...(others > 0 ? [{ agent_name: "Others", spend_usd: others, pct: slicePct(others) }] : []),
            ],
            total_spend_usd: totalCost,
          },
        },
        status_code: 200,
        message: "ok",
      };
    }],

    [{ method: "GET", path: /^\/api\/observability\/finops\/spend-timeseries/ }, () => {
      const empty = new URLSearchParams(globalThis.location.search).has("empty");
      if (empty) return { data: { bucket: "day", points: [] }, status_code: 200, message: "ok" };
      // 30 daily buckets ending today. Deterministic (a sine, not a random) so
      // two screenshots of the same page diff to nothing.
      const now = new Date();
      const points = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(now.getTime() - (29 - i) * 86400000);
        const wave = Math.sin(i / 3.1) * 0.35 + Math.sin(i / 7.7) * 0.2;
        const ops = Math.round(2600 + wave * 1400);
        // Latency is anti-correlated with load here (a busy fleet is a slow
        // one), so the two panels are visibly telling different stories rather
        // than the same wave twice.
        const p50 = Math.round(1600 + wave * 700);
        return {
          bucket_start: d.toISOString(),
          spend_usd: Math.round((150 + wave * 90) * 100) / 100,
          operations: ops,
          tool_calls: Math.round(ops * (0.55 + wave * 0.12)),
          top_agent_name: "Finance Analyst",
          top_agent_spend_usd: Math.round((60 + wave * 30) * 100) / 100,
          // One gap in the middle of the window: the line breaks there rather
          // than diving to zero.
          p50_latency_ms: i === 14 ? null : p50,
          p95_latency_ms: i === 14 ? null : Math.round(p50 * 2.4),
          p99_latency_ms: i === 14 ? null : Math.round(p50 * 4.1),
        };
      });
      return { data: { bucket: "day", points }, status_code: 200, message: "ok" };
    }],

    // Provider dropdown — same shape as llm-router.preview.js's fixture.
    ["GET /api/llm-router/providers", {
      data: [
        { provider: "anthropic", models: [{ model: "claude-opus-4-1" }, { model: "claude-sonnet-4-5" }] },
        { provider: "openai", models: [{ model: "gpt-5.2" }, { model: "gpt-4o" }] },
        { provider: "gemini", models: [{ model: "gemini-2.5-pro" }] },
      ],
      status_code: 200,
      message: "ok",
    }],

    // Flat `GET /api/org/units` — rows arrive in `path` order, `depth` 1 = root.
    ["GET /api/org/units", {
      data: [
        { id: "ou-1", parent_id: null, name: "Nasiko Max", depth: 1, member_count: 84 },
        { id: "ou-2", parent_id: "ou-1", name: "Engineering", depth: 2, member_count: 34 },
        { id: "ou-3", parent_id: "ou-1", name: "Finance", depth: 2, member_count: 12 },
      ],
      status_code: 200,
      message: "ok",
    }],
  ],

  scenarios: {
    // First-run screen: the hero, the inert filters and the two panels holding
    // their "what will appear here" copy.
    empty: async (page) => {
      await page.goto(`${page.url().split("?")[0]}?empty=1`);
      await page.waitForSelector("overview-page .hero:not([hidden])");
    },
  },
};
