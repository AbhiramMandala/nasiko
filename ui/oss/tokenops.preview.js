// TokenOps fixtures, matching `tokensopsapis.md` (the backend handoff):
//   GET /api/observability/finops/dashboard          FinopsDashboardResponse
//   GET /api/observability/finops/spend-timeseries   "Spend over time"
//   GET /api/observability/finops/spend-calendar     month heatmap (no panel yet)
//   GET /api/observability/finops/spend-calendar/day "Spend concentration" drill-down
//   GET /api/observability/finops/attributions       standalone table source (not called yet)
// Every fixture function is self-contained — a preview fixture runs without
// this module's scope, so it may not reach a shared helper.
function qparam(req, name) {
  return new URL(String(req?.url ?? ""), "http://x").searchParams.get(name);
}

const AGENTS = [
  { agent_id: "a-001", agent_name: "DevOps Engineer", total_cost: 1247.83, operations: 3842, avg_cost_per_operation: 0.32, prompt_tokens: 12200000, completion_tokens: 6200000, cache_read_tokens: 4100000, cache_creation_tokens: 900000, total_tokens: 18400000, avg_latency_ms: 2400, version: "v4", container_hours: 128.5, is_capped: false },
  { agent_id: "a-002", agent_name: "Documentation Assistant", total_cost: 892.14, operations: 5217, avg_cost_per_operation: 0.17, prompt_tokens: 5400000, completion_tokens: 8700000, cache_read_tokens: 1200000, cache_creation_tokens: 300000, total_tokens: 14100000, avg_latency_ms: 1800, version: "v2", container_hours: 96.2, is_capped: false },
  // Highest-volume agent — the `is_capped` example: a real but undercounted approximation.
  { agent_id: "a-003", agent_name: "Finance Analyst", total_cost: 2034.56, operations: 2156, avg_cost_per_operation: 0.94, prompt_tokens: 17800000, completion_tokens: 4900000, cache_read_tokens: 6300000, cache_creation_tokens: 1100000, total_tokens: 22700000, avg_latency_ms: 4100, version: "v7", container_hours: 214.7, is_capped: true },
  { agent_id: "a-004", agent_name: "HR Assistant", total_cost: 436.29, operations: 6489, avg_cost_per_operation: 0.07, prompt_tokens: 4200000, completion_tokens: 3100000, cache_read_tokens: 800000, cache_creation_tokens: 200000, total_tokens: 7300000, avg_latency_ms: 1200, version: "v3", container_hours: 52.8, is_capped: false },
  { agent_id: "a-005", agent_name: "Research Agent", total_cost: 318.40, operations: 1204, avg_cost_per_operation: 0.26, prompt_tokens: 2900000, completion_tokens: 1400000, cache_read_tokens: 400000, cache_creation_tokens: 90000, total_tokens: 4300000, avg_latency_ms: 3100, version: "v1", container_hours: 41.3, is_capped: false },
  { agent_id: "a-006", agent_name: "QA Agent", total_cost: 96.12, operations: 482, avg_cost_per_operation: 0.20, prompt_tokens: 900000, completion_tokens: 400000, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 1300000, avg_latency_ms: 890, version: "v2", container_hours: 18.9, is_capped: false },
];

const WORKFLOWS = [
  { workflow_id: "wf-101", workflow_name: "Agent onboarding pipeline", total_cost: 612.40, total_tokens: 5100000, operations: 812, avg_latency_ms: 2100 },
  { workflow_id: "wf-102", workflow_name: "Social media content pipeline", total_cost: 1988.10, total_tokens: 16800000, operations: 4310, avg_latency_ms: 1650 },
  { workflow_id: "wf-103", workflow_name: "Weekly finance rollup", total_cost: 892.77, total_tokens: 6900000, operations: 340, avg_latency_ms: 3900 },
];

