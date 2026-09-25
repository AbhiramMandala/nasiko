/**
 * The eval harness's own checker.
 *
 * The harness judges model output, so it has to be trustworthy before its
 * verdicts mean anything — a checker that passes a broken generation is worse
 * than no checker, because it reads as evidence. These feed it DSL with faults
 * planted on purpose and assert it catches each one.
 *
 * No model and no network: the generations here are hand-written to be exactly
 * as broken as they claim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  check, evaluateGeneration, provenanceFrom, runProvenance, CASES, ALLOWED_SOURCES,
} from '../scripts/eval-generations.mjs';

/** The control-kind pair: one source, one argument, two affordances. */
const PAIR_A = CASES.find((c) => c.id === 'month-typed');
const PAIR_B = CASES.find((c) => c.id === 'month-picked');

/** The second pair, on a value no specialised control is in reach of. */
const MODEL_A = CASES.find((c) => c.id === 'model-searched');
const MODEL_B = CASES.find((c) => c.id === 'model-picked');

const GOOD = `Sure — building that now.
totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
requestsQ = Query("fetchUsageSummary", [], 0, "request_count")
costCard = AppStatCard("Total cost", totalCostQ)
reqCard = AppStatCard("Requests", requestsQ)
root = AppStack([costCard, reqCard], "md")
There you go — let me know if you want anything changed.`;

const kase = (expect) => ({ id: 't', prompt: 'p', expect });

test('a sound generation passes', () => {
  const { fail } = check(kase({ minQueries: 2, minComponents: 3 }), GOOD);
  assert.deepEqual(fail, []);
});

test('a reference to something undefined is caught', () => {
  const dsl = GOOD.replace('root = AppStack([costCard, reqCard], "md")',
                           'root = AppStack([costCard, ghostCard], "md")');
  const { fail } = check(kase({}), dsl);
  assert.ok(fail.some((f) => /ghostCard.*not defined/.test(f)), fail.join(' | '));
});

test('a source outside the scope is caught', () => {
  const dsl = GOOD.replace('"fetchUsageSummary", [], 0, "total_cost_usd"',
                           '"fetchAwsBilling", [], 0, "total"');
  const { fail } = check(kase({}), dsl);
  assert.ok(fail.some((f) => /fetchAwsBilling.*scope does not allow/.test(f)), fail.join(' | '));
});

test('a component that does not exist is caught', () => {
  const dsl = GOOD.replace('costCard = AppStatCard("Total cost", totalCostQ)',
                           'costCard = AppSparklineDeluxe("Total cost", totalCostQ)');
  const { fail } = check(kase({}), dsl);
  assert.ok(fail.length > 0, 'an invented component must not pass');
});

test('a generation with no root is caught', () => {
  const { fail } = check(kase({}), 'costCard = AppStatCard("Total", "1")\n');
  assert.ok(fail.some((f) => /no root/.test(f)));
});

test('a dashboard with no data at all is caught', () => {
  const dsl = `Here you go.
costCard = AppStatCard("Total cost", "0")
root = AppStack([costCard], "md")
Done.`;
  const { quality: fail } = check(kase({ minQueries: 1 }), dsl);
  assert.ok(fail.some((f) => /no real data/.test(f)), fail.join(' | '));
});

test('a Mutation wired to a button is caught — no write-capable source exists', () => {
  // Reachable via @Run, which is the only shape that matters: an unreachable
  // Mutation is never evaluated and never fires, so it cannot hurt anyone.
  const dsl = `Here.
del = Mutation("deleteAgent", ["a1"])
doIt = Action([@Run(del)])
btn = AppButton("Delete", "danger", "md", false, null, false, false, "button", null, null, null, doIt)
root = AppStack([btn], "md")
Done.`;
  const { quality: fail } = check(kase({}), dsl);
  assert.ok(fail.some((f) => /Mutation/.test(f)), fail.join(' | '));
});

test('a required component that never appears is caught', () => {
  const { quality: fail } = check(kase({ tags: ['app-table'] }), GOOD);
  assert.ok(fail.some((f) => /no <app-table>/.test(f)));
});

test('a greeting case fails if it builds a dashboard anyway', () => {
  const { quality: fail } = check(kase({ noSurface: true }), GOOD);
  assert.ok(fail.some((f) => /rule 11/.test(f)));
});

test('a greeting case passes on prose alone', () => {
  const { quality: fail } = check(kase({ noSurface: true }), 'I can build dashboards from your usage data.\n');
  assert.deepEqual(fail, []);
});

test('a greeting that answers with nothing is caught', () => {
  const { quality: fail } = check(kase({ noSurface: true }), '   \n');
  assert.ok(fail.some((f) => /nothing at all/.test(f)));
});

test('an out-of-scope ask may legitimately produce no surface', () => {
  const { fail } = check(kase({ allowNoSurface: true }), 'I do not have a source for AWS billing.\n');
  assert.deepEqual(fail, []);
});

test('the interactive cases ask for state and an action, not for a component', () => {
  // Asserting a specific component would make this a test of the model's
  // taste, which changes with every prompt tweak and is not a regression.
  const dsl = `Here.
$view = "cost"
costQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
showOps = Action([@Set($view, "ops")])
btn = AppButton("Ops", "primary", "md", false, null, false, false, "button", null, null, null, showOps)
card = AppStatCard("Cost", costQ)
root = AppStack([btn, card], "md")
Done.`;
  const { quality: fail } = check(kase({ minQueries: 1, minActions: 1, minStates: 1 }), dsl);
  assert.deepEqual(fail, []);
});

test('prose is separated from DSL, both directions', () => {
  const r = evaluateGeneration(GOOD);
  assert.equal(r.prose.length, 2);
  assert.equal(r.statements, 5);
});

test('every case names a scope source the manifest actually allows', () => {
  // The harness cannot be stricter than the backend, or it fails runs that are
  // correct; it cannot be looser, or it passes runs that are broken.
  //
  // Asserted as agreement with the manifest, not as a count. The count was 5
  // and the manifest moved to 7, so this test passed while the harness it
  // guards was rejecting a source the model had been told it could use —
  // a literal pinning the wrong side of the very drift it exists to catch.
  const manifest = JSON.parse(
    readFileSync(new URL('../common/surface/data-manifest.json', import.meta.url), 'utf8'),
  );
  const declared = new Set(
    Object.values(manifest.scopes ?? {}).flat().map((x) => (typeof x === 'string' ? x : x.name)),
  );
  assert.deepEqual([...ALLOWED_SOURCES].sort(), [...declared].sort());
  assert.ok(declared.size > 0, 'a manifest with no sources in scope is a generator bug');
  assert.ok(CASES.length >= 8, 'a handful of prompts is not a baseline');
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, 'ids are the fixture filenames');
});

test('a corrected mistake is shown but does not fail the case', () => {
  // The runtime repairs a whole-response default, so the dashboard is fine.
  // Failing here would report a problem the user never has, and a checker that
  // conflates "we handled it" with "it is broken" gets ignored.
  const dsl = `Here.
q = Query("fetchUsageByModel", ["", 1, 50], {data: [], total: 0}, "data")
t = AppTable(q)
root = AppStack([t], "md")
Done.`;
  const { fail, advisory } = check(kase({ minQueries: 1 }), dsl);
  assert.deepEqual(fail, []);
  assert.equal(advisory.length, 1);
  assert.match(advisory[0], /default_is_whole_response/);
});

test('a genuine breakage is still fatal', () => {
  const { fail } = check(kase({}), 'root = AppStack([ghost], "md")\n');
  assert.ok(fail.length > 0);
});

