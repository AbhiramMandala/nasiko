import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../common/surface/store.js';
import { createQueryManager } from '../common/surface/queries.js';
import { createActionRunner } from '../common/surface/actions.js';
import { parseBuffer } from '../common/surface/parser.js';
import { materialize, buildComponentIndex } from '../common/surface/materialize.js';
import catalog from '../common/surface/dsl-catalog.json' with { type: 'json' };

const index = buildComponentIndex(catalog);

/**
 * A whole surface, wired the way `surface-stream.js` wires one — store, query
 * manager and runner over the same DSL text. These tests are about how the
 * three behave *together*, which is where the interesting promises live.
 */
function surface(dsl, { call = async () => null, onAssistant } = {}) {
  const diagnostics = [];
  const store = createStore();
  const queries = createQueryManager({ call, onDiagnostic: (d) => diagnostics.push(d) });
  let last = null;

  function walk() {
    const { statements } = parseBuffer(dsl);
    const out = materialize(statements, index, {
      store, queryResults: queries.results, mutationResults: queries.mutationResults,
    });
    store.initialize(out.stateDefaults);
    queries.sync(out.queries, out.mutations);
    last = out;
    return out;
  }

  const actions = createActionRunner({
    store, queries, refresh: walk,
    onAssistant,
    onDiagnostic: (d) => diagnostics.push(d),
  });

  walk();
  return {
    store, queries, diagnostics, walk,
    get last() { return last; },
    /** Fire an Action the way a click would, with the rendering pass's evaluator. */
    run: (action) => actions.run(action, last.evaluateAst),
  };
}

function evalAction(out, name) {
  return out.evaluateAst({ k: 'Ref', n: name }, null);
}

// ── Worked Example 3b, the whole point of Phase 3 ───────────────────────────

const FILTER_DSL = `$days = 7
historyQ = Query("fetchUsageHistory", [$days], [])
showThirty = Action([@Set($days, 30), @Run(historyQ)])
showNoRun = Action([@Set($days, 90)])
root = AppStack([chart], "md")
chart = AppChart(historyQ, "line")`;

test('@Set then @Run in one Action re-fetches with the new value', async () => {
  const seen = [];
  const s = surface(FILTER_DSL, { call: async (_n, days) => { seen.push(days); return [days]; } });
  await s.queries.settled();
  assert.deepEqual(seen, [7], 'the declared default is what the first fetch uses');

  await s.run(evalAction(s.last, 'showThirty'));
  assert.deepEqual(seen, [7, 30], 'this is the difference between a filter that reloads and one that lies');
  assert.equal(s.store.get('$days'), 30);
  assert.deepEqual(s.queries.results.get('historyQ'), [30]);
});

test('@Set on its own does not re-fetch, and says so by leaving the old data', async () => {
  const seen = [];
  const s = surface(FILTER_DSL, { call: async (_n, days) => { seen.push(days); return [days]; } });
  await s.queries.settled();

  await s.run(evalAction(s.last, 'showNoRun'));
  await s.queries.settled();
  assert.deepEqual(seen, [7], 'agent.yaml rule 5, stated as a test');
  assert.equal(s.store.get('$days'), 90, 'the variable did move');
  assert.deepEqual(s.queries.results.get('historyQ'), [7], 'the chart is honestly stale, not silently wrong');
});

test('the first paint fetches the declared default, not null', async () => {
  const seen = [];
  const s = surface(FILTER_DSL, { call: async (_n, days) => { seen.push(days); return []; } });
  await s.queries.settled();
  assert.deepEqual(seen, [7]);
});

// ── Step semantics ──────────────────────────────────────────────────────────

test('@Reset returns a filter to its declared value', async () => {
  const s = surface(`$view = "cost"
setOps = Action([@Set($view, "ops")])
clear = Action([@Reset($view)])
root = AppStack([b], "md")
b = AppButton("Ops", "primary", "md", false, false, false, "button", null, null, null, setOps)`);
  await s.run(evalAction(s.last, 'setOps'));
  assert.equal(s.store.get('$view'), 'ops');
  await s.run(evalAction(s.last, 'clear'));
  assert.equal(s.store.get('$view'), 'cost');
});

test('a failed mutation skips every step after it', async () => {
  const ran = [];
  const s = surface(`del = Mutation("deleteAgent", ["a1"])
refreshQ = Query("fetchAgents", [], [])
doIt = Action([@Run(del), @Run(refreshQ)])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, doIt)
tbl = AppTable(refreshQ)
root = AppStack([btn, tbl], "md")`, {
    call: async (name) => {
      ran.push(name);
      if (name === 'deleteAgent') throw new Error('403');
      return [];
    },
  });
  await s.queries.settled();
  ran.length = 0;

  const res = await s.run(evalAction(s.last, 'doIt'));
  assert.equal(res.halted, true);
  assert.deepEqual(ran, ['deleteAgent'], 'closing the dialog over a delete that did not happen is the bug this stops');
  assert.ok(s.diagnostics.some((d) => d.code === 'action_halted'));
});

