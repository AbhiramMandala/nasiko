/**
 * The saved-views store, which is two stores wearing one interface.
 *
 * Saved views live on the server; unsaved ones live in localStorage and are
 * never sent. The seam between them is where the bugs are, so that is what
 * these cover: the id changing at first Save, a visit count that has to survive
 * it, and a 404 meaning "this build does not have the feature" rather than
 * "something went wrong".
 *
 * The module is imported once and keeps module-level cache between tests, which
 * is exactly how it behaves in a tab — so each test sets the fetch script it
 * needs and asserts on the state that results, rather than pretending to a
 * fresh module every time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBrowserShim } from './browser-shim.mjs';

installBrowserShim();

/** Requests seen, so a test can assert on method/path/body as well as outcome. */
let calls = [];
/** Next responses, consumed in order. A test that runs out gets a loud 500. */
let script = [];

const reply = (status, data, message = 'ok') => ({
  status,
  body: JSON.stringify({ data, status_code: status, message }),
});

globalThis.fetch = async (url, init = {}) => {
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
  const next = script.shift()
    ?? reply(500, null, `unscripted ${method} ${url}`);
  return new Response(next.body, {
    status: next.status,
    headers: { 'content-type': 'application/json' },
  });
};

const views = await import('../common/state/weave-views.js');

function scriptedRun(responses) {
  calls = [];
  script = responses;
}

const row = (over = {}) => ({
  id: 'srv-1',
  title: 'Cost review',
  dsl: 'root = AppStack(children: [])',
  catalog_version: 'abc123',
  data_sources: [],
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-02T10:00:00Z',
  ...over,
});

test('the list is unwrapped, converted and marked saved', async () => {
  scriptedRun([reply(200, [row(), row({ id: 'srv-2', title: 'Latency' })])]);
  const list = await views.refreshViews();

  assert.equal(calls[0].url, '/api/weave/views');
  assert.equal(list.length, 2);
  assert.equal(views.viewsAvailable(), true);
  // snake_case and RFC3339 do not reach the pages.
  assert.equal(list[0].catalogVersion, 'abc123');
  assert.equal(list[0].updatedAt, Date.parse('2026-09-02T10:00:00Z'));
  assert.equal(list[0].saved, true);
});

test('a local view is addressable but is not on the server', async () => {
  scriptedRun([]);
  const view = views.createView('Create a view for monitoring costs of the top 5 agents');

  assert.equal(calls.length, 0, 'createView must not write to the server');
  assert.equal(view.saved, false);
  // The fallback title is the prompt itself (untruncated, under the cap) — the
  // real title lands later via `generateViewTitle` + `renameView`, not here.
  assert.equal(view.title, 'Create a view for monitoring costs of the top 5 agents');
  assert.equal(views.getView(view.id).id, view.id);
  // …and it shows up alongside the saved ones for anything listing everything.
  assert.ok(views.listViews().some((v) => v.id === view.id));
  // …but not in the shelf, which is the saved list only.
  assert.ok(!views.listSavedViews().some((v) => v.id === view.id));
});

test('setViewSurface on a local view stays local, and writes both fields', async () => {
  scriptedRun([]);
  const view = views.createView('spend by provider');
  const after = await views.setViewSurface(view.id, { dsl: 'root = X()', catalogVersion: 'v1' });

  assert.equal(calls.length, 0);
  assert.equal(after.dsl, 'root = X()');
  assert.equal(after.catalogVersion, 'v1');
  assert.equal(views.getView(view.id).dsl, 'root = X()');
});

test('saving before the generation lands is refused here, not by the server', async () => {
  scriptedRun([]);
  const view = views.createView('anything');
  await assert.rejects(() => views.saveView(view.id), { code: 'view_not_ready' });
  assert.equal(calls.length, 0, 'a request the API would 400 must not be sent');
});

