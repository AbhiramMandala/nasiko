/**
 * The stream host, driven against a real SSE body in the exact wire format
 * weave2.0's sse_encoder.py emits — `id:` / `event:` / one JSON object per
 * `data:` line, frames separated by a blank line.
 *
 * fetch, the paint scheduler and the document are all injected, so this runs
 * under `node --test` without a browser and without a network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { createSurfaceSession } = await import(new URL('../common/surface/surface-stream.js', import.meta.url).href);
const catalog = JSON.parse(readFileSync(new URL('../common/surface/dsl-catalog.json', import.meta.url), 'utf8'));

/** Records the calls the renderer makes; see surface-render.test.mjs. */
function recorder() {
  const make = (tag) => ({
    tag, attrs: {}, children: [], listeners: {}, textContent: undefined,
    setAttribute(k, v) { this.attrs[k] = v; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    replaceChildren() { this.children.length = 0; },
  });
  return { doc: { createElement: make }, container: make('div') };
}

/**
 * The same recorder, plus the four things focus.js asks of a document.
 *
 * Separate rather than folded into `recorder()` because every other test in
 * this file asserts on a tree that has no notion of who is focused, and a
 * recorder that grows a `doc.activeElement` invites those tests to start
 * depending on it by accident.
 */
function focusRecorder() {
  const doc = { activeElement: null };
  const make = (tag) => {
    const node = {
      tag,
      tagName: tag.toUpperCase(),
      attrs: {},
      children: [],
      listeners: {},
      parentElement: null,
      focusCount: 0,
      setAttribute(k, v) { this.attrs[k] = v; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
      appendChild(c) { c.parentElement = node; node.children.push(c); return c; },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      replaceChildren() {
        for (const c of node.children) c.parentElement = null;
        node.children.length = 0;
      },
      contains(other) { for (let n = other; n; n = n.parentElement) if (n === node) return true; return false; },
      focus() { node.focusCount++; doc.activeElement = node; },
    };
    return node;
  };
  doc.createElement = make;
  return { doc, container: make('div') };
}

const frame = (event, obj, id) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;

/** A Response whose body emits `chunks`, one per tick. */
function sse(chunks) {
  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
        await new Promise((r) => setTimeout(r, 1));
      }
      controller.close();
    },
  });
  // Weave sends this, and the client now refuses a 200 without it — a body
  // that is not an event stream is the wrong endpoint, not a dropped one.
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * A session wired to a canned stream. `schedule` runs synchronously so a paint
 * is observable immediately; coalescing itself is asserted separately.
 */
function session(chunks, { status = 200, schedule, answers = {} } = {}) {
  const { doc, container } = recorder();
  const messages = [];
  const diagnostics = [];
  const statuses = [];
  const requests = [];
  const dataCalls = [];
  const assistant = [];
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: schedule ?? ((fn) => fn()),
    onMessage: (t) => messages.push(t),
    onDiagnostics: (d) => diagnostics.push(...d),
    onStatus: (x) => statuses.push(x.phase),
    onAssistant: (t) => assistant.push(t),
    call: async (name, ...args) => {
      dataCalls.push([name, ...args]);
      const a = answers[name];
      return typeof a === 'function' ? a(...args) : a;
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return status === 200 ? sse(chunks) : new Response('nope', { status });
    },
  });
  return { s, container, messages, diagnostics, statuses, requests, dataCalls, assistant };
}

/** The DSL a normal turn produces, split the way a model streams it. */
const DSL = [
  'Sure — building that now.\n',
  'root = AppStack([kpis], "md")\n',
  'kpis = AppRow([kpiCost], "md")\n',
  'kpiCost = AppStatCard("Total cost", "12.50", "+3.20", 12.50 > 9.30 ? "up" : "neutral")\n',
  "Here's your spend dashboard — let me know if you'd like anything adjusted!",
];
const TURN = [
  frame('surface', { specVersion: '1.0', catalogVersion: catalog.catalogVersion, surfaceId: 's1' }, 1),
  ...DSL.map((t, i) => frame('dsl-chunk', { text: t }, i + 2)),
  frame('end', { status: 'ok' }, 9),
];