test('a mutation that succeeds lets the refresh after it run', async () => {
  const ran = [];
  const s = surface(`del = Mutation("deleteAgent", ["a1"])
refreshQ = Query("fetchAgents", [], [])
doIt = Action([@Run(del), @Run(refreshQ)])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, doIt)
tbl = AppTable(refreshQ)
root = AppStack([btn, tbl], "md")`, {
    call: async (name) => { ran.push(name); return name === 'fetchAgents' ? ['b'] : 'ok'; },
  });
  await s.queries.settled();
  ran.length = 0;

  const res = await s.run(evalAction(s.last, 'doIt'));
  assert.equal(res.halted, false);
  assert.deepEqual(ran, ['deleteAgent', 'fetchAgents']);
});

test('a mutation sends its declared arguments', async () => {
  const calls = [];
  const s = surface(`del = Mutation("deleteAgent", ["a1", 2])
doIt = Action([@Run(del)])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, doIt)
root = AppStack([btn], "md")`, { call: async (...a) => { calls.push(a); return 'ok'; } });
  await s.run(evalAction(s.last, 'doIt'));
  assert.deepEqual(calls, [['deleteAgent', 'a1', 2]]);
});

test('@ToAssistant hands the host a message', async () => {
  const said = [];
  const s = surface(`ask = Action([@ToAssistant("show me last week instead")])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, ask)
root = AppStack([btn], "md")`, { onAssistant: (t) => said.push(t) });
  await s.run(evalAction(s.last, 'ask'));
  assert.deepEqual(said, ['show me last week instead']);
});

test('@OpenUrl is refused and reported, not quietly dropped', async () => {
  const s = surface(`go = Action([@OpenUrl("/agents/a1")])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, go)
root = AppStack([btn], "md")`);
  await s.run(evalAction(s.last, 'go'));
  const d = s.diagnostics.find((x) => x.code === 'open_url_blocked');
  assert.ok(d, 'shipping it closed is a decision, so it has to be visible');
  assert.match(d.message, /route allowlist/);
});

test('@Run of a statement that is not a Query or Mutation is reported', async () => {
  const s = surface(`label = "hello"
go = Action([@Run(label)])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, go)
root = AppStack([btn], "md")`);
  await s.run(evalAction(s.last, 'go'));
  assert.ok(s.diagnostics.some((d) => d.code === 'run_unknown'));
});

test('a second fire while the first is still running is refused', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = surface(`del = Mutation("deleteAgent", [])
doIt = Action([@Run(del)])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, doIt)
root = AppStack([btn], "md")`, { call: async () => { await gate; return 'ok'; } });
  const action = evalAction(s.last, 'doIt');
  const first = s.run(action);
  const second = await s.run(action);
  release();
  await first;
  assert.equal(second.ran, 0);
  assert.ok(s.diagnostics.some((d) => d.code === 'action_in_flight'));
});

test('steps run in order, not in parallel', async () => {
  const order = [];
  const s = surface(`$a = 1
q1 = Query("one", [$a], [])
q2 = Query("two", [$a], [])
doIt = Action([@Set($a, 2), @Run(q1), @Run(q2)])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, doIt)
t1 = AppTable(q1)
t2 = AppTable(q2)
root = AppStack([btn, t1, t2], "md")`, {
    call: async (name, a) => { order.push(`${name}:${a}`); return []; },
  });
  await s.queries.settled();
  order.length = 0;
  await s.run(evalAction(s.last, 'doIt'));
  assert.deepEqual(order, ['one:2', 'two:2']);
});

test('an Action with a bad @Set target is reported and the rest still runs', async () => {
  const ran = [];
  const s = surface(`q = Query("fetchAgents", [], [])
doIt = Action([@Set(notState, 1), @Run(q)])
btn = AppButton("Go", "primary", "md", false, false, false, "button", null, null, null, doIt)
tbl = AppTable(q)
root = AppStack([btn, tbl], "md")`, { call: async (n) => { ran.push(n); return []; } });
  await s.queries.settled();
  ran.length = 0;
  await s.run(evalAction(s.last, 'doIt'));
  assert.ok(s.diagnostics.some((d) => d.code === 'bad_set'));
  assert.deepEqual(ran, ['fetchAgents']);
});
