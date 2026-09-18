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
/** Attributes the DSL actually asked for. Every generated node also carries
 *  `data-weave`, the marker weave-surface.css scopes its defaults to — it is
 *  the renderer's own, not something a statement can set or suppress. */
const authored = (el) => Object.fromEntries(
  Object.entries(el.attrs).filter(([k]) => k !== 'data-weave'));

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
  const { el } = draw('root = AppGrid([], null, "md")');
  assert.equal(el.hasAttribute('columns'), false);
  assert.equal(el.attrs.gap, 'md');
});

test('style and class can never be set from a surface', () => {
  const node = { type: 'element', tag: 'app-stack', props: { style: 'color:red', class: 'x' }, children: [] };
  const { doc } = recorder();
  const diagnostics = [];
  const el = renderNode(node, catalog, { doc, onDiagnostic: (d) => diagnostics.push(d) });
  assert.deepEqual(authored(el), {});
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

  const sel = draw(`root = AppSelect(null, null, "Range", null, null, null, null, null, null, null, null, null, act)
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
  const { el, diagnostics } = draw(`root = AppStack([heading, kpis], "md")
heading = AppText("Usage summary", "title")
totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
requestCountQ = Query("fetchUsageSummary", [], 0, "request_count")
kpis = AppStatRow([{label: "Total cost", value: totalCostQ, sub: "all time"}, {label: "Requests", value: requestCountQ}])`,
  { ctx: { queryResults: new Map([['totalCostQ', 12.5], ['requestCountQ', 342]]) } });

  const [heading, kpis] = el.children;
  assert.equal(heading.attrs.variant, 'title');
  assert.equal(heading.textContent, 'Usage summary');
  // A json attribute is serialised, not spread — the strip parses it itself.
  assert.deepEqual(JSON.parse(kpis.attrs.items), [
    { label: 'Total cost', value: 12.5, sub: 'all time' },
    { label: 'Requests', value: 342 },
  ]);
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
// Measured, not imagined. Three recorded generations tried to nest something
// in an app-card, which had no children parameter: one wrote
// `AppCard([chart], "Cost Distribution by Model")` and put the chart into
// `name`, one padded nineteen arguments at a card that takes fifteen, and one
// gave up and left the chart orphaned. app-card now leads with children, so
// the first of those is correct DSL today — but the category error it exposed
// is general, and app-empty-state still has a default slot and no children
// parameter, so it stands in here.

test('a component handed to a string attribute is named, not stringified', () => {
  const { el, diagnostics } = draw([
    'chart = AppChart([], "bar")',
    'root = AppEmptyState([chart], "No usage yet")',
  ].join('\n'));
  assert.equal(el.attrs.title, undefined, 'a node must never reach the attribute');
  assert.ok(codes(diagnostics).includes('component_as_attribute'), codes(diagnostics).join(','));
  const d = diagnostics.find((x) => x.code === 'component_as_attribute');
  assert.match(d.message, /app-chart/, 'names what was put in the slot');
  assert.match(d.message, /slots/, 'says how app-empty-state actually takes children');
});

test('a bare component, not only a list of them, is caught', () => {
  const { diagnostics } = draw([
    'chart = AppChart([], "bar")',
    'root = AppEmptyState(chart)',
  ].join('\n'));
  assert.ok(codes(diagnostics).includes('component_as_attribute'), codes(diagnostics).join(','));
});

test('and a card, which now leads with children, simply takes them', () => {
  // The other half of the same change: what used to be silent content loss is
  // the plain way to write a card. If this regresses, the diagnostic above
  // starts firing on correct DSL.
  const { el, diagnostics } = draw([
    'chart = AppChart([], "bar")',
    'root = AppCard([chart], "Cost distribution")',
  ].join('\n'));
  assert.equal(el.attrs.name, 'Cost distribution');
  assert.equal(el.children.length, 1, 'the chart is inside the card');
  assert.equal(el.children[0].tag, 'app-chart');
  assert.deepEqual(codes(diagnostics), []);
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
  assert.deepEqual(authored(el), {}, 'body is the default — nothing to write');
});

test('the role is the second positional, and it is a closed set', () => {
  assert.equal(draw('root = AppText("Cost overview", "title")').el.attrs.variant, 'title');
  const { el, diagnostics } = draw('root = AppText("Cost overview", "h1")');
  assert.ok(codes(diagnostics).includes('enum_violation'), codes(diagnostics).join(','));
  assert.equal(el.attrs.variant, 'body', 'falls back to the default rather than rendering unstyled');
});

// ── Where an unslotted child lands ──────────────────────────────────────────
// A component that accepts children does not necessarily have anywhere to put
// them. app-card, app-banner and app-toolbar declare no `default` slot, and
// the first two rewrite innerHTML when they render — so an unmarked child is
// appended by the renderer and destroyed by the component a moment later. The
// page is missing a chart, the diagnostics are empty, and the model's closing
// sentence says the chart is there.

test('a card child lands in the body slot the catalog names for it', () => {
  const { el, diagnostics } = draw('root = AppCard([c], "Cost by model")\nc = AppChart([], "donut")');
  assert.deepEqual(codes(diagnostics), []);
  assert.equal(el.children.length, 1, 'the chart is still in the card');
  assert.equal(el.children[0].attrs['data-slot'], 'body',
    'without the marker app-card wipes it on render');
});

test('an explicit Slot still wins over the catalog fallback', () => {
  const { el, diagnostics } = draw(
    'root = AppCard([s], "Agent")\ns = Slot("footer", b)\nb = AppButton("Open")');
  assert.deepEqual(codes(diagnostics), []);
  assert.equal(el.children[0].attrs['data-slot'], 'footer');
});

test('a child with nowhere to land is reported, not silently dropped', () => {
  // app-toolbar has start/end and no default. Before this the child was
  // appended unpositioned and nothing said so.
  const { diagnostics } = draw('root = AppToolbar([b])\nb = AppButton("Export")');
  assert.deepEqual(codes(diagnostics), ['children_have_nowhere_to_land']);
  assert.match(diagnostics[0].message, /Slot\("start"/, 'the message names a slot that exists');
});

test('every component that takes children can say where they go', () => {
  // The guarantee this rests on: for each `childrenParam` component the
  // catalog either declares a `default` slot or a `childrenSlot`, or the
  // renderer reports. No fourth case — a new component cannot quietly join
  // the silent-loss group.
  for (const [tag, def] of Object.entries(catalog.components)) {
    if (!def.childrenParam) continue;
    const slots = (def.slots || []).map((s) => (typeof s === 'string' ? s : s.name));
    const lands = slots.includes('default') || Boolean(def.childrenSlot);
    if (lands) continue;
    assert.ok(slots.length > 0,
      `${tag} takes children, has no default slot and no childrenSlot, and declares no slot at all`);
  }
});

// ── Positional drift ────────────────────────────────────────────────────────
// Arguments are positional, so the commonest way a generated call goes wrong
// is a RIGHT value one slot out of step, not a wrong value. The route path has
// always read it that way (non_route_value: "an argument is in the wrong
// position"); these are the same reading everywhere else.

test('an enum violation says where in the signature the value landed', () => {
  // The real failure: app-chart has 16 positional parameters (15 before the
  // failure state's `error` was appended), rule 16 asks for
  // `empty-text` on every chart, and reaching it means seven nulls in the
  // right pattern. A live generation put the empty message in `format-y2`.
  // "not one of number, currency, percent, compact, duration" is true and
  // useless — it describes the slot, not the mistake.
  const { diagnostics } = draw(
    'root = AppChart([], "line", false, "currency", "USD", null, null, "auto", '
    + 'null, null, null, null, false, "No spend in the last 7 days")');
  const enumViolation = diagnostics.find((d) => d.code === 'enum_violation');
  assert.ok(enumViolation, 'the value is still wrong for the slot it is in');
  assert.match(enumViolation.message, /argument 14 of 16/,
    'the position is what makes this actionable');
  assert.match(enumViolation.message, /out of step/);
});

test('a boolean in a text slot is reported, not rendered as the word "false"', () => {
  // The silent half of the same miscount. `empty-text="false"` shows the
  // literal word to anyone whose dashboard has no data — which is exactly
  // when that message is the only thing on screen.
  const { el, diagnostics } = draw('root = AppChart([], "line", false, "number", "USD", null, null, "auto", false)');
  assert.ok(codes(diagnostics).includes('value_in_the_wrong_slot'));
  assert.equal(el.attrs['empty-text'], undefined, 'and it is not set to "false"');
});

test('a real string in a text slot is left alone', () => {
  // The guard has to stay out of the way of the correct call — which is what
  // the same generation wrote before the prompt change that broke it.
  const { el, diagnostics } = draw(
    'root = AppChart([], "line", false, "currency", "USD", null, null, "auto", "No spend in the last 7 days")');
  assert.deepEqual(codes(diagnostics), []);
  assert.equal(el.attrs['empty-text'], 'No spend in the last 7 days');
});

test('a candidate is named only when another enum really lists that value', () => {
  // "auto" is not a chart type and IS a legend setting, so the drift is
  // legible and worth naming.
  const named = draw('root = AppChart([], "auto")');
  const msg = named.diagnostics.find((d) => d.code === 'enum_violation').message;
  assert.match(msg, /fits legend/, 'the value is a member of legend, not merely a string');
});

test('a value from a sibling component is not reported as a miscount', () => {
  // The guess this rule exists to prevent, and it was a real one. A chart of
  // token counts written `format: "tokens"` — a real format name, just one
  // AppStatRow takes and AppChart did not — was told the value "fits label,
  // which is argument 11, the call looks out of step by 7". It was not out of
  // step at all; `label` was simply the one unset string attribute.
  //
  // (app-chart takes `tokens` now, for the same reason it read as a miscount:
  // two vocabularies for one idea. So this uses another stat-only format.)
  const { diagnostics } = draw('root = AppChart([], "bar", false, "bytes")');
  const msg = diagnostics.find((d) => d.code === 'enum_violation').message;
  assert.doesNotMatch(msg, /fits/, 'no string attribute should be offered as a candidate');
  assert.match(msg, /out of step/, 'the honest answer is "you may be counting wrong"');
});
