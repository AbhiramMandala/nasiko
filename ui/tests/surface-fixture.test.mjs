/**
 * The preview fixture's DSL, run through the real runtime.
 *
 * `oss/weave.preview.js` shows people what a generated dashboard looks like.
 * If its DSL has drifted from what the parser and materializer actually do,
 * the fixture is showing a dashboard nobody can generate — worse than having
 * no fixture, because it looks like evidence. Importing the same constant the
 * scenario streams is what stops that.
 *
 * Also the closest thing to an end-to-end test that can run without a browser:
 * the page and the element use server-absolute `/common/...` specifiers, so
 * they are only loadable from the dev server. This covers everything below
 * them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GENERATED_DSL } from '../oss/weave.preview.js';
import { parseBuffer } from '../common/surface/parser.js';
import { materialize, buildComponentIndex } from '../common/surface/materialize.js';
import { render } from '../common/surface/render.js';
import { createStore } from '../common/surface/store.js';
import { createQueryManager } from '../common/surface/queries.js';
import { createActionRunner } from '../common/surface/actions.js';

const catalog = JSON.parse(readFileSync(new URL('../common/surface/dsl-catalog.json', import.meta.url), 'utf8'));
const index = buildComponentIndex(catalog);

/** The same recorder the renderer tests use — no DOM, just what was asked for. */
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

/** The four usage sources the fixture stubs, answering the way the real API does. */
function sources() {
  const calls = [];
  const call = async (name, ...args) => {
    calls.push([name, ...args]);
    switch (name) {
      case 'fetchUsageSummary':
        return { total_cost_usd: 12.47, request_count: 1842 };
      case 'fetchUsageHistory':
        return Array.from({ length: args[0] ?? 7 }, (_, i) => ({
          date: `2026-08-${String(i + 1).padStart(2, '0')}`,
          total_cost_usd: i + 1,
          total_tokens: 1000 * (i + 1),
        }));
      case 'fetchUsageByAgent':
        return { data: [{ agent_name: 'coding-agent', total_cost_usd: 5.62 }], total: 1 };
      default:
        throw new Error(`the tokenops scope has no source "${name}"`);
    }
  };
  return { call, calls };
}

/** Everything below the element, wired the way `surface-stream.js` wires it. */
function surface(text, { call }) {
  const diagnostics = [];
  const { doc, container } = recorder();
  const store = createStore();
  const queries = createQueryManager({ call, onDiagnostic: (d) => diagnostics.push(d) });
  let last = null;

  function walk() {
    const { statements } = parseBuffer(text);
    const out = materialize(statements, index, {
      store, queryResults: queries.results, mutationResults: queries.mutationResults,
    });
    store.initialize(out.stateDefaults);
    queries.sync(out.queries, out.mutations);
    last = out;
    return out;
  }

  const actions = createActionRunner({
    store, queries, refresh: walk, onDiagnostic: (d) => diagnostics.push(d),
  });

  function draw() {
    const out = walk();
    render(out.root, container, catalog, { doc, onDiagnostic: (d) => diagnostics.push(d) });
    return out;
  }

  return {
    draw, walk, store, queries, diagnostics, container,
    get last() { return last; },
    run: (action) => actions.run(action, last.evaluateAst),
  };
}

const TEXT = GENERATED_DSL.join('');

test('the fixture parses with no diagnostics and both prose lines separated out', () => {
  const { statements, prose } = parseBuffer(TEXT);
  assert.equal(statements.length, 16, 'every DSL line is a statement');
  assert.deepEqual(prose.map((p) => p.slice(0, 6)), ['Sure —', "Here's"]);
});

test('the fixture materializes to the dashboard it claims to show', async () => {
  const { call } = sources();
  const s = surface(TEXT, { call });
  s.draw();
  await s.queries.settled();
  const out = s.draw();

  assert.equal(out.diagnostics.length, 0, JSON.stringify(out.diagnostics));
  assert.deepEqual(out.unresolved, []);

  const stack = s.container.children[0];
  assert.equal(stack.tag, 'app-stack');
  const [heading, kpis, filters, chartCard, table] = stack.children;
  assert.equal(heading.tag, 'app-text');
  assert.equal(kpis.tag, 'app-stat-row');
  assert.equal(filters.tag, 'app-row');
  assert.equal(chartCard.tag, 'app-card');
  assert.equal(chartCard.children[0].tag, 'app-chart', 'the chart is inside the card, not beside it');
  assert.equal(table.tag, 'app-table');
});

