/**
 * The repair turn: deciding one is worth asking for, and writing it.
 *
 * The loop's own stopping conditions are tested through a fake transport in
 * surface-stream.test.mjs. What is under test here is the judgement in front
 * of it — which diagnostics a model can act on, and whether the prompt says
 * enough to act on them. Both are pure, which is the point of the module
 * being separate from the thing that sends it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { repairableDiagnostics, buildRepairPrompt } =
  await import(new URL('../common/surface/repair.js', import.meta.url).href);

// The `diagnostics` map, which is what catalog-load.js#severities() hands the
// runtime — not the whole file.
const table = JSON.parse(
  readFileSync(new URL('../common/surface/diagnostics.json', import.meta.url), 'utf8')).diagnostics;

const d = (code, extra = {}) => ({ source: 'render', code, message: `${code} happened`, ...extra });

test('a runtime diagnostic is never handed back', () => {
  // query_failed is the data source failing. The DSL naming it is correct,
  // and asking the model to fix it teaches it the opposite.
  const out = repairableDiagnostics([d('query_failed'), d('http_error')], table);
  assert.deepEqual(out, []);
});

test('a fatal the model wrote is handed back', () => {
  const out = repairableDiagnostics(
    [d('missing_accessible_name', { pointer: 'tabs' })], table);
  assert.equal(out.length, 1);
  assert.equal(out[0].pointer, 'tabs');
});

test("a fatal that is not the model's fault is not handed back", () => {
  // component_threw is a JS stack from inside a component; no DSL edit
  // addresses it, and the message is not something to hand a generator.
  assert.deepEqual(repairableDiagnostics([d('component_threw')], table), []);
  assert.deepEqual(repairableDiagnostics([d('no_data_property')], table), []);
});

test('advisories are held back unless asked for', () => {
  const advisory = [d('default_is_whole_response', { pointer: 'rowsQ' })];
  assert.deepEqual(repairableDiagnostics(advisory, table), [],
    'the surface on screen is already right — not worth making a user wait');
  assert.equal(repairableDiagnostics(advisory, table, { includeAdvisory: true }).length, 1,
    'the eval measures these, so it opts in');
});

test('a code this build has never heard of is left alone', () => {
  // A newer runtime talking to an older client. Guessing that the model can
  // fix something this build cannot classify is how a loop starts talking to
  // itself.
  assert.deepEqual(repairableDiagnostics([d('some_future_code')], table), []);
});

test('the same problem reported by two components is one instruction', () => {
  // A Query default of the wrong shape is reported once per reader. The model
  // has one line to fix.
  const dupes = [
    d('missing_accessible_name', { pointer: 'box' }),
    d('missing_accessible_name', { pointer: 'box' }),
    d('missing_accessible_name', { pointer: 'other' }),
  ];
  assert.equal(repairableDiagnostics(dupes, table).length, 2);
});

test('no repairable diagnostics means no prompt at all', () => {
  assert.equal(buildRepairPrompt([]), null);
  assert.equal(buildRepairPrompt(null), null);
});

test('the prompt names the statement and states the remedy', () => {
  const prompt = buildRepairPrompt([{
    code: 'missing_accessible_name',
    pointer: 'viewTabs',
    message: 'app-tabs is operable but has no name — set label',
  }]);
  assert.match(prompt, /`viewTabs`/, 'the model addresses statements by name');
  assert.match(prompt, /set label/, 'the runtime already worked out the fix');
  assert.match(prompt, /SAME names/, 'rule 8 is how the patch lands');
});

test('the prompt forbids the three things a revision turn does by default', () => {
  const prompt = buildRepairPrompt([{ code: 'enum_violation', pointer: 'chart', message: 'bad gap' }]);
  assert.match(prompt, /Do not rebuild the dashboard/);
  assert.match(prompt, /Do not re-emit `root`/);
  assert.match(prompt, /opening or closing sentence/);
});

test('a flood is truncated, and says so, and says to look for one cause', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    code: 'unknown_attribute', pointer: `c${i}`, message: `no "fmt" attribute`,
  }));
  const prompt = buildRepairPrompt(many);
  assert.match(prompt, /30 problems/, 'the real count is stated');
  assert.match(prompt, /and 18 more/, 'the listing is capped at 12');
  assert.match(prompt, /fix the cause/, 'thirty reports are usually one mistake');
  assert.ok(prompt.split('\n').filter((l) => l.startsWith('- ')).length === 12);
});

test('a diagnostic with no pointer still makes it into the list', () => {
  // Some codes are about the surface as a whole (root_not_a_component). They
  // are still worth saying; they just cannot name a line.
  const prompt = buildRepairPrompt([{ code: 'root_not_a_component', message: 'root is a string' }]);
  assert.match(prompt, /an unnamed statement/);
  assert.match(prompt, /root is a string/);
});

test('before the severity table has loaded, nothing is repairable', () => {
  // A repair turn built on a guess about which codes mean what is worse than
  // no repair turn: it would hand back runtime faults as if the DSL caused
  // them.
  assert.deepEqual(repairableDiagnostics([d('missing_accessible_name')], null), []);
  assert.deepEqual(repairableDiagnostics([d('missing_accessible_name')], undefined), []);
});
