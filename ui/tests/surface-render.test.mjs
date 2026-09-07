/**
 * The renderer, driven through an injected recording document.
 *
 * Deliberately not a fake DOM. Nothing here pretends a custom element upgrades
 * or that CSS applies — that belongs in the browser suite. What is under test
 * is the decision layer: which attributes get set and how, which values become
 * properties instead, where a slot marker goes, and which event an Action binds
 * to. Those are catalog-driven choices, and a recorder shows them exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { parseBuffer } = await import(new URL('../common/surface/parser.js', import.meta.url).href);
const { materialize, buildComponentIndex } = await import(new URL('../common/surface/materialize.js', import.meta.url).href);
const { render, renderNode } = await import(new URL('../common/surface/render.js', import.meta.url).href);

const catalog = JSON.parse(readFileSync(new URL('../common/surface/dsl-catalog.json', import.meta.url), 'utf8'));
const index = buildComponentIndex(catalog);

/** One recording element. Shared so a test can hand-build a hostile document. */
function makeEl(tag) {
  return {
    tag, attrs: {}, children: [], listeners: {}, textContent: undefined,
    setAttribute(k, v) { this.attrs[k] = v; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    replaceChildren() { this.children.length = 0; },
  };
}

/** Records every call the renderer makes, and nothing else. */
function recorder() {
  return { doc: { createElement: makeEl }, container: makeEl('div') };
}

/** DSL → materialized tree, for tests that build their own document. */
function materializeDsl(dsl) {
  return materialize(parseBuffer(dsl).statements, index);
}

/** DSL → rendered recorder tree, plus whatever diagnostics came out. */
function draw(dsl, opts = {}) {
  const { doc, container } = recorder();
  const diagnostics = [];
  const fired = [];
  const out = materialize(parseBuffer(dsl).statements, index, opts.ctx);
  render(out.root, container, catalog, {
    doc,
    onDiagnostic: (d) => diagnostics.push(d),
    onAction: (a, el) => fired.push({ action: a, el }),
  });
  return { el: container.children[0], container, diagnostics, fired, materialized: out };
}
const codes = (d) => d.map((x) => x.code);

// ── attributes ──────────────────────────────────────────────────────────────

test('a truthy boolean is present and empty; a falsy one is absent entirely', () => {
  // `search="false"` would read as true to every hasAttribute check inside the
  // component — presence is the whole meaning of a boolean attribute.
  const on = draw('root = AppTable([], 10, "pages", true)');
  assert.equal(on.el.attrs.search, '');
  const off = draw('root = AppTable([], 10, "pages", false)');
  assert.equal(off.el.hasAttribute('search'), false);
});

test('a bad enum value falls back to the catalog default and is reported', () => {
  const { el, diagnostics } = draw('root = AppStack([], "enormous")');
  assert.equal(el.attrs.gap, 'md', 'dropping it instead would collapse the layout');
  assert.deepEqual(codes(diagnostics), ['enum_violation']);
});

test('a json attribute is serialised', () => {
  const { el } = draw('root = AppStatRow([{label: "Cost", value: "12"}])');
  assert.equal(el.attrs.items, '[{"label":"Cost","value":"12"}]');
});

test('numbers and strings are written as text', () => {
  const { el } = draw('root = AppStatCard("Total", 12.5)');
  assert.deepEqual([el.attrs.label, el.attrs.value], ['Total', '12.5']);
});

test('a null prop is omitted rather than written as "null"', () => {
  const { el } = draw('root = AppStatCard("Total", "12", null, "up")');
  assert.equal(el.hasAttribute('delta'), false);
  assert.equal(el.attrs.trend, 'up');
});

test('style and class can never be set from a surface', () => {
  const node = { type: 'element', tag: 'app-stack', props: { style: 'color:red', class: 'x' }, children: [] };
  const { doc } = recorder();
  const diagnostics = [];
  const el = renderNode(node, catalog, { doc, onDiagnostic: (d) => diagnostics.push(d) });
  assert.deepEqual(el.attrs, {});
  assert.deepEqual(codes(diagnostics), ['denied_attribute', 'denied_attribute']);
});

// ── text, data, action ──────────────────────────────────────────────────────

test('textParam becomes text content, never an attribute', () => {
  // textContent by construction, so nothing a model writes here can be markup.
  const { el } = draw('root = AppButton("Save & <b>go</b>", "primary")');
  assert.equal(el.textContent, 'Save & <b>go</b>');
  assert.equal(el.hasAttribute('text'), false);
});

test('app-table rows arrive as a fetcher on dataFn, with no registry write', () => {
  // The prototype registered a synthetic source in the app-wide data-sources
  // registry on every render pass and never removed it. A property assignment
  // has no shared namespace to leak into.
  const { el } = draw('root = AppTable([{model: "gpt-4o", cost: 1}], 10)');
  assert.equal(el.hasAttribute('data-fn'), false);
  assert.equal(typeof el.dataFn, 'function');
  return el.dataFn().then((r) => {
    assert.deepEqual(r, { data: [{ model: 'gpt-4o', cost: 1 }], total: 1 });
  });
});

test('app-chart data is passed through on a property, both shapes intact', () => {
  const canvas = draw(`rows = [{date: "d1", cost: 2}]
root = AppChart({labels: rows.date, datasets: [{label: "Cost", data: rows.cost}]}, "line")`);
  assert.deepEqual(canvas.el.data, { labels: ['d1'], datasets: [{ label: 'Cost', data: [2] }] });
  assert.equal(canvas.el.hasAttribute('data'), false);

  const rows = draw('root = AppChart([{label: "a", value: 1}], "hbar")');
  assert.deepEqual(rows.el.data, [{ label: 'a', value: 1 }]);
});

test('an Action binds to click on a button and to change on a select', () => {
  const btn = draw(`root = AppButton("Go", "primary", null, null, null, null, null, null, null, null, null, act)
act = Action([@Set($v, 1)])`);
  assert.deepEqual(Object.keys(btn.el.listeners), ['click']);
  btn.el.listeners.click[0]();
  assert.equal(btn.fired.length, 1);
  assert.deepEqual(btn.fired[0].action.steps.map((s) => s.kind), ['set']);

  const sel = draw(`root = AppSelect(null, null, "Range", null, null, null, null, null, null, null, null, act)
act = Action([@Set($v, 1)])`);
  assert.deepEqual(Object.keys(sel.el.listeners), ['change'], 'a component with its own change event means that');
});

test('no on* attribute is ever written for an action', () => {
  const { el } = draw(`root = AppButton("Go", "primary", null, null, null, null, null, null, null, null, null, act)
act = Action([@Set($v, 1)])`);
  assert.deepEqual(Object.keys(el.attrs).filter((k) => k.startsWith('on')), []);
});

// ── slots ───────────────────────────────────────────────────────────────────

test('a slot marker uses the attribute that parent actually reads', () => {
  // Not uniform: app-modal reads data-slot, app-card reads slot.
  const modal = draw(`root = AppModal([f], "Edit")
f = Slot("footer", b)
b = AppButton("Save", "primary")`);
  assert.equal(modal.el.children[0].attrs['data-slot'], 'footer');
  assert.equal(modal.el.children[0].hasAttribute('slot'), false);
});

test('an unknown slot still renders the child, and reports', () => {
  const { el, diagnostics } = draw(`root = AppModal([f], "Edit")
f = Slot("nowhere", b)
b = AppButton("Save", "primary")`);
  assert.equal(el.children.length, 1, 'a misplaced button beats a missing one');
  assert.deepEqual(codes(diagnostics), ['unknown_slot']);
});

// ── tree and failure ────────────────────────────────────────────────────────

test('children render in order and nest', () => {
  const { el } = draw(`root = AppStack([a, b], "md")
a = AppBadge("one")
b = AppRow([c], "sm")
c = AppBadge("two")`);
  assert.deepEqual(el.children.map((x) => x.tag), ['app-badge', 'app-row']);
  assert.equal(el.children[1].children[0].textContent, 'two');
});

test('rendering replaces the container rather than appending to it', () => {
  const { doc, container } = recorder();
  container.appendChild({ tag: 'stale' });
  const out = materialize(parseBuffer('root = AppBadge("fresh")').statements, index);
  render(out.root, container, catalog, { doc });
  assert.deepEqual(container.children.map((c) => c.tag), ['app-badge']);
});

test('a null root clears the container and draws nothing', () => {
  const { doc, container } = recorder();
  container.appendChild({ tag: 'stale' });
  render(null, container, catalog, { doc });
  assert.deepEqual(container.children, []);
});

test('a component missing from the catalog is skipped, siblings survive', () => {
  const node = {
    type: 'element', tag: 'app-stack', props: {}, children: [
      { type: 'element', tag: 'app-nonesuch', props: {}, children: [] },
      { type: 'element', tag: 'app-badge', props: {}, text: 'alive', children: [] },
    ],
  };
  const { doc } = recorder();
  const diagnostics = [];
  const el = renderNode(node, catalog, { doc, onDiagnostic: (d) => diagnostics.push(d) });
  assert.deepEqual(el.children.map((c) => c.tag), ['app-badge']);
  assert.deepEqual(codes(diagnostics), ['unknown_component_type']);
});

test('Worked Example 1 renders the whole tree with its real values', () => {
  const { el, diagnostics } = draw(`root = AppStack([kpis], "md")
kpis = AppRow([kpiCost, kpiCount], "md")
totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
requestCountQ = Query("fetchUsageSummary", [], 0, "request_count")
kpiCost = AppStatCard("Total cost", totalCostQ, null, "up")
kpiCount = AppStatCard("Requests", requestCountQ, null, "neutral")`,
  { ctx: { queryResults: new Map([['totalCostQ', 12.5], ['requestCountQ', 342]]) } });

  const [cost, count] = el.children[0].children;
  assert.deepEqual([cost.attrs.label, cost.attrs.value, cost.attrs.trend], ['Total cost', '12.5', 'up']);
  assert.deepEqual([count.attrs.label, count.attrs.value], ['Requests', '342']);
  assert.deepEqual(diagnostics, []);
});

// ── The error boundary ──────────────────────────────────────────────────────
// A generated tree meets attribute combinations nobody would hand-write, so
// "a component threw" is a normal event here, not an exceptional one.

test('a component that throws on construction costs its node, not the surface', () => {
  const diagnostics = [];
  const doc = {
    createElement(tag) {
      if (tag === 'app-badge') throw new TypeError('boom in constructor');
      return makeEl(tag);
    },
  };
  const container = makeEl('div');
  const out = materializeDsl(`bad = AppBadge("nope")
good = AppStatCard("Total", "12")
root = AppStack([bad, good], "md")`);
  render(out.root, container, catalog, { doc, onDiagnostic: (d) => diagnostics.push(d) });

  const stack = container.children[0];
  assert.equal(stack.tag, 'app-stack', 'the surface still rendered');
  assert.deepEqual(stack.children.map((c) => c.tag), ['app-stat-card'],
    'the sibling survives — the blast radius is the node that threw');
  const d = diagnostics.find((x) => x.code === 'component_threw');
  assert.ok(d);
  assert.match(d.message, /app-badge/);
  assert.match(d.message, /boom in constructor/);
});

test('a component that throws on append is caught too', () => {
  const diagnostics = [];
  const doc = {
    createElement(tag) {
      const el = makeEl(tag);
      if (tag === 'app-badge') el.appendChild = () => { throw new Error('boom in connectedCallback'); };
      return el;
    },
  };
  const container = makeEl('div');
  const out = materializeDsl(`inner = AppStatCard("Total", "12")
bad = AppBadge("nope")
root = AppStack([bad], "md")`);
  render(out.root, container, catalog, { doc, onDiagnostic: (d) => diagnostics.push(d) });
  assert.equal(container.children.length, 1, 'the root still attached');
});

test('a throwing root leaves the container empty and says why', () => {
  const diagnostics = [];
  const doc = { createElement(tag) { throw new Error('everything is broken'); } };
  const container = makeEl('div');
  const out = materializeDsl('root = AppStack([], "md")');
  render(out.root, container, catalog, { doc, onDiagnostic: (d) => diagnostics.push(d) });
  assert.equal(container.children.length, 0);
  assert.ok(diagnostics.some((d) => d.code === 'component_threw'));
});

// ── The accessibility floor ─────────────────────────────────────────────────
// A model composes trees nobody reviews, and an unnamed control passes a
// sighted glance perfectly. These are the cases it produces by default.

test('a button with text is named', () => {
  const { diagnostics } = draw('root = AppButton("Delete agent", "danger")');
  assert.equal(codes(diagnostics).includes('missing_accessible_name'), false);
});

test('a button with no text and no aria-label is reported', () => {
  const { diagnostics } = draw('root = AppButton(null, "danger")');
  assert.ok(codes(diagnostics).includes('missing_accessible_name'));
});

test('an icon-only button needs aria-label even when it has text', () => {
  // icon-only squares the control and hides the label, so text stops being the
  // accessible name — the one case where "it has text" is the wrong answer.
  const withText = draw('root = AppButton("Delete", "danger", "md", true)');
  assert.ok(codes(withText.diagnostics).includes('missing_accessible_name'));

  const labelled = draw('root = AppButton("Delete", "danger", "md", true, null, false, false, "button", "Delete agent")');
  assert.equal(codes(labelled.diagnostics).includes('missing_accessible_name'), false);
});

test('a search box with no aria-label is reported', () => {
  const { diagnostics } = draw('root = AppSearch("Find an agent")');
  assert.ok(codes(diagnostics).includes('missing_accessible_name'),
    'a placeholder is not a name — it is announced inconsistently and vanishes on the first keystroke');
});

test('a non-interactive component is not asked for a name', () => {
  const { diagnostics } = draw('root = AppStack([], "md")');
  assert.equal(codes(diagnostics).includes('missing_accessible_name'), false);
});

test('the diagnostic says which attributes would fix it', () => {
  const { diagnostics } = draw('root = AppButton(null, "danger")');
  const d = diagnostics.find((x) => x.code === 'missing_accessible_name');
  assert.match(d.message, /text or aria-label/);
});

// ── app-grid.columns: an integer or a named ratio, nothing else ───────────

test('an integer column count still renders', () => {
  assert.equal(draw('root = AppGrid([], 3)').el.attrs.columns, '3');
});

test('a named ratio renders — the only way to express proportion anywhere', () => {
  // app-row has no per-child sizing, so AppGrid's template string is the whole
  // mechanism. It worked all along; nothing ever told the model it existed,
  // because @attr {string|number} is collapsed to `number` in the catalog.
  assert.equal(draw('root = AppGrid([], "2fr 1fr")').el.attrs.columns, '2fr 1fr');
});

test('an unlisted template is refused rather than reaching the stylesheet', () => {
  // app-grid.js puts this straight into style.setProperty('--grid-columns', ...)
  // with no filtering, and the DSL is written by a model — so the set is closed
  // rather than "a string is fine".
  const { el, diagnostics } = draw('root = AppGrid([], "7fr 3fr")');
  assert.equal(el.attrs.columns, undefined, 'must not reach the element');
  assert.ok(codes(diagnostics).includes('template_not_allowed'), codes(diagnostics).join(','));
});

test('omitting columns leaves the responsive default in place', () => {
  // The CSS default is repeat(auto-fill, minmax(300px, 1fr)); setting columns at
  // all replaces it, so the integer and template forms are both deliberate
  // desktop shapes rather than interchangeable with omitting it.
  assert.equal(draw('root = AppGrid([])').el.attrs.columns, undefined);
});

// ── a component in a value slot ─────────────────────────────────────────────
//
// Measured, not imagined: this is what a recorded generation actually did.
// `AppCard([chartContainer], "Cost Distribution by Model")` — app-card takes
// children through slots, so its first positional is `name`, and the chart
// went into the heading. Before this diagnostic the tree came back with
// props.name set to an element node, children null, and no diagnostics at
// all; the chart was gone from the page and nothing said so.

test('a component handed to a string attribute is named, not stringified', () => {
  const { el, diagnostics } = draw([
    'chart = AppChart([], "bar")',
    'root = AppCard([chart], "Cost Distribution by Model")',
  ].join('\n'));
  assert.equal(el.attrs.name, undefined, 'a node must never reach the attribute');
  assert.ok(codes(diagnostics).includes('component_as_attribute'), codes(diagnostics).join(','));
  const d = diagnostics.find((x) => x.code === 'component_as_attribute');
  assert.match(d.message, /app-chart/, 'names what was put in the slot');
  assert.match(d.message, /slots/, 'says how app-card actually takes children');
});

test('a bare component, not only a list of them, is caught', () => {
  const { diagnostics } = draw([
    'chart = AppChart([], "bar")',
    'root = AppCard(chart)',
  ].join('\n'));
  assert.ok(codes(diagnostics).includes('component_as_attribute'), codes(diagnostics).join(','));
});

test('structured data still reaches a json attribute untouched', () => {
  // The check is for nodes, not for structure — `json` attributes take arrays
  // and objects by design, and narrowing that would be the cure being worse.
  const { el, diagnostics } = draw('root = AppTable([{"a": 1}], ["a"])');
  assert.ok(!codes(diagnostics).includes('component_as_attribute'), codes(diagnostics).join(','));
  assert.ok(el, 'renders');
});

// ── app-text ────────────────────────────────────────────────────────────────

test('AppText puts its text in the element, not in an attribute', () => {
  const { el } = draw('root = AppText("Spend is up 12% week over week")');
  assert.equal(el.tag, 'app-text');
  assert.equal(el.textContent, 'Spend is up 12% week over week');
  assert.deepEqual(el.attrs, {}, 'body is the default — nothing to write');
});

test('the role is the second positional, and it is a closed set', () => {
  assert.equal(draw('root = AppText("Cost overview", "title")').el.attrs.variant, 'title');
  const { el, diagnostics } = draw('root = AppText("Cost overview", "h1")');
  assert.ok(codes(diagnostics).includes('enum_violation'), codes(diagnostics).join(','));
  assert.equal(el.attrs.variant, 'body', 'falls back to the default rather than rendering unstyled');
});