test('the checker reads severity from the manifest, not from a literal', () => {
  // The coupling this asserts is the point of the manifest. Before it, severity
  // was a three-entry Set in eval-generations.mjs, and a new code moved the
  // pass/fail line the moment it was added — twice, in the wrong direction, by
  // making a correct surface look broken.
  //
  // Reclassifying a code in gen-diagnostics.mjs must change what the checker
  // does. So: take a code the manifest calls advisory, plant it, and assert the
  // checker files it as advisory rather than as a failure — and the same for a
  // fatal one. If someone reintroduces a hardcoded list, one of these breaks.
  const manifest = JSON.parse(
    readFileSync(new URL('../common/surface/diagnostics.json', import.meta.url), 'utf8'),
  ).diagnostics;

  assert.equal(manifest.non_route_value.severity, 'advisory');
  // AppCard(children, name, status, description, tags, href, loading) — the
  // boolean lands in `href`, which is a route slot. Sixteen positions is how
  // this used to happen by accident; seven is why it now takes effort.
  const wrongSlot = `Here.
c = AppCard([], "Spend", null, null, null, false)
root = AppStack([c], "md")
Done.`;
  const shifted = check(kase({}), wrongSlot);
  assert.deepEqual(shifted.fail, [], shifted.fail.join(' / '));
  assert.match(shifted.advisory.join(' '), /non_route_value/);

  assert.equal(manifest.component_as_attribute.severity, 'fatal');
  // app-empty-state, not app-card: the card leads with children now, so that
  // call is correct DSL. What is still a category error is a component handed
  // to a component that has slots but no children parameter.
  const swallowed = `Here.
chart = AppChart([], "bar")
root = AppEmptyState([chart], "No usage yet")
Done.`;
  const lost = check(kase({}), swallowed);
  assert.match(lost.fail.join(' '), /component_as_attribute/);
});

