/**
 * Platform-layer tests. Run with: `node --test oss/ui/tests/` (or `just test-ui`).
 *
 * These are the first automated tests in a frontend of ~48k LOC that previously
 * had none — no unit tests, no lint, no type checking, with the entire QA story
 * resting on screenshot fixtures driven by a tool that isn't in the repo. They
 * cover the layer where a silent regression is most expensive: the API funnel's
 * error contract, dependency injection, cache invalidation, and the list
 * envelope that every table in the product depends on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserShim } from './browser-shim.mjs';

installBrowserShim({ pathname: '/agents.html' });

const B = new URL('../common/', import.meta.url).href;
const load = (p) => import(B + p);

test('container: dependency injection and test-time override', async () => {
  const { keys, inject, withOverrides, isRegistered } = await load('core/container.js');
  await load('core/bootstrap.js');

  assert.ok(isRegistered(keys.api), 'api is bound by bootstrap');
  assert.ok(isRegistered(keys.store), 'store is bound lazily');

  const fake = { get: async () => ({ data: [], total: 0 }) };
  await withOverrides([[keys.api, fake]], async () => {
    assert.equal(inject(keys.api), fake, 'override is visible inside the scope');
  });
  assert.notEqual(inject(keys.api), fake, 'override is restored afterwards');
});

test('container: resolving an unbound key fails loudly', async () => {
  const { createKey, inject } = await load('core/container.js');
  const orphan = createKey('somethingNobodyBound');
  assert.throws(() => inject(orphan), /No provider registered for "somethingNobodyBound"/);
});

test('errors: classification the UI previously had no access to', async () => {
  const { ApiError, SessionExpiredError, shouldReport, userMessage, isAbort } = await load(
    'core/errors.js',
  );

  assert.equal(new ApiError({ status: 503 }).isRetryable, true);
  assert.equal(new ApiError({ status: 404 }).isNotFound, true);
  assert.equal(new ApiError({ status: 403 }).isForbidden, true);

  // A cancellation and a session expiry must never reach the user.
  assert.equal(shouldReport(new ApiError({ status: 500 })), true);
  assert.equal(shouldReport(new SessionExpiredError({ status: 401 })), false);
  assert.equal(isAbort(Object.assign(new Error('x'), { name: 'AbortError' })), true);

  // Regression guard for the original defect: a raw JSON body must never be
  // shown to a user as if it were a message.
  assert.notEqual(userMessage(new ApiError({ status: 400, message: '{"error":"x"}' })), '{"error":"x"}');
  assert.equal(userMessage(new ApiError({ status: 404 })), 'Not found.');
  assert.equal(userMessage(new ApiError({ status: 400, message: 'Name is taken' })), 'Name is taken');
});

test('query: one envelope shape, and no NaN offsets', async () => {
  const { qs, pageToRange, normalizeList } = await load('services/query.js');

  assert.equal(qs({ a: 1, b: '', c: null, d: 0 }), '?a=1&d=0', 'drops empty, keeps 0');
  assert.equal(qs({}), '', 'nothing to send means no question mark');

  assert.deepEqual(pageToRange(3, 10), { limit: 10, offset: 20 }, 'page is 1-based');
  assert.deepEqual(pageToRange(undefined, undefined), { limit: 10, offset: 0 }, 'no NaN');
  assert.deepEqual(pageToRange(0, -5), { limit: 10, offset: 0 }, 'nonsense clamped');

  // The settled contract: components read {data, total}. `items` was never read
  // by either table component despite both JSDocs claiming it.
  assert.deepEqual(normalizeList([1, 2]), { data: [1, 2], total: 2 }, 'bare array');
  assert.equal(normalizeList({ teams: [1], total: 9 }, 'teams').total, 9, 'named collection');
  assert.equal(normalizeList({ data: [1], total_count: 7 }).total, 7, 'total_count honoured');
  assert.deepEqual(normalizeList(null), { data: [], total: 0 }, 'null does not throw');
});

test('signal: batching, equality gating, and no observer leak on dispose', async () => {
  const { signal, computed, effect, batch } = await load('state/signal.js');

  const a = signal(1, 'a');
  const b = signal(2, 'b');
  const sum = computed(() => a.get() + b.get(), 'sum');

  let runs = 0;
  const stop = effect(() => {
    sum.get();
    runs++;
  });

  assert.equal(sum.get(), 3);
  a.set(5);
  assert.equal(sum.get(), 7);

  const before = runs;
  batch(() => {
    a.set(10);
    b.set(20);
  });
  assert.equal(sum.get(), 30);
  assert.equal(runs, before + 1, 'batched writes notify once');

  const stable = runs;
  a.set(10);
  assert.equal(runs, stable, 'setting an Object.is-equal value does not notify');

  // Scope matters here. The effect reads `sum` (the computed), so `a`'s
  // observer belongs to the *computed*, not the effect — asserting on `a` after
  // stopping the effect was the wrong scope, and chasing it surfaced a real gap:
  // a computed created inside a component never detached from its sources.
  const direct = signal(0, 'direct');
  let directRuns = 0;
  const stopDirect = effect(() => {
    direct.get();
    directRuns++;
  });
  assert.equal(direct.observerCount, 1, 'effect is attached to what it read');
  stopDirect();
  assert.equal(direct.observerCount, 0, 'disposer detaches — otherwise the component leaks');
  stopDirect();

  // And the computed is disposable too, so a component-local one can be cleaned
  // up by NasikoElement#compute().
  assert.equal(a.observerCount, 1, "the computed is still attached to its source");
  sum.dispose();
  assert.equal(a.observerCount, 0, 'computed.dispose() detaches from sources');

  stop();
});

test('store: single-flight, caching, invalidation, stale-while-revalidate', async () => {
  const { resource, invalidate, closeInvalidationChannel } = await load('state/store.js');

  let calls = 0;
  const r = resource('test.agents', async () => {
    calls++;
    await new Promise((s) => setTimeout(s, 5));
    return [{ n: calls }];
  });

  await Promise.all([r.load(), r.load(), r.load()]);
  assert.equal(calls, 1, 'three concurrent loads collapse into one request');

  await r.load();
  assert.equal(calls, 1, 'served from cache');

  const previous = r.data.peek();
  invalidate('test.agents');
  assert.deepEqual(r.data.peek(), previous, 'old value stays readable while stale');

  await r.load();
  assert.equal(calls, 2, 'refetched after invalidation');
  assert.equal(r.state.peek(), 'ready');

  r.dispose();
  closeInvalidationChannel();
});

test('store: a failing loader records the error without throwing state away', async () => {
  const { resource, closeInvalidationChannel } = await load('state/store.js');
  const r = resource('test.fails', async () => {
    throw Object.assign(new Error('boom'), { status: 500 });
  });
  await assert.rejects(() => r.load(), /boom/);
  assert.equal(r.state.peek(), 'error');
  assert.match(r.error.peek().message, /boom/);
  r.dispose();
  closeInvalidationChannel();
});

test('events: the bus is a closed contract, and publish invalidates', async () => {
  const { publish, subscribe, EVENTS } = await load('core/events.js');
  const { closeInvalidationChannel } = await load('state/store.js');

  let heard = null;
  const off = subscribe('agent:created', (p) => (heard = p));
  publish('agent:created', { agentId: 'a1' });
  assert.deepEqual(heard, { agentId: 'a1' });
  off();

  publish('agent:created', { agentId: 'a2' });
  assert.deepEqual(heard, { agentId: 'a1' }, 'unsubscribed handler stops hearing');

  assert.throws(() => publish('not:a:real:event', {}), /Unknown application event/);
  assert.ok(EVENTS['agent:created'].invalidates.includes('agents'), 'contract declares its cache keys');
  closeInvalidationChannel();
});

test('env: dev detection uses the explicit flag and loopback only, never the port', async () => {
  const { isDev } = await load('core/env.js');

  globalThis.location.hostname = 'localhost';
  assert.equal(isDev(), true);

  // The original heuristic treated any non-default port as dev, which would
  // have thrown policy violations at customers behind :8443.
  globalThis.location.hostname = 'cp.nasiko.dev';
  globalThis.location.port = '8443';
  assert.equal(isDev(), false);

  globalThis.window.nasikoConfig = { dev: true };
  assert.equal(isDev(), true, 'server-injected flag is authoritative');
  delete globalThis.window.nasikoConfig;
  globalThis.location.hostname = 'localhost';
});

test('url-policy: opaque params allowed, user-authored content refused', async () => {
  const { checkParam, readSearchParams } = await load('utils/url-policy.js');

  assert.equal(checkParam('id'), null);
  assert.equal(checkParam('session_id'), null);
  assert.match(checkParam('q'), /must never appear/);
  assert.match(checkParam('email'), /must never appear/);
  assert.match(checkParam('customer_name'), /not an allowed URL param/);

  assert.deepEqual(
    readSearchParams(['id', 'q'], '?id=abc&q=secret+search'),
    { id: 'abc' },
    'a forbidden param present in a link is ignored, not honoured',
  );
});

test('escape: one implementation, correct in attribute position', async () => {
  const { escHtml, escAttr, safeHtml, trusted } = await load('utils/escape.js');

  assert.equal(escHtml('<b>&'), '&lt;b&gt;&amp;');
  assert.equal(escHtml(null), '', 'null renders empty, not "null"');
  assert.equal(escHtml(0), '0', 'zero is not empty');

  // The family-A defect: the DOM-round-trip escaper left quotes alone, and two
  // pages interpolated it into attribute values with user-controlled data.
  assert.equal(escAttr('a"b'), 'a&quot;b');
  assert.equal(escAttr("it's"), 'it&#39;s');

  assert.equal(safeHtml`<a title="${'x"y'}">`, '<a title="x&quot;y">');
  assert.equal(safeHtml`${trusted('<b>ok</b>')}`, '<b>ok</b>', 'trusted markup passes through');
});

test('data-sources: duplicate registration and missing names both fail loudly', async () => {
  const { register, resolve, resolveOptional, has, reset } = await load('core/data-sources.js');
  reset();

  register('fetchAgents', async () => ({ data: [], total: 0 }));
  assert.ok(has('fetchAgents'));

  assert.throws(() => register('fetchAgents', () => {}), /already registered/);
  register('fetchAgents', () => {}, { replace: true });

  // The old window lookup returned undefined and rendered an empty view forever.
  assert.throws(() => resolve('fetchAgent'), /Did you mean: fetchAgents/);
  assert.equal(resolveOptional('nothingHere'), undefined);
  reset();
});
