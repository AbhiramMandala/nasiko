// Weave fixtures.
//
// Two layers, because a generated surface has two dependencies and they fail
// differently:
//
//   The generation itself — `POST /api/weave/surface`, an SSE stream of DSL
//   text. Stubbed in the `generated` scenario rather than in `fetch`, because
//   it needs a real streaming `Response` body and the fixture layer's plain
//   values cannot express one. Stubbing it inside `page.evaluate` means the
//   fixture exercises the same `readSseFrames` path production does, chunk
//   boundaries and all.
//
//   The data the surface then asks for — the five read-only `tokenops` sources
//   Weave's own `dashboard_data_sources.json` allows. These are ordinary
//   fetches and live in `fetch` below. Their payloads mirror the real
//   envelopes in oss/server/src (see /api/docs); a shape mismatch here would
//   make the preview lie about what a generated dashboard looks like.

const usageSummary = {
  request_count: 1842,
  total_input_tokens: 482000,
  total_output_tokens: 215000,
  total_tokens: 697000,
  total_cost_usd: 12.47,
  avg_latency_ms: 342,
  period_days: 30,
};

const usageHistory = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 7, 15 + i));
  return {
    date: d.toISOString().slice(0, 10),
    request_count: 90 + ((i * 37) % 70),
    total_tokens: 38000 + ((i * 5100) % 22000),
    total_cost_usd: Number((0.62 + ((i * 13) % 40) / 100).toFixed(2)),
  };
});

const byAgent = [
  { agent_id: "a-001", agent_name: "coding-agent",   request_count: 842, total_input_tokens: 220000, total_output_tokens: 98000, total_tokens: 318000, total_cost_usd: 5.62, avg_latency_ms: 380 },
  { agent_id: "a-002", agent_name: "research-agent", request_count: 512, total_input_tokens: 145000, total_output_tokens: 62000, total_tokens: 207000, total_cost_usd: 3.55, avg_latency_ms: 290 },
  { agent_id: "a-004", agent_name: "qa-agent",       request_count: 310, total_input_tokens: 78000,  total_output_tokens: 35000, total_tokens: 113000, total_cost_usd: 2.10, avg_latency_ms: 420 },
  { agent_id: "a-003", agent_name: "devops-agent",   request_count: 120, total_input_tokens: 28000,  total_output_tokens: 14000, total_tokens: 42000,  total_cost_usd: 0.82, avg_latency_ms: 310 },
  { agent_id: "a-005", agent_name: "docs-agent",     request_count: 58,  total_input_tokens: 11000,  total_output_tokens: 6000,  total_tokens: 17000,  total_cost_usd: 0.38, avg_latency_ms: 250 },
];

const byModel = [
  { provider: "anthropic", model: "claude-sonnet", request_count: 1204, total_input_tokens: 330000, total_output_tokens: 148000, total_tokens: 478000, total_cost_usd: 8.10, avg_latency_ms: 330 },
  { provider: "anthropic", model: "claude-haiku",  request_count: 498,  total_input_tokens: 118000, total_output_tokens: 52000,  total_tokens: 170000, total_cost_usd: 2.94, avg_latency_ms: 190 },
  { provider: "openai",    model: "gpt-4o-mini",   request_count: 140,  total_input_tokens: 34000,  total_output_tokens: 15000,  total_tokens: 49000,  total_cost_usd: 1.43, avg_latency_ms: 410 },
];

/**
 * The DSL a generation produces, as the model would stream it.
 *
 * Exported rather than inlined in the scenario so `ui/tests/surface-fixture.test.mjs`
 * can run this exact text through the real parser and materializer. A fixture
 * that has drifted from what the runtime actually does is worse than no
 * fixture — it shows a dashboard nobody can generate.
 *
 * Shape follows agent.yaml's Worked Examples 2b, 2c and 3b: a `$state` filter
 * with `@Set` + `@Run` in one Action, a paginated source read through a
 * dot-path, and a chart fed by an array pluck.
 */
