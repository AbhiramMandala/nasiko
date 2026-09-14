/**
 * Generated views — the store behind the Weave dock and the Custom Views page.
 *
 * A "view" is a screen the user asked Weave for in conversation. It exists the
 * moment it is generated (so `/view?id=…` has something to render) and becomes
 * *saved* only when the user presses Save view on it — that is what puts it in
 * the sidebar and on `/custom-views`.
 *
 * ## Two homes, on purpose
 *
 * Saved views live on the server (`/api/weave/views`). Unsaved ones live in
 * localStorage and never leave the browser, because the API deliberately
 * writes nothing until Save — a user who generates six dashboards while
 * thinking out loud has created nothing, and that is the intended behaviour,
 * not a limitation to work around.
 *
 * So a view's id tells you where it lives: a local id until it is saved, the
 * server's UUID afterwards. `saveView` swaps one for the other and returns the
 * new row, because the URL the user is looking at has to follow it.
 *
 * ## Enterprise-only
 *
 * These routes do not exist on the OSS build — not 403, a plain 404, because
 * the route is absent. There is no capability endpoint to ask, so the answer
 * comes from trying: the first list call decides, the result is remembered, and
 * everything saved-related turns itself off. `viewsAvailable()` is what the
 * rail and the Save button read.
 *
 * ## `visits` has no server field
 *
 * /custom-views offers a "Most visited" sort and the API has nowhere to put a
 * visit count. It stays local: a small id→count map, merged on read. A user on
 * a second machine sees the same views ordered by their own use of them, which
 * is the honest reading of what that sort means anyway.
 *
 * @module common/state/weave-views
 */

// Relative, not `/common/…`: everything under state/ is unit-tested in Node,
// where a site-root specifier has nothing to resolve against. store.js is the
// same for the same reason.
import { getJson, postJson, patchJson, deleteJson } from '../services/api.js';

/** Versioned so a shape change can't be read back as the old one. */
const KEY = 'weave-views-v1';
/** Visit counts, kept apart because they outlive the local row once it is saved. */
const VISITS_KEY = 'weave-view-visits-v1';
/** Local id → server id, so nothing that kept the pre-Save id is orphaned by it. */
const ALIAS_KEY = 'weave-view-aliases-v1';
/** Oldest aliases are dropped past this. Generous; each entry is two short strings. */
const ALIAS_LIMIT = 200;

/** Fired on `document` after any mutation. The dock, the pages and the rail listen. */
export const VIEWS_CHANGED = 'weave-views-change';

/** Saved rows, newest-updated first, as the server last reported them. */
let saved = [];
/** null = not asked yet, true/false = the answer from the first list call. */
let available = null;

// ── local storage: unsaved views, and visit counts ──────────────────────────

function readLocal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // corrupt or unavailable storage must not blank the app
  }
}

function writeLocal(views) {
  try { localStorage.setItem(KEY, JSON.stringify(views)); } catch { /* quota / private mode */ }
  announce();
}

function readVisits() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VISITS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readAliases() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Remember that a local id became a server one.
 *
 * The dock's artifact card, and any link copied before Save, hold the id the
 * view had when they were made. Without this they lead to "That view is gone"
 * for a view the user still has — the one outcome the id swap must not produce.
 *
 * Insertion-ordered and trimmed from the front, so this cannot grow without
 * bound in a browser that is never cleared.
 */
function addAlias(from, to) {
  const aliases = readAliases();
  aliases[from] = to;
  const keys = Object.keys(aliases);
  const trimmed = keys.length > ALIAS_LIMIT
    ? Object.fromEntries(keys.slice(keys.length - ALIAS_LIMIT).map((k) => [k, aliases[k]]))
    : aliases;
  try { localStorage.setItem(ALIAS_KEY, JSON.stringify(trimmed)); } catch { /* quota */ }
}

/** The id a view is known by now, following one hop of the swap above. */
export const resolveViewId = (id) => readAliases()[id] || id;

function writeVisits(visits) {
  try { localStorage.setItem(VISITS_KEY, JSON.stringify(visits)); } catch { /* quota / private mode */ }
}

const announce = () => document.dispatchEvent(new CustomEvent(VIEWS_CHANGED));

// ── the wire shape ──────────────────────────────────────────────────────────

/**
 * A server `ViewRow` in the shape the UI already speaks.
 *
 * The API is snake_case and stores epoch-free RFC3339 strings; everything here
 * sorts and formats on numbers. Converting once, here, keeps that difference
 * out of four call sites — and out of the pages, which should not have to know
 * this store has a server behind it at all.
 */
function fromRow(row, visits = readVisits()) {
  return {
    id: row.id,
    title: row.title,
    prompt: '',                       // not stored server-side; only the title survives
    dsl: row.dsl || null,
    catalogVersion: row.catalog_version || null,
    dataSources: row.data_sources || [],
    createdAt: Date.parse(row.created_at) || 0,
    updatedAt: Date.parse(row.updated_at) || 0,
    saved: true,
    visits: visits[row.id] ?? 0,
  };
}