test('an @Run whose own state is not a Query argument is caught', () => {
  // The wiring mistake the toolbar worked example caused, in miniature. The
  // agent search filters rows already fetched, which is right for a source
  // with no name argument — but the @Run came along from the server-side
  // shape it was adapted from, so every keystroke refetches identical data.
  // Nothing else in the harness notices: it renders, it has no diagnostic,
  // and the screen does not move.
  const refetchesNothing = `Here.
$q = ""
setQ = Action([@Set($q, $event), @Run(rowsQ)])
box = AppSearch("md", null, false, false, "Search agents...", $q, null, null, null, null, null, setQ)
rowsQ = Query("fetchTokenopsDashboard", [{}], {attributions: {rows: []}}, "data")
rows = @Filter(rowsQ.attributions.rows, "agent_name", "contains", $q)
table = AppTable(rows, 25, "pages", false)
root = AppStack([box, table], "md")
Done.`;
  const caught = check(kase({}), refetchesNothing);
  assert.match(caught.quality.join(' '), /setQ re-runs rowsQ/);

  // The same surface with the @Run dropped is correct and must stay silent —
  // writing $q alone already repaints, and @Filter re-evaluates against it.
  const correct = refetchesNothing.replace(', @Run(rowsQ)', '');
  assert.deepEqual(check(kase({}), correct).quality, []);

  // A state that IS an argument earns its @Run.
  const serverSide = `Here.
$range = "7d"
setRange = Action([@Set($range, $event), @Run(rowsQ)])
picker = AppSegmentedControl([{value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $range, "md", false, null, "Range", null, setRange)
rowsQ = Query("fetchTokenopsDashboard", [{range: $range}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([picker, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), serverSide).quality, []);

  // A Refresh button is a bare @Run with no @Set at all, and is exactly right.
  const refresh = `Here.
again = Action([@Run(rowsQ)])
btn = AppButton("Refresh", "secondary", null, null, null, null, null, null, null, null, null, again)
rowsQ = Query("fetchTokenopsDashboard", [{}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([btn, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), refresh).quality, []);

  // One state in the arguments justifies the @Run for every other set in the
  // same Action — flagging that would be a taste assertion, not a defect.
  const mixed = `Here.
$range = "7d"
$dense = false
both = Action([@Set($range, $event), @Set($dense, true), @Run(rowsQ)])
picker = AppSegmentedControl([{value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $range, "md", false, null, "Range", null, both)
rowsQ = Query("fetchTokenopsDashboard", [{range: $range}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([picker, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), mixed).quality, []);
});

test('a free-text control wired to an exactly-matched argument is caught', () => {
  // The defect: AppSearch hands whatever was typed to an argument the source
  // matches exactly, so a partial name returns nothing and the table reads as
  // "no usage" rather than as a wiring mistake. Generated twice in a row with
  // no diagnostic, which is why the harness needed its own eye for it.
  const freeTextIntoId = `Here.
$agent = ""
setAgent = Action([@Set($agent, $event), @Run(rowsQ)])
box = AppSearch("md", null, false, false, "Search agents...", $agent, null, null, null, null, null, setAgent)
rowsQ = Query("fetchTokenopsDashboard", [{agentId: $agent}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([box, table], "md")
Done.`;
  const caught = check(kase({}), freeTextIntoId);
  assert.deepEqual(caught.fail, [], caught.fail.join(' / '));
  assert.match(caught.advisory.join(' '), /semantic_control_argument_mismatch/);
  assert.match(caught.advisory.join(' '), /agentId/);

  // `model` is the same shape and was generated alongside it.
  const intoModel = freeTextIntoId.replace(/agentId/g, 'model');
  assert.match(check(kase({}), intoModel).advisory.join(' '), /semantic_control_argument_mismatch/);

  // A picker's value comes from a set the component defines, so the same
  // argument is correct — this is what the fix looks like, and flagging it
  // would make the check unusable.
  const pickerIntoId = `Here.
$agent = ""
setAgent = Action([@Set($agent, $event), @Run(rowsQ)])
picker = AppSelect("md", null, "Agent", null, "All agents", ["a-1", "a-2"], false, false, "agentId", "Select agent", $agent, false, setAgent)
rowsQ = Query("fetchTokenopsDashboard", [{agentId: $agent}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([picker, table], "md")
Done.`;
  assert.doesNotMatch(check(kase({}), pickerIntoId).advisory.join(' '), /semantic_control_argument_mismatch/);

  // Free text over rows already fetched is what free text is FOR. No query
  // argument is involved, so there is nothing to mismatch.
  const freeTextIntoFilter = `Here.
$q = ""
setQ = Action([@Set($q, $event)])
box = AppSearch("md", null, false, false, "Search dates...", $q, null, null, null, null, null, setQ)
rowsQ = Query("fetchUsageHistory", [7], [])
rows = @Filter(rowsQ, "date", "contains", $q)
table = AppTable(rows, 25, "pages", false)
root = AppStack([box, table], "md")
Done.`;
  assert.doesNotMatch(check(kase({}), freeTextIntoFilter).advisory.join(' '), /semantic_control_argument_mismatch/);

  // An argument the manifest describes as a search argument is the one place
  // free text belongs server-side. Positional, so the argument is identified
  // by its order rather than by a key.
  const freeTextIntoSearchArg = `Here.
$q = ""
setQ = Action([@Set($q, $event), @Run(rowsQ)])
box = AppSearch("md", null, false, false, "Search agents...", $q, null, null, null, null, null, setQ)
rowsQ = Query("fetchUsageByAgent", [$q, 1, 20], [], "data")
table = AppTable(rowsQ, 20, "pages", true)
root = AppStack([box, table], "md")
Done.`;
  assert.doesNotMatch(check(kase({}), freeTextIntoSearchArg).advisory.join(' '), /semantic_control_argument_mismatch/);

  // A picker into an enum argument, which is most of what these dashboards do.
  const pickerIntoEnum = `Here.
$range = "7d"
setRange = Action([@Set($range, $event), @Run(rowsQ)])
picker = AppSegmentedControl([{value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $range, "md", false, null, "Range", null, setRange)
rowsQ = Query("fetchTokenopsDashboard", [{range: $range}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([picker, table], "md")
Done.`;
  assert.doesNotMatch(check(kase({}), pickerIntoEnum).advisory.join(' '), /semantic_control_argument_mismatch/);
});

test('a Query argument whose setter never re-runs it is caught', () => {
  // The mirror of the redundant-@Run case, and the half nothing could see.
  // `$agentFilter` IS one of the Query's arguments, so typing has to refetch —
  // but `@Run` forces and `$state` does not, so this filter moves the store
  // and leaves the table showing data fetched under the old value. It
  // renders, nothing is unresolved, no diagnostic fires.
  const inertFilter = `Here.
$agent = ""
$range = "7d"
setAgent = Action([@Set($agent, $event)])
setRange = Action([@Set($range, $event), @Run(rowsQ)])
box = AppSearch("md", null, false, false, "Search agents...", $agent, null, null, null, null, null, setAgent)
picker = AppSegmentedControl([{value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $range, "md", false, null, "Range", null, setRange)
rowsQ = Query("fetchTokenopsDashboard", [{range: $range, agentId: $agent}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([box, picker, table], "md")
Done.`;
  const caught = check(kase({}), inertFilter);
  assert.match(caught.quality.join(' '), /setAgent sets \$agent, which rowsQ reads as an argument/);
  // The range control is wired correctly and must not be named.
  assert.doesNotMatch(caught.quality.join(' '), /setRange/);

  // Adding the @Run is the fix, and silences it.
  const fixed = inertFilter.replace(
    'setAgent = Action([@Set($agent, $event)])',
    'setAgent = Action([@Set($agent, $event), @Run(rowsQ)])',
  );
  assert.deepEqual(check(kase({}), fixed).quality, []);

  // Taking the state out of the arguments and filtering what is already
  // fetched is the other fix, and must not trip the redundant-@Run half.
  const clientSide = `Here.
$agent = ""
$range = "7d"
setAgent = Action([@Set($agent, $event)])
setRange = Action([@Set($range, $event), @Run(rowsQ)])
box = AppSearch("md", null, false, false, "Search agents...", $agent, null, null, null, null, null, setAgent)
picker = AppSegmentedControl([{value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $range, "md", false, null, "Range", null, setRange)
rowsQ = Query("fetchTokenopsDashboard", [{range: $range}], {attributions: {rows: []}}, "data")
rows = @Filter(rowsQ.attributions.rows, "agent_name", "contains", $agent)
table = AppTable(rows, 25, "pages", false)
root = AppStack([box, picker, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), clientSide).quality, []);
});

test('the missing-@Run check does not invent defects', () => {
  // A state nothing sets is a constant with an initial value. There is no
  // Action that forgot anything.
  const constantArg = `Here.
$range = "7d"
rowsQ = Query("fetchTokenopsDashboard", [{range: $range}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([table], "md")
Done.`;
  assert.deepEqual(check(kase({}), constantArg).quality, []);

  // Type, then submit: the input sets the state and a Search button carries
  // the @Run. That button sets none of the Query's state arguments, which is
  // what a bare trigger looks like, and it makes the surface correct.
  const typeThenSubmit = `Here.
$q = ""
setQ = Action([@Set($q, $event)])
runIt = Action([@Run(rowsQ)])
box = AppSearch("md", null, false, false, "Search agents...", $q, null, null, null, null, null, setQ)
btn = AppButton("Search", "primary", null, null, null, null, null, null, null, null, null, runIt)
rowsQ = Query("fetchUsageByAgent", [$q, 1, 20], [], "data")
table = AppTable(rowsQ, 20, "pages", true)
root = AppStack([box, btn, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), typeThenSubmit).quality, []);
});

test('an @Filter on a field the source does not return is caught', () => {
  // The fleet rows carry agent_name and no model at all — AgentFinopsRow,
  // observability/service.rs. Filtering on "model" matches nothing on every
  // keystroke and the table renders as though the period had no usage, with
  // no error at any layer. Three of twelve A/B generations did this.
  const invented = `Here.
$model = ""
setModel = Action([@Set($model, $event)])
box = AppSearch("md", null, false, false, "Search models...", $model, null, null, null, null, null, setModel)
rowsQ = Query("fetchTokenopsDashboard", [{}], {attributions: {rows: []}}, "data")
rows = @Filter(rowsQ.attributions.rows, "model", "contains", $model)
table = AppTable(rows, 25, "pages", false)
root = AppStack([box, table], "md")
Done.`;
  assert.match(check(kase({}), invented).quality.join(' '),
    /filters on "model", which fetchTokenopsDashboard does not return/);

  // agent_name is real on the same source, so the same shape passes.
  assert.deepEqual(check(kase({}), invented.replace(/"model", "contains"/, '"agent_name", "contains"')).quality, []);

  // The same field IS real on the by-model source, so this must stay silent.
  const byModel = `Here.
$model = ""
setModel = Action([@Set($model, $event)])
box = AppSearch("md", null, false, false, "Search models...", $model, null, null, null, null, null, setModel)
rowsQ = Query("fetchUsageByModel", ["", 1, 20], [], "data")
rows = @Filter(rowsQ, "model", "contains", $model)
table = AppTable(rows, 20, "pages", true)
root = AppStack([box, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), byModel).quality, []);
});

test('the filter-field check follows chains and guesses at nothing', () => {
  // A @Filter over a @Filter inherits its source — the second link has to be
  // checked against the same response, not skipped.
  const chained = `Here.
$agent = ""
$other = ""
setAgent = Action([@Set($agent, $event)])
setOther = Action([@Set($other, $event)])
a = AppSearch("md", null, false, false, "Agent", $agent, null, null, null, null, null, setAgent)
b = AppSearch("md", null, false, false, "Other", $other, null, null, null, null, null, setOther)
rowsQ = Query("fetchTokenopsDashboard", [{}], {attributions: {rows: []}}, "data")
first = @Filter(rowsQ.attributions.rows, "agent_name", "contains", $agent)
second = @Filter(first, "provider", "contains", $other)
table = AppTable(second, 25, "pages", false)
root = AppStack([a, b, table], "md")
Done.`;
  const caught = check(kase({}), chained);
  assert.match(caught.quality.join(' '), /second filters on "provider"/);
  assert.doesNotMatch(caught.quality.join(' '), /"agent_name"/);

  // A @Filter whose first argument is not a Query cannot be resolved to a
  // source, and an unresolvable reference is left alone rather than guessed.
  const literal = `Here.
rows = @Filter([{name: "a"}, {name: "b"}], "name", "contains", "a")
table = AppTable(rows, 25, "pages", false)
root = AppStack([table], "md")
Done.`;
  assert.doesNotMatch(check(kase({}), literal).quality.join(' '), /does not return/);
});

/*
 * The positional contract (NAS-729).
 *
 * `app-input` has twenty-four positional parameters, `value` at thirteen and
 * `action` at twenty-four, and every recorded generation that reached for it
 * miscounted. One of those was scored a clean pass: twenty arguments is not
 * more than twenty-four, so no arity check fires, and the Action it named was
 * referenced, so nothing was orphaned — for a box that does nothing at all.
 *
 * A correctly wired control, and then the same control with one argument
 * moved. Every fault below is a real one that was recorded, not an invented
 * shape.
 */
/**
 * AppInput's positional slots, by name.
 *
 * Written as a builder rather than as literal calls, which is what these were
 * until the signature went from twenty-four slots to eleven (NAS-758) and
 * every fixture below silently became a call with fourteen arguments past the
 * end — testing the wrong fault, or none. A positional test that hard-codes a
 * position has to be rewritten every time the vocabulary moves, and the one
 * time it is not rewritten it keeps passing while measuring nothing.
 *
 * So the slot list is stated once and each case says which slot it is moving.
 * `extra` exists for the one fault that is only expressible past the end.
 */
const APP_INPUT_SLOTS = [
  'size', 'state', 'label', 'hint', 'required',
  'disabled', 'type', 'placeholder', 'value', 'aria-label', 'action',
];

const appInput = (over = {}, extra = []) => {
  const slots = {
    size: '"md"', state: 'null', label: '"Agent ID"', hint: 'null', required: 'false',
    disabled: 'false', type: '"text"', placeholder: 'null', value: '$agentId',
    'aria-label': 'null', action: 'setId', ...over,
  };
  return `AppInput(${[...APP_INPUT_SLOTS.map((k) => slots[k]), ...extra].join(', ')})`;
};

/** The same surface every time, with one control argument moved. */
const control = (call) => `Sure — building that now.
$agentId = ""
setId = Action([@Set($agentId, $event), @Run(rowsQ)])
idInput = ${call}
rowsQ = Query("fetchUsageByAgent", [$agentId, 1, 20], {data: [], total: 0})
table = AppTable(rowsQ.data, 20, "pages", false, null, null, "No agents")
root = AppStack([idInput, table], "md")
Done.`;

const CONTROL = control(appInput());

/** The codes the positional contract reported, in order. */
const codesFor = (dsl) => evaluateGeneration(dsl).positionalContract.map((p) => p.code);

test('a correctly bound control reports nothing', () => {
  const r = evaluateGeneration(CONTROL);
  assert.deepEqual(r.positionalContract, []);
  assert.deepEqual(check(kase({ minQueries: 1 }), CONTROL).quality, []);
});

test('an Action in the wrong slot is caught', () => {
  // Recorded twice against the old signature, silent both times. The slot it
  // lands in differs now; that it lands in one that cannot hold an Action
  // does not.
  const dsl = control(appInput({ placeholder: 'setId', action: 'null' }));
  assert.ok(codesFor(dsl).includes('action_in_wrong_slot'), codesFor(dsl).join(','));
  assert.match(check(kase({}), dsl).quality.join(' '),
    /takes its Action last, but setId is at "placeholder"/);
});

test('an Action past the end of the parameter list is caught', () => {
  const dsl = control(appInput({ action: 'null' }, ['setId']));
  assert.ok(codesFor(dsl).includes('action_dropped'), codesFor(dsl).join(','));
  assert.match(check(kase({}), dsl).quality.join(' '), /past the end of its parameter list/);
});

test('a $state in a slot that binds nothing is caught', () => {
  // The state slides off `value` into a slot that displays text and binds
  // nothing, and `value` goes null — so the box shows the id as its hint and
  // keeps nothing the user types.
  const dsl = control(appInput({ hint: '$agentId', value: 'null' }));
  const codes = codesFor(dsl);
  assert.ok(codes.includes('state_in_non_binding_slot'), codes.join(','));
  assert.match(check(kase({}), dsl).quality.join(' '), /\$agentId at "hint" \(slot 4\)/);
});

test('a control with wiring but nothing bound to value is caught', () => {
  // The Action is in the right slot and the value is simply never bound —
  // the case materialize.js's `uncontrolled_input` covers only when the
  // action slot happens to be the one that was filled.
  const dsl = control(appInput({ value: 'null' }));
  const codes = codesFor(dsl);
  assert.ok(codes.includes('control_never_bound'), codes.join(','));
  assert.match(check(kase({}), dsl).quality.join(' '), /not read back from a \$state/);
});

test("a state's name in quotes is not the state", () => {
  const dsl = control(appInput({ value: '"$agentId"' }));
  const codes = codesFor(dsl);
  assert.ok(codes.includes('state_as_literal'), codes.join(','));
  assert.match(check(kase({}), dsl).quality.join(' '), /is the state's NAME in quotes/);

  // A string that merely looks like one is left alone — the name has to be a
  // state this surface actually declares.
  const unrelated = control(appInput({ label: '"$notAState"' }));
  assert.ok(!codesFor(unrelated).includes('state_as_literal'), codesFor(unrelated).join(','));
});

test('narrower controls are not flagged, which is why only app-input ever was', () => {
  // app-search puts `value` at 6 and `action` at 12, and no recorded
  // generation has ever mis-slotted it. The check must agree.
  const search = `Here.
$q = ""
setQ = Action([@Set($q, $event), @Run(rowsQ)])
box = AppSearch("md", null, false, false, "Search agents...", $q, null, null, null, null, null, setQ)
rowsQ = Query("fetchUsageByAgent", [$q, 1, 20], {data: [], total: 0})
table = AppTable(rowsQ.data, 20, "pages", false)
root = AppStack([box, table], "md")
Done.`;
  assert.deepEqual(evaluateGeneration(search).positionalContract, []);
});

/*
 * Run provenance.
 *
 * A recorded run used to say which catalog THIS CHECKOUT held and nothing
 * about the generator, so the only way to attribute an A/B was the order the
 * containers were deployed in. The 3f experiment is inconclusive for exactly
 * that reason: the worked example was committed thirteen minutes before the
 * first "baseline" case, and the redeploy that separated the arms left no
 * trace but a network error in the middle.
 */

test('a surface event carries every provenance field, present or not', () => {
  // The payload weave_surface.rs emits, verbatim in shape.
  const full = provenanceFrom({
    catalogVersion: 'b663b6eaa08a',
    surfaceId: 's-1',
    promptDigest: '0123456789ab',
    specDigest: 'ba9876543210',
    generatorDigest: 'cafebabe0001',
    model: 'a-model',
  });
  assert.equal(full.promptDigest, '0123456789ab');
  assert.equal(full.specDigest, 'ba9876543210');
  assert.equal(full.generatorDigest, 'cafebabe0001');
  assert.equal(full.model, 'a-model');
  assert.equal(full.catalogVersion, 'b663b6eaa08a');

  // An older generator sends the two original keys. The run is recordable and
  // visibly unattributed, rather than looking like any other run.
  const old = provenanceFrom({ catalogVersion: 'b663b6eaa08a', surfaceId: 's-1' });
  assert.equal(old.promptDigest, null);
  assert.equal(old.model, null);
});

test('a run whose cases agree is one experimental condition', () => {
  const g = { promptDigest: 'aaaaaaaaaaaa', specDigest: 'bbbbbbbbbbbb', model: 'm' };
  const { generator, generatorConsistent } = runProvenance({ a: { ...g }, b: { ...g }, c: { ...g } });
  assert.equal(generatorConsistent, true);
  assert.equal(generator.promptDigest, 'aaaaaaaaaaaa');
});

test('a run recorded across a redeploy is rejected as one condition', () => {
  const { generatorConsistent, generatorSpread } = runProvenance({
    'grouped-filters': { promptDigest: 'aaaaaaaaaaaa' },
    'agent-by-id': { promptDigest: 'aaaaaaaaaaaa' },
    'paged-agent-usage': { promptDigest: 'zzzzzzzzzzzz' },
  });
  assert.equal(generatorConsistent, false);
  assert.deepEqual(generatorSpread.aaaaaaaaaaaa, ['grouped-filters', 'agent-by-id']);
  assert.deepEqual(generatorSpread.zzzzzzzzzzzz, ['paged-agent-usage']);
});

test('a case that reported no provenance is not silently folded into one that did', () => {
  const { generatorConsistent } = runProvenance({
    a: { promptDigest: 'aaaaaaaaaaaa' },
    b: { promptDigest: null },
  });
  assert.equal(generatorConsistent, false);
});

/*
 * Candidate A — the four mechanism decisions a server-paged source forces.
 *
 * `fetchUsageByAgent(query, page, limit)` returns `{data, total}`. Each of
 * the three arguments and the envelope can be answered the wrong way while
 * the surface renders perfectly, so they are read as four booleans and never
 * summed. The wrong answers below are the shapes the corpus actually
 * contains: a frozen `["", 1, 50]`, app-table's own pager, an @Filter over
 * the page that came back, and a "data" path that throws `total` away.
 */
const pagedCase = {
  id: 'paged-agent-usage',
  prompt: 'p',
  expect: { minQueries: 1, mechanism: { source: 'fetchUsageByAgent' } },
};

const SERVER_PAGED = `Sure — building that now.
$q = ""
$page = 1
setQ = Action([@Set($q, $event), @Set($page, 1), @Run(rowsQ)])
prev = Action([@Set($page, $page - 1), @Run(rowsQ)])
next = Action([@Set($page, $page + 1), @Run(rowsQ)])
rowsQ = Query("fetchUsageByAgent", [$q, $page, 20], {data: [], total: 0})
box = AppSearch("md", null, false, false, "Search agents...", $q, null, null, null, null, null, setQ)
prevBtn = AppButton("Previous", "secondary", "md", false, null, $page <= 1, false, "button", null, null, null, prev)
nextBtn = AppButton("Next", "secondary", "md", false, null, false, false, "button", null, null, null, next)
count = AppText(rowsQ.total, "body")
table = AppTable(rowsQ.data, 20, "off", false, null, null, "No agents")
root = AppStack([box, count, table, prevBtn, nextBtn], "md")
Done.`;

test('the four mechanism dimensions read a correct server-paged surface', () => {
  const { dimensions } = check(pagedCase, SERVER_PAGED);
  assert.deepEqual(
    { ...dimensions, detail: undefined },
    {
      sourceCorrect: true,
      paginationCorrect: true,
      searchMechanismCorrect: true,
      totalCorrect: true,
      detail: undefined,
    },
  );
  assert.equal(dimensions.detail.pageArg, '$page');
  assert.equal(dimensions.detail.queryArg, '$q');
});

test('a frozen page argument with app-table doing the paging is not pagination', () => {
  // `["", 1, 50]` is what every recorded generation against the sibling
  // source wrote, four times out of four.
  const dsl = SERVER_PAGED
    .replace('[$q, $page, 20]', '[$q, 1, 500]')
    .replace('AppTable(rowsQ.data, 20, "off"', 'AppTable(rowsQ.data, 20, "pages"');
  const { dimensions } = check(pagedCase, dsl);
  assert.equal(dimensions.paginationCorrect, false);
  assert.equal(dimensions.detail.pageArg, null);
  assert.equal(dimensions.detail.clientPagination, true);
  // Search is a separate decision and is still right — which is the whole
  // reason these are not one number.
  assert.equal(dimensions.searchMechanismCorrect, true);
});

test('an @Filter over the fetched page is not the search mechanism', () => {
  const dsl = SERVER_PAGED
    .replace('[$q, $page, 20]', '["", $page, 20]')
    .replace('setQ = Action([@Set($q, $event), @Set($page, 1), @Run(rowsQ)])',
             'setQ = Action([@Set($q, $event)])')
    .replace('table = AppTable(rowsQ.data, 20, "off"',
             'shown = @Filter(rowsQ.data, "agent_name", "contains", $q)\ntable = AppTable(shown, 20, "off"');
  const { dimensions } = check(pagedCase, dsl);
  assert.equal(dimensions.searchMechanismCorrect, false);
  assert.equal(dimensions.detail.clientFilter, true);
  // Pagination is untouched by the search mistake.
  assert.equal(dimensions.paginationCorrect, true);
});

test('a "data" path throws total away before anything can read it', () => {
  const dsl = SERVER_PAGED
    .replace('{data: [], total: 0})', '[], "data")')
    .replace('count = AppText(rowsQ.total, "body")', 'count = AppText(@Count(rowsQ), "body")')
    .replace('AppTable(rowsQ.data, 20', 'AppTable(rowsQ, 20');
  const { dimensions } = check(pagedCase, dsl);
  assert.equal(dimensions.totalCorrect, false);
  assert.equal(dimensions.sourceCorrect, true);
});

test('a different source is a source failure, not four failures', () => {
  const dsl = SERVER_PAGED.replace('"fetchUsageByAgent"', '"fetchTokenopsDashboard"');
  const { dimensions } = check(pagedCase, dsl);
  assert.equal(dimensions.sourceCorrect, false);
  assert.deepEqual(dimensions.detail.sourceUsed, ['fetchTokenopsDashboard']);
});

test('the mechanism dimensions never reach the pass/fail line', () => {
  // Every dimension wrong, and the surface is still sound. A case that gated
  // on the answer it measures could only ever return the answer it was given.
  const dsl = SERVER_PAGED
    .replace('"fetchUsageByAgent"', '"fetchUsageByModel"')
    .replace('[$q, $page, 20]', '["", 1, 50]')
    .replace('setQ = Action([@Set($q, $event), @Set($page, 1), @Run(rowsQ)])',
             'setQ = Action([@Set($q, $event)])')
    .replace('prev = Action([@Set($page, $page - 1), @Run(rowsQ)])', 'prev = Action([@Set($page, 1)])')
    .replace('next = Action([@Set($page, $page + 1), @Run(rowsQ)])', 'next = Action([@Set($page, 2)])')
    .replace('count = AppText(rowsQ.total, "body")', 'count = AppText(@Count(rowsQ.data), "body")');
  const { fail, dimensions } = check(pagedCase, dsl);
  assert.deepEqual(fail, []);
  assert.equal(dimensions.sourceCorrect, false);
  assert.equal(dimensions.paginationCorrect, false);
  assert.equal(dimensions.totalCorrect, false);
});

/*
 * Pagination, read against what the prompt actually asked for.
 *
 * "20 rows at a time with next and previous buttons" is four separate
 * claims, and a surface can satisfy the shape of it while satisfying none:
 * a `$page` that reaches the argument but is only ever set to 1, a page size
 * of 50, a next button that moves the state and never refetches. Each is
 * checked on its own so the baseline can say which one failed.
 *
 * Nothing here names a component. Which control fires the Action is taste;
 * that the Action moves the page by one and forces the fetch is not.
 */
const pageDetail = (dsl) => check(pagedCase, dsl).dimensions.detail;

test('page state, a page size of 20, and a step in each direction that refetches', () => {
  const { dimensions } = check(pagedCase, SERVER_PAGED);
  assert.equal(dimensions.paginationCorrect, true);
  const d = dimensions.detail;
  assert.equal(d.pageArg, '$page');
  assert.equal(d.limitResolved, 20);
  assert.equal(d.limitFrom, 'literal');
  assert.deepEqual(d.next, { action: 'next', runs: true });
  assert.deepEqual(d.prev, { action: 'prev', runs: true });
});

test('a frozen page literal is not pagination, however the buttons look', () => {
  const dsl = SERVER_PAGED.replace('[$q, $page, 20]', '[$q, 1, 20]');
  const { dimensions } = check(pagedCase, dsl);
  assert.equal(dimensions.paginationCorrect, false);
  assert.equal(dimensions.detail.pageArg, null);
  // No page argument means there is no page to step, so the buttons are not
  // read as steps at all — they move a state the fetch never sees.
  assert.equal(dimensions.detail.next.action, null);
});

test('a page size of 50 is not the 20 that was asked for', () => {
  const dsl = SERVER_PAGED.replace('[$q, $page, 20]', '[$q, $page, 50]');
  const { dimensions } = check(pagedCase, dsl);
  assert.equal(dimensions.paginationCorrect, false);
  assert.equal(dimensions.detail.limitResolved, 50);
  // Everything else about the pagination is right, which is the point of
  // reporting the parts rather than the verdict.
  assert.equal(dimensions.detail.next.runs, true);
  assert.equal(dimensions.detail.prev.runs, true);
});

test('a limit held in a state counts when the state resolves to 20', () => {
  const dsl = SERVER_PAGED
    .replace('$page = 1', '$page = 1\n$pageSize = 20')
    .replace('[$q, $page, 20]', '[$q, $page, $pageSize]');
  const { dimensions } = check(pagedCase, dsl);
  assert.equal(dimensions.detail.limitResolved, 20);
  assert.equal(dimensions.detail.limitFrom, 'state');
  assert.equal(dimensions.paginationCorrect, true);

  // …and does not, when it resolves to something else.
  const wrong = dsl.replace('$pageSize = 20', '$pageSize = 100');
  assert.equal(check(pagedCase, wrong).dimensions.paginationCorrect, false);
});

test('a next button that moves the page but never refetches is caught', () => {
  const dsl = SERVER_PAGED.replace(
    'next = Action([@Set($page, $page + 1), @Run(rowsQ)])',
    'next = Action([@Set($page, $page + 1)])',
  );
  const d = pageDetail(dsl);
  // Told apart from having no next button at all: the Action is named, and
  // the missing @Run is what is false.
  assert.equal(d.next.action, 'next');
  assert.equal(d.next.runs, false);
  assert.equal(d.prev.runs, true);
  assert.equal(check(pagedCase, dsl).dimensions.paginationCorrect, false);
});

test('a previous button that moves the page but never refetches is caught', () => {
  const dsl = SERVER_PAGED.replace(
    'prev = Action([@Set($page, $page - 1), @Run(rowsQ)])',
    'prev = Action([@Set($page, $page - 1)])',
  );
  const d = pageDetail(dsl);
  assert.equal(d.prev.action, 'prev');
  assert.equal(d.prev.runs, false);
  assert.equal(d.next.runs, true);
  assert.equal(check(pagedCase, dsl).dimensions.paginationCorrect, false);
});

test('a next button that jumps rather than steps is not a next button', () => {
  // `@Set($page, 2)` sets page two from page seven. It refetches, the table
  // changes, and it is not what "next" means.
  const dsl = SERVER_PAGED.replace('@Set($page, $page + 1)', '@Set($page, 2)');
  const d = pageDetail(dsl);
  assert.equal(d.next.action, null);
  assert.equal(d.prev.action, 'prev');
  assert.equal(check(pagedCase, dsl).dimensions.paginationCorrect, false);
});

test('a previous button that resets rather than steps is not a previous button', () => {
  const dsl = SERVER_PAGED.replace('@Set($page, $page - 1)', '@Set($page, 1)');
  const d = pageDetail(dsl);
  assert.equal(d.prev.action, null);
  assert.equal(d.next.action, 'next');
  assert.equal(check(pagedCase, dsl).dimensions.paginationCorrect, false);
});

test('a guarded step still steps', () => {
  // Clamping at page one is a better surface, not a different mechanism.
  const dsl = SERVER_PAGED.replace('@Set($page, $page - 1)', '@Set($page, @Max($page - 1, 1))');
  assert.equal(check(pagedCase, dsl).dimensions.paginationCorrect, true);
});

test('an omitted limit is the service default, and says so', () => {
  // usage-service.js:111 — `limit ?? 20`. Twenty rows really do come back,
  // so it counts; `limitFrom` keeps it tellable apart from a decision.
  const dsl = SERVER_PAGED.replace('[$q, $page, 20]', '[$q, $page]');
  const d = pageDetail(dsl);
  assert.equal(d.limitResolved, 20);
  assert.equal(d.limitFrom, 'service default');
  assert.equal(check(pagedCase, dsl).dimensions.paginationCorrect, true);
});

test('the tightened pagination check leaves the other three dimensions alone', () => {
  // Pagination wrong in all four ways at once; source, search and total
  // untouched. A composite score could not say this.
  const dsl = SERVER_PAGED
    .replace('[$q, $page, 20]', '[$q, 1, 50]')
    .replace('next = Action([@Set($page, $page + 1), @Run(rowsQ)])', 'next = Action([@Set($page, 2)])')
    .replace('prev = Action([@Set($page, $page - 1), @Run(rowsQ)])', 'prev = Action([@Set($page, 1)])');
  const { fail, dimensions } = check(pagedCase, dsl);
  assert.equal(dimensions.paginationCorrect, false);
  assert.equal(dimensions.sourceCorrect, true);
  assert.equal(dimensions.searchMechanismCorrect, true);
  assert.equal(dimensions.totalCorrect, true);
  assert.deepEqual(fail, []);
});

/*
 * The control-kind pair.
 *
 * `fetchSpendCalendar.month` is REQUIRED and is a plain string sent verbatim,
 * so typing "2026-08" and picking "2026-08" are the same request, and the
 * response carries only the month asked for — there is no client-side
 * mechanism to choose instead. Which leaves exactly one thing to get right,
 * and these assert that the evaluator can see it.
 *
 * The distinction that matters here is between an `@Run` that exists and an
 * `@Run` that can fire. On `agent-by-id`, five runs authored the token inside
 * an Action that had landed in `pattern`, `step`, `list` or `aria-label`, or
 * past the end of a 24-slot signature. Counting tokens said 5/10; counting
 * reachable refetches said 0/10.
 */
const TYPED = `Sure — building that now.
root = AppStack([heading, monthBox, chart], "md")
heading = AppText("Daily spend", "title")
$month = "2026-09"
setMonth = Action([@Set($month, $event), @Run(daysQ)])
monthBox = AppSearch("md", null, false, false, "YYYY-MM", $month, null, null, null, null, "Month", setMonth)
daysQ = Query("fetchSpendCalendar", [{month: $month}], {days: []}, "data")
chart = AppChart({labels: daysQ.days.date, datasets: [{label: "Spend (USD)", data: daysQ.days.spend_usd}]}, "bar", false, "currency", "USD", null, null, "auto", "No spend for that month")
Done.`;

const PICKED = TYPED.replace(
  'monthBox = AppSearch("md", null, false, false, "YYYY-MM", $month, null, null, null, null, "Month", setMonth)',
  'monthPicker = AppSegmentedControl([{value: "2026-07", label: "Jul"}, {value: "2026-08", label: "Aug"}, {value: "2026-09", label: "Sep"}], $month, "md", false, null, null, "Month", setMonth)',
).replace('[heading, monthBox, chart]', '[heading, monthPicker, chart]');

const four = (c) => [c.sourceCorrect, c.argumentCorrect, c.controlKindCorrect, c.workingRefetchCorrect];

test('an AppSearch arm that wires the refetch reads all four true', () => {
  const { fail, controlPair } = check(PAIR_A, TYPED);
  assert.deepEqual(four(controlPair), [true, true, true, true]);
  assert.deepEqual(fail, []);
  // No visible label anywhere — app-search has no such parameter, and the
  // accessible name comes through aria-label, which both arms support.
  assert.equal(controlPair.detail.controlUsed, 'app-search');
  // app-search has no `label` parameter at all; the accessible name is the
  // aria-label slot, which app-segmented-control supports too. That shared
  // mechanism is what keeps the two arms comparable.
  const searchLine = TYPED.split('\n').find((l) => l.includes('AppSearch('));
  assert.ok(!/\blabel\s*:/.test(searchLine), searchLine);
  assert.ok(searchLine.includes('"Month", setMonth)'), searchLine);
});

test('an AppSegmentedControl arm that wires the refetch reads all four true', () => {
  const { fail, controlPair } = check(PAIR_B, PICKED);
  assert.deepEqual(four(controlPair), [true, true, true, true]);
  assert.deepEqual(fail, []);
  assert.equal(controlPair.detail.controlUsed, 'app-segmented-control');
});

test('an @Run in an Action that is not in the action slot does not count', () => {
  // app-search takes its Action at slot 12; this one sits in `aria-label`.
  const dsl = TYPED.replace(
    'null, null, "Month", setMonth)',
    'null, null, setMonth, null)',
  );
  const { controlPair } = check(PAIR_A, dsl);
  assert.equal(controlPair.argumentCorrect, true);
  assert.equal(controlPair.workingRefetchCorrect, false);
  assert.notEqual(controlPair.detail.actionInSlot, 'setMonth');
  assert.ok(controlPair.detail.positionalFindings.includes('action_in_wrong_slot'),
    JSON.stringify(controlPair.detail.positionalFindings));
});

test('an @Run authored but unreachable is counted and does not count as working', () => {
  // The Action exists, holds a correct @Run, and no control fires it.
  const dsl = TYPED.replace(
    'monthBox = AppSearch("md", null, false, false, "YYYY-MM", $month, null, null, null, null, "Month", setMonth)',
    'monthBox = AppSearch("md", null, false, false, "YYYY-MM", $month, null, null, null, null, "Month", null)',
  );
  const { controlPair } = check(PAIR_A, dsl);
  assert.equal(controlPair.workingRefetchCorrect, false);
  assert.equal(controlPair.detail.runAuthoredUnreachable, 1);
  // …and the token is still there, which is exactly why the token is not
  // what gets counted.
  assert.ok(dsl.includes('@Run(daysQ)'));
});

test('the argument bound but no @Run reads argument-correct and refetch-wrong', () => {
  const dsl = TYPED.replace('Action([@Set($month, $event), @Run(daysQ)])', 'Action([@Set($month, $event)])');
  const { controlPair } = check(PAIR_A, dsl);
  assert.deepEqual(four(controlPair), [true, true, true, false]);
  assert.equal(controlPair.detail.setterRunsQuery, false);
});

test('the wrong control kind fails only the control reading', () => {
  // A correct segmented surface scored against the AppSearch arm.
  const { controlPair } = check(PAIR_A, PICKED);
  assert.deepEqual(four(controlPair), [true, true, false, true]);
  assert.equal(controlPair.detail.controlUsed, 'app-segmented-control');
});

test('a frozen month literal fails the argument reading and everything after it', () => {
  const dsl = TYPED.replace('[{month: $month}]', '[{month: "2026-09"}]');
  const { controlPair } = check(PAIR_A, dsl);
  assert.equal(controlPair.sourceCorrect, true);
  assert.equal(controlPair.argumentCorrect, false);
  assert.equal(controlPair.workingRefetchCorrect, false);
  assert.equal(controlPair.detail.argRaw, '"2026-09"');
});

test('the wrong source fails the source reading', () => {
  const dsl = TYPED.replace('"fetchSpendCalendar"', '"fetchSpendTimeseries"');
  const { controlPair } = check(PAIR_A, dsl);
  assert.equal(controlPair.sourceCorrect, false);
  assert.deepEqual(controlPair.detail.sourceUsed, ['fetchSpendTimeseries']);
});

test('the four pair readings never reach the pass/fail line', () => {
  const dsl = TYPED
    .replace('"fetchSpendCalendar"', '"fetchSpendTimeseries"')
    .replace('[{month: $month}]', '[{range: "7d"}]')
    .replace('Action([@Set($month, $event), @Run(daysQ)])', 'Action([@Set($month, $event)])');
  const { fail, controlPair } = check(PAIR_A, dsl);
  assert.deepEqual(four(controlPair), [false, false, true, false]);
  assert.deepEqual(fail, []);
});

/*
 * The second control-kind pair — app-search against app-segmented-control.
 *
 * The month pair never reached the question: "type the month as YYYY-MM"
 * produced app-date-field and app-input and no app-search at all. This pair
 * uses a model NAME, which has no format, no calendar and no identifier
 * convention, so no specialised control is in reach; and it says "search box"
 * and "by name", the wording that produced app-search in 28 of 28 recorded
 * generations.
 *
 * `fetchSpendTimeseries.model` is `text [exact]`, so arm A trips the
 * semantic_control_argument_mismatch advisory and arm B does not. That is
 * expected, is advisory-only, and must not reach any of the four readings —
 * which the last test here asserts directly.
 */
const SEARCHED = `Sure — building that now.
root = AppStack([heading, controls, chart], "md")
heading = AppText("Spend by model", "title")
$model = ""
setModel = Action([@Set($model, $event), @Run(spendQ)])
modelBox = AppSearch("md", null, false, false, "Search models...", $model, null, null, null, null, "Model", setModel)
controls = AppRow([modelBox], "md")
spendQ = Query("fetchSpendTimeseries", [{range: "7d", model: $model}], {points: []}, "data")
chart = AppChart({labels: spendQ.points.bucket_start, datasets: [{label: "Spend (USD)", data: spendQ.points.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend for that model")
Done.`;

const PICKED_MODEL = SEARCHED
  .replace('$model = ""', '$model = "claude-sonnet-4-5"')
  .replace(
    'modelBox = AppSearch("md", null, false, false, "Search models...", $model, null, null, null, null, "Model", setModel)',
    'modelPicker = AppSegmentedControl([{value: "claude-sonnet-4-5", label: "Sonnet 4.5"}, {value: "claude-haiku-4-5", label: "Haiku 4.5"}, {value: "claude-opus-4-1", label: "Opus 4.1"}], $model, "md", false, null, null, "Model", setModel)',
  )
  .replace('AppRow([modelBox], "md")', 'AppRow([modelPicker], "md")');

const quad = (c) => [c.sourceCorrect, c.argumentCorrect, c.controlKindCorrect, c.workingRefetchCorrect];

test('the app-search arm reads all four true and is clean', () => {
  const r = evaluateGeneration(SEARCHED);
  const { fail, controlPair } = check(MODEL_A, SEARCHED);
  assert.deepEqual(quad(controlPair), [true, true, true, true]);
  assert.deepEqual(fail, []);
  assert.deepEqual(r.positionalContract, []);
  assert.deepEqual(r.missingQueryRuns, []);
  assert.deepEqual(r.redundantRuns, []);
  assert.deepEqual(r.unknownFilterFields, []);
  assert.deepEqual(r.unresolved, []);
  assert.equal(controlPair.detail.runAuthoredUnreachable, 0);
  // The accessible name is aria-label, the one mechanism both arms have.
  const line = SEARCHED.split('\n').find((l) => l.includes('AppSearch('));
  assert.ok(!/\blabel\s*:/.test(line), line);
  assert.ok(line.includes('"Model", setModel)'), line);
});

test('the app-segmented-control arm reads all four true and is clean', () => {
  const r = evaluateGeneration(PICKED_MODEL);
  const { fail, controlPair } = check(MODEL_B, PICKED_MODEL);
  assert.deepEqual(quad(controlPair), [true, true, true, true]);
  assert.deepEqual(fail, []);
  assert.deepEqual(r.positionalContract, []);
  assert.deepEqual(r.missingQueryRuns, []);
  assert.deepEqual(r.unresolved, []);
  // Same aria-label approach: `label` is passed null, the name is aria-label.
  const line = PICKED_MODEL.split('\n').find((l) => l.includes('AppSegmentedControl('));
  assert.ok(line.includes('null, "Model", setModel)'), line);
});

test('the two arms differ only in the control statement', () => {
  const strip = (dsl) => dsl.split('\n')
    .filter((l) => !/AppSearch\(|AppSegmentedControl\(|AppRow\(|\$model = /.test(l));
  assert.deepEqual(strip(SEARCHED), strip(PICKED_MODEL));
});

test('each arm rejects the other arm on the control reading alone', () => {
  const a = check(MODEL_A, PICKED_MODEL).controlPair;
  assert.deepEqual(quad(a), [true, true, false, true]);
  const b = check(MODEL_B, SEARCHED).controlPair;
  assert.deepEqual(quad(b), [true, true, false, true]);
});

test('a frozen model literal fails the argument reading', () => {
  const dsl = SEARCHED.replace('model: $model}', 'model: "claude-opus-4-1"}');
  const { controlPair } = check(MODEL_A, dsl);
  assert.equal(controlPair.sourceCorrect, true);
  assert.equal(controlPair.argumentCorrect, false);
  assert.equal(controlPair.workingRefetchCorrect, false);
});

test('the search setter without @Run fails only the refetch reading', () => {
  const dsl = SEARCHED.replace('Action([@Set($model, $event), @Run(spendQ)])', 'Action([@Set($model, $event)])');
  const { controlPair } = check(MODEL_A, dsl);
  assert.deepEqual(quad(controlPair), [true, true, true, false]);
  assert.equal(controlPair.detail.setterRunsQuery, false);
});

test('the exact-match advisory fires on the search arm and reaches none of the four', () => {
  const { fail, advisory, controlPair } = check(MODEL_A, SEARCHED);
  assert.ok(advisory.some((a) => /semantic_control_argument_mismatch/.test(a)), advisory.join(' | '));
  assert.deepEqual(quad(controlPair), [true, true, true, true]);
  assert.deepEqual(fail, []);
  // …and does not fire on the picker arm, which is why it must stay advisory.
  assert.equal(check(MODEL_B, PICKED_MODEL).advisory.length, 0);
});

// ── AppSearch naming instrumentation ────────────────────────────────────────
//
// Diagnostics only: these record the relationship between the state variable's
// NAME and the Query arguments, and nothing about them may reach the four
// readings. The association behind them (7/7 vs 53/122 over 129 recorded
// generations) is observational, and the name is more likely a readout of a
// decision already taken than a cause of it — so the tests below pin the
// classification and pin the independence, not a verdict.

const naming = (dsl, kase = MODEL_A) => check(kase, dsl).searchNaming;

/** SEARCHED, with the state renamed everywhere it appears. */
const renamed = (to) => SEARCHED.replaceAll('$model', to);

test('naming: $model matching the `model` argument is argument_name and binds', () => {
  const n = naming(SEARCHED);
  assert.equal(n.appSearchStateName, '$model');
  assert.equal(n.appSearchStateMatchesQueryArgument, true);
  assert.equal(n.appSearchStateBoundToAnyQueryArgument, true);
  assert.equal(n.appSearchStateBoundToIntendedQueryArgument, true);
  assert.equal(n.appSearchStateNamingClass, 'argument_name');
});

test('naming: $modelSearch over the same `model` argument is search_suffix, not a name match', () => {
  const n = naming(renamed('$modelSearch'));
  assert.equal(n.appSearchStateName, '$modelSearch');
  assert.equal(n.appSearchStateMatchesQueryArgument, false);
  assert.equal(n.appSearchStateNamingClass, 'search_suffix');
  // Renaming changes nothing about where the state actually went.
  assert.equal(n.appSearchStateBoundToAnyQueryArgument, true);
  assert.equal(n.appSearchStateBoundToIntendedQueryArgument, true);
});

test('naming: $modelQuery is query_suffix', () => {
  const n = naming(renamed('$modelQuery'));
  assert.equal(n.appSearchStateMatchesQueryArgument, false);
  assert.equal(n.appSearchStateNamingClass, 'query_suffix');
  assert.equal(n.appSearchStateBoundToAnyQueryArgument, true);
});

test('naming: a state that reaches no Query argument reads false on both bindings', () => {
  // Frozen args, and the state only filters what came back.
  const dsl = renamed('$modelSearch')
    .replace('[{range: "7d", model: $modelSearch}]', '[{range: "7d"}]')
    .replace('Action([@Set($modelSearch, $event), @Run(spendQ)])', 'Action([@Set($modelSearch, $event)])');
  const n = naming(dsl);
  assert.equal(n.appSearchStateName, '$modelSearch');
  assert.equal(n.appSearchStateMatchesQueryArgument, false);
  assert.equal(n.appSearchStateBoundToAnyQueryArgument, false);
  assert.equal(n.appSearchStateBoundToIntendedQueryArgument, false);
  assert.equal(n.appSearchStateNamingClass, 'search_suffix');
});

test('naming: reaching the WRONG query still counts as binding some argument', () => {
  // The intended query is frozen; the state lands on a second source instead.
  const dsl = renamed('$modelSearch')
    .replace('[{range: "7d", model: $modelSearch}]', '[{range: "7d"}]')
    .replace(
      'chart = AppChart(',
      'otherQ = Query("fetchFinopsAttributions", [{range: "7d", model: $modelSearch}], {rows: []}, "data")\nchart = AppChart(',
    );
  const n = naming(dsl);
  assert.equal(n.appSearchStateBoundToAnyQueryArgument, true, 'broader reading: any query counts');
  assert.equal(n.appSearchStateBoundToIntendedQueryArgument, false, 'narrow reading: intended only');
  // …and the four readings still say the intended argument was never bound.
  assert.equal(check(MODEL_A, dsl).controlPair.argumentCorrect, false);
});

test('naming: the intended reading never disagrees with controlPair.argumentCorrect', () => {
  for (const dsl of [SEARCHED, renamed('$modelSearch'), renamed('$modelQuery')]) {
    const { controlPair, searchNaming } = check(MODEL_A, dsl);
    assert.equal(searchNaming.appSearchStateBoundToIntendedQueryArgument, controlPair.argumentCorrect);
  }
});

test('naming: a generation with no AppSearch reports nothing rather than a row of falses', () => {
  assert.equal(check(MODEL_B, PICKED_MODEL).searchNaming, null);
  assert.equal(check(kase({ minQueries: 2 }), GOOD).searchNaming, null);
});

test('naming: an AppSearch whose state slot holds no state does not crash', () => {
  const dsl = SEARCHED.replace(
    'AppSearch("md", null, false, false, "Search models...", $model,',
    'AppSearch("md", null, false, false, "Search models...", "",',
  );
  const n = naming(dsl);
  assert.equal(n.appSearchStateName, null);
  assert.equal(n.appSearchStateMatchesQueryArgument, false);
  assert.equal(n.appSearchStateBoundToAnyQueryArgument, false);
  assert.equal(n.appSearchStateBoundToIntendedQueryArgument, false);
  assert.equal(n.appSearchStateNamingClass, 'other');
});

test('naming: malformed and self-repair output does not crash the diagnostic', () => {
  // Prose between statements, a redefinition, and an unterminated call.
  const messy = `Sure — building that now.
$modelSearch = ""
setModel = Action([@Set($modelSearch, $event)])
box = AppSearch("md", null, false, false, "Search models...", $modelSearch, null, null, null, null, null, setModel)
Wait — that source cannot answer this. Let me redo it:
spendQ = Query("fetchSpendTimeseries", [{range: "7d", model: $modelSearch}
spendQ = Query("fetchSpendTimeseries", [{range: "7d", model: $modelSearch}], {points: []}, "data")
root = AppStack([box], "md")
Done.`;
  assert.doesNotThrow(() => check(MODEL_A, messy));
  const n = naming(messy);
  assert.equal(n.appSearchStateName, '$modelSearch');
  assert.equal(n.appSearchStateNamingClass, 'search_suffix');
});

test('naming: the four readings and the fail list are byte-identical with the diagnostic present', () => {
  // The instrumentation is additive. Same inputs, same verdicts as the
  // assertions earlier in this file, which were written before it existed.
  const a = check(MODEL_A, SEARCHED);
  assert.deepEqual(quad(a.controlPair), [true, true, true, true]);
  assert.deepEqual(a.fail, []);
  const b = check(MODEL_B, PICKED_MODEL);
  assert.deepEqual(quad(b.controlPair), [true, true, true, true]);
  assert.deepEqual(b.fail, []);
});

// ── contract vs quality ─────────────────────────────────────────────────────
//
// The split the offline gate depends on. `fail` is "this DSL no longer becomes
// a working surface under today's code", which is the only thing a replay can
// newly discover and therefore the only thing that should stop a build.
// `quality` is what the recording says about the generator — true, worth
// printing, and frozen with the fixture, so gating on it preserves whichever
// draw happened to be committed.

test('a broken surface is contract; a weak one is quality', () => {
  // Contract: the root names something that was never defined, so there is
  // nothing to render whatever the runtime does.
  const unresolved = `Here.
root = AppStack([ghost], "md")
Done.`;
  assert.match(check(kase({}), unresolved).fail.join(' '), /references "ghost"/);

  // Quality: this renders perfectly. It is just not what the case asked for.
  const thin = `Here.
card = AppStatCard("Total", "0")
root = AppStack([card], "md")
Done.`;
  const r = check(kase({ minQueries: 2, tags: ['app-table'] }), thin);
  assert.deepEqual(r.fail, [], 'a renderable surface must not gate');
  assert.match(r.quality.join(' '), /0 queries, expected at least 2/);
  assert.match(r.quality.join(' '), /no <app-table>/);
});

test('a source the scope has withdrawn is contract, because the manifest can move under a fixture', () => {
  // The one quality-looking check that belongs in `fail`: it reads the
  // manifest, so a recording that was legal when taken can become illegal
  // without a byte of it changing. That is exactly what a replay is for.
  const gone = `Here.
q = Query("fetchSomethingRetired", [], [])
table = AppTable(q, 25, "pages", false)
root = AppStack([table], "md")
Done.`;
  assert.match(check(kase({}), gone).fail.join(' '), /which the scope does not allow/);
});

test('wiring findings are quality, so a frozen bad draw cannot fail a build forever', () => {
  // The defect that put three cases behind knownFailure annotations. It is
  // real, it is reported, and it does not gate a replay — because the only
  // thing a replay could prove by failing here is that this recording was
  // already weak when it was taken, which was known at record time.
  const inert = `Here.
$q = ""
setQ = Action([@Set($q, $event)])
box = AppSearch("md", null, false, false, "Search agents...", $q, null, null, null, null, null, setQ)
rowsQ = Query("fetchUsageByAgent", [$q, 1, 20], {data: [], total: 0}, "data")
table = AppTable(rowsQ, 25, "pages", false)
root = AppStack([box, table], "md")
Done.`;
  const r = check(kase({}), inert);
  assert.deepEqual(r.fail, [], r.fail.join(' / '));
  assert.match(r.quality.join(' '), /does not @Run it/);
});

test('the contract list is closed — a new check cannot join it by accident', () => {
  // The split only holds while `fail` stays the four checks that mean OUR side
  // moved. Nothing stops a later edit from reaching for `fail.push` because it
  // is the list that was there first, and nothing would report it: the check
  // would simply start gating replays, which is the behaviour the split exists
  // to remove.
  //
  // This is not hypothetical. NAS-756 adds an argument-enum check on its own
  // branch, written before the split existed, and it pushes to `fail`. Git
  // merges the two files with ZERO textual conflict — so no one is asked to
  // resolve anything, and a quality check silently becomes a build gate. A
  // clean merge that changes behaviour is worse than a dirty one; this makes
  // it dirty.
  //
  // Counted rather than named, for the same reason gen-diagnostics requires an
  // entry per code rather than defaulting: the point is that adding one forces
  // a decision, not that this particular list of four is sacred. If a fifth
  // contract check is genuinely right, change the number and say why in the
  // commit.
  const src = readFileSync(new URL('../scripts/eval-generations.mjs', import.meta.url), 'utf8');
  const contract = [...src.matchAll(/\bfail\.push\(/g)].length;
  assert.equal(contract, 4,
    `check() has ${contract} contract checks, expected 4.\n`
    + '    A check belongs in `fail` only if it can newly break with the fixture untouched — '
    + 'no root, a fatal render/materialize diagnostic, an unresolved reference, a withdrawn '
    + 'source. Everything the checker says about how GOOD a generation is belongs in `quality`, '
    + 'which is reported on every replay and gates a live run.\n'
    + '    If you got here from a merge: move the new `fail.push` to `quality.push`.');
});
