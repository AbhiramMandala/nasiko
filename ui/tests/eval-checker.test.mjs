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
import { check, evaluateGeneration, CASES, ALLOWED_SOURCES } from '../scripts/eval-generations.mjs';

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
  const { fail } = check(kase({ minQueries: 1 }), dsl);
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
  const { fail } = check(kase({}), dsl);
  assert.ok(fail.some((f) => /Mutation/.test(f)), fail.join(' | '));
});

test('a required component that never appears is caught', () => {
  const { fail } = check(kase({ tags: ['app-table'] }), GOOD);
  assert.ok(fail.some((f) => /no <app-table>/.test(f)));
});

test('a greeting case fails if it builds a dashboard anyway', () => {
  const { fail } = check(kase({ noSurface: true }), GOOD);
  assert.ok(fail.some((f) => /rule 11/.test(f)));
});

test('a greeting case passes on prose alone', () => {
  const { fail } = check(kase({ noSurface: true }), 'I can build dashboards from your usage data.\n');
  assert.deepEqual(fail, []);
});

test('a greeting that answers with nothing is caught', () => {
  const { fail } = check(kase({ noSurface: true }), '   \n');
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
  const { fail } = check(kase({ minQueries: 1, minActions: 1, minStates: 1 }), dsl);
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
  assert.match(caught.fail.join(' '), /setQ re-runs rowsQ/);

  // The same surface with the @Run dropped is correct and must stay silent —
  // writing $q alone already repaints, and @Filter re-evaluates against it.
  const correct = refetchesNothing.replace(', @Run(rowsQ)', '');
  assert.deepEqual(check(kase({}), correct).fail, []);

  // A state that IS an argument earns its @Run.
  const serverSide = `Here.
$range = "7d"
setRange = Action([@Set($range, $event), @Run(rowsQ)])
picker = AppSegmentedControl([{value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $range, "md", false, null, "Range", null, setRange)
rowsQ = Query("fetchTokenopsDashboard", [{range: $range}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([picker, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), serverSide).fail, []);

  // A Refresh button is a bare @Run with no @Set at all, and is exactly right.
  const refresh = `Here.
again = Action([@Run(rowsQ)])
btn = AppButton("Refresh", "secondary", null, null, null, null, null, null, null, null, again)
rowsQ = Query("fetchTokenopsDashboard", [{}], {attributions: {rows: []}}, "data")
table = AppTable(rowsQ.attributions.rows, 25, "pages", false)
root = AppStack([btn, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), refresh).fail, []);

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
  assert.deepEqual(check(kase({}), mixed).fail, []);
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
  assert.match(caught.fail.join(' '), /setAgent sets \$agent, which rowsQ reads as an argument/);
  // The range control is wired correctly and must not be named.
  assert.doesNotMatch(caught.fail.join(' '), /setRange/);

  // Adding the @Run is the fix, and silences it.
  const fixed = inertFilter.replace(
    'setAgent = Action([@Set($agent, $event)])',
    'setAgent = Action([@Set($agent, $event), @Run(rowsQ)])',
  );
  assert.deepEqual(check(kase({}), fixed).fail, []);

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
  assert.deepEqual(check(kase({}), clientSide).fail, []);
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
  assert.deepEqual(check(kase({}), constantArg).fail, []);

  // Type, then submit: the input sets the state and a Search button carries
  // the @Run. That button sets none of the Query's state arguments, which is
  // what a bare trigger looks like, and it makes the surface correct.
  const typeThenSubmit = `Here.
$q = ""
setQ = Action([@Set($q, $event)])
runIt = Action([@Run(rowsQ)])
box = AppSearch("md", null, false, false, "Search agents...", $q, null, null, null, null, null, setQ)
btn = AppButton("Search", "primary", null, null, null, null, null, null, null, null, runIt)
rowsQ = Query("fetchUsageByAgent", [$q, 1, 20], [], "data")
table = AppTable(rowsQ, 20, "pages", true)
root = AppStack([box, btn, table], "md")
Done.`;
  assert.deepEqual(check(kase({}), typeThenSubmit).fail, []);
});
