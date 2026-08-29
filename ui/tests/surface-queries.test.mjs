import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryManager, selectPath } from '../common/surface/queries.js';

/** A call log plus canned answers, so every test can see exactly what fetched. */
function stub(answers = {}) {
  const calls = [];
  const call = async (name, ...args) => {
    calls.push([name, ...args]);
    const a = answers[name];
    if (typeof a === 'function') return a(...args);
    if (a instanceof Error) throw a;
    return a;
  };
  return { call, calls };
}

const q = (statementId, source, args = [], select = null, stateful = false) =>
  ({ statementId, source, args, select, stateful });

test('selectPath walks a dot-path and returns null for a missing hop', () => {
  assert.equal(selectPath({ a: { b: 2 } }, 'a.b'), 2);
  assert.equal(selectPath({ a: {} }, 'a.b'), null);
  assert.equal(selectPath(null, 'a'), null);
  assert.deepEqual(selectPath([1, 2], null), [1, 2]);
});

test('two statements over one source and args share a single fetch', async () => {
  const { call, calls } = stub({ fetchUsageSummary: { total_cost_usd: 12.5, request_count: 40 } });
  const m = createQueryManager({ call });
  m.sync([
    q('totalCostQ', 'fetchUsageSummary', [], 'total_cost_usd'),
    q('requestCountQ', 'fetchUsageSummary', [], 'request_count'),
  ]);
  await m.settled();
  assert.equal(calls.length, 1, 'Worked Example 1 writes this exact shape on every dashboard');
  assert.equal(m.results.get('totalCostQ'), 12.5);
  assert.equal(m.results.get('requestCountQ'), 40);
});

test('the same dashboard arriving chunk by chunk fetches once', async () => {
  const { call, calls } = stub({ fetchUsageHistory: [1, 2, 3] });
  const m = createQueryManager({ call });
  for (let i = 0; i < 20; i++) m.sync([q('historyQ', 'fetchUsageHistory', [14])]);
  await m.settled();
  assert.equal(calls.length, 1);
});

test('a failed query keeps the declared default rather than a value', async () => {
  const diagnostics = [];
  const { call } = stub({ fetchUsageSummary: new Error('502') });
  const m = createQueryManager({ call, onDiagnostic: (d) => diagnostics.push(d) });
  m.sync([q('costQ', 'fetchUsageSummary')]);
  await m.settled();
  assert.equal(m.results.has('costQ'), false, 'nothing published means materialize shows the default');
  assert.equal(diagnostics[0].code, 'query_failed');
});

test('a failed refetch keeps the last good value on screen', async () => {
  let fail = false;
  const { call } = stub({ fetchUsageHistory: async () => { if (fail) throw new Error('down'); return [1]; } });
  const m = createQueryManager({ call, onDiagnostic: () => {} });
  m.sync([q('h', 'fetchUsageHistory', [7])]);
  await m.settled();
  assert.deepEqual(m.results.get('h'), [1]);
  fail = true;
  await m.run('h');
  assert.deepEqual(m.results.get('h'), [1], 'blanking a chart because a refresh failed is worse than stale');
});

test('a $state filter moving does NOT refetch — that is @Run’s job alone', async () => {
  const { call, calls } = stub({ fetchUsageHistory: (days) => [days] });
  const m = createQueryManager({ call });
  m.sync([q('historyQ', 'fetchUsageHistory', [7], null, true)]);
  await m.settled();
  assert.deepEqual(m.results.get('historyQ'), [7]);

  // $days moved to 30, the surface re-materialized, nothing @Run yet.
  m.sync([q('historyQ', 'fetchUsageHistory', [30], null, true)]);
  await m.settled();
  assert.equal(calls.length, 1, 'agent.yaml rule 5: a variable changing never re-fetches on its own');
  assert.deepEqual(m.results.get('historyQ'), [7], 'and the old value is what stays on screen');
});

test('@Run after that filter change fetches under the new args', async () => {
  const { call, calls } = stub({ fetchUsageHistory: (days) => [days] });
  const m = createQueryManager({ call });
  m.sync([q('historyQ', 'fetchUsageHistory', [7], null, true)]);
  await m.settled();
  m.sync([q('historyQ', 'fetchUsageHistory', [30], null, true)]);
  await m.run('historyQ');
  assert.deepEqual(calls, [['fetchUsageHistory', 7], ['fetchUsageHistory', 30]]);
  assert.deepEqual(m.results.get('historyQ'), [30]);
});