/** Unwrap the EE envelope, which every route here shares. */
const unwrap = (body) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * Pull the saved list from the server, once per call, and cache it.
 *
 * A 404 here is the OSS build answering "this route does not exist" — not an
 * error to show anyone. It is recorded, the feature switches off, and nothing
 * calls again. Any other failure leaves `available` alone so a flaky network
 * does not permanently disable a feature the user has.
 */
export async function refreshViews() {
  try {
    const body = await getJson('/weave/views');
    // Already sorted updated_at DESC by the server (doc 7.2) - kept in that order.
    saved = (unwrap(body) || []).map((row) => fromRow(row));
    available = true;
  } catch (err) {
    if (err?.status !== 404) {
      // Keep the last good list rather than blanking the sidebar because one
      // request timed out, and let the caller decide whether to say anything.
      announce();
      throw err;
    }
    // 404 is the OSS build answering "this route does not exist". Not an error
    // to show anyone, and not a reason to keep asking.
    available = false;
    saved = [];
  }
  announce();
  return saved;
}

/** In-flight/settled first load, so the several callers that need it share one. */
let firstLoad = null;

/**
 * The saved list, loaded once.
 *
 * Everything that renders on boot - the rail, /custom-views - needs the list
 * before it can paint and none of them owns it. Failures resolve rather than
 * throw: a nav item missing because the network hiccuped is a smaller problem
 * than navigation that fails to build.
 */
export function ensureViews() {
  firstLoad ??= refreshViews().catch(() => saved);
  return firstLoad;
}

/**
 * Whether this build has the feature at all.
 *
 * `null` until the first list call answers — callers that must not flash a
 * Save button on OSS should await `refreshViews()` first, and everything else
 * can treat null as "probably, ask later".
 */
export const viewsAvailable = () => available;