test('first Save is a POST, and the view takes the server id with it', async () => {
  scriptedRun([]);
  const local = views.createView('agent latency by provider');
  await views.setViewSurface(local.id, { dsl: 'root = Y()', catalogVersion: 'cat-9' });
  views.touchView(local.id);
  views.touchView(local.id);

  scriptedRun([reply(201, row({ id: 'srv-new', title: 'agent latency by provider', dsl: 'root = Y()' }))]);
  const savedRow = await views.saveView(local.id);

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/weave/views');
  assert.deepEqual(calls[0].body, {
    title: 'agent latency by provider',
    dsl: 'root = Y()',
    catalog_version: 'cat-9',
    data_sources: [],
  });

  assert.equal(savedRow.id, 'srv-new');
  assert.notEqual(savedRow.id, local.id);
  assert.equal(savedRow.saved, true);
  // The local row is gone: one view, one id, one home.
  // …but the id it had is not a dead end: the dock's artifact card and any link
  // copied before Save still hold it.
  assert.equal(views.resolveViewId(local.id), 'srv-new');
  assert.equal(views.getView(local.id).id, 'srv-new');
  assert.equal(views.getView('srv-new').id, 'srv-new');
  assert.ok(views.listSavedViews().some((v) => v.id === 'srv-new'));
  // The visit count followed the id across, or "Most visited" would reset every
  // time someone saved the thing they had been opening.
  assert.equal(views.getView('srv-new').visits, 2);
});

test('the pre-Save id keeps resolving, so nothing holding it is orphaned', () => {
  // The dock's artifact card, and any link copied before Save, hold the local id.
  const stale = views.listViews().find((v) => v.id === 'srv-new');
  assert.ok(stale, 'sanity: the saved row is in the list');
  assert.equal(views.resolveViewId('srv-new'), 'srv-new', 'a canonical id is left alone');
});

test('a second Save is a PATCH carrying dsl and catalog_version together', async () => {
  scriptedRun([reply(200, row({ id: 'srv-new', dsl: 'root = Z()', catalog_version: 'cat-10' }))]);
  await views.setViewSurface('srv-new', { dsl: 'root = Z()', catalogVersion: 'cat-10' });

  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, '/api/weave/views/srv-new');
  assert.deepEqual(calls[0].body, { dsl: 'root = Z()', catalog_version: 'cat-10' });
  assert.equal(views.getView('srv-new').dsl, 'root = Z()');
});

test('renaming a saved view sends the title alone', async () => {
  scriptedRun([reply(200, row({ id: 'srv-new', title: 'Spend review' }))]);
  const renamed = await views.renameView('srv-new', '  Spend review  ');

  assert.equal(calls[0].method, 'PATCH');
  // Only `title`. Omitting is what keeps the other fields; sending `[]` or ""
  // for them would clear them (doc §7.4).
  assert.deepEqual(calls[0].body, { title: 'Spend review' });
  assert.equal(renamed.title, 'Spend review');
  assert.equal(views.getView('srv-new').title, 'Spend review');
});

test('an empty rename is refused before it reaches the server', async () => {
  scriptedRun([]);
  await assert.rejects(() => views.renameView('srv-new', '   '), /needs a name/);
  assert.equal(calls.length, 0);
});

test('renaming an unsaved view stays local', async () => {
  scriptedRun([]);
  const local = views.createView('draft');
  await views.renameView(local.id, 'Better name');
  assert.equal(calls.length, 0);
  assert.equal(views.getView(local.id).title, 'Better name');
  await views.deleteView(local.id);
});

test('renaming with a pre-Save id still reaches the saved row', async () => {
  // Reproduces the dock's #retitle race: it reads `view.id` once, before
  // Save can swap it for the server's UUID. If a rename lands after that
  // swap, it must still find the row — not silently no-op and leave the
  // server holding the placeholder title forever.
  scriptedRun([]);
  const local = views.createView('quarterly spend');
  await views.setViewSurface(local.id, { dsl: 'root = Q()', catalogVersion: 'cat-11' });

  scriptedRun([reply(201, row({ id: 'srv-race', title: 'quarterly spend', dsl: 'root = Q()' }))]);
  await views.saveView(local.id);

  scriptedRun([reply(200, row({ id: 'srv-race', title: 'Quarterly Spend Review' }))]);
  const renamed = await views.renameView(local.id, 'Quarterly Spend Review');

  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, '/api/weave/views/srv-race');
  assert.equal(renamed.title, 'Quarterly Spend Review');
  assert.equal(views.getView('srv-race').title, 'Quarterly Spend Review');
});

test('deleting a saved view waits for the server before dropping the card', async () => {
  scriptedRun([reply(500, null, 'boom')]);
  await assert.rejects(() => views.deleteView('srv-new'));
  assert.ok(views.getView('srv-new'), 'a failed delete must leave the view visible');

  scriptedRun([reply(200, null)]);
  await views.deleteView('srv-new');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(views.getView('srv-new'), null);
});

test('deleting twice is the same outcome, so the second is not an error', async () => {
  scriptedRun([reply(200, [row({ id: 'srv-gone' })])]);
  await views.refreshViews();
  scriptedRun([reply(404, null, 'no such view')]);
  await views.deleteView('srv-gone');
  assert.equal(views.getView('srv-gone'), null);
});