export const GENERATED_DSL = [
  "Sure — building that now.\n",
  '$days = 14\n',
  'summaryQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")\n',
  'requestsQ = Query("fetchUsageSummary", [], 0, "request_count")\n',
  'historyQ = Query("fetchUsageHistory", [$days], [])\n',
  'agentRows = Query("fetchUsageByAgent", ["", 1, 20], [], "data")\n',
  'showSeven = Action([@Set($days, 7), @Run(historyQ)])\n',
  'showFourteen = Action([@Set($days, 14), @Run(historyQ)])\n',
  'heading = AppText("Spend and request volume", "title")\n',
  'kpis = AppStatRow([{label: "Total cost", value: summaryQ}, {label: "Requests", value: requestsQ}])\n',
  'sevenBtn = AppButton("7 days", "tertiary", "sm", false, null, false, false, "button", null, null, null, showSeven)\n',
  'fourteenBtn = AppButton("14 days", "primary", "sm", false, null, false, false, "button", null, null, null, showFourteen)\n',
  'filters = AppRow([sevenBtn, fourteenBtn], "sm")\n',
  'spendChart = AppChart(historyQ.total_cost_usd, "line")\n',
  'agentTable = AppTable(agentRows)\n',
  'chartCard = AppCard([spendChart], "Daily spend")\n',
  'root = AppStack([heading, kpis, filters, chartCard, agentTable], "md")\n',
  "Here's your spend dashboard with a 7/14 day filter — let me know if you'd like anything adjusted!",
];

export default {
  fetch: [
    [{ method: "GET", path: /^\/api\/usage\/summary/ }, usageSummary],
    [{ method: "GET", path: /^\/api\/usage\/history/ }, usageHistory],
    [{ method: "GET", path: /^\/api\/usage\/by-agent/ }, { data: byAgent, total: byAgent.length }],
    [{ method: "GET", path: /^\/api\/usage\/by-model/ }, { data: byModel, total: byModel.length }],
  ],

  scenarios: {
    // A finished generation: the surface, the assistant's two sentences, and
    // the real usage data underneath it.
    generated: async (page) => {
      await page.evaluate((DSL) => {
        const frame = (event, obj, id) =>
          `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;

        const realFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (!url.includes("/weave/surface")) return realFetch(input, init);
          const enc = new TextEncoder();
          const body = new ReadableStream({
            async start(c) {
              c.enqueue(enc.encode(frame("surface", {
                specVersion: "1.0", catalogVersion: null, surfaceId: "preview",
              }, 1)));
              for (let i = 0; i < DSL.length; i++) {
                c.enqueue(enc.encode(frame("dsl-chunk", { text: DSL[i] }, i + 2)));
                await new Promise((r) => setTimeout(r, 4));
              }
              c.enqueue(enc.encode(frame("end", { status: "ok" }, 99)));
              c.close();
            },
          });
          return Promise.resolve(new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }));
        };
      }, GENERATED_DSL);

      await page.evaluate(() => {
        const page_ = document.querySelector("weave-page");
        page_.querySelector("#prompt").value = "Show me spend for the last 14 days";
        page_.querySelector("#composer").dispatchEvent(new Event("submit", { cancelable: true }));
      });

      await page.waitForSelector("weave-surface app-stat-row");
      await page.waitForFunction(() => {
        const b = document.querySelector("weave-page #status");
        return b && /done|ok/.test(b.textContent);
      });
    },

    // Generation refused. The surface stays empty and the reason is on screen
    // rather than in the console — the whole point of the diagnostics pane.
    failed: async (page) => {
      await page.evaluate(() => {
        const frame = (event, obj, id) =>
          `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
        const realFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (!url.includes("/weave/surface")) return realFetch(input, init);
          const body =
            frame("surface", { specVersion: "1.0", catalogVersion: null, surfaceId: "p" }, 1) +
            frame("fail", { code: "no_data_source", message: 'the "tokenops" scope has no source matching that request' }, 2);
          return Promise.resolve(new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }));
        };
      });

      await page.evaluate(() => {
        const page_ = document.querySelector("weave-page");
        page_.querySelector("#prompt").value = "Show me our AWS bill";
        page_.querySelector("#composer").dispatchEvent(new Event("submit", { cancelable: true }));
      });

      await page.waitForSelector("weave-page .diag");
    },
  },
};
