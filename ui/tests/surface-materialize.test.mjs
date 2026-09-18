/**
 * The materializer and its evaluator, against the real generated DSL catalog
 * rather than a fixture — so a change to the design system fails here rather
 * than in a rendered dashboard.
 *
 * The coercion assertions are not style choices: they are the semantics
 * agent.yaml teaches the model (divide-by-zero is 0, `+` concatenates when
 * either side is a string, `.field` on an array plucks). If these drift, the
 * model's mental model and the runtime's stop agreeing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { parseBuffer } = await import(new URL('../common/surface/parser.js', import.meta.url).href);
const { materialize, buildComponentIndex } = await import(new URL('../common/surface/materialize.js', import.meta.url).href);

const catalog = JSON.parse(readFileSync(new URL('../common/surface/dsl-catalog.json', import.meta.url), 'utf8'));
const index = buildComponentIndex(catalog);

const run = (dsl, ctx) => materialize(parseBuffer(dsl).statements, index, ctx);
/** Evaluate one expression by reading it back off a stat card's label. */
const val = (src, ctx) => run(`root = AppStatCard(${src}, "v")`, ctx).root.props.label;
const tree = (n, d = 0) => (!n ? '' : `${'  '.repeat(d)}${n.tag}\n${(n.children || []).map((c) => tree(c, d + 1)).join('')}`);

// ── arithmetic and coercion ─────────────────────────────────────────────────