test('a full turn renders the tree the DSL describes', async () => {
  const { s, container } = session(TURN);
  const out = await s.send('build me a spend dashboard');
  assert.equal(out.status, 'ok');
  const stack = container.children[0];
  assert.equal(stack.tag, 'app-stack');
  const card = stack.children[0].children[0];
  // The delta and its arrow are COMPUTED, which is the only honest way to show
  // either. A generation that hardcodes "up" is asserting a direction nothing
  // measured, and this fixture is the shape the prompt teaches instead.
  // The arrow is derived from a comparison rather than stated. A generation
  // that hardcodes "up" is asserting a direction nothing measured, and this
  // fixture is the shape the prompt teaches instead.
  assert.deepEqual([card.attrs.label, card.attrs.value, card.attrs.delta, card.attrs.trend],
    ['Total cost', '12.50', '+3.20', 'up']);
});

test('both prose sentences reach the chat log, and no DSL line does', async () => {
  const { s, messages } = session(TURN);
  await s.send('go');
  assert.deepEqual(messages, [
    'Sure — building that now.',
    "Here's your spend dashboard — let me know if you'd like anything adjusted!",
  ]);
});

test('a half-typed sentence is never emitted as a message', async () => {
  // The intro arrives in pieces like everything else. Emitting on every chunk
  // would put "Sure — buil" in the chat log.
  const chunks = [
    frame('surface', {}, 1),
    frame('dsl-chunk', { text: 'Sure — buil' }, 2),
    frame('dsl-chunk', { text: 'ding that now.\n' }, 3),
    frame('dsl-chunk', { text: 'root = AppBadge("x")\n' }, 4),
    frame('end', { status: 'ok' }, 5),
  ];
  const { s, messages } = session(chunks);
  await s.send('go');
  assert.deepEqual(messages, ['Sure — building that now.']);
});

test('each prose line is emitted exactly once across many repaints', async () => {
  const { s, messages } = session(TURN);
  await s.send('go');
  assert.equal(new Set(messages).size, messages.length);
});

test('the surface builds up progressively rather than appearing at the end', async () => {
  const seen = [];
  const { s, container } = session(TURN, { schedule: (fn) => { fn(); seen.push(container.children.length); } });
  await s.send('go');
  assert.ok(seen.length >= 2, 'more than one paint happened while streaming');
  assert.ok(seen.some((n) => n === 1), 'a tree was on screen before the stream ended');
});

test('paints coalesce — many chunks in one frame draw once', async () => {
  let scheduled = 0;
  const pending = [];
  const { s } = session(TURN, { schedule: (fn) => { scheduled++; pending.push(fn); } });
  const done = s.send('go');
  await done;
  // Five dsl-chunks, but each paint is only re-armed once the previous ran.
  assert.ok(scheduled < 5, `expected fewer paints than chunks, got ${scheduled}`);
  pending.forEach((fn) => fn());
});

test('the previous turn goes back as context.currentSurface', async () => {
  const { s, requests } = session(TURN);
  await s.send('first');
  assert.equal(requests[0].body.context.currentSurface, undefined, 'nothing to revise on turn one');
  assert.ok(s.currentSurface.includes('kpiCost = AppStatCard'));

  const second = session(TURN);
  // Same session object is what carries it; simulate by sending twice.
  await s.send('now change it');
  assert.ok(requests[1].body.context.currentSurface.includes('root = AppStack'));
  assert.equal(second.requests.length, 0);
});

