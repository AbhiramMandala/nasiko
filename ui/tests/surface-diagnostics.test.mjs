/**
 * The diagnostic manifest, as a contract rather than a document.
 *
 * `gen-diagnostics --check` already fails the gate when the manifest is stale,
 * so this does not re-test the generator. What it tests is the thing the
 * generator cannot: that the classification is *usable* — that the eval reads
 * severity from here rather than from a literal, that the three ranks mean what
 * the eval does with them, and that the codes the two known-good behaviours
 * depend on have not quietly changed rank.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../common/surface/diagnostics.json', import.meta.url), 'utf8'),
);
const { diagnostics, counts } = manifest;

test('every code carries a rank, a reason and at least one emitter', () => {
  for (const [code, d] of Object.entries(diagnostics)) {
    assert.ok(['fatal', 'advisory', 'runtime'].includes(d.severity), `${code}: ${d.severity}`);
    assert.ok(d.why?.length > 10, `${code} has no stated reason`);
    assert.ok(d.emitters?.length, `${code} is classified but nothing emits it`);
    for (const e of d.emitters) assert.ok(e.module.endsWith('.js'), `${code}: ${e.module}`);
  }
});

test('the counts in the header match the body', () => {
  const actual = { fatal: 0, advisory: 0, runtime: 0, repairable: 0 };
  for (const d of Object.values(diagnostics)) {
    actual[d.severity]++;
    if (d.repairable) actual.repairable++;
  }
  assert.deepEqual(actual, counts);
});

test('only a verdict on the DSL is ever handed back for repair', () => {
  // A repair turn asks the model to fix its own output. A `runtime` code is
  // not its output — a data source that 500s, a dropped stream, a host with
  // no navigator — and asking it to repair one teaches it that the DSL was
  // at fault when it was not.
  for (const [code, d] of Object.entries(diagnostics)) {
    if (d.severity !== 'runtime') continue;
    assert.ok(!d.repairable, `${code} is runtime and marked repairable`);
  }
  // And the exceptions are stated, not implied: a fatal that is NOT
  // repairable has to say why, so the list cannot quietly grow.
  for (const [code, d] of Object.entries(diagnostics)) {
    if (d.severity === 'runtime' || d.repairable) continue;
    assert.ok(d.notRepairable, `${code} is a ${d.severity} that no repair is offered for, with no reason recorded`);
  }
});

test('a code emitted from two modules records both, with each one\'s source', () => {
  // route_not_allowed is `render` from a href attribute and `actions` from
  // @OpenUrl. Recording whichever was scanned first would give a consumer
  // filtering by source a manifest that lies about half its own vocabulary.
  const both = diagnostics.route_not_allowed.emitters;
  assert.equal(both.length, 2, JSON.stringify(both));
  assert.deepEqual(new Set(both.map((e) => e.source)), new Set(['render', 'actions']));
});

test('content loss is fatal — the whole reason the rank exists', () => {
  // Each of these means something the model asked for is not on the page.
  // Demoting any of them to advisory is how the eval starts passing surfaces
  // that are visibly missing their content, so they are pinned here rather
  // than left to whoever next edits the map.
  for (const code of [
    'component_as_attribute', 'orphaned_statement', 'excess_arguments',
    'unknown_attribute', 'unknown_slot', 'bad_slot', 'data_not_rows',
    'missing_accessible_name', 'root_not_a_component',
  ]) {
    assert.equal(diagnostics[code]?.severity, 'fatal', code);
  }
});

test('a corrected mistake is advisory, and the surface is still right', () => {
  for (const code of ['excess_null_padding', 'default_is_whole_response', 'non_route_value']) {
    assert.equal(diagnostics[code]?.severity, 'advisory', code);
  }
});

test('transport and upstream failures say nothing about the DSL', () => {
  // These can all happen to a perfect generation. Ranking one fatal would fail
  // an eval case for a dropped connection, which is how a checker loses the
  // right to be believed.
  for (const code of [
    'stream_interrupted', 'stream_resumed', 'http_error', 'not_an_event_stream',
    'query_failed', 'mutation_failed', 'catalog_version_mismatch', 'request_failed',
  ]) {
    assert.equal(diagnostics[code]?.severity, 'runtime', code);
  }
});
