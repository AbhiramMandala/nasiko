/** One A2A status frame carrying a single `data` part. */
const step = (data) => ({
  statusUpdate: {
    taskId: "t-preview",
    contextId: "ses_preview",
    status: { state: "TASK_STATE_WORKING", message: { parts: [{ data }] } },
  },
});

/** The MCP tool gate used by two scenarios. */
const LINEAR_PAUSE = {
  type: "hitl", id: "h-linear", kind: "tool_approval", agent: "Orchestrator",
  task_id: "t-preview", context_id: "ses_preview",
  question: {
    connector_id: "c-linear", connector_name: "Linear",
    connector_logo_url: null, tool_name: "LINEAR_GET_PROJECT",
    message: "This tool reads a project and its issues from Linear.",
  },
};

/**
 * Serve `frames` as the next turn's SSE stream, leaving every other request —
 * the reconnect included — to the fixtures.
 *
 * Wraps the harness's stub after the page has loaded rather than via
 * addInitScript: the stub falls back to the real fetch it captured at install
 * time, so a property getter installed *before* it recurses into itself.
 */
const servePause = (page, frames) =>
  page.evaluate((scripted) => {
    const inner = window.fetch;
    window.fetch = (url, opts) => {
      const body = String(opts?.body || "");
      if (!String(url).includes("/orchestrator/a2a") || body.includes("reconnect_after_hitl_id")) {
        return inner(url, opts);
      }
      window.fetch = inner; // one turn only
      const enc = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({
        async start(controller) {
          for (const frame of scripted) {
            await new Promise((r) => setTimeout(r, 120));
            controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
          }
          controller.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    };
  }, frames);

export default {
  fetch: [
    ["POST /api/chat/sessions", { session_id: "s-preview-001", id: "s-preview-001" }],
    [{ method: "POST", path: /^\/api\/chat\/sessions\/.*\/messages$/ }, { ok: true }],
    [{ method: "GET", path: /^\/api\/chat\/sessions\/.*\/messages$/ }, {
      data: [
        { role: "user", content: "How do I configure container networking for multi-agent communication?", trace_id: null },
        { role: "assistant", input_tokens: 1840, output_tokens: 512, model: "gpt-4o", duration_ms: 4200, cost_usd: "0.00972000", usage_estimated: false, content: "Here's how to configure container networking for multi-agent communication:\n\n**1. DNS-based discovery**\n\nEach agent container gets a DNS entry in the `nasiko-agents` network. Other agents can reach it via `<agent-id>.nasiko-agents.local`.\n\n**2. Network policy**\n\nBy default, agents can communicate freely within the same namespace. To restrict:\n\n- Use `network_policy: isolated` in the deploy spec\n- Whitelist specific agents with `allowed_peers`\n\n**3. Example configuration**\n\n```yaml\ndeploy:\n  network: nasiko-agents\n  network_policy: restricted\n  allowed_peers:\n    - coding-agent\n    - research-agent\n```\n\n**4. Verifying connectivity**\n\nYou can test connectivity between agents using:\n\n```bash\nnasiko exec <agent-id> -- curl http://other-agent.nasiko-agents.local:8080/health\n```\n\nSee the [networking docs](https://docs.nasiko.dev/networking) for more details.", trace_id: "abc123def456" },
        { role: "user", content: "Can I use mTLS between agents?", trace_id: null },
        // CLI-written sessions store replies as "agent" (not "assistant") —
        // the UI must render both as markdown agent replies.
        { role: "agent", content: "Yes, mTLS between agents is supported. Here's how:\n\n1. Enable the `mtls` feature on the namespace\n2. The platform auto-provisions certificates via the internal CA\n3. Agents receive certs as mounted secrets\n\nNo code changes needed in your agent -- the sidecar proxy handles TLS termination.\n\n`NASIKO_MTLS=enabled` in the agent's env vars activates it.", trace_id: "xyz789abc012" },
        { role: "user", content: "Compare the network policy modes in a table", trace_id: null },
        { role: "assistant", content: "Here's a comparison of the available network policy modes:\n\n| Mode | Default peers | Use case | Overhead |\n| --- | --- | --- | --- |\n| `open` | All agents in namespace | Development, trusted teams | None |\n| `restricted` | Only `allowed_peers` | Production multi-tenant | Low |\n| `isolated` | None | Sensitive workloads, compliance | Low |\n| `mtls` | `allowed_peers` + mutual TLS | Zero-trust environments | Medium |\n\nFor most production deployments, `restricted` is the sweet spot between security and operability.", trace_id: "tbl456trace789" },
      ],
    }],
    ["POST /api/orchestrator/a2a", (() => {
      const answer = "## Scaling agents\n\nUse the `scale` command with **replica count**:\n\n```bash\nnasiko scale my-agent --replicas 3\n```\n\n- Replicas share one service endpoint\n- Traffic is round-robin balanced";
      const evt = (obj) => `data: ${JSON.stringify({ result: obj })}\n\n`;
      const dataMsg = (data) => ({ status: { state: "TASK_STATE_WORKING", message: { parts: [{ data }] } } });
      return { __stream: [
        { text: evt({ statusUpdate: dataMsg({ type: "trace_meta", trace_id: "trace-preview-chat" }) }), delay: 600 },
        { text: evt({ statusUpdate: dataMsg({ type: "thinking", content: "Analyzing the request..." }) }), delay: 150 },
        { text: evt({ statusUpdate: dataMsg({ type: "tool_call", agent: "devops-agent", message: "How do I scale an agent deployment?", turn: 1 }) }), delay: 150 },
        { text: evt({ statusUpdate: dataMsg({ type: "sub_status", agent: "devops-agent", message: "Consulting deployment runbook..." }) }), delay: 100 },
        { text: evt({ statusUpdate: dataMsg({ type: "sub_status", agent: "devops-agent", message: "Checking KEDA autoscaler limits..." }) }), delay: 100 },
        { text: evt({ statusUpdate: dataMsg({ type: "tool_result", agent: "devops-agent", result: "Use `nasiko scale` with --replicas; traffic is balanced round-robin.", success: true, turn: 1 }) }), delay: 250 },
        // Working-status text chunks — cumulative sends, like python-SDK agents stream.
        { text: evt({ statusUpdate: { status: { state: "TASK_STATE_WORKING", message: { parts: [{ text: "## Scaling agents\n\nUse the `scale`" }] } } } }), delay: 150 },
        { text: evt({ statusUpdate: { status: { state: "TASK_STATE_WORKING", message: { parts: [{ text: "## Scaling agents\n\nUse the `scale` command with **replica count**:" }] } } } }), delay: 150 },
        { text: evt({ artifactUpdate: { artifact: { parts: [{ text: answer }] }, append: false } }), delay: 300 },
        { text: evt({ statusUpdate: dataMsg({ type: "usage_meta", input_tokens: 932, output_tokens: 214, total_tokens: 1146, cost_usd: 0.00447, duration_ms: 3400, model: "gpt-4o", estimated: true, trace_id: "trace-preview-chat" }) }), delay: 50 },
        { text: evt({ statusUpdate: { status: { state: "TASK_STATE_COMPLETED", message: { parts: [{ text: answer }] } } } }), delay: 100 },
      ] };
    })()],

    // HITL rows. The stream frame carries only id/kind/question, so the card
    // hydrates the rest from here.
    [{ method: "GET", path: /^\/api\/hitl\/[^/]+$/ }, (request) => {
      const id = String(request.url).split("/").pop();
      const rows = {
        "h-invoice": { kind: "tool_approval", question: { connector_id: "c-ledger", connector_name: "Northwind Ledger",
          connector_logo_url: null, tool_name: "LEDGER_PAY_INVOICE",
          message: "September annotation work. The invoice matches the purchase order and the work was signed off.",
          metadata: { amount: "$18,400.00 USD", payee_account: "Changed 2 days ago",
            approved_before: "6 invoices, same vendor, old account",
            undo: "None. Money leaves and does not come back." } } },
        "h-input": { kind: "input_required", question: { message: "Which actions should even reach a human?" } },
        "h-linear": { kind: "tool_approval", question: { connector_id: "c-linear", connector_name: "Linear",
          connector_logo_url: null, tool_name: "LINEAR_GET_PROJECT",
          message: "This tool reads a project and its issues from Linear." } },
        "h-auth": { kind: "auth_required", question: { connector_id: "c-linear", connector: "linear",
          message: "Authentication for connector 'linear' is missing or no longer works. A human must re-authenticate before this tool can be used again." } },
      };
      const row = rows[id] || rows["h-linear"];
      return {
        id, kind: row.kind, status: "pending", resume_status: "not_started",
        question: row.question, human_response: null,
        execution: { origin: "orchestrator", agent_id: "a-001", task_id: "t-preview",
          context_id: "ses_preview", chat_session_id: "ses_preview",
          maf_execution_id: null, maf_step_index: null },
        allowed_actions: row.kind === "input_required" ? ["answer", "cancel"] : ["approve", "reject", "cancel"],
        expires_at: "2026-09-14T13:33:49Z", created_at: "2026-09-07T13:33:49Z", resolved_at: null,
      };
    }],
    [{ method: "POST", path: /^\/api\/hitl\/[^/]+\/resolve$/ }, { status: "resolved", resume_status: "not_started" }],
    [{ method: "POST", path: /^\/api\/hitl\/[^/]+\/cancel$/ }, { status: "canceled", already_canceled: false }],
    [{ method: "GET", path: /^\/api\/mcp\/agents\/[^/]+\/connectors$/ }, {
      data: { connectors: [
        { id: "c-linear", name: "Linear", logo_url: null },
        { id: "c-ledger", name: "Northwind Ledger", logo_url: null },
      ] },
    }],
  ],
  scenarios: {
    "with-messages": async (page) => {
      // Navigate with session_id to trigger message loading
      const url = page.url();
      const base = url.split('?')[0];
      await page.goto(`${base}?agent_id=a-001&agent_name=Coding+Agent&session_id=s-001`);
      await page.waitForSelector('.msg-row');
    },
    "hover-actions": async (page) => {
      // Hover an assistant reply to reveal the copy + trace actions toolbar
      const url = page.url();
      const base = url.split('?')[0];
      await page.goto(`${base}?agent_id=a-001&agent_name=Coding+Agent&session_id=s-001`);
      await page.waitForSelector('.msg-row.is-assistant');
      await page.hover('.msg-row.is-assistant:last-of-type .msg');
      await page.waitForTimeout(200);
    },
    "history-skeleton": async (page) => {
      // Hold the messages request forever so the skeleton stays visible
      // (init script wins over the fixture fetch stub after reload).
      await page.addInitScript(() => {
        let real = window.fetch.bind(window);
        Object.defineProperty(window, "fetch", {
          configurable: true,
          get: () => (url, opts) =>
            String(url).includes("/messages") ? new Promise(() => {}) : real(url, opts),
          // Let the fixture harness install its stub for everything else.
          set: (v) => { real = v; },
        });
      });
      const base = page.url().split("?")[0];
      await page.goto(`${base}?agent_id=a-001&agent_name=Coding+Agent&session_id=s-001`);
      await page.waitForSelector(".msg-skel");
      await page.waitForTimeout(200);
    },
    "streamed-response": async (page) => {
      // Submit a message and let the mocked SSE stream render live
      await page.fill('#textarea', 'How do I scale an agent?');
      await page.click('#submitBtn');
      await page.waitForSelector('.stream-content.is-visible', { timeout: 8000 });
      await page.waitForTimeout(300);
    },
    // Just after submit: bouncing typing indicator, before any stream event.
    "typing-indicator": async (page) => {
      await page.fill('#textarea', 'How do I scale an agent?');
      await page.click('#submitBtn');
      await page.waitForSelector('.typing-indicator', { timeout: 5000 });
      await page.waitForTimeout(150);
    },
    // Mid-stream: tool-call step visible and running.
    "streaming-steps": async (page) => {
      await page.fill('#textarea', 'How do I scale an agent?');
      await page.click('#submitBtn');
      await page.waitForSelector('agent-steps .step', { timeout: 5000 });
      await page.waitForTimeout(250);
    },
    // ── Human-in-the-loop ───────────────────────────────────────────────
    //
    // These need a stream that ENDS in a `hitl` part instead of a reply, and
    // the fixture layer serves one scripted stream per path while every turn
    // on this page posts to /api/orchestrator/a2a. So each scenario swaps in
    // its own pause stream for the next turn and lets everything else —
    // including the reconnect that follows a decision — fall through.
    "hitl-tool-approval": async (page) => {
      await servePause(page, [
        step({ type: "tool_call", agent: "archive", message: "Searched available tools", turn: 1 }),
        step({ type: "tool_result", agent: "archive", result: "Failed: no matching tool", success: false, turn: 1 }),
        step({ type: "tool_call", agent: "archive", message: "List issue", turn: 2 }),
        step(LINEAR_PAUSE),
      ]);
      await page.fill("#textarea", "Get the Linear project for NAS-14");
      await page.click("#submitBtn");
      await page.waitForSelector("hitl-card .hc-actions app-button", { timeout: 8000 });
      await page.waitForTimeout(400);
    },
    // A high-stakes approval that carries its own detail rows in
    // question.metadata — same card, same three actions.
    "hitl-tool-approval-detailed": async (page) => {
      await servePause(page, [
        step({ type: "tool_call", agent: "finance", message: "Pay invoice INV-20418", turn: 1 }),
        step({
          type: "hitl", id: "h-invoice", kind: "tool_approval",
          task_id: "t-preview", context_id: "ses_preview",
          question: {
            connector_id: "c-ledger", connector_name: "Northwind Ledger",
            connector_logo_url: null, tool_name: "LEDGER_PAY_INVOICE",
            message: "September annotation work. The invoice matches the purchase order and the work was signed off.",
            metadata: {
              amount: "$18,400.00 USD",
              payee_account: "Changed 2 days ago",
              approved_before: "6 invoices, same vendor, old account",
              undo: "None. Money leaves and does not come back.",
            },
          },
        }),
      ]);
      await page.fill("#textarea", "Pay invoice INV-20418 to Northwind Data Labs");
      await page.click("#submitBtn");
      await page.waitForSelector("hitl-card .hc-rows", { timeout: 8000 });
      await page.waitForTimeout(400);
    },
    // A plain question: answered in the card's own field, with the composer
    // closed and saying so.
    "hitl-input-required": async (page) => {
      await servePause(page, [
        { statusUpdate: { status: { state: "TASK_STATE_WORKING", message: { parts: [{ text: "Reviewing the current policy set…" }] } } } },
        step({
          type: "hitl", id: "h-input", kind: "input_required",
          task_id: "t-preview", context_id: "ses_preview",
          question: { message: "Which actions should even reach a human?" },
        }),
      ]);
      await page.fill("#textarea", "Set up an approval policy with a human in the loop");
      await page.click("#submitBtn");
      await page.waitForSelector("hitl-card .hc-field app-input input", { timeout: 8000 });
      await page.waitForSelector('hitl-card .hc-actions app-button[icon-only]', { timeout: 8000 });
      await page.waitForTimeout(400);
    },
    // A broken connector credential: two clicks, because "start" only records
    // that the human went off to sign in — the row stays pending until they
    // come back and say they are done.
    "hitl-auth-required": async (page) => {
      await servePause(page, [
        step({ type: "tool_call", agent: "archive", message: "List issue", turn: 1 }),
        step({
          type: "hitl", id: "h-auth", kind: "auth_required", agent: "Orchestrator",
          task_id: "t-preview", context_id: "ses_preview",
          question: {
            connector_id: "c-linear", connector: "linear",
            message: "Authentication for connector 'linear' is missing or no longer works. A human must re-authenticate before this tool can be used again.",
          },
        }),
      ]);
      await page.fill("#textarea", "Get the Linear project for NAS-14");
      await page.click("#submitBtn");
      await page.waitForSelector("hitl-card .hc-actions app-button", { timeout: 8000 });
      await page.waitForTimeout(400);
    },
    // After approving: the reconnect replays the resumed events and the turn
    // finishes normally.
    "hitl-resumed": async (page) => {
      await servePause(page, [step({ type: "tool_call", agent: "archive", message: "List issue", turn: 1 }), step(LINEAR_PAUSE)]);
      await page.fill("#textarea", "Get the Linear project for NAS-14");
      await page.click("#submitBtn");
      await page.waitForSelector('hitl-card app-button[variant="primary"]', { timeout: 8000 });
      await page.click('hitl-card app-button[variant="primary"] button');
      await page.waitForSelector(".stream-content.is-visible", { timeout: 8000 });
      await page.waitForTimeout(400);
    },
    // Completed reply with the steps summary re-expanded.
    "steps-expanded": async (page) => {
      await page.fill('#textarea', 'How do I scale an agent?');
      await page.click('#submitBtn');
      await page.waitForSelector('agent-steps.is-done', { timeout: 8000 });
      await page.click('agent-steps .steps-header');
      await page.waitForTimeout(200);
    },
  },
};