test('a conversational turn does not wipe the dashboard', async () => {
  const { s } = session(TURN);
  await s.send('build it');
  const built = s.currentSurface;
  assert.ok(built);

  // A turn that is only prose — rule 10's "respond in plain text only".
  const chat = [
    frame('surface', {}, 1),
    frame('dsl-chunk', { text: 'I can build dashboards from your TokenOps data.' }, 2),
    frame('end', { status: 'ok' }, 3),
  ];
  const { s: s2 } = session(chat);
  await s2.send('what can you do?');
  assert.equal(s2.currentSurface, '', 'no surface produced, so nothing to revise from');
});

test('two content hashes that differ is a real mismatch, and the render continues', async () => {
  const chunks = [
    frame('surface', { catalogVersion: 'deadbeef1234' }, 1),
    frame('dsl-chunk', { text: 'root = AppBadge("still drawn")\n' }, 2),
    frame('end', { status: 'ok' }, 3),
  ];
  const { s, container, diagnostics } = session(chunks);
  await s.send('go');
  assert.ok(diagnostics.some((d) => d.code === 'catalog_version_mismatch'));
  assert.equal(container.children[0].textContent, 'still drawn', 'a stale generator still beats a blank screen');
});

test('a version that is not a content hash cannot be compared, and says so', async () => {
  // Weave shipped a literal "1.0" against our hash, so a plain !== fired on
  // every single turn. A warning that is always on is one nobody reads, which
  // is worse than no warning at all — the day it means something looks
  // identical to every other day.
  const chunks = [
    frame('surface', { catalogVersion: '1.0' }, 1),
    frame('dsl-chunk', { text: 'root = AppBadge("drawn")\n' }, 2),
    frame('end', { status: 'ok' }, 3),
  ];
  const { s, diagnostics } = session(chunks);
  await s.send('go');
  assert.equal(diagnostics.some((d) => d.code === 'catalog_version_mismatch'), false);
  const d = diagnostics.find((x) => x.code === 'catalog_version_unverifiable');
  assert.ok(d);
  assert.match(d.message, /not a content hash/);
});

test('a matching version is silent', async () => {
  const chunks = [
    frame('surface', { catalogVersion: catalog.catalogVersion }, 1),
    frame('dsl-chunk', { text: 'root = AppBadge("drawn")\n' }, 2),
    frame('end', { status: 'ok' }, 3),
  ];
  const { s, diagnostics } = session(chunks);
  await s.send('go');
  assert.equal(diagnostics.length, 0);
});

test('the request tells the generator which catalog this client renders with', async () => {
  const { s, requests } = session(TURN);
  await s.send('go');
  assert.equal(requests[0].body.context.catalogVersion, catalog.catalogVersion,
    'without this the generator cannot tell a deploy landed mid-flight');
});

test('a fail frame is surfaced and the last good render is kept', async () => {
  const chunks = [
    frame('surface', {}, 1),
    frame('dsl-chunk', { text: 'root = AppBadge("drawn")\n' }, 2),
    frame('fail', { code: 'planner_error', message: 'upstream 502' }, 3),
  ];
  const { s, container, diagnostics, statuses } = session(chunks);
  const out = await s.send('go');
  assert.equal(out.status, 'failed');
  assert.equal(statuses.at(-1), 'failed');
  assert.ok(diagnostics.some((d) => d.code === 'planner_error'));
  assert.equal(container.children[0].textContent, 'drawn', 'the failure did not blank the screen');
});

test('an HTTP error resolves rather than throwing, keeping the old surface', async () => {
  const { s, statuses } = session([], { status: 500 });
  const out = await s.send('go');
  assert.equal(out.status, 'http_error');
  assert.equal(statuses.at(-1), 'failed');
});

test('an unparseable or unknown frame is reported and skipped', async () => {
  const chunks = [
    'id: 1\nevent: dsl-chunk\ndata: {"text":\n\n',
    frame('gibberish', {}, 2),
    frame('dsl-chunk', { text: 'root = AppBadge("ok")\n' }, 3),
    frame('end', { status: 'ok' }, 4),
  ];
  const { s, container, diagnostics } = session(chunks);
  await s.send('go');
  const codes = diagnostics.map((d) => d.code);
  assert.ok(codes.includes('malformed_frame'));
  assert.ok(codes.includes('unknown_frame'));
  assert.equal(container.children[0].textContent, 'ok');
});

