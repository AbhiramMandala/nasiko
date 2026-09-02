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
import { check, evaluateGeneration, CASES, ALLOWED_SOURCES } from '../scripts/eval-generations.mjs';

const GOOD = `Sure — building that now.
totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
requestsQ = Query("fetchUsageSummary", [], 0, "request_count")
costCard = AppStatCard("Total cost", totalCostQ, null, "up")
reqCard = AppStatCard("Requests", requestsQ, null, "up")
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
  const dsl = GOOD.replace('costCard = AppStatCard("Total cost", totalCostQ, null, "up")',
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
costCard = AppStatCard("Total cost", "0", null, "up")
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
card = AppStatCard("Cost", costQ, null, "up")
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
  assert.equal(ALLOWED_SOURCES.size, 5);
  assert.ok(ALLOWED_SOURCES.has('fetchUsageSummary'));
  assert.ok(CASES.length >= 8, 'a handful of prompts is not a baseline');
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, 'ids are the fixture filenames');
});
