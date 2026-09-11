// Sessions page fixtures.
//
// Timestamps are relative to load, not fixed dates: the list defaults to the
// "Last 7 days" range, and a fixture pinned to a literal date falls out of it
// the week after it is written and previews as an empty page. Computed at
// module scope, which the preview harness evaluates in the page — only
// `scenarios`/`window` functions lose this module's scope.
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

const sessionsData = [
  { session_id: "s-001", title: "DNS resolution in container networking", agent_name: "Coding Agent", agent_id: "a-001", last_message: "Fixed the DNS resolution issue in the container networking layer", message_count: 12, created_at: hoursAgo(3), updated_at: hoursAgo(2), trace_count: 4, total_tokens: 18400, latency_p50_ms: 1240 },
  { session_id: "s-002", title: "Kubernetes operator patterns", agent_name: "Research Agent", agent_id: "a-002", last_message: "Here's the summary of Kubernetes operator patterns and best practices for implementing CRDs", message_count: 8, created_at: hoursAgo(28), updated_at: hoursAgo(26), trace_count: 2, total_tokens: 7200, latency_p50_ms: 890 },
  { session_id: "s-003", title: "API documentation sweep", agent_name: "Docs Agent", agent_id: "a-005", last_message: "Generated API documentation for 12 endpoints including request/response schemas", message_count: 5, created_at: hoursAgo(31), updated_at: hoursAgo(30), trace_count: 0, total_tokens: null, latency_p50_ms: null },
  { session_id: "s-004", title: "CI pipeline build times", agent_name: "DevOps Agent", agent_id: "a-003", last_message: "Optimized the CI pipeline — build time reduced by 40% after parallelizing test stages", message_count: 22, created_at: hoursAgo(56), updated_at: hoursAgo(54), trace_count: 9, total_tokens: 52300, latency_p50_ms: 2150 },
  { session_id: "s-005", title: "Auth flow integration tests", agent_name: "QA Agent", agent_id: "a-004", last_message: "Created 24 integration tests covering the auth flow and token refresh edge cases", message_count: 15, created_at: hoursAgo(98), updated_at: hoursAgo(96), trace_count: 3, total_tokens: 4100, latency_p50_ms: 640 },
  { session_id: "s-006", title: "Routing engine refactor", agent_name: "Coding Agent", agent_id: "a-001", last_message: "Refactored the routing engine to use a trait-based design for better testability", message_count: 31, created_at: hoursAgo(142), updated_at: hoursAgo(140), trace_count: 12, total_tokens: 121000, latency_p50_ms: 3400 },
];

export default {
  fetch: [
    [{ method: "GET", path: /^\/api\/observability\/session\/list/ }, {
      data: {
        sessions: [
          { session_id: "s-001", first_input: "Fix the DNS resolution issue in container networking", num_traces: 4, token_usage: { total: 18400 }, trace_latency_ms_p50: 1240 },
          { session_id: "s-002", first_input: "Summarize Kubernetes operator patterns", num_traces: 2, token_usage: { total: 7200 }, trace_latency_ms_p50: 890 },
          { session_id: "s-004", first_input: "Optimize the CI pipeline build times", num_traces: 9, token_usage: { total: 52300 }, trace_latency_ms_p50: 2150 },
          { session_id: "s-006", first_input: "Refactor the routing engine to a trait-based design", num_traces: 12, token_usage: { total: 121000 }, trace_latency_ms_p50: 3400 },
        ],
      },
    }],
    // Cursor-paginated shape, matching CursorPage from oss/server/src/chat/routes.rs.
    // `next_cursor` is set so the pager's "Load more" state is exercised.
    [{ method: "GET", path: /^\/api\/chat\/sessions/ }, {
      data: sessionsData,
      has_more: true,
      next_cursor: "preview-cursor-page-2",
      prev_cursor: null,
    }],
    [{ method: "DELETE", path: /^\/api\/chat\/sessions\// }, { ok: true }],
  ],
  window: {
    deleteSession: async () => {},
  },
  scenarios: {
    empty: async (page) => {
      await page.evaluate(() => {
        __dataSources.registerAll({ fetchSessions: async () => ({ data: [], total: 0 }) }, { replace: true });
      });
      await page.evaluate(() => {
        document.querySelector("sessions-page").remove();
        const el = document.createElement("sessions-page");
        document.body.appendChild(el);
      });
      await page.waitForSelector("app-empty-state");
    },
  },
};