test('diagnostics are reported once per change, not once per chunk', async () => {
  const chunks = [
    frame('surface', {}, 1),
    frame('dsl-chunk', { text: 'root = AppNonesuch("x")\n' }, 2),
    frame('dsl-chunk', { text: 'filler = 1\n' }, 3),
    frame('dsl-chunk', { text: 'more = 2\n' }, 4),
    frame('end', { status: 'ok' }, 5),
  ];
  const { s, diagnostics } = session(chunks);
  await s.send('go');
  const unknown = diagnostics.filter((d) => d.code === 'unknown_component_type');
  assert.equal(unknown.length, 1, 'the same diagnostic on every chunk is noise');
});

test('aborting mid-stream stops the reader', async () => {
  const controller = new AbortController();
  const { s } = session(TURN);
  const p = s.send('go', { signal: controller.signal });
  controller.abort();
  await assert.doesNotReject(() => p);
});

// ── Reactivity, end to end through the host ─────────────────────────────────

/** Worked Example 3b: a filter that genuinely reloads. */
const FILTER = [
  'Sure — building that now.\n',
  '$days = 7\n',
  'historyQ = Query("fetchUsageHistory", [$days], [])\n',
  'showThirty = Action([@Set($days, 30), @Run(historyQ)])\n',
  'btn = AppButton("30 days", "primary", "md", false, null, false, false, "button", null, null, null, showThirty)\n',
  'chart = AppChart(historyQ, "line")\n',
  'root = AppStack([btn, chart], "md")\n',
  'Here you go — let me know if you want a different window.',
];
const FILTER_TURN = [
  frame('surface', { specVersion: '1.0', catalogVersion: catalog.catalogVersion, surfaceId: 's2' }, 1),
  ...FILTER.map((t, i) => frame('dsl-chunk', { text: t }, i + 2)),
  frame('end', { status: 'ok' }, 20),
];

test('a Query fetches once as the dashboard streams in, not once per chunk', async () => {
  const { s, dataCalls } = session(FILTER_TURN, { answers: { fetchUsageHistory: (d) => [{ d }] } });
  await s.send('spend over time');
  await s.queries.settled();
  assert.deepEqual(dataCalls, [['fetchUsageHistory', 7]], 'the declared default, fetched exactly once');
});

test('clicking a filter button runs @Set then @Run and re-fetches', async () => {
  const { s, container, dataCalls } = session(FILTER_TURN, {
    answers: { fetchUsageHistory: (d) => [{ d }] },
  });
  await s.send('spend over time');
  await s.queries.settled();

  const button = container.children[0].children[0];
  assert.equal(button.tag, 'app-button');
  button.listeners.click[0]();
  await s.queries.settled();
  // The action itself is async; let its steps drain.
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(dataCalls, [['fetchUsageHistory', 7], ['fetchUsageHistory', 30]]);
  assert.equal(s.store.get('$days'), 30);
  assert.deepEqual(s.queries.results.get('historyQ'), [{ d: 30 }]);
});

test('a query that fails leaves the declared default on screen and reports why', async () => {
  const { s, container, diagnostics } = session(FILTER_TURN, {
    answers: { fetchUsageHistory: () => { throw new Error('502 upstream'); } },
  });
  await s.send('spend over time');
  await s.queries.settled();
  await new Promise((r) => setTimeout(r, 5));

  const d = diagnostics.find((x) => x.code === 'query_failed');
  assert.ok(d, 'a permanent skeleton with nothing in the console is the failure mode this replaces');
  assert.match(d.message, /502 upstream/);
  assert.equal(container.children[0].tag, 'app-stack', 'and the surface still rendered');
});

