/**
 * Generated views — the store behind the Weave dock and the Custom Views page.
 *
 * A "view" is a screen the user asked Weave for in conversation. It exists the
 * moment it is generated (so `/view?id=…` has something to render) and becomes
 * *saved* only when the user presses Save view on it — that is what puts it in
 * the sidebar and on `/custom-views`.
 *
 * ponytail: localStorage, not a server table, and the generation itself is
 * canned. This module is the seam that swaps when Weave generates for real —
 * the six functions below are the whole contract the UI depends on.
 */

/** Versioned so a shape change can't be read back as the old one. */
const KEY = 'weave-views-v1';

/** Fired on `document` after any mutation. The dock, the pages and the rail listen. */
export const VIEWS_CHANGED = 'weave-views-change';

function read() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // corrupt or unavailable storage must not blank the app
  }
}

function write(views) {
  try { localStorage.setItem(KEY, JSON.stringify(views)); } catch { /* quota / private mode */ }
  document.dispatchEvent(new CustomEvent(VIEWS_CHANGED));
}

/**
 * Words a request is phrased with rather than about. Stripping them is what
 * turns "Create a view for monitoring costs of the top 5 agents" into a title
 * short enough for a tab and a card.
 *
 * ponytail: a canned heuristic standing in for the model's own title. Replace
 * this with whatever the generator returns, not with a longer word list.
 */
const FILLER = new Set([
  'a', 'an', 'the', 'me', 'my', 'our', 'of', 'for', 'to', 'in', 'on', 'with',
  'and', 'or', 'that', 'this', 'only', 'all', 'some', 'please', 'can', 'you',
  'create', 'build', 'make', 'show', 'give', 'add', 'generate', 'get', 'want',
  'view', 'views', 'dashboard', 'screen', 'page', 'report', 'chart',
]);

/**
 * A connective left dangling at the cut, e.g. "agent latency by" from "…latency
 * by provider". Trimmed rather than added to FILLER: these words carry meaning
 * inside a phrase and only read as debris at the end of one.
 */
const DANGLING = /\s+(by|per|from|over|across|within|into|at|as|about|between|than)$/;

function titleFrom(prompt) {
  const words = String(prompt || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
  if (!words.length) return 'New view';
  const picked = words.slice(0, 3).join(' ').replace(DANGLING, '');
  return picked.charAt(0).toUpperCase() + picked.slice(1);
}

/**
 * A local, opaque id. `crypto.randomUUID` is secure-context-only, so the `??`
 * arm is what keeps this working over plain http (the preview harness, an IP
 * address in dev) — the same fallback chat-page and orchestrator-page use.
 */
const newId = () => crypto.randomUUID?.()
  ?? Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Every view, newest first — generated and saved alike. */
export function listViews() {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

/** The saved ones, which are the only ones the sidebar and /custom-views show. */
export function listSavedViews({ sort = 'visits' } = {}) {
  const saved = read().filter((v) => v.saved);
  return saved.sort(sort === 'recent'
    ? (a, b) => b.updatedAt - a.updatedAt
    : (a, b) => (b.visits ?? 0) - (a.visits ?? 0) || b.updatedAt - a.updatedAt);
}

export const hasSavedViews = () => read().some((v) => v.saved);

export const getView = (id) => read().find((v) => v.id === id) || null;

/** A fresh generated view. Unsaved: it is reachable by URL and nowhere else. */
export function createView(prompt) {
  const now = Date.now();
  const view = {
    id: newId(),
    title: titleFrom(prompt),
    prompt: String(prompt || ''),
    createdAt: now,
    updatedAt: now,
    saved: false,
    visits: 0,
  };
  write([...read(), view]);
  return view;
}

/** Promote a generated view into the sidebar. Idempotent. */
export function saveView(id) {
  const views = read();
  const view = views.find((v) => v.id === id);
  if (!view || view.saved) return view || null;
  view.saved = true;
  view.updatedAt = Date.now();
  write(views);
  return view;
}

export function deleteView(id) {
  write(read().filter((v) => v.id !== id));
}

/** Bump the visit counter that orders /custom-views' "Most visited". */
export function touchView(id) {
  const views = read();
  const view = views.find((v) => v.id === id);
  if (!view) return;
  view.visits = (view.visits ?? 0) + 1;
  write(views);
}

/**
 * Subscribe to any mutation above. Returns the unsubscribe — callers register
 * in `connectedCallback` and call it from `disconnectedCallback`.
 */
export function onViewsChange(fn) {
  document.addEventListener(VIEWS_CHANGED, fn);
  return () => document.removeEventListener(VIEWS_CHANGED, fn);
}