test('the headline metrics get the real numbers, through a json attribute', async () => {
  const { call } = sources();
  const s = surface(TEXT, { call });
  s.draw();
  await s.queries.settled();
  const out = s.draw();

  // The strip takes its metrics as data, not as child components, so this is
  // also the proof that a Query reference resolves inside a json literal —
  // the whole reason AppStatRow is usable for live figures at all.
  assert.deepEqual(out.root.children[1].props.items, [
    { label: 'Total cost', value: 12.47 },
    { label: 'Requests', value: 1842 },
  ]);

  // This test used to lock a bug in Weave's own agent.yaml: AppStatCard's third
  // positional is `delta`, not `trend`, so a generation writing "up" there set
  // the delta slot and rendered no arrow. The preview no longer builds a row of
  // cards at all — a strip of headline metrics is what AppStatRow is for — so
  // the positional trap is gone from this fixture by construction rather than
  // by being watched. The card's own positions are covered in
  // surface-materialize.test.mjs.
  const rendered = s.container.children[0].children[1];
  assert.equal(rendered.tag, 'app-stat-row');
  assert.equal(rendered.children.length, 0, 'the metrics are data, not child components');
});

test('one summary fetch serves both cards', async () => {
  const { call, calls } = sources();
  const s = surface(TEXT, { call });
  s.draw();
  await s.queries.settled();
  assert.equal(calls.filter((c) => c[0] === 'fetchUsageSummary').length, 1);
});

test('the paginated source is read through its dot-path', async () => {
  const { call } = sources();
  const s = surface(TEXT, { call });
  s.draw();
  await s.queries.settled();
  assert.deepEqual(s.queries.results.get('agentRows'), [{ agent_name: 'coding-agent', total_cost_usd: 5.62 }]);
});

test('the chart gets a plucked array of numbers, not the rows', async () => {
  const { call } = sources();
  const s = surface(TEXT, { call });
  s.draw();
  await s.queries.settled();
  const out = s.draw();
  const chart = out.root.children[3].children[0];
  assert.deepEqual(chart.data, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    'AppChart(historyQ.total_cost_usd) is an array pluck — Worked Example 2c');
});

test('the 7-day button re-fetches with 7', async () => {
  const { call, calls } = sources();
  const s = surface(TEXT, { call });
  s.draw();
  await s.queries.settled();
  s.draw();
  assert.deepEqual(calls.filter((c) => c[0] === 'fetchUsageHistory'), [['fetchUsageHistory', 14]]);

  await s.run(s.last.evaluateAst({ k: 'Ref', n: 'showSeven' }, null));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'fetchUsageHistory'),
    [['fetchUsageHistory', 14], ['fetchUsageHistory', 7]],
  );
  assert.equal(s.store.get('$days'), 7);
  assert.equal(s.queries.results.get('historyQ').length, 7);
});

test('the filter buttons carry a click handler each', async () => {
  const { call } = sources();
  const s = surface(TEXT, { call });
  s.draw();
  await s.queries.settled();
  s.draw();
  const [seven, fourteen] = s.container.children[0].children[2].children;
  assert.equal(seven.tag, 'app-button');
  assert.equal(seven.attrs.text ?? seven.textContent, '7 days');
  assert.equal(seven.listeners.click?.length, 1, 'an action-bearing button with no listener is a dead button');
  assert.equal(fourteen.listeners.click?.length, 1);
});

test('every source the fixture names is one the tokenops manifest allows', () => {
  // Weave's dashboard_data_sources.json is the security boundary; naming
  // anything outside it here would preview a dashboard the backend refuses.
  const ALLOWED = new Set([
    'fetchTokenopsDashboard', 'fetchUsageSummary', 'fetchUsageHistory',
    'fetchUsageByAgent', 'fetchUsageByModel',
  ]);
  const { statements } = parseBuffer(TEXT);
  const out = materialize(statements, index, {});
  for (const q of out.queries) assert.ok(ALLOWED.has(q.source), `"${q.source}" is not in the tokenops scope`);
  assert.ok(out.queries.length >= 4);
});