test('reset drops the data as well as the text', async () => {
  const { s } = session(FILTER_TURN, { answers: { fetchUsageHistory: () => [1] } });
  await s.send('spend over time');
  await s.queries.settled();
  assert.equal(s.queries.results.size, 1);
  s.reset();
  assert.equal(s.queries.results.size, 0);
  assert.equal(s.store.get('$days'), undefined);
  assert.equal(s.currentSurface, '');
});

test('a container that throws on replaceChildren does not abandon the turn', async () => {
  const { doc, container } = recorder();
  let thrown = false;
  container.replaceChildren = function () {
    this.children.length = 0;
    if (!thrown) { thrown = true; throw new Error('detached'); }
  };
  const diagnostics = [];
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onDiagnostics: (d) => diagnostics.push(...d),
    fetchImpl: async () => sse(TURN),
  });
  const out = await s.send('go');
  assert.equal(out.status, 'ok');
  assert.ok(diagnostics.some((d) => d.code === 'paint_failed'));
  assert.ok(container.children.length > 0, 'the turn recovered on the next chunk');
});

test('a turn emits exactly one telemetry record, with both catalog versions', async () => {
  const records = [];
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onTurn: (r) => records.push(r),
    fetchImpl: async () => sse(TURN),
  });
  await s.send('build me a spend dashboard');

  assert.equal(records.length, 1, 'one turn, one record — however many chunks it took');
  const r = records[0];
  assert.equal(r.kind, 'weave-surface-turn');
  assert.equal(r.status, 'ok');
  assert.equal(r.rendered, true);
  assert.equal(r.emptyRender, false);
  assert.equal(r.chunks, 5);
  assert.equal(r.catalogVersion, catalog.catalogVersion);
  assert.equal(r.generatorCatalogVersion, catalog.catalogVersion);
  assert.equal(r.promptLength, 'build me a spend dashboard'.length);
  assert.equal(JSON.stringify(r).includes('spend dashboard'), false, 'the prompt itself must not travel');
});

test('a failed turn still produces a record, flagged', async () => {
  const records = [];
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onTurn: (r) => records.push(r),
    fetchImpl: async () => new Response('nope', { status: 502 }),
  });
  await s.send('go');
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'http_error');
  assert.equal(records[0].rendered, false);
});

// ── Resume ──────────────────────────────────────────────────────────────────
// A dropped connection used to lose the turn: the user re-prompts, and the
// second generation costs the same as the first would have.

/** A body that ends abruptly after `cut` chunks, with no terminal frame. */
function truncated(cut) {
  return [
    frame('surface', { specVersion: '1.0', catalogVersion: catalog.catalogVersion, surfaceId: 's1' }, 1),
    ...DSL.slice(0, cut).map((t, i) => frame('dsl-chunk', { text: t }, i + 2)),
  ];
}

test('a dropped stream is picked back up, and the turn completes', async () => {
  const requests = [];
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    fetchImpl: async (url, init) => {
      requests.push(init.headers['Last-Event-ID'] ?? null);
      // First attempt dies after two chunks; the retry replays the whole turn.
      return sse(requests.length === 1 ? truncated(2) : TURN);
    },
  });
  const out = await s.send('go');
  assert.equal(out.status, 'ok');
  assert.equal(requests.length, 2, 'it tried again rather than losing the turn');
  assert.ok(requests[1], 'the retry says where it got to');
  assert.equal(container.children[0].tag, 'app-stack');
});

test('a restart discards the partial surface rather than splicing two together', async () => {
  const diagnostics = [];
  let n = 0;
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onDiagnostics: (d) => diagnostics.push(...d),
    fetchImpl: async () => sse(++n === 1 ? truncated(3) : TURN),
  });
  await s.send('go');
  // A second `surface` frame means the server started over. Appending would
  // have produced two half-dashboards concatenated.
  assert.ok(diagnostics.some((d) => d.code === 'stream_restarted'));
  const stack = container.children[0];
  assert.equal(stack.children.length, 1, 'one dashboard, not one and a half');
});