/** Every view this browser knows about, newest first — saved and unsaved alike. */
export function listViews() {
  const visits = readVisits();
  return [...saved, ...readLocal().map((v) => ({ ...v, visits: visits[v.id] ?? 0 }))]
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The saved ones, which are the only ones the sidebar and /custom-views show.
 *
 * Synchronous and served from cache on purpose: this is called on every render
 * and every store change. `refreshViews()` is what makes it current.
 */
export function listSavedViews({ sort = 'visits' } = {}) {
  const visits = readVisits();
  const rows = saved.map((v) => ({ ...v, visits: visits[v.id] ?? 0 }));
  return rows.sort(sort === 'recent'
    ? (a, b) => b.updatedAt - a.updatedAt
    : (a, b) => (b.visits ?? 0) - (a.visits ?? 0) || b.updatedAt - a.updatedAt);
}

export const hasSavedViews = () => saved.length > 0;

/** A view by id, wherever it lives. Local first: an unsaved view is only here. */
export function getView(id) {
  const visits = readVisits();
  const key = resolveViewId(id);
  const view = readLocal().find((v) => v.id === key) || saved.find((v) => v.id === key);
  // `visits` is merged on read rather than stored on the row, for both homes:
  // the count changes without the row changing, and on a saved row the copy
  // baked in at fetch time would be stale the moment the view was opened.
  return view ? { ...view, visits: visits[key] ?? 0 } : null;
}

// ── titles and ids ──────────────────────────────────────────────────────────

/**
 * The server's `titling::MAX_TITLE_CHARS`, restated.
 *
 * Restated, not shared — there is no build step between Rust and this file —
 * so `weave-views.test.mjs` reads the constant out of `titling.rs` and fails
 * if the two drift. A cap that silently disagrees across the boundary gives
 * one truncation before the fetch and a different one after it, on the same
 * prompt, which reads as the title changing for no reason.
 */
const MAX_TITLE_CHARS = 80;

/**
 * The title a view is created with, before the real one arrives.
 *
 * A plain truncation of the prompt — the same fallback the server uses when
 * its own LLM call fails — rather than a heuristic that tries to guess a
 * good title client-side. The dock replaces this via `renameView` the moment
 * `POST /weave/title` resolves (see `weave-dock.js#retitle`); this is only
 * what's on screen for the second or two before that.
 */
export function fallbackTitle(prompt) {
  const trimmed = String(prompt || '').trim();
  if (!trimmed) return 'New view';
  // Code POINTS, and no ellipsis — both to match `titling::truncate_title`,
  // which does `char_indices().nth(MAX)` then `trim_end()` and appends
  // nothing. `slice()` counts UTF-16 units, so an emoji costs two: sixty of
  // them plus a few words came out at 41 code points here against the
  // server's 76, and a cut landing between a surrogate pair leaves half a
  // character behind. The ellipsis was the more visible half of the same
  // mismatch — the same prompt was titled "…every agent…" here and
  // "…every agent" the moment the server answered.
  const points = [...trimmed];
  if (points.length <= MAX_TITLE_CHARS) return trimmed;
  return points.slice(0, MAX_TITLE_CHARS).join('').trimEnd();
}

/**
 * The model's own title for `prompt`, via the same LLM call chat sessions use
 * server-side (`POST /weave/title`, `nasiko_server::titling`).
 *
 * Resolves to `null` on any failure — an unconfigured provider, a flaky
 * network, or the OSS build (the route is EE-only, so this 404s there) —
 * rather than throwing, so a title fetch is never treated as the turn itself
 * failing. The caller keeps whatever fallback title is already showing.
 */
export async function generateViewTitle(prompt) {
  try {
    const title = unwrap(await postJson('/weave/title', { prompt: String(prompt || '') }))?.title;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}

/**
 * A local, opaque id. `crypto.randomUUID` is secure-context-only, so the `??`
 * arm is what keeps this working over plain http (the preview harness, an IP
 * address in dev) — the same fallback chat-page and orchestrator-page use.
 */
const newId = () => crypto.randomUUID?.()
  ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

// ── writes ──────────────────────────────────────────────────────────────────

/**
 * A fresh generated view. Local and unsaved: reachable by URL and nowhere else.
 *
 * Nothing is sent to the server here, and that is the whole design — a user
 * who generates six dashboards while thinking has created six things worth
 * looking at and nothing worth keeping. Save is what makes one durable.
 */
export function createView(prompt) {
  const now = Date.now();
  const view = {
    id: newId(),
    title: fallbackTitle(prompt),
    prompt: String(prompt || ''),
    createdAt: now,
    updatedAt: now,
    saved: false,
    visits: 0,
    // Informational server-side (doc 6); empty until something knows which
    // data functions the generated surface actually reached for.
    dataSources: [],
    // Filled in by setViewSurface when the generation lands. Absent, not empty,
    // so "still generating" and "generated an empty surface" stay distinct.
    dsl: null,
    catalogVersion: null,
  };
  writeLocal([...readLocal(), view]);
  return view;
}

export function hydrateView({ id, title, dsl, catalogVersion }) {
  const existing = getView(id);
  if (existing) return existing;
  const now = Date.now();
  const view = {
    id,
    title: title || 'New view',
    prompt: '',
    createdAt: now,
    updatedAt: now,
    saved: false,
    visits: 0,
    dataSources: [],
    dsl: dsl ?? null,
    catalogVersion: catalogVersion ?? null,
  };
  writeLocal([...readLocal(), view]);
  return view;
}

/**
 * Attach the surface a generation produced.
 *
 * Kept apart from `createView` because the two happen at different times and
 * the gap is the point: the view is created and routed to the instant the user
 * presses send, so `/view?id=…` has something to render the working state on,
 * and the DSL lands seconds later when the model is done.
 *
 * `dsl` and `catalogVersion` are written together and never separately. The
 * version is a content hash of the vocabulary the DSL was generated against,
 * so a pair that disagrees is worse than either being absent — it renders, and
 * the arguments may mean something other than what the generator intended.
 *
 * On a view that is already saved this is a real save: the server is the copy
 * that matters, and a revision the user can see but the server cannot is the
 * bug this avoids.
 */
export async function setViewSurface(id, { dsl, catalogVersion }) {
  const local = readLocal();
  const view = local.find((v) => v.id === id);
  if (view) {
    view.dsl = String(dsl ?? '');
    view.catalogVersion = catalogVersion ?? null;
    view.updatedAt = Date.now();
    writeLocal(local);
    return view;
  }

  const row = saved.find((v) => v.id === id);
  if (!row) return null;
  // Both fields together — see §7.4 of the API doc, and the reason above.
  return patchSaved(id, { dsl: String(dsl ?? ''), catalog_version: catalogVersion ?? row.catalogVersion });
}

/**
 * PATCH one saved row and adopt what comes back.
 *
 * The server returns the full updated row and the doc is explicit that it
 * should replace local state (7.4) — so nothing here merges fields by hand.
 * `updated_at` in particular is the server's clock, and the sidebar sorts on it.
 */
async function patchSaved(id, body) {
  const row = fromRow(unwrap(await patchJson(`/weave/views/${encodeURIComponent(id)}`, body)));
  saved = saved.map((v) => (v.id === id ? row : v));
  announce();
  return row;
}

/**
 * Thrown when Save is pressed on a view that has nothing to save yet.
 *
 * `catalog_version` is required and non-empty on create (7.1), and a view
 * only has one once its generation lands. Rather than let the server answer
 * that with a 400 whose message is about a field the user has never heard of,
 * the store refuses first and says the thing that is actually true.
 */
export class ViewNotReadyError extends Error {
  constructor() {
    super('This view is still generating — save it once the dashboard appears.');
    this.name = 'ViewNotReadyError';
    this.code = 'view_not_ready';
  }
}

/**
 * Promote a generated view into the sidebar, or save over one already there.
 *
 * The first Save is a POST and the row it returns has a *different id* — the
 * server's UUID. That id replaces the local one everywhere: the local row is
 * dropped, the server row is adopted, and the caller gets the new row back so
 * it can move the URL it is sitting on. Anything that kept the old id would be
 * pointing at a view that no longer exists.
 *
 * A second Save is a PATCH carrying `dsl` and `catalog_version` together, for
 * the reason in `setViewSurface`.
 */
export async function saveView(id) {
  const local = readLocal().find((v) => v.id === id);
  if (!local) {
    const row = saved.find((v) => v.id === id);
    if (!row) return null;
    if (!row.catalogVersion) throw new ViewNotReadyError();
    return patchSaved(id, { dsl: row.dsl ?? '', catalog_version: row.catalogVersion });
  }

  if (!local.catalogVersion) throw new ViewNotReadyError();
  const row = fromRow(unwrap(await postJson('/weave/views', {
    title: local.title,
    dsl: local.dsl ?? '',
    catalog_version: local.catalogVersion,
    data_sources: local.dataSources ?? [],
  })));

  // Carry the visit count across the id change, then swap the rows. Both
  // writes happen before the single announce so no listener ever sees the
  // view twice or not at all.
  const visits = readVisits();
  if (visits[id]) {
    visits[row.id] = (visits[row.id] ?? 0) + visits[id];
    delete visits[id];
    writeVisits(visits);
  }
  addAlias(id, row.id);
  saved = [row, ...saved];
  try { localStorage.setItem(KEY, JSON.stringify(readLocal().filter((v) => v.id !== id))); } catch { /* quota */ }
  announce();
  return row;
}

/**
 * Rename a view.
 *
 * A title-only PATCH is an expected shape (doc §7.4) — the other fields are
 * omitted, not sent empty, because omitting keeps and `[]`/`""` would clear.
 * An empty title is rejected here for the same reason `saveView` refuses an
 * empty catalog version: the server would 400, and the message would be about
 * a field rather than about the box the user just emptied.
 */
export async function renameView(id, title) {
  const next = String(title ?? '').trim();
  if (!next) throw new Error('A view needs a name.');

  // Resolved, not the raw id, the same way `getView`/`touchView` are: a caller
  // that captured a view's pre-Save id (the dock's `#retitle`, firing after a
  // generation, does exactly this) can still be racing a Save that already
  // swapped it for the server's UUID. Without this hop, neither `readLocal()`
  // nor `saved` has a row under the stale id, the rename silently no-ops, and
  // the server keeps the placeholder title forever.
  const key = resolveViewId(id);
  const local = readLocal();
  const view = local.find((v) => v.id === key);
  if (view) {
    view.title = next;
    view.updatedAt = Date.now();
    writeLocal(local);
    return view;
  }
  if (!saved.some((v) => v.id === key)) return null;
  return patchSaved(key, { title: next });
}

/**
 * Delete a view, wherever it lives.
 *
 * A local view is just forgotten. A saved one is deleted server-side first and
 * dropped from the cache only if that succeeded — a card that vanishes and
 * reappears on the next load is worse than one that stays put and says why.
 * Deleting twice answers 404, which is the same outcome, so it is not an error.
 */
export async function deleteView(id) {
  const local = readLocal();
  if (local.some((v) => v.id === id)) {
    writeLocal(local.filter((v) => v.id !== id));
    return;
  }
  if (!saved.some((v) => v.id === id)) return;
  try {
    await deleteJson(`/weave/views/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err?.status !== 404) throw err;
  }
  saved = saved.filter((v) => v.id !== id);
  announce();
}

/**
 * Bump the visit counter that orders /custom-views' "Most visited".
 *
 * Local by design: the server has no such field, and a count of how often *you*
 * opened something is the honest reading of that sort anyway. Kept in its own
 * map rather than on the row, so it survives the id swap at first Save and does
 * not need re-merging every time the list is refreshed.
 */
export function touchView(id) {
  if (!id) return;
  const key = resolveViewId(id);
  const visits = readVisits();
  visits[key] = (visits[key] ?? 0) + 1;
  writeVisits(visits);
  announce();
}

/**
 * Subscribe to any mutation above. Returns the unsubscribe — callers register
 * in `connectedCallback` and call it from `disconnectedCallback`.
 */
export function onViewsChange(fn) {
  document.addEventListener(VIEWS_CHANGED, fn);
  return () => document.removeEventListener(VIEWS_CHANGED, fn);
}
