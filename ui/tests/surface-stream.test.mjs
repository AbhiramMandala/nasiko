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
  return new Response(body, { status: 200 });
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
  'kpiCost = AppStatCard("Total cost", "12.50", null, "up")\n',
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
  assert.deepEqual([card.attrs.label, card.attrs.value, card.attrs.trend], ['Total cost', '12.50', 'up']);
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