test('a stream that keeps dropping gives up rather than looping forever', async () => {
  const diagnostics = [];
  let n = 0;
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onDiagnostics: (d) => diagnostics.push(...d),
    fetchImpl: async () => { n++; return sse(truncated(1)); },
  });
  const out = await s.send('go');
  assert.equal(out.status, 'interrupted');
  assert.equal(n, 3, 'the first attempt plus two resumes');
  assert.ok(diagnostics.some((d) => d.code === 'stream_interrupted'));
});

test('an aborted turn is not retried — the user cancelled it', async () => {
  let n = 0;
  const { doc, container } = recorder();
  const controller = new AbortController();
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    fetchImpl: async () => { n++; controller.abort(); return sse(truncated(1)); },
  });
  await s.send('go', { signal: controller.signal });
  assert.equal(n, 1, 'cancelling means stop, not try harder');
});

test('a clean turn makes exactly one request', async () => {
  let n = 0;
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface', catalog, container, doc,
    schedule: (fn) => fn(),
    fetchImpl: async () => { n++; return sse(TURN); },
  });
  await s.send('go');
  assert.equal(n, 1);
});

test('by default the request is same-origin and carries no secret', async () => {
  let seen = null;
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface', catalog, container, doc,
    schedule: (fn) => fn(),
    fetchImpl: async (url, init) => { seen = { url, headers: init.headers }; return sse(TURN); },
  });
  await s.send('go');
  assert.equal(seen.url, '/api/weave/surface', 'the proxy path, not a host');
  assert.equal('x-weave-internal-token' in seen.headers, false,
    'a shared secret in a shipped build is a published secret');
});

test('the surface sent back is pruned of what nothing references', async () => {
  // A model that wrote a card and forgot to hang it off root. Handing that
  // line back next turn tells the model a component is on screen that the
  // user cannot see, and it rides along in the context forever.
  const chunks = [
    frame('surface', {}, 1),
    frame('dsl-chunk', { text: 'root = AppStack([kpi], "md")\n' }, 2),
    frame('dsl-chunk', { text: 'kpi = AppStatCard("Cost", "1", null, "up")\n' }, 3),
    frame('dsl-chunk', { text: 'stray = AppStatCard("Nobody", "0", null, "up")\n' }, 4),
    frame('end', { status: 'ok' }, 5),
  ];
  const { s, diagnostics, requests } = session(chunks);
  await s.send('build it');
  await s.send('now change it');

  const sent = requests[1].body.context.currentSurface;
  assert.ok(sent.includes('kpi = AppStatCard'), sent);
  assert.equal(sent.includes('stray'), false, sent);
  // What was stored stays the faithful record of what the model emitted.
  assert.ok(s.currentSurface.includes('stray'));
  // And the orphan is reported, not just quietly dropped.
  assert.ok(diagnostics.some((d) => d.code === 'orphaned_statement' && d.pointer === 'stray'),
    JSON.stringify(diagnostics));
});

test('a $state line goes back holding what the user set, not what the DSL declared', async () => {
  // Otherwise the revision turn reasons about the cost view while the user is
  // looking at the ops view they switched to.
  const chunks = [
    frame('surface', {}, 1),
    frame('dsl-chunk', { text: '$view = "cost"\n' }, 2),
    frame('dsl-chunk', { text: 'root = AppStatCard($view, "1", null, "up")\n' }, 3),
    frame('end', { status: 'ok' }, 4),
  ];
  const { s, requests } = session(chunks);
  await s.send('build it');
  assert.ok(s.currentSurface.includes('$view = "cost"'), s.currentSurface);

  // The user switches — which happens after the turn ended, which is exactly
  // why the rewrite cannot be done when the surface was stored.
  s.store.set('$view', 'ops');
  await s.send('now change it');
  assert.ok(requests[1].body.context.currentSurface.includes('$view = "ops"'),
    requests[1].body.context.currentSurface);
});

