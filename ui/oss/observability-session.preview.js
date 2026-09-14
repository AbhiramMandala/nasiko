// Session detail fixtures — session/{id}, trace/{id}, span/{t}/{s}, chat transcript
// (shapes from oss/server/src/observability/service.rs + chat/models.rs; see /api/docs).

const SESSION_ID = "ses_18a5801d3353463ca39ebc216887f385";
const TRACE_ID = "8a880df26caf4c12a0e2d5f898f49420";
const ZERO_TRACE_ID = "00000000000000000000000000000000";

// Re-load the page with ?session_id=… when the harness opened it bare.
const withSession = async (page) => {
  if (page.url().includes("session_id=")) return;
  const u = new URL(page.url());
  u.searchParams.set("session_id", SESSION_ID);
  await page.goto(u.toString());
  await page.waitForSelector(".pane-title");
  await page.waitForTimeout(300);
};

const mkSpan = (spanId, name, kind, latency, tokens, model, children = []) => ({
  id: btoa(spanId),
  span_id: spanId,
  name,
  span_kind: kind,
  status_code: "OK",
  start_time: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  end_time: new Date(Date.now() - 40 * 60 * 1000 + latency).toISOString(),
  parent_id: null,
  latency_ms: latency,
  token_count_total: tokens,
  input_tokens: Math.round(tokens * 0.7),
  output_tokens: Math.round(tokens * 0.3),
  model,
  // The greyed subtitle and the provider behind the row glyph. Both are null
  // on spans whose attributes name neither — the UI draws nothing then.
  operation: model ? "chat" : "agent.execute",
  provider: model ? "openai" : null,
  span_annotation_summaries: [],
  children,
});

const spanTree = mkSpan("span-root", "a2a.execute", "agent", 15620, 6705, null, [
  mkSpan("span-cc1", "ChatCompletion", "internal", 2110, 1411, "gpt-4o"),
  mkSpan("span-cc2", "ChatCompletion", "internal", 4320, 2350, "gpt-4o"),
  mkSpan("span-cc3", "ChatCompletion", "internal", 6950, 2944, "gpt-4o"),
]);

const spanDetail = (spanId, name) => ({
  data: {
    span: {
      id: btoa(spanId),
      span_id: spanId,
      trace: { id: btoa(TRACE_ID), trace_id: TRACE_ID },
      name,
      span_kind: name === "a2a.execute" ? "agent" : "internal",
      status_code: "OK",
      code: "OK",
      status_message: "",
      start_time: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() - 40 * 60 * 1000 + 2111).toISOString(),
      parent_id: name === "a2a.execute" ? null : btoa("span-root"),
      latency_ms: 2111,
      token_count_total: 1411,
      provider: "openai",
      model: "gpt-4o-2024-08-06",
      cache_read_tokens: 384,
      cache_creation_tokens: 0,
      cost_summary: {
        total: { cost: 0.0004, tokens: 1411 },
        prompt: { cost: 0.0002, tokens: 987 },
        completion: { cost: 0.0002, tokens: 424 },
      },
      // The real wire shape, verified against the span-detail endpoint on a live
      // deployment (cp.nasiko.dev, 2026-08-10): the server resolves the message
      // content into `input.value`/`output.value` (a JSON *string* in the GenAI
      // semconv `parts[]` form), and `attributes` is RE-NESTED from the dotted
      // OTLP keys by unflatten_attrs (oss/server/src/observability/service.rs) —
      // `attributes.gen_ai.input.messages`, never a flat
      // `attributes["gen_ai.input.messages"]`. Two prior fixture shapes (nested
      // `llm.input_messages` arrays, then flat dotted keys) each matched a UI
      // build that worked in preview and broke against production. Keep this
      // mirroring the endpoint, not the UI.
      input: {
        value: JSON.stringify([
          { role: "system", parts: [{ type: "text", content: "You are the Nasiko orchestrator. Route user queries to the best agent." }] },
          { role: "user", parts: [{ type: "text", content: "Hello, what can you do?" }] },
        ]),
        mime_type: "json",
      },
      output: {
        value: JSON.stringify([
          {
            role: "assistant",
            parts: [
              { type: "text", content: "Hello! I'm an orchestrator that can help you with a variety of tasks by delegating to specialized agents:\n\n- Route coding questions to the coding agent\n- Answer research questions via the research agent\n- Manage deployments through the devops agent" },
            ],
          },
        ]),
        mime_type: "json",
      },
      attributes: {
        gen_ai: {
          operation: { name: "chat" },
          request: { model: "gpt-4o" },
          usage: { input_tokens: "987", output_tokens: "424" },
          input: {
            messages: JSON.stringify([
              { role: "system", parts: [{ type: "text", content: "You are the Nasiko orchestrator. Route user queries to the best agent." }] },
              { role: "user", parts: [{ type: "text", content: "Hello, what can you do?" }] },
            ]),
          },
          output: {
            messages: JSON.stringify([
              {
                role: "assistant",
                parts: [
                  { type: "text", content: "Hello! I'm an orchestrator that can help you with a variety of tasks by delegating to specialized agents:\n\n- Route coding questions to the coding agent\n- Answer research questions via the research agent\n- Manage deployments through the devops agent" },
                ],
              },
            ]),
          },
        },
      },
      events: [
        {
          name: "gen_ai.content.prompt",
          timestamp: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
          attributes: { "gen_ai.prompt": "Hello, what can you do?" },
        },
      ],
      span_annotations: [],
      span_annotation_summaries: [],
      document_retrieval_metrics: [],
      document_evaluations: [],
      project: { id: "orchestrator", annotation_configs: [] },
    },
  },
});