test('a component downstream of a failed query says so, not "No data"', () => {
  // A failed fetch falls back to the declared default, so by value alone it is
  // identical to a genuinely empty result — and the component then asserts
  // nothing exists. Observed live: "Spend over time / No data" for a
  // fetchSpendTimeseries that had returned a malformed body.
  const dsl = [
    'root = AppStack([chart, table], "md")',
    'spendQ = Query("fetchSpendTimeseries", [], {points: []}, "data.points")',
    'chart = AppChart({labels: spendQ.bucket_start, datasets: []}, "line")',
    'okQ = Query("fetchUsageByAgent", [null, 1, 50], [], "data")',
    'table = AppTable(okQ, 20, "pages", false)',
  ].join('\n');

  const failed = run(dsl, { complete: true, failedQueries: new Set(['spendQ']) });
  const [chart, table] = failed.root.children;
  // Through `error`, not the empty message: the components have a real
  // failure state now (icon, one line, Retry), and dressing a failure up as
  // an empty result was the workaround that state replaced.
  assert.match(chart.props.error, /Couldn't load/);
  assert.equal(chart.props['empty-text'], undefined, 'the empty copy is not a failure channel');
  // The transitive step is the point: the failure is on spendQ, the message
  // lands on the chart that reads it.
  assert.equal(table.props.error, undefined, 'a healthy query is untouched');

  // And with nothing failing, neither is touched — an empty result still reads
  // as empty, which is true.
  const healthy = run(dsl, { complete: true });
  assert.equal(healthy.root.children[0].props.error, undefined);
});

test('a hand-written empty message survives a failed query', () => {
  // Overriding wording the author chose would be a worse default than the one
  // it replaced — and it is no longer even the channel: the failure goes to
  // `error`, so the author's empty copy is simply not in the way.
  const out = run([
    'root = AppStack([chart], "md")',
    'spendQ = Query("fetchSpendTimeseries", [], {points: []}, "data.points")',
    // empty-text is the 9th positional argument (paramOrder), not the 6th —
    // getting that wrong puts the string in center-value, which is exactly the
    // silent-rebinding hazard the catalog's written-out paramOrder exists for.
    'chart = AppChart({labels: spendQ.bucket_start, datasets: []}, "line", false, "currency", "USD", null, null, null, "No spend in the last 7 days")',
  ].join('\n'), { complete: true, failedQueries: new Set(['spendQ']) });
  assert.equal(out.root.children[0].props['empty-text'], 'No spend in the last 7 days');
  assert.match(out.root.children[0].props.error, /Couldn't load/);
});


test('a root restatement that drops a child is caught, not silent', () => {
  // agent.yaml rule 7 forbids writing `root` twice, and justifies it with
  // "anything that was only reachable through the first root ... never renders,
  // with no error shown anywhere". That justification is obsolete: the orphan
  // walk reports exactly this, fatally. The rule is what stops the generator
  // ever changing a layout on a revision turn, so the safety it claims to buy
  // is worth pinning — if this assertion ever fails, restating root becomes
  // unsafe again and the prompt rule has to come back.
  const out = run([
    'root = AppStack([heading, kpis, spendChart], "md")',
    'heading = AppText("Cost", "title")',
    'kpis = AppStatRow([{label: "Spend", value: 0}])',
    'spendChart = AppChart({labels: [], datasets: []}, "line")',
    'root = AppStack([heading, kpis], "md")',
  ].join('\n'), { complete: true });

  const orphans = out.diagnostics.filter((d) => d.code === 'orphaned_statement');
  assert.equal(orphans.length, 1);
  assert.match(orphans[0].message, /spendChart/);
  // And the surviving root is the second one — same-name-replaces, which is
  // what makes a revision turn able to change the layout at all.
  assert.equal(out.root.children.length, 2);
});


test('divide and modulo by zero are 0, never Infinity or NaN', () => {
  assert.equal(val('1 / 0'), 0);
  assert.equal(val('5 % 0'), 0);
});

test('+ concatenates when either side is a string, adds otherwise', () => {
  assert.equal(val('"Cost: " + 12'), 'Cost: 12');
  assert.equal(val('1 + 2'), 3);
  assert.equal(val('"n=" + true'), 'n=true');
});

test('a missing value concatenates as empty, not as the word null', () => {
  assert.equal(val('"Cost: " + nope'), 'Cost: ');
});

test('non-numeric operands coerce to 0 rather than NaN', () => {
  assert.equal(val('"abc" * 2'), 0);
  assert.equal(val('nope + 1'), 1);
});

test('comparisons coerce both sides; equality stays loose', () => {
  assert.equal(val('"10" > 9'), true);
  assert.equal(val('5 == "5"'), true);
  assert.equal(val('5 != "5"'), false);
});

test('&& and || return a value, not a boolean', () => {
  assert.equal(val('"" || "Untitled"'), 'Untitled');
  assert.equal(val('"set" || "fallback"'), 'set');
  assert.equal(val('0 && "never"'), 0);
});

test('unary minus coerces, unary bang is truthiness', () => {
  assert.equal(val('-"3"'), -3);
  assert.equal(val('!""'), true);
});

// ── member, index, pluck ────────────────────────────────────────────────────

test('member access on an array plucks the field from every element', () => {
  const out = run(`rows = [{cost: 1}, {cost: 2}, {}]
root = AppChart(rows.cost, "line")`);
  assert.deepEqual(out.root.data, [1, 2, null]);
});

test('.length on an array is the count; on a missing value everything is null', () => {
  assert.equal(val('rows.length\nrows = [1, 2, 3]'), 3);
  assert.equal(val('nope.deep.deeper'), null);
});

test('index access works on arrays and objects', () => {
  assert.equal(val('rows[1].cost\nrows = [{cost: 1}, {cost: 9}]'), 9);
  assert.equal(val('obj["k"]\nobj = {k: "v"}'), 'v');
});

// ── statements ──────────────────────────────────────────────────────────────

test('a later statement with the same name replaces the earlier one', () => {
  const out = run(`root = AppStatCard("first", "v")
root = AppStatCard("second", "v")`);
  assert.equal(out.root.props.label, 'second');
});

test('name = null deletes the statement rather than leaving a literal null', () => {
  // agent.yaml rule 9. A surviving literal null would render an empty child.
  const out = run(`root = AppStack([a, b], "md")
a = AppBadge("keep")
b = AppBadge("drop")
b = null`);
  assert.equal(out.root.children.length, 1);
  assert.equal(out.root.children[0].text, 'keep');
});

test('forward references resolve; a reference that never arrives is reported', () => {
  const out = run(`root = AppStack([later], "md")
later = AppBadge("here")`);
  assert.equal(out.root.children[0].text, 'here');
  const missing = run('root = AppStack([ghost], "md")');
  assert.deepEqual(missing.unresolved, ['ghost']);
  assert.equal(missing.root.children.length, 0, 'an unresolved child is absent, not a null hole');
});

test('a self-referential statement is reported, not a stack overflow', () => {
  const out = run('root = AppStack([root], "md")');
  assert.ok(out.diagnostics.some((d) => d.code === 'cycle'));
});

test('an unknown component is dropped with a diagnostic', () => {
  const out = run('root = AppNonesuch("x")');
  assert.equal(out.root, null);
  assert.ok(out.diagnostics.some((d) => d.code === 'unknown_component_type'));
});

// ── positional mapping ──────────────────────────────────────────────────────

test('arguments map positionally onto the catalog paramOrder', () => {
  // AppGrid rather than AppStatCard: four parameters, a mix of types, and a
  // signature that is not about to be trimmed. The point is the mapping, and a
  // test that has to be rewritten every time a component's DSL surface changes
  // is testing the component instead.
  const out = run('root = AppGrid([], "2fr 1fr", "md", "lg")');
  assert.deepEqual(out.root.props, { columns: '2fr 1fr', gap: 'md', padding: 'lg' });
  assert.deepEqual(out.root.children, [], 'children lead, and land in children rather than props');
});

test('children, data, text and action land in their own slots, not in props', () => {
  const stack = run('root = AppStack([kid], "md")\nkid = AppBadge("hi")').root;
  assert.equal(stack.props.gap, 'md');
  assert.equal(stack.children[0].text, 'hi', 'textParam becomes text, not an attribute');
  assert.equal(stack.children[0].props.text, undefined);

  const table = run('root = AppTable([{a: 1}], 10)').root;
  assert.deepEqual(table.data, [{ a: 1 }]);
  assert.equal(table.props.limit, 10);
});

test('too many arguments is reported and the extras ignored', () => {
  const out = run('root = AppBadge("x", "neutral", "spurious", "more")');
  assert.ok(out.diagnostics.some((d) => d.code === 'excess_arguments'));
  assert.equal(out.root.text, 'x');
});

// ── $state ──────────────────────────────────────────────────────────────────

test('a $state reference reads the store, and undeclared ones are collected', () => {
  const store = { get: (n) => (n === '$view' ? 'cost' : null) };
  const out = run('root = AppStatCard($view == "cost" ? "Total cost" : "Requests", "v")', { store });
  assert.equal(out.root.props.label, 'Total cost');
  assert.ok(out.states.includes('$view'));
});

test('an undeclared $state reads as null rather than failing', () => {
  const out = run('root = AppStatCard($nothing, "v")');
  assert.equal(out.root.props.label, null);
  assert.ok(out.states.includes('$nothing'));
});

// ── Query, Mutation, Action, Slot ───────────────────────────────────────────

test('a Query yields its declared default until the manager has a result', () => {
  const dsl = `costQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
root = AppStatCard("Total cost", costQ)`;
  const pending = run(dsl);
  assert.equal(pending.root.props.value, 0, 'the default is what stops a blank card mid-fetch');
  assert.deepEqual(pending.queries[0], {
    statementId: 'costQ', source: 'fetchUsageSummary', args: [], select: 'total_cost_usd',
    stateful: false,
  });

  const resolved = run(dsl, { queryResults: new Map([['costQ', 12.5]]) });
  assert.equal(resolved.root.props.value, 12.5);
});

test('a Query records its positional args, including one read from $state', () => {
  const store = { get: () => 30 };
  const out = run('historyQ = Query("fetchUsageHistory", [$days], [])\nroot = AppTable(historyQ)', { store });
  assert.deepEqual(out.queries[0].args, [30]);
});

test('an Action materializes to steps, with @Set keeping its value unevaluated', () => {
  // Twelve parameters: text, variant, size, icon-only, href, disabled, loading,
  // type, aria-label, title, aria-expanded, action. Miscount and the Action
  // lands on aria-expanded, silently — which is the whole reason paramOrder is
  // written into the catalog rather than inferred. It went from eleven to
  // twelve the day `href` was re-admitted, and the hash moved with it.
  const out = run(`root = AppButton("Go", "primary", null, null, null, null, null, null, null, null, null, act)
act = Action([@Set($days, 30), @Run(historyQ)])`);
  const action = out.root.action;
  assert.equal(action.type, 'action');
  assert.deepEqual(action.steps.map((s) => s.kind), ['set', 'run']);
  assert.equal(action.steps[0].target, '$days');
  assert.equal(action.steps[0].valueAst.k, 'Num', 'evaluated at fire time, not now');
  assert.equal(action.steps[1].ref, 'historyQ');
});

test('Slot tags its child rather than wrapping it', () => {
  const out = run(`root = AppModal([footer], "Edit")
footer = Slot("footer", saveBtn)
saveBtn = AppButton("Save", "primary")`);
  const child = out.root.children[0];
  assert.equal(child.tag, 'app-button');
  assert.equal(child.slot, 'footer');
});

test('an Action step used as a value is reported', () => {
  const out = run('root = AppStatCard(@Set($a, 1), "v")');
  assert.ok(out.diagnostics.some((d) => d.code === 'unknown_builtin'));
});

// ── builtins in expression position ─────────────────────────────────────────

test('eager builtins evaluate against resolved data', () => {
  const dsl = `rows = [{cost: 2}, {cost: 4}]
root = AppStatCard("Avg", @Round(@Avg(rows.cost), 1))`;
  assert.equal(run(dsl).root.props.value, 3);
});

test('@Each is lazy and binds a plain identifier, not a $variable', () => {
  const out = run(`rows = [{cost: 1}, {cost: 2}]
root = AppChart(@Each(rows, "r", r.cost * 10), "line")`);
  assert.deepEqual(out.root.data, [10, 20]);
});

test('an @Each variable shadows a statement of the same name inside the template', () => {
  const out = run(`r = "outer"
rows = [{cost: 7}]
root = AppChart(@Each(rows, "r", r.cost), "line")`);
  assert.deepEqual(out.root.data, [7]);
});

// ── the whole worked example ────────────────────────────────────────────────

test('Worked Example 1 materializes into the tree it describes', () => {
  const out = run(`root = AppStack([heading, kpis], "md")
heading = AppText("Usage summary", "title")
totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
requestCountQ = Query("fetchUsageSummary", [], 0, "request_count")
kpis = AppStatRow([{label: "Total cost", value: totalCostQ, sub: "all time"}, {label: "Requests", value: requestCountQ}])`,
  { queryResults: new Map([['totalCostQ', 12.5], ['requestCountQ', 342]]) });

  assert.equal(tree(out.root), 'app-stack\n  app-text\n  app-stat-row\n');
  // Query references resolve inside a json literal, which is what makes the
  // one-statement strip usable for live figures rather than only for constants.
  assert.deepEqual(out.root.children[1].props.items, [
    { label: 'Total cost', value: 12.5, sub: 'all time' },
    { label: 'Requests', value: 342 },
  ]);
  assert.equal(out.queries.length, 2);
  assert.deepEqual(out.diagnostics, []);
});

test('a whole-response default is repaired, so the component still gets its shape', () => {
  // Repair is safe under exactly the condition that detects it: we have
  // already established the default IS the envelope, so the path through it is
  // the value the model meant. A correct `[]` has no "data" key and is never
  // touched. Reported as well as repaired — the mistake stays fixable upstream
  // rather than being absorbed silently.
  const out = run('q = Query("fetchUsageByModel", ["", 1, 50], {data: [], total: 0}, "data")\nroot = AppTable(q)');
  assert.deepEqual(out.root.data, [], 'the table gets rows, not the envelope');
  assert.ok(out.diagnostics.some((d) => d.code === 'default_is_whole_response'));
});

test('a default that is the whole response is caught at the Query, not at the table', () => {
  // The generator writes this: the envelope as the default, plus a dot-path.
  // The component then fails with "needs an array of rows", which points at
  // the table and not at the line that is actually wrong.
  const out = run('q = Query("fetchUsageByModel", ["", 1, 50], {data: [], total: 0}, "data")\nroot = AppTable(q)');
  const d = out.diagnostics.find((x) => x.code === 'default_is_whole_response');
  assert.ok(d, 'the diagnostic has to name the Query, or nobody finds it');
  assert.match(d.message, /"data" path/);
});

test('a default that walked half the path is caught at the same place', () => {
  // Recorded, not imagined: `{agents: []}` under a "data.agents" path. The model
  // walked `data` and stopped. The head-only test missed it because the default
  // has no "data" key, so it surfaced two hops later as `data_not_rows` — a
  // diagnostic pointing at the table, which is not the line that is wrong.
  const out = run('q = Query("fetchTokenopsDashboard", [], {agents: []}, "data.agents")\nroot = AppTable(q)');
  const d = out.diagnostics.find((x) => x.code === 'default_is_whole_response');
  assert.ok(d, 'a half-walked default is the same mistake as an unwalked one');
  assert.match(d.message, /stops at "data"/, d?.message);
  assert.deepEqual(out.root.data, [], 'and it is repaired to the rows the table wanted');
  assert.equal(out.diagnostics.some((x) => x.code === 'data_not_rows'), false,
    'the table no longer takes the blame for the Query line');
});

test('a deeper path than the default knows about is left alone', () => {
  // No segment of "meta.page.size" is a key here, so this default is simply a
  // value of its own shape — repairing it would be inventing a mistake.
  const out = run('q = Query("fetchUsageByModel", ["", 1, 50], {rows: []}, "meta.page.size")\nroot = AppTable(q)');
  assert.equal(out.diagnostics.some((x) => x.code === 'default_is_whole_response'), false);
});

test('a correctly shaped default is silent', () => {
  const out = run('q = Query("fetchUsageByModel", ["", 1, 50], [], "data")\nroot = AppTable(q)');
  assert.equal(out.diagnostics.some((x) => x.code === 'default_is_whole_response'), false);
});

test('an object default with no dot-path is fine', () => {
  // Nothing is being selected, so the whole object *is* what the component gets.
  const out = run('q = Query("fetchUsageSummary", [], {total: 0})\nroot = AppStatCard("Total", q.total)');
  assert.equal(out.diagnostics.some((x) => x.code === 'default_is_whole_response'), false);
});

test('an object default whose keys do not match the path is left alone', () => {
  // Only a default that literally contains the first path segment is flagged.
  // Anything looser would guess, and guessing wrong here means shouting at a
  // correct line.
  const out = run('q = Query("fetchUsageSummary", [], {total_cost_usd: 0}, "summary.cost")\nroot = AppStatCard("Total", q)');
  assert.equal(out.diagnostics.some((x) => x.code === 'default_is_whole_response'), false);
});

test('with no store attached, a $state still reads the statement that declared it', () => {
  // "No store" means nothing is set, not that everything is null. Answering
  // null made `$view = "cost"` evaluate to null, so every `$view == "cost"`
  // took its else branch and whole halves of a dashboard — including the
  // Queries behind them — silently never evaluated. Found by the eval harness
  // reporting a generation as having no data when it plainly had a Query.
  const out = run(`$view = "cost"
summaryQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
card = AppStatCard("Total", $view == "cost" ? summaryQ : null)
root = AppStack([card], "md")`);
  assert.equal(out.queries.length, 1, 'the branch that was taken must actually evaluate');
  assert.equal(out.root.children[0].props.value, 0);
});

test('a Query referenced twice reports its bad default once', () => {
  // Referencing evaluates, and there is no memoization — so a mistake in one
  // statement was reported once per reader.
  const out = run(`q = Query("fetchUsageSummary", [], {total_cost_usd: 0}, "total_cost_usd")
a = AppStatCard("A", q)
b = AppStatCard("B", q)
root = AppStack([a, b], "md")`);
  const hits = out.diagnostics.filter((d) => d.code === 'default_is_whole_response');
  assert.equal(hits.length, 1);
});

// ── unreachable statements ──────────────────────────────────────────────────

test('a statement nothing references is reported once the stream is done', () => {
  // The shape a real generation produced: two charts and the row holding
  // them, with the card that should have held the row left holding null.
  const out = run(`
root = AppStack([header, chartSection], "md")
header = AppRow([title], "md")
title = AppStatCard("Usage by Model", null, null, "neutral")
chartSection = AppCard(null, "Distribution")
chartRow = AppRow([costChart], "md")
costChart = AppChart({labels: []}, "bar", false, "compact")
`, { complete: true });
  const orphaned = out.diagnostics.filter((d) => d.code === 'orphaned_statement').map((d) => d.pointer);
  assert.deepEqual(orphaned.sort(), ['chartRow', 'costChart']);
  assert.deepEqual(out.orphans.sort(), ['chartRow', 'costChart']);
});

test('mid-stream, an orphan is not reported — its parent has not arrived yet', () => {
  // Exactly the state a buffer is in between two chunks. Reporting here would
  // fire on every well-formed generation, once per statement.
  const out = run(`
root = AppStack([body], "md")
card = AppStatCard("Cost", 1, null, "neutral")
`);
  assert.deepEqual(out.diagnostics.filter((d) => d.code === 'orphaned_statement'), []);
  assert.deepEqual(out.orphans, ['card']);
});

test('reachability follows both branches of a ternary, not the taken one', () => {
  // An evaluation-time walk would call `ops` dead whenever $view is "cost".
  const out = run(`
$view = "cost"
cost = AppStatCard("Cost", 1, null, "neutral")
ops = AppStatCard("Ops", 2, null, "neutral")
root = $view == "cost" ? cost : ops
`, { complete: true });
  assert.deepEqual(out.orphans, []);
});

test('a state variable is reachable through the Action that sets it', () => {
  const out = run(`
$view = "cost"
showOps = Action([@Set($view, "ops")])
btn = AppButton("Ops", "primary", "md", false, null, false, false, "button", null, null, null, showOps)
root = AppStack([btn], "md")
`, { complete: true });
  assert.deepEqual(out.orphans, []);
});

// ── arguments past the end of a signature ───────────────────────────────────

test('trailing null padding is separated from a dropped value', () => {
  const pad = run('root = AppStatCard("Cost", 1, null, "neutral", null, null, null, null, null)');
  const held = run('root = AppStatCard("Cost", 1, null, "neutral", null, null, null, null, "lost")');
  assert.equal(pad.diagnostics.find((d) => d.code === 'excess_null_padding')?.code, 'excess_null_padding');
  assert.equal(pad.diagnostics.some((d) => d.code === 'excess_arguments'), false);
  assert.match(held.diagnostics.find((d) => d.code === 'excess_arguments')?.message ?? '', /1 past the end held values/);
});

// ── an editable control that discards what is typed into it ─────────────────

test('an Action-bearing input whose value is not state is named', () => {
  // The failure is one step worse than the caret loss it sits beside: the
  // Action fires, the store changes, render() rebuilds, and the new input is
  // built from an argument that never moved — so the box empties as you type,
  // silently. Found by a browser test that had left `value` unbound and could
  // not explain why the caret came back at 0.
  const out = run('$q = ""\na = Action([@Set($q, $event)])\n'
    + 'root = AppSearch(null, null, null, null, "Filter", null, null, null, null, null, null, a)');
  const d = out.diagnostics.find((x) => x.code === 'uncontrolled_input');
  assert.ok(d, out.diagnostics.map((x) => x.code).join(','));
  assert.match(d.message, /\$state/);
});

test('a constant value counts as unbound, because it never moves either', () => {
  // Checked on the AST: after evaluation `$q` and "fixed" are both a string,
  // so the difference only exists before the evaluator runs.
  const out = run('$q = ""\na = Action([@Set($q, $event)])\n'
    + 'root = AppSearch(null, null, null, null, "Filter", "fixed", null, null, null, null, null, a)');
  assert.ok(out.diagnostics.some((x) => x.code === 'uncontrolled_input'));
});

test('a value read back from state is silent — this is the correct shape', () => {
  const out = run('$q = ""\na = Action([@Set($q, $event)])\n'
    + 'root = AppSearch(null, null, null, null, "Filter", $q, null, null, null, null, null, a)');
  assert.equal(out.diagnostics.some((x) => x.code === 'uncontrolled_input'), false,
    out.diagnostics.map((x) => x.code).join(','));
});

test('a button with an Action is not an editable control', () => {
  // The check keys on the component having a `value` parameter at all, so the
  // components that carry an Action and nothing to type into stay quiet.
  const out = run('$v = 1\na = Action([@Set($v, 2)])\n'
    + 'root = AppButton("Go", null, null, null, null, null, null, null, null, null, null, a)');
  assert.equal(out.diagnostics.some((x) => x.code === 'uncontrolled_input'), false);
});

test('an input with no Action is left alone', () => {
  const out = run('root = AppSearch(null, null, null, null, "Filter", null)');
  assert.equal(out.diagnostics.some((x) => x.code === 'uncontrolled_input'), false);
});

// ── a Query default that does not cover what the DSL reads ──────────────────

const misses = (dsl) => run(dsl, { complete: true }).diagnostics
  .filter((d) => d.code === 'default_misses_a_read_field')
  .map((d) => d.message);

test('a field the default misses is named, not left to render as an em-dash', () => {
  // The exact shape from the empty-database dashboard: total_cost had a
  // default (so it showed $0) and total_operations did not (so it showed —).
  const out = misses([
    'root = AppStatCard("Operations", q.summary.total_operations)',
    'q = Query("fetchTokenopsDashboard", [{}], {summary: {total_cost: 0}}, "data")',
  ].join('\n'));
  assert.equal(out.length, 1, out.join(' | '));
  assert.match(out[0], /summary\.total_operations/);
  assert.match(out[0], /does not cover "summary\.total_operations"/);
});

test('a covered field says nothing', () => {
  assert.deepEqual(misses([
    'root = AppStatCard("Cost", q.summary.total_cost)',
    'q = Query("fetchTokenopsDashboard", [{}], {summary: {total_cost: 0}}, "data")',
  ].join('\n')), []);
});

test('a concatenated ratio is caught, which no component fallback can be', () => {
  // `app-stat-card`'s `|| '—'` cannot fire here: " / " is a truthy string, so
  // the card renders a bare slash. The AST is the only place the miss shows.
  const out = misses([
    'root = AppStatCard("Agents", q.s.active_agents + " / " + q.s.total_agents)',
    'q = Query("fetchTokenopsDashboard", [{}], {s: {}}, "data")',
  ].join('\n'));
  assert.equal(out.length, 2, out.join(' | '));
  assert.ok(out.some((m) => /"s\.active_agents"/.test(m)));
  assert.ok(out.some((m) => /"s\.total_agents"/.test(m)));
});

test('array pluck is not a missing field', () => {
  // `rows.spend_usd` on a `[]` default is the taught array-pluck form. The
  // element shape is unknowable from an empty array, so flagging it would be
  // a guess — and a wrong one on every table in the product.
  assert.deepEqual(misses([
    'root = AppChart({labels: rows.bucket_start, datasets: []}, "line")',
    'rows = Query("fetchSpendTimeseries", [{}], [], "data.points")',
  ].join('\n')), []);
});

test('the repaired default is what gets checked, not the one that was written', () => {
  // The envelope repair runs first, so a default that was the whole response
  // is checked at the level the dot-path leaves it — otherwise every repaired
  // Query would report a second, bogus miss.
  assert.deepEqual(misses([
    'root = AppStatCard("Cost", q.total_cost)',
    'q = Query("fetchTokenopsDashboard", [{}], {data: {total_cost: 0}}, "data")',
  ].join('\n')), []);
});

test('nothing is said mid-stream, when the Query may not have arrived', () => {
  const dsl = [
    'root = AppStatCard("Operations", q.summary.total_operations)',
    'q = Query("fetchTokenopsDashboard", [{}], {summary: {}}, "data")',
  ].join('\n');
  const partial = run(dsl, {}).diagnostics.filter((d) => d.code === 'default_misses_a_read_field');
  assert.equal(partial.length, 0);
  assert.equal(misses(dsl).length, 1);
});

test('a read off a non-Query statement is left alone', () => {
  assert.deepEqual(misses([
    'root = AppStatCard("x", shape.missing)',
    'shape = {present: 1}',
  ].join('\n')), []);
});