test('a 200 that is not an event stream is named, not retried as a drop', async () => {
  // The real shape: the control plane has no /api/weave/surface route, the
  // request falls through to the SPA fallback, and index.html comes back with
  // a 200. That used to read as a dropped connection — no frames, no terminal
  // frame — so the resume loop spent two more requests on it and reported
  // "the stream dropped", which points at the network rather than the router.
  const { doc, container } = recorder();
  const diagnostics = [];
  const statuses = [];
  let requests = 0;
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onDiagnostics: (d) => diagnostics.push(...d),
    onStatus: (x) => statuses.push(x.phase),
    fetchImpl: async () => {
      requests++;
      return new Response('<!doctype html><title>Nasiko</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });

  const out = await s.send('spend last 14 days');

  assert.equal(out.status, 'not_an_event_stream');
  assert.equal(requests, 1, 'must not burn resume attempts proving it again');
  const d = diagnostics.find((x) => x.code === 'not_an_event_stream');
  assert.ok(d, JSON.stringify(diagnostics));
  assert.match(d.message, /text\/html/);
  assert.equal(diagnostics.some((x) => x.code === 'stream_resumed'), false);
  assert.equal(diagnostics.some((x) => x.code === 'stream_interrupted'), false);
  assert.ok(statuses.includes('failed'));
});

test('an error status reports the code and what the body said', async () => {
  // The proxy answers `{error}` naming the actual problem. Reporting a bare
  // "http_error" threw that away and left the status pill as the only evidence.
  const { doc, container } = recorder();
  const diagnostics = [];
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onDiagnostics: (d) => diagnostics.push(...d),
    fetchImpl: async () => new Response(
      JSON.stringify({ error: 'weave generation is not configured on this deployment' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ),
  });

  const out = await s.send('spend last 14 days');
  assert.equal(out.status, 'http_error');
  const d = diagnostics.find((x) => x.code === 'http_error');
  assert.ok(d, JSON.stringify(diagnostics));
  assert.match(d.message, /503/);
  assert.match(d.message, /not configured on this deployment/);
});

// ── the caret across a $state write ─────────────────────────────────────────

test('typing into a filter box does not throw the caret away', async () => {
  // The bug this exists for: store.subscribe(() => paint()) means a @Set is a
  // repaint, render() is replaceChildren(), and the input being typed into is
  // destroyed by its own keystroke. One character landed and the next went
  // nowhere. Driven end to end rather than through focus.js directly, because
  // the failure was never in either half — it was that nothing joined them.
  const { doc, container } = focusRecorder();
  const dsl = [
    '$q = ""\n',
    'setQ = Action([@Set($q, $event)])\n',
    'box = AppSearch(null, null, null, null, null, null, null, null, null, null, "Filter agents", setQ)\n',
    'root = AppStack([box], "md")\n',
  ];
  const chunks = [
    frame('surface', { specVersion: '1.0', catalogVersion: catalog.catalogVersion, surfaceId: 's1' }, 1),
    ...dsl.map((t, i) => frame('dsl-chunk', { text: t }, i + 2)),
    frame('end', { status: 'ok' }, 9),
  ];
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    fetchImpl: async () => sse(chunks),
    routes: new Set(),
  });
  await s.send('a dashboard with a filter');

  const before = container.children[0].children[0];
  assert.equal(before.tag, 'app-search');

  // The user clicks into it and types one character.
  doc.activeElement = before;
  const fire = before.listeners.input?.[0] ?? before.listeners.change?.[0];
  assert.ok(fire, 'the search must carry its action listener, or there is no bug to fix');
  fire({ target: { value: 'a' }, detail: 'a' });
  await new Promise((r) => setTimeout(r, 0));

  const after = container.children[0].children[0];
  assert.notEqual(after, before, 'the repaint really did rebuild the tree');
  assert.equal(doc.activeElement, after, 'and the caret followed it to the new node');
  assert.equal(after.focusCount, 1, 'focused once, not on a loop');
});