test('deleting an unsaved view sends nothing', async () => {
  scriptedRun([]);
  const local = views.createView('throwaway');
  await views.deleteView(local.id);
  assert.equal(calls.length, 0);
  assert.equal(views.getView(local.id), null);
});

test('a 404 on the list is the OSS build, not a failure to report', async () => {
  scriptedRun([reply(404, null, 'not found')]);
  const list = await views.refreshViews();

  assert.deepEqual(list, []);
  assert.equal(views.viewsAvailable(), false);
  assert.equal(views.hasSavedViews(), false);
});

test('any other list failure keeps the last good list rather than blanking it', async () => {
  scriptedRun([reply(200, [row({ id: 'srv-keep' })])]);
  await views.refreshViews();

  scriptedRun([reply(503, null, 'upstream down')]);
  await assert.rejects(() => views.refreshViews());
  assert.equal(views.hasSavedViews(), true);
  assert.equal(views.getView('srv-keep').id, 'srv-keep');
  assert.equal(views.viewsAvailable(), true, 'a flaky network must not disable the feature');
});

// ── generateViewTitle: never throws, resolves null on anything but a real title ──

test('generateViewTitle returns the trimmed title on a clean response', async () => {
  scriptedRun([reply(200, { title: '  Cost Monitoring Dashboard  ' })]);
  const title = await views.generateViewTitle('build me a cost dashboard');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/weave/title');
  assert.deepEqual(calls[0].body, { prompt: 'build me a cost dashboard' });
  assert.equal(title, 'Cost Monitoring Dashboard');
});

test('generateViewTitle resolves null, not "", on a whitespace-only title', async () => {
  scriptedRun([reply(200, { title: '   ' })]);
  assert.equal(await views.generateViewTitle('x'), null);
});

test('generateViewTitle resolves null on an empty-string title', async () => {
  scriptedRun([reply(200, { title: '' })]);
  assert.equal(await views.generateViewTitle('x'), null);
});

test('generateViewTitle resolves null when the envelope has no data at all', async () => {
  script = [{ status: 200, body: JSON.stringify({ status_code: 200, message: 'ok' }) }];
  calls = [];
  assert.equal(await views.generateViewTitle('x'), null);
});

test('generateViewTitle resolves null when title is missing from data', async () => {
  scriptedRun([reply(200, {})]);
  assert.equal(await views.generateViewTitle('x'), null);
});

test('generateViewTitle resolves null when title is not a string', async () => {
  scriptedRun([reply(200, { title: 12345 })]);
  assert.equal(await views.generateViewTitle('x'), null);
});

test('generateViewTitle never throws on a 404 (OSS build has no route)', async () => {
  scriptedRun([reply(404, null, 'not found')]);
  await assert.doesNotReject(async () => {
    const title = await views.generateViewTitle('x');
    assert.equal(title, null);
  });
});

test('generateViewTitle never throws on a malformed (non-JSON) response body', async () => {
  script = [{ status: 200, body: 'not json at all {{{' }];
  calls = [];
  await assert.doesNotReject(async () => {
    const title = await views.generateViewTitle('x');
    assert.equal(title, null);
  });
});

test('generateViewTitle never throws on a network/server error', async () => {
  scriptedRun([reply(500, null, 'boom')]);
  await assert.doesNotReject(async () => {
    const title = await views.generateViewTitle('x');
    assert.equal(title, null);
  });
});

test('generateViewTitle coerces a non-string/undefined prompt to a string rather than sending null', async () => {
  scriptedRun([reply(200, { title: 'ok' })]);
  await views.generateViewTitle(undefined);
  assert.deepEqual(calls[0].body, { prompt: '' });
});

test('changes are announced on document, once per mutation', async () => {
  let beats = 0;
  const off = views.onViewsChange(() => { beats += 1; });
  scriptedRun([]);
  views.createView('a');
  assert.equal(beats, 1);
  off();
  views.createView('b');
  assert.equal(beats, 1, 'unsubscribe must actually unsubscribe');
});

// ── the fallback title, and the boundary it has to match ───────────────────
// A view is titled twice: once here the instant it is created, and again when
// POST /weave/title answers. The two have to agree on the truncation, or the
// same prompt is titled one way for a second and another way after — which
// reads as the title changing by itself.

