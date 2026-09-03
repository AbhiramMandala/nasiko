// TokenOps fixtures. Two endpoints back the page:
//   GET /api/observability/finops/dashboard    FinopsDashboardResponse
//   GET /api/usage/history                     Vec<DailyUsage>
// (The hourly agent-hours fixture went with the stacked plot it fed — the
// panels now reserve an empty plot box.)
// (oss/server/src/observability/service.rs and oss/server/src/usage/routes.rs;
// see /api/docs.) Every fixture function is self-contained — a preview fixture
// runs without this module's scope, so it may not reach a shared helper.
export default {
  fetch: [
    [{ method: "GET", path: /^\/api\/observability\/finops\/dashboard/ }, (req) => {
      // The page fetches this twice per load: the window, then the window
      // immediately before it, which is the baseline behind the delta chips.
      // Anything starting more than ~45 days ago is that baseline on the
      // default 30-day range, and gets scaled-down numbers so the chips move.
      const start = new URL(String(req?.url ?? ""), "http://x").searchParams.get("start_time");
      const baseline = start ? Date.parse(start) < Date.now() - 45 * 86400000 : false;
      const k = baseline ? 0.92 : 1;
      const agents = [
        { agent_id: "a-001", agent_name: "DevOps Engineer", total_cost: 1247.83, operations: 3842, avg_cost_per_operation: 0.32, prompt_tokens: 12200000, completion_tokens: 6200000, cache_read_tokens: 4100000, cache_creation_tokens: 900000, total_tokens: 18400000, avg_latency_ms: 2400, version: "v4", container_hours: 128.5 },
        { agent_id: "a-002", agent_name: "Documentation Assistant", total_cost: 892.14, operations: 5217, avg_cost_per_operation: 0.17, prompt_tokens: 5400000, completion_tokens: 8700000, cache_read_tokens: 1200000, cache_creation_tokens: 300000, total_tokens: 14100000, avg_latency_ms: 1800, version: "v2", container_hours: 96.2 },
        { agent_id: "a-003", agent_name: "Finance Analyst", total_cost: 2034.56, operations: 2156, avg_cost_per_operation: 0.94, prompt_tokens: 17800000, completion_tokens: 4900000, cache_read_tokens: 6300000, cache_creation_tokens: 1100000, total_tokens: 22700000, avg_latency_ms: 4100, version: "v7", container_hours: 214.7 },
        { agent_id: "a-004", agent_name: "HR Assistant", total_cost: 436.29, operations: 6489, avg_cost_per_operation: 0.07, prompt_tokens: 4200000, completion_tokens: 3100000, cache_read_tokens: 800000, cache_creation_tokens: 200000, total_tokens: 7300000, avg_latency_ms: 1200, version: "v3", container_hours: 52.8 },
        { agent_id: "a-005", agent_name: "Research Agent", total_cost: 318.40, operations: 1204, avg_cost_per_operation: 0.26, prompt_tokens: 2900000, completion_tokens: 1400000, cache_read_tokens: 400000, cache_creation_tokens: 90000, total_tokens: 4300000, avg_latency_ms: 3100, version: "v1", container_hours: 41.3 },
        { agent_id: "a-006", agent_name: "QA Agent", total_cost: 96.12, operations: 482, avg_cost_per_operation: 0.20, prompt_tokens: 900000, completion_tokens: 400000, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 1300000, avg_latency_ms: 890, version: "v2", container_hours: 18.9 },
      ].map((a) => (k === 1 ? a : {
        ...a,
        total_cost: Math.round(a.total_cost * k * 100) / 100,
        operations: Math.round(a.operations * k),
        total_tokens: Math.round(a.total_tokens * k),
        prompt_tokens: Math.round(a.prompt_tokens * k),
        completion_tokens: Math.round(a.completion_tokens * k),
        avg_latency_ms: Math.round(a.avg_latency_ms * 1.06),
      }));
      return {
        data: {
          summary: {
            total_cost: Math.round(46210 * k),
            total_operations: Math.round(19390 * k),
            operations_last_24h: Math.round(842 * k),
            average_cost: baseline ? 2.51 : 2.383,
            active_agents: 5,
            total_agents: 6,
            total_container_hours: Math.round(552.4 * k * 10) / 10,
          },
          agents,
          token_usage: {
            total_tokens: Math.round(1230000000 * k),
            prompt_tokens: Math.round(806000000 * k),
            completion_tokens: Math.round(424000000 * k),
            cache_read_tokens: Math.round(129000000 * k),
            cache_creation_tokens: Math.round(25900000 * k),
            avg_tokens_per_operation: 63450,
          },
        },
        status_code: 200,
        message: "FinOps dashboard retrieved successfully",
      };
    }],

    // Per-day series for "Spend over time". Generated relative to today so the
    // rows always land inside whatever window the page has selected, with two
    // deliberate spikes so the >2σ anomaly caption has something to report.
    [{ method: "GET", path: /^\/api\/usage\/history/ }, () => {
      const days = 31;
      const spikes = new Set([13, 27]);
      return Array.from({ length: days }, (_, i) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - (days - 1 - i));
        const base = 280 + Math.round(Math.sin(i / 3) * 60) + i * 2;
        const cost = spikes.has(d.getDate()) ? base * 1.6 : base;
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return {
          date: iso,
          // Its own shape, not a multiple of cost — the two normalised series
          // would otherwise sit exactly on top of each other in the % view.
          request_count: Math.round(420 + Math.cos(i / 4) * 180 + i * 6),
          total_tokens: Math.round(cost * 12000),
          total_cost_usd: Math.round(cost * 100) / 100,
        };
      });
    }],
  ],
};
