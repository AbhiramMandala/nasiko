/**
 * `$event` — what the user actually typed.
 *
 * agent.yaml teaches it (rule at :69, Worked Example 3c) as the only way an
 * Action can read live input: `@Set($query, $query)` re-sets a variable to
 * itself. The runtime did not implement it, so every generated search box set
 * its variable to null and searched for nothing — silently, with no diagnostic,
 * because null is a legal value.
 *
 * Found by reading a real recorded generation, not by a failing test. Hence
 * these.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { valueOf, createActionRunner } from '../common/surface/actions.js';

// ── Getting a value out of the event ────────────────────────────────────────

test('a custom element reporting through detail.value wins over the DOM node', () => {
  // A composed component's target can be an inner element whose value means
  // something else entirely.
  assert.equal(valueOf({ detail: { value: 'typed' }, target: { value: 'inner' } }), 'typed');
});

test('a native input reports its value', () => {
  assert.equal(valueOf({ target: { value: 'coding-agent' } }), 'coding-agent');
});

test('a checkbox reports checked, not value', () => {
  // `value` on a checkbox is a submit-time string with nothing to do with what
  // the user did.
  assert.equal(valueOf({ target: { type: 'checkbox', checked: true, value: 'on' } }), true);
  assert.equal(valueOf({ target: { type: 'checkbox', checked: false, value: 'on' } }), false);
});

test('an empty string is a real value, not an absence', () => {
  // Clearing a search box has to reach the query, or the results never reset.
  assert.equal(valueOf({ target: { value: '' } }), '');
});

test('nothing meaningful yields undefined, so $event falls through to the store', () => {
  assert.equal(valueOf(null), undefined);
  assert.equal(valueOf({}), undefined);
  assert.equal(valueOf({ target: {} }), undefined);
});

// ── Binding it into an Action ───────────────────────────────────────────────

function runnerFor(sets) {
  return createActionRunner({
    store: { set: (name, value) => { sets.push([name, value]); return true; }, reset: () => false },
    queries: {
      isQuery: () => true, isMutation: () => false,
      run: async () => ({ ok: true }), fireMutation: async () => ({ ok: true }),
    },
    refresh: () => ({ evaluateAst: evaluate }),
    onDiagnostic: () => {},
  });
}

/** Stands in for the materializer's evaluator, including its scope lookup. */
function evaluate(node, scope) {
  if (!node) return null;
  if (node.k === 'Str') return node.v;
  if (node.k === 'StateRef') {
    for (let s = scope; s; s = s.parent) if (s.name === node.n) return s.value;
    return null; // not bound, and no store in this stand-in
  }
  return null;
}

const setFromEvent = {
  type: 'action', statementId: 'runSearch',
  steps: [{ kind: 'set', target: '$query', valueAst: { k: 'StateRef', n: '$event' }, scope: null }],
};

test('@Set($query, $event) stores what the user typed', () => {
  const sets = [];
  return runnerFor(sets).run(setFromEvent, evaluate, { target: { value: 'coding' } })
    .then(() => assert.deepEqual(sets, [['$query', 'coding']]));
});

test('with no event, $event is unbound rather than a confident empty string', async () => {
  const sets = [];
  await runnerFor(sets).run(setFromEvent, evaluate, null);
  assert.deepEqual(sets, [['$query', null]]);
});

test('every step of one run sees the same value', async () => {
  // Bound once for the Action, not re-read per step — an earlier step
  // re-materializes, and the value the user produced must not move under it.
  const sets = [];
  const twoSteps = {
    type: 'action', statementId: 'a',
    steps: [
      { kind: 'set', target: '$a', valueAst: { k: 'StateRef', n: '$event' }, scope: null },
      { kind: 'set', target: '$b', valueAst: { k: 'StateRef', n: '$event' }, scope: null },
    ],
  };
  await runnerFor(sets).run(twoSteps, evaluate, { target: { value: 'x' } });
  assert.deepEqual(sets, [['$a', 'x'], ['$b', 'x']]);
});

test('@ToAssistant($event) sends the typed message', async () => {
  const said = [];
  const runner = createActionRunner({
    store: { set: () => false, reset: () => false },
    queries: { isQuery: () => false, isMutation: () => false, run: async () => ({ ok: true }), fireMutation: async () => ({ ok: true }) },
    refresh: () => ({ evaluateAst: evaluate }),
    onAssistant: (t) => said.push(t),
    onDiagnostic: () => {},
  });
  await runner.run({
    type: 'action', statementId: 'send',
    steps: [{ kind: 'toAssistant', messageAst: { k: 'StateRef', n: '$event' }, scope: null }],
  }, evaluate, { detail: { value: 'show me last week' } });
  assert.deepEqual(said, ['show me last week']);
});