function pctChange(current, previous) {
  if (previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export default {
  fetch: [
    [{ method: "GET", path: /^\/api\/observability\/finops\/dashboard/ }, (req) => {
      const view = qparam(req, "view") === "workflow" ? "workflow" : "agent";
      const rows = view === "workflow" ? WORKFLOWS : AGENTS;

      const totalCost = AGENTS.reduce((s, a) => s + a.total_cost, 0);
      const totalTokens = AGENTS.reduce((s, a) => s + a.total_tokens, 0);
      const totalOps = AGENTS.reduce((s, a) => s + a.operations, 0);
      const avgLatency = Math.round(
        AGENTS.reduce((s, a) => s + a.avg_latency_ms * a.operations, 0) / totalOps);
      const costPerOp = Math.round((totalCost / totalOps) * 1000) / 1000;

      // A modest prior-window baseline so every chip but one has direction —
      // `total_tokens.change_pct: null` demonstrates the "—" (no comparable
      // baseline) rendering the doc calls out explicitly.
      const prevCost = totalCost * 0.92;
      const prevLatency = avgLatency * 1.06;
      const prevCostPerOp = costPerOp * 0.95;

      return {
        data: {
          kpis: {
            total_spend: { current: totalCost, previous: prevCost, change_pct: pctChange(totalCost, prevCost) },
            total_tokens: { current: totalTokens, previous: null, change_pct: null },
            cost_per_operation: { current: costPerOp, previous: prevCostPerOp, change_pct: pctChange(costPerOp, prevCostPerOp) },
            avg_latency_ms: { current: avgLatency, previous: prevLatency, change_pct: pctChange(avgLatency, prevLatency) },
          },
          summary: {
            total_cost: Math.round(totalCost * 100) / 100,
            total_operations: totalOps,
            operations_last_24h: 842,
            average_cost: costPerOp,
            active_agents: 5,
            total_agents: AGENTS.length,
            total_container_hours: Math.round(AGENTS.reduce((s, a) => s + a.container_hours, 0) * 10) / 10,
          },
          agents: AGENTS,
          attributions: { view, rows },
        },
        status_code: 200,
        message: "FinOps dashboard retrieved successfully",
      };
    }],

    // "Spend over time" — one point per day of a 31-day look-back, two
    // deliberate spikes so the plot has a visible shape (no anomaly styling
    // any more; the backend has no anomaly service — see doc point 7).
    [{ method: "GET", path: /^\/api\/observability\/finops\/spend-timeseries/ }, () => {
      const days = 31;
      const spikes = new Set([13, 27]);
      const points = Array.from({ length: days }, (_, i) => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - (days - 1 - i));
        const base = 280 + Math.round(Math.sin(i / 3) * 60) + i * 2;
        const spend = spikes.has(d.getDate()) ? base * 1.6 : base;
        return {
          bucket_start: d.toISOString(),
          spend_usd: Math.round(spend * 100) / 100,
          operations: Math.round(420 + Math.cos(i / 4) * 180 + i * 6),
          top_agent_name: AGENTS[i % AGENTS.length].agent_name,
          top_agent_spend_usd: Math.round(spend * 0.4 * 100) / 100,
        };
      });
      return { data: { bucket: "day", points }, status_code: 200, message: "ok" };
    }],

    // Click-a-day hourly drill-down — powers "Spend concentration".
    // Real /finops/spend-calendar/day payloads (confirmed against a live
    // capture) put `top_agents`/`others_spend_usd` on EVERY hour, not just
    // once for the whole day — a per-hour ranking, not only a per-day one.
    // tokenops-page.js only reads the day-level fields today (`day.top_agents`
    // / `day.others_spend_usd`), so this fixture carries the per-hour ones
    // for contract accuracy without the UI consuming them yet.
    [{ method: "GET", path: /^\/api\/observability\/finops\/spend-calendar\/day/ }, (req) => {
      const dateStr = qparam(req, "date") || new Date().toISOString().slice(0, 10);
      const curve = [1, 1, 1, 1, 1, 2, 4, 8, 12, 14, 13, 11, 12, 13, 12, 10, 8, 7, 5, 3, 3, 3, 2, 2];
      const weight = curve.reduce((a, b) => a + b, 0);
      // A different day totals a bit differently, so the picker visibly changes something.
      const daySeed = new Date(dateStr).getDate() || 1;
      const dayTotal = 280 + (daySeed % 7) * 35;
      const rankedAgents = [...AGENTS].sort((a, b) => b.total_cost - a.total_cost);
      const top4 = rankedAgents.slice(0, 4);
      const others = rankedAgents.slice(4);
      // Scale the real window totals down to a single day's share so the
      // legend and the hourly curve are in the same ballpark.
      const scale = dayTotal / top4.reduce((s, a) => s + a.total_cost, 0);
      const dayTopAgents = top4.map((a) => ({ agent_name: a.agent_name, spend_usd: a.total_cost * scale }));
      const dayOthers = others.reduce((s, a) => s + a.total_cost, 0) * scale;
      const hours = curve.map((w, hour) => {
        const hourSpend = Math.round((dayTotal * w) / weight * 100) / 100;
        // This hour's share of the day (curve weight / total weight) applied
        // to the day-level agent split — same proportions, scaled down to
        // one hour, matching how the real endpoint's per-hour figures track
        // its own day-level ones.
        const hourFraction = w / weight;
        const hourTopAgents = dayTopAgents
          .map((a) => ({ agent_name: a.agent_name, spend_usd: Math.round(a.spend_usd * hourFraction * 100) / 100 }))
          .filter((a) => a.spend_usd > 0);
        const hourOthers = Math.round(dayOthers * hourFraction * 100) / 100;
        return { hour, spend_usd: hourSpend, top_agents: hourTopAgents, others_spend_usd: hourOthers };
      });
      return {
        data: {
          date: dateStr,
          hours,
          avg_hourly_spend_usd: Math.round((dayTotal / 24) * 100) / 100,
          top_agents: top4.map((a) => ({ agent_name: a.agent_name, spend_usd: Math.round(a.total_cost * scale * 100) / 100 })),
          others_spend_usd: Math.round(others.reduce((s, a) => s + a.total_cost, 0) * scale * 100) / 100,
        },
        status_code: 200,
        message: "ok",
      };
    }],

    // Month heatmap — no panel calls this yet (see tokenops-page.js header
    // note), fixture kept in step with the other four so the contract does
    // not drift before that UI exists.
    [{ method: "GET", path: /^\/api\/observability\/finops\/spend-calendar(?!\/day)/ }, (req) => {
      const month = qparam(req, "month") || new Date().toISOString().slice(0, 7);
      const [y, m] = month.split("-").map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const days = Array.from({ length: daysInMonth }, (_, i) => {
        const spend = 200 + Math.round(Math.sin(i / 4) * 120);
        return {
          date: `${month}-${String(i + 1).padStart(2, "0")}`,
          spend_usd: spend,
          operations: Math.round(spend * 3.4),
          intensity: 0,
        };
      });
      const max = Math.max(...days.map((d) => d.spend_usd));
      days.forEach((d) => { d.intensity = Math.round((d.spend_usd / max) * 100) / 100; });
      return { data: { days, highlighted_dates: [] }, status_code: 200, message: "ok" };
    }],

    [{ method: "GET", path: /^\/api\/observability\/finops\/attributions/ }, (req) => {
      const view = qparam(req, "view") === "workflow" ? "workflow" : "agent";
      return { data: { view, rows: view === "workflow" ? WORKFLOWS : AGENTS }, status_code: 200, message: "ok" };
    }],
  ],
};