// ── show(): a saved surface, rendered without a turn ────────────────────────
//
// Reopening a stored view is not a generation. Before this there was no way in
// that did not involve an SSE stream, so a saved dashboard had nowhere to go.

test('a stored surface renders with no request at all', async () => {
  const { doc, container } = recorder();
  let requests = 0;
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    fetchImpl: async () => { requests++; return sse([]); },
    routes: new Set(),
  });

  const out = s.show('root = AppStack([kpi], "md")\nkpi = AppStatCard("Total cost", "12.50")');
  assert.equal(requests, 0, 'reopening a view must not call the generator');
  assert.equal(container.children[0].tag, 'app-stack');
  assert.equal(container.children[0].children[0].tag, 'app-stat-card');
  assert.deepEqual(out.diagnostics, []);
});

test('show() runs the complete-only diagnostics on its single pass', async () => {
  // Mid-stream an unreferenced statement is normal — the parent has not arrived
  // yet. A stored surface has no "yet", so orphan reporting must fire on the
  // first and only pass rather than waiting for an end frame that never comes.
  const { doc, container } = recorder();
  const diagnostics = [];
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onDiagnostics: (d) => diagnostics.push(...d),
    routes: new Set(),
  });
  s.show('root = AppStack([], "md")\nstray = AppBadge("nobody references me")');
  assert.ok(diagnostics.some((d) => d.code === 'orphaned_statement'), diagnostics.map((d) => d.code).join(','));
});

test('a view saved against an older catalog says so', async () => {
  // The case this check exists for. A stored surface can outlive the catalog it
  // was generated against, and positional arguments may have been rebound
  // underneath it — so the caller gets a diagnostic rather than a plausible
  // dashboard whose columns have quietly shifted.
  const { doc, container } = recorder();
  const diagnostics = [];
  const s = createSurfaceSession({
    endpoint: '/weave/surface',
    catalog,
    container,
    doc,
    schedule: (fn) => fn(),
    onDiagnostics: (d) => diagnostics.push(...d),
    routes: new Set(),
  });
  s.show('root = AppBadge("hi")', { catalogVersion: 'aaaaaaaaaaaa' });
  const d = diagnostics.find((x) => x.code === 'catalog_version_mismatch');
  assert.ok(d, diagnostics.map((x) => x.code).join(','));
  assert.match(d.message, /aaaaaaaaaaaa/);
});

test('reopening one view after another leaves nothing of the first behind', async () => {
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface', catalog, container, doc,
    schedule: (fn) => fn(), routes: new Set(),
  });
  s.show('root = AppStack([a, b], "md")\na = AppBadge("one")\nb = AppBadge("two")');
  assert.equal(container.children[0].children.length, 2);
  s.show('root = AppBadge("only")');
  assert.equal(container.children.length, 1, 'the container holds one surface, not two');
  assert.equal(container.children[0].tag, 'app-badge');
  assert.equal(s.currentSurface, 'root = AppBadge("only")', 'and currentSurface is the one on screen');
});

test('a reopened surface is still live, not a screenshot', async () => {
  // The reason show() reuses draw() rather than rendering once and stopping.
  // A saved dashboard whose filters do nothing would be a picture of a
  // dashboard, and the difference is invisible until someone clicks.
  const { doc, container } = recorder();
  const s = createSurfaceSession({
    endpoint: '/weave/surface', catalog, container, doc,
    schedule: (fn) => fn(), routes: new Set(),
  });
  s.show([
    '$label = "before"',
    'flip = Action([@Set($label, "after")])',
    // action is the 12th positional (paramOrder ends 'aria-expanded', 'action')
    'btn = AppButton($label, "primary", null, null, null, null, null, null, null, null, null, flip)',
    'root = AppStack([btn], "md")',
  ].join('\n'));

  const button = container.children[0].children[0];
  assert.equal(button.textContent, 'before');
  button.listeners.click[0]({});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(container.children[0].children[0].textContent, 'after',
    'the Action ran and the surface repainted');
});
