/**
 * The per-turn record.
 *
 * Two properties matter more than the rest and both are tested by trying to
 * violate them: nothing a person typed or a model wrote may leave the page,
 * and one turn produces exactly one record however many times the runtime
 * re-walked the tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceTelemetry } from '../common/surface/telemetry.js';

function harness() {
  const records = [];
  let clock = 1000;
  const t = createSurfaceTelemetry({ report: (r) => records.push(r), now: () => clock });
  return { t, records, tick: (ms) => { clock += ms; } };
}

test('one turn produces exactly one record', () => {
  const { t, records } = harness();
  t.begin({ promptLength: 20, catalogVersion: 'aaaaaaaaaaaa' });
  for (let i = 0; i < 30; i++) t.chunk();
  t.record([{ source: 'materializer', code: 'unresolved' }]);
  t.end({ status: 'ok', rendered: true });
  assert.equal(records.length, 1);
  assert.equal(records[0].chunks, 30);
});

test('the same diagnostic on every chunk is counted, not repeated', () => {
  // The runtime re-derives the whole tree per chunk, so one bad statement
  // emits its diagnostic dozens of times in two seconds. Reported raw that
  // reads as a catastrophe and buries the turn with one real error in it.
  const { t, records } = harness();
  t.begin();
  for (let i = 0; i < 40; i++) t.record([{ source: 'render', code: 'unknown_attribute' }]);
  t.record([{ source: 'queries', code: 'query_failed' }]);
  t.end({ status: 'ok', rendered: true });
  assert.deepEqual(records[0].diagnostics, [
    { source: 'render', code: 'unknown_attribute', count: 40 },
    { source: 'queries', code: 'query_failed', count: 1 },
  ]);
});

test('nothing a person typed or a model wrote is in the record', () => {
  const { t, records } = harness();
  t.begin({ promptLength: 42, catalogVersion: 'aaaaaaaaaaaa' });
  t.record([{
    source: 'materializer',
    code: 'unresolved',
    message: 'Acme Corp Q3 revenue by region is not defined',
    pointer: 'acmeRevenueByRegion',
  }]);
  t.end({ status: 'ok', rendered: true });

  const serialized = JSON.stringify(records[0]);
  assert.equal(serialized.includes('Acme'), false, 'a prompt is about the user’s own data');
  assert.equal(serialized.includes('acmeRevenueByRegion'), false, 'a statement name quotes the prompt back');
  assert.equal(records[0].promptLength, 42, 'the shape is fine; the content is not');
});

test('a turn that finished ok and drew nothing is flagged as its own thing', () => {
  const { t, records } = harness();
  t.begin();
  t.end({ status: 'ok', rendered: false });
  assert.equal(records[0].emptyRender, true,
    'the user definitely saw a failure, whatever the status field says');
});

test('a turn that drew something is not flagged', () => {
  const { t, records } = harness();
  t.begin();
  t.end({ status: 'ok', rendered: true });
  assert.equal(records[0].emptyRender, false);
});

test('elapsed time is measured across the turn', () => {
  const { t, records, tick } = harness();
  t.begin();
  tick(2400);
  t.end({ status: 'ok', rendered: true });
  assert.equal(records[0].elapsedMs, 2400);
});

test('both catalog versions are recorded, so a skew is findable after the fact', () => {
  const { t, records } = harness();
  t.begin({ catalogVersion: 'aaaaaaaaaaaa' });
  t.identify({ surfaceId: 's-1', catalogVersion: 'bbbbbbbbbbbb' });
  t.end({ status: 'ok', rendered: true });
  assert.equal(records[0].catalogVersion, 'aaaaaaaaaaaa');
  assert.equal(records[0].generatorCatalogVersion, 'bbbbbbbbbbbb');
  assert.equal(records[0].surfaceId, 's-1');
});

test('a throwing sink does not break the render, or the other sinks', () => {
  const { t } = harness();
  let reached = false;
  t.onTurn(() => { throw new Error('sink is down'); });
  t.onTurn(() => { reached = true; });
  t.begin();
  assert.doesNotThrow(() => t.end({ status: 'ok', rendered: true }));
  assert.equal(reached, true);
});

test('recording outside a turn is ignored rather than throwing', () => {
  const { t, records } = harness();
  t.record([{ source: 'x', code: 'y' }]);
  t.chunk();
  assert.equal(t.end({ status: 'ok' }), null);
  assert.equal(records.length, 0);
});

test('unsubscribing stops delivery', () => {
  const { t } = harness();
  let n = 0;
  const off = t.onTurn(() => n++);
  t.begin(); t.end({ status: 'ok', rendered: true });
  off();
  t.begin(); t.end({ status: 'ok', rendered: true });
  assert.equal(n, 1);
});