test('the truncation cap has not drifted from the server that shares it', () => {
  // Restated across a boundary with no build step between them, so this is
  // the only thing keeping them equal. Reading the Rust rather than a copy of
  // it is the point: a copy drifts the same way the constant would.
  const rust = readFileSync(new URL('../../oss/server/src/titling.rs', import.meta.url), 'utf8');
  const declared = rust.match(/pub const MAX_TITLE_CHARS:\s*usize\s*=\s*(\d+)/)?.[1];
  assert.ok(declared, 'titling.rs no longer declares MAX_TITLE_CHARS — the comment in weave-views.js points at it');
  assert.equal(views.fallbackTitle('x'.repeat(200)).length, Number(declared),
    `the client truncates at ${views.fallbackTitle('x'.repeat(200)).length}, titling.rs at ${declared}`);
});

test('the fallback truncates by code point, the way truncate_title does', () => {
  // `slice()` counts UTF-16 units, so an astral character costs two: this
  // input is 100 code points and 200 units, and the old cut took 40 of them
  // where the server takes 80. It could also land between a surrogate pair
  // and leave half a character behind.
  const out = views.fallbackTitle('📊'.repeat(100));
  assert.equal([...out].length, 80, 'eighty code points, not eighty code units');
  // `u` matters: without it, `$` anchors to the last code UNIT, so the low
  // surrogate of a perfectly good pair matches and the check fails on
  // correct output. In unicode mode the class only catches a lone one.
  assert.doesNotMatch(out, /[\uD800-\uDFFF]$/u, 'never ends on half a surrogate pair');
  // And one that is under the cap only when counted properly: 60 astral
  // characters plus 16 of text is 76 points but 136 units, so a unit-based
  // cut would truncate a title that fits.
  const fits = `${'📊'.repeat(60)} spend dashboard`;
  assert.equal(views.fallbackTitle(fits), fits, 'under the cap, left alone');
});

test('the fallback adds no ellipsis, because the server adds none', () => {
  const out = views.fallbackTitle('word '.repeat(40));
  assert.doesNotMatch(out, /…|\.\.\.$/);
  assert.equal(out, out.trimEnd(), 'and the cut is trimmed, like trim_end()');
});

test('a blank prompt still gets a name', () => {
  assert.equal(views.fallbackTitle(''), 'New view');
  assert.equal(views.fallbackTitle('   '), 'New view');
  assert.equal(views.fallbackTitle(null), 'New view');
});

test('a short prompt is left exactly alone', () => {
  assert.equal(views.fallbackTitle('  spend by agent  '), 'spend by agent');
});

// ── hydrateView: the resume path ───────────────────────────────────────────
// Reopening a chat from the dock's history replays its messages and, for the
// last one that carried a view, puts that view back in the store so /view can
// draw it. It writes to localStorage, so getting it wrong leaves a duplicate
// or a shadow row over something already saved.

test('hydrating a view the store has never seen puts it in the local list', () => {
  scriptedRun([]);
  const view = views.hydrateView({
    id: 'resumed-1', title: 'Spend review', dsl: 'root = AppText("hi")', catalogVersion: 'abc123',
  });
  assert.equal(view.id, 'resumed-1');
  assert.equal(view.dsl, 'root = AppText("hi")');
  assert.equal(view.catalogVersion, 'abc123');
  assert.equal(views.getView('resumed-1').title, 'Spend review');
  assert.equal(calls.length, 0, 'hydrating is local — it must not call the server');
});

test('hydrating twice does not duplicate the row', () => {
  scriptedRun([]);
  views.hydrateView({ id: 'resumed-2', title: 'First', dsl: 'a' });
  const again = views.hydrateView({ id: 'resumed-2', title: 'Second', dsl: 'b' });
  assert.equal(again.title, 'First', 'the row already there wins — a resume is not an edit');
  assert.equal(views.listViews().filter((v) => v.id === 'resumed-2').length, 1);
});

test('hydrating an id that is already SAVED does not shadow it locally', () => {
  // The dangerous case. A saved view lives on the server and is reached
  // through `saved`, not localStorage — writing a second unsaved row under
  // the same id would give the shelf one title and /view another.
  scriptedRun([reply(200, [row({ id: 'srv-hydrate', title: 'On the server' })])]);
  return views.refreshViews().then(() => {
    scriptedRun([]);
    const out = views.hydrateView({ id: 'srv-hydrate', title: 'Stale local copy', dsl: 'x' });
    assert.equal(out.title, 'On the server');
    assert.equal(views.getView('srv-hydrate').title, 'On the server');
  });
});

test('a hydrated view with no title still gets a name', () => {
  scriptedRun([]);
  assert.equal(views.hydrateView({ id: 'resumed-3' }).title, 'New view');
});