test('a revision turn rewriting literal args does refetch', async () => {
  const { call, calls } = stub({ fetchUsageHistory: (days) => [days] });
  const m = createQueryManager({ call });
  m.sync([q('historyQ', 'fetchUsageHistory', [14])]);
  await m.settled();
  m.sync([q('historyQ', 'fetchUsageHistory', [30])]);
  await m.settled();
  assert.equal(calls.length, 2, 'no @Run is coming for a hand-written change — nobody would ever see 30');
  assert.deepEqual(m.results.get('historyQ'), [30]);
});

test('@Run forces, so a refresh button refreshes', async () => {
  let n = 0;
  const { call } = stub({ fetchAgents: async () => [++n] });
  const m = createQueryManager({ call });
  m.sync([q('agentsQ', 'fetchAgents')]);
  await m.settled();
  assert.deepEqual(m.results.get('agentsQ'), [1]);
  await m.run('agentsQ');
  assert.deepEqual(m.results.get('agentsQ'), [2]);
});

test('@Run of a name that is neither Query nor Mutation is reported', async () => {
  const diagnostics = [];
  const m = createQueryManager({ call: async () => null, onDiagnostic: (d) => diagnostics.push(d) });
  const res = await m.run('nope');
  assert.equal(res.ok, false);
  assert.equal(diagnostics[0].code, 'run_unknown');
});

test('a mutation never fires on its own', async () => {
  const { call, calls } = stub({ deleteAgent: 'gone' });
  const m = createQueryManager({ call });
  m.sync([], [{ statementId: 'del', source: 'deleteAgent', argsAst: [] }]);
  await m.settled();
  assert.equal(calls.length, 0, 'a delete must not run because a chunk of text arrived');
  assert.equal(m.isMutation('del'), true);
});

test('a second click while a mutation is in flight is refused, not queued', async () => {
  const diagnostics = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { call, calls } = stub({ deleteAgent: async () => { await gate; return 'gone'; } });
  const m = createQueryManager({ call, onDiagnostic: (d) => diagnostics.push(d) });
  m.sync([], [{ statementId: 'del', source: 'deleteAgent', argsAst: [] }]);
  const first = m.fireMutation('del', ['a1']);
  const second = await m.fireMutation('del', ['a1']);
  release();
  await first;
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'in_flight');
  assert.equal(calls.length, 1);
  assert.equal(diagnostics[0].code, 'mutation_in_flight');
});

test('a mutation records its outcome where the surface can read it', async () => {
  const { call } = stub({ deleteAgent: new Error('403') });
  const m = createQueryManager({ call, onDiagnostic: () => {} });
  m.sync([], [{ statementId: 'del', source: 'deleteAgent', argsAst: [] }]);
  const res = await m.fireMutation('del', []);
  assert.equal(res.ok, false);
  assert.equal(m.mutationResults.get('del').status, 'error');
});

test('a superseded fetch does not overwrite the newer one', async () => {
  const gates = [];
  const { call } = stub({
    slow: () => new Promise((r) => { gates.push(r); }),
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const m = createQueryManager({ call });
  m.sync([q('s', 'slow', [1])]);
  await tick();
  const forced = m.run('s');
  await tick();
  assert.equal(gates.length, 2, 'both fetches are genuinely in flight');
  // Resolve the first (superseded) call last.
  gates[1]('second');
  gates[0]('first');
  await forced;
  await tick();
  assert.equal(m.results.get('s'), 'second', 'the older args landing late must not win');
});

test('a deleted statement stops reading, and the cache keeps the value for an undo', async () => {
  const { call, calls } = stub({ fetchAgents: ['a'] });
  const m = createQueryManager({ call });
  m.sync([q('agentsQ', 'fetchAgents')]);
  await m.settled();
  m.sync([]);
  assert.equal(m.results.has('agentsQ'), false);
  m.sync([q('agentsQ', 'fetchAgents')]);
  await m.settled();
  assert.equal(calls.length, 1, 'flipping a chart off and back on must not cost a round trip');
  assert.deepEqual(m.results.get('agentsQ'), ['a']);
});