export default {
  fetch: [
    [{ method: "GET", path: /^\/api\/observability\/session\/ses_/ }, {
      data: {
        session: {
          id: btoa(SESSION_ID),
          session_id: SESSION_ID,
          title: "Orchestrator capabilities",
          agent_name: "admin-claude-code",
          // Two: the fixture's second trace carries no message of its own and
          // folds into the turn before it.
          num_traces: 2,
          token_usage: { total: 6705 },
          cost_summary: {
            total: { cost: 0.001, tokens: 6705 },
            prompt: { cost: 0.0007, tokens: 5480 },
            completion: { cost: 0.0003, tokens: 1225 },
          },
          latency_p50: 15620,
          latency_p99: 15620,
          latency_avg: 15620,
          cache_read_tokens: 1024,
          cache_creation_tokens: 0,
          metrics_complete: true,
          traces: [{
            id: btoa(TRACE_ID),
            trace_id: TRACE_ID,
            cursor: "c1",
            root_span: {
              id: btoa("span-root"),
              span_id: "span-root",
              attributes: "{}",
              cumulative_token_count_total: 6705,
              input_tokens: 5480,
              output_tokens: 1225,
              cache_read_tokens: 1024,
              cache_creation_tokens: 0,
              latency_ms: 15620,
              start_time: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
              span_annotations: [],
              span_annotation_summaries: [],
              project: { id: "orchestrator" },
              input: { value: "Hello, what can you do?", mime_type: "text/plain" },
              output: { value: "Hello! I'm an orchestrator...", mime_type: "text/plain" },
              trace: { id: btoa(TRACE_ID), cost_summary: { total: { cost: 0.0004 } } },
            },
          }, {
            id: btoa(ZERO_TRACE_ID),
            trace_id: ZERO_TRACE_ID,
            cursor: "c2",
            root_span: {
              id: btoa("span-zero"),
              span_id: "span-zero",
              cumulative_token_count_total: 0,
              latency_ms: 0,
              trace: { id: btoa(ZERO_TRACE_ID), cost_summary: { total: { cost: 0 } } },
            },
          }],
          pagination: { end_cursor: null, has_next_page: false },
        },
      },
    }],
    [{ method: "GET", path: /^\/api\/observability\/trace\// }, {
      data: {
        trace: {
          id: btoa(TRACE_ID),
          project_session_id: SESSION_ID,
          num_spans: 4,
          latency_ms: 15620,
          cost_summary: { total: { cost: 0.001 }, prompt: { cost: 0.0007 }, completion: { cost: 0.0003 } },
          root_spans: { edges: [{ span: { id: btoa("span-root"), span_id: "span-root", parent_id: null, status_code: "OK" } }] },
          spans: [spanTree],
          span_lookup: {},
        },
      },
    }],
    [{ method: "GET", path: /^\/api\/observability\/span\/[^/]+\/span-root$/ }, spanDetail("span-root", "a2a.execute")],
    // One static entry per span: function fixtures are serialized into the
    // page and lose module-scope closures (spanDetail would be undefined).
    [{ method: "GET", path: /^\/api\/observability\/span\/[^/]+\/span-cc1$/ }, spanDetail("span-cc1", "ChatCompletion")],
    [{ method: "GET", path: /^\/api\/observability\/span\/[^/]+\/span-cc2$/ }, spanDetail("span-cc2", "ChatCompletion")],
    [{ method: "GET", path: /^\/api\/observability\/span\/[^/]+\/span-cc3$/ }, spanDetail("span-cc3", "ChatCompletion")],
    // The Observability module nav lists recent sessions, which is the plain
    // list endpoint — distinct from the transcript route below, which is what
    // fetchChatSession actually calls (…/{id}/messages). Without this the nav
    // renders without its group.
    [{ method: "GET", path: /^\/api\/chat\/sessions\?/ }, {
      data: [
        { session_id: SESSION_ID, title: "Orchestrator capabilities", agent_id: null, agent_name: null, updated_at: new Date(Date.now() - 40 * 60 * 1000).toISOString() },
        { session_id: "ses_deploy_rollback", title: "Deploy rollback procedure", agent_id: null, agent_name: null, updated_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() },
        { session_id: "ses_dns_networking", title: "DNS resolution in container networking", agent_id: null, agent_name: null, updated_at: new Date(Date.now() - 26 * 3600 * 1000).toISOString() },
      ],
      has_more: false,
      next_cursor: null,
    }],
    [{ method: "GET", path: /^\/api\/chat\/sessions\/ses_.*\/messages/ }, {
      data: [
        // `trace_id` on the assistant row is what ties this turn's text to its
        // spans — the turn strip joins on it. Without one the page falls back
        // to the root span's input/output value, which is the BYO-key path.
        { id: "m1", session_id: SESSION_ID, role: "user", content: "Hello, what can you do?", has_file_parts: false, timestamp: new Date(Date.now() - 40 * 60 * 1000).toISOString() },
        { id: "m2", session_id: SESSION_ID, role: "assistant", content: "Hello! I'm an orchestrator that can help you with a variety of tasks by delegating to specialized agents. Here's what I can do:", has_file_parts: false, timestamp: new Date(Date.now() - 39 * 60 * 1000).toISOString(), trace_id: TRACE_ID, input_tokens: 5480, output_tokens: 1225, model: "gpt-4o", duration_ms: 15620, metadata: { coding_agent: { capture_policy: "content", tool_calls: [{ id: "tool-1", name: "list_agents", kind: "tool", status: "succeeded", duration_ms: 24 }] } } },
        { id: "m3", session_id: SESSION_ID, role: "user", content: "Synthetic no-op turn", has_file_parts: false, timestamp: new Date(Date.now() - 38 * 60 * 1000).toISOString() },
        { id: "m4", session_id: SESSION_ID, role: "assistant", content: "No model call was required for this turn.", trace_id: ZERO_TRACE_ID, has_file_parts: false, timestamp: new Date(Date.now() - 38 * 60 * 1000).toISOString() },
      ],
      has_more: false,
      next_cursor: null,
      prev_cursor: "m1",
    }],
  ],
  scenarios: {
    // The page reads session_id from the query; the harness loads the bare
    // URL (and never runs a scenario literally named "default"), so the
    // populated state is captured via this named scenario and every other
    // scenario first navigates with the id.
    "with-session": async (page) => { await withSession(page); },
    // The turn strip walks the session's traces; the picker jumps between them.
    "turn-picker": async (page) => {
      await withSession(page);
      await page.waitForSelector("#turn-menu .aam-trigger");
      await page.click("#turn-menu .aam-trigger");
      await page.waitForSelector("#turn-menu .aam-menu:not([hidden])");
      await page.waitForTimeout(200);
    },
    "usage-tab": async (page) => {
      await withSession(page);
      await page.waitForSelector('.tab[data-key="usage"]');
      await page.click('.tab[data-key="usage"]');
      await page.waitForSelector(".usage-grid");
      await page.waitForTimeout(200);
    },
    "events-tab": async (page) => {
      await withSession(page);
      await page.waitForSelector('.tab[data-key="events"]');
      await page.click('.tab[data-key="events"]');
      await page.waitForTimeout(200);
    },
    // The switch swaps the whole tab set for the span's raw attribute tree.
    "raw-attributes": async (page) => {
      await withSession(page);
      // The label, not the input: app-switch hides the real checkbox behind a
      // styled track, so the input is never a clickable target.
      await page.waitForSelector("#raw-toggle label");
      await page.click("#raw-toggle label");
      await page.waitForSelector(".raw-json");
      await page.waitForTimeout(300);
    },
    // A session the trace backend has nothing for: the span-detail pane folds
    // away and one empty state covers the width.
    "no-traces": async (page) => {
      await withSession(page);
      await page.evaluate(() => {
        __dataSources.registerAll({ fetchObservabilitySession: async () => ({
          data: { session: { session_id: "ses_empty", num_traces: 0, token_usage: { total: 0 }, cost_summary: { total: { cost: 0 } }, latency_p50: 0, latency_p99: 0, traces: [] } },
        }) }, { replace: true });
        document.querySelector("observability-session-page").remove();
        document.body.appendChild(document.createElement("observability-session-page"));
      });
      await page.waitForSelector(".panes.traces-empty app-empty-state");
      await page.waitForTimeout(200);
    },
    "tool-span-selected": async (page) => {
      await withSession(page);
      await page.waitForSelector(".span-row");
      const rows = await page.$$(".span-row");
      if (rows[2]) await rows[2].click();
      await page.waitForTimeout(300);
    },
  },
};
