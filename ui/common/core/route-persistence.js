/**
 * Route state persistence — survives hard reloads and deep links.
 *
 * Ported from Flutter's `route_state_persistence.dart`. Persists per-route
 * context (title, scroll position, component state) in sessionStorage so
 * that hard reloads, deep links, and browser back/forward can restore
 * nested screens without the in-memory navigation payload.
 *
 * Storage layout:
 *   One JSON map keyed by route path, stored under `nasiko_route_context_v2`.
 *   Entries are kept in LRU order (most recently persisted last) and capped
 *   at {@link MAX_ENTRIES} so long sessions don't grow the payload
 *   unboundedly.
 *
 * Scroll restoration:
 *   Each entry optionally stores `scrollTop` for the content area. On
 *   restore, the scroll position is applied after a rAF so the content
 *   has been laid out.
 *
 * @module route-persistence
 */

const STORAGE_KEY = 'nasiko_route_context_v2';

/**
 * Upper bound on remembered routes. 40 comfortably covers a working
 * session while keeping the sessionStorage payload small.
 */
const MAX_ENTRIES = 40;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Persist route context for the given path.
 *
 * @param {object} opts
 * @param {string} opts.path       Route path (e.g. '/agents/my-agent')
 * @param {string} opts.title      Page title / breadcrumb label
 * @param {object} [opts.data]     Arbitrary JSON-serialisable state
 * @param {number} [opts.scrollTop] Scroll position of the content area
 */
export function persistRoute({ path, title, data, scrollTop }) {
  if (!path) return;

  const entries = _readEntries();

  // Re-insert to move path to MRU end
  delete entries[path];
  entries[path] = {
    title,
    data: data ?? null,
    scrollTop: scrollTop ?? null,
    ts: Date.now(),
  };

  // Evict oldest entries beyond cap
  const keys = Object.keys(entries);
  while (keys.length > MAX_ENTRIES) {
    const oldest = keys.shift();
    delete entries[oldest];
  }

  _writeEntries(entries);
}

/**
 * Get persisted data for a route path.
 *
 * @param {string} path
 * @returns {{ title?: string, data?: object, scrollTop?: number } | null}
 */
export function getPersistedRoute(path) {
  const entry = _readEntries()[path];
  if (!entry || typeof entry !== 'object') return null;

  return {
    title: entry.title || null,
    data: entry.data || null,
    scrollTop: entry.scrollTop ?? null,
  };
}

/**
 * Get just the persisted title for a path.
 * @param {string} path
 * @returns {string|null}
 */
export function getPersistedTitle(path) {
  const entry = _readEntries()[path];
  if (!entry || typeof entry !== 'object') return null;
  return typeof entry.title === 'string' ? entry.title : null;
}

/**
 * Remove a specific path from persistence.
 * @param {string} path
 */
export function removePersistedRoute(path) {
  const entries = _readEntries();
  if (path in entries) {
    delete entries[path];
    _writeEntries(entries);
  }
}

/**
 * Clear all persisted routes.
 */
export function clearPersistedRoutes() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

// ── Scroll position helpers ────────────────────────────────────────────

/**
 * Save the scroll position of the content area for the current route.
 * Call this before a navigation away.
 *
 * @param {string} path    Current route path
 * @param {HTMLElement} [scrollContainer]  The scrollable element (defaults to #outlet or .scaffold-body)
 */
export function saveScrollPosition(path, scrollContainer) {
  if (!path) return;

  const el = scrollContainer
    || document.querySelector('.scaffold-body')
    || document.getElementById('outlet');
  if (!el) return;

  const entries = _readEntries();
  const entry = entries[path];
  if (entry && typeof entry === 'object') {
    entry.scrollTop = el.scrollTop;
    _writeEntries(entries);
  }
}

/**
 * Restore the scroll position for a route after content has rendered.
 * Waits one animation frame so layout is complete.
 *
 * @param {string} path
 * @param {HTMLElement} [scrollContainer]
 */
export function restoreScrollPosition(path, scrollContainer) {
  const persisted = getPersistedRoute(path);
  if (!persisted || persisted.scrollTop == null) return;

  const el = scrollContainer
    || document.querySelector('.scaffold-body')
    || document.getElementById('outlet');
  if (!el) return;

  requestAnimationFrame(() => {
    el.scrollTop = persisted.scrollTop;
  });
}

// ── History integration ────────────────────────────────────────────────

/**
 * Integrate with the SPA router. Call once after the router is initialised.
 * Automatically saves scroll positions on navigation and restores them
 * on popstate (back/forward).
 *
 * @param {object} [opts]
 * @param {HTMLElement} [opts.scrollContainer]
 */
export function initRouteIntegration(opts = {}) {
  const container = opts.scrollContainer;

  // Save scroll position before navigating away
  window.addEventListener('route-change', (evt) => {
    const e = /** @type {CustomEvent} */ (evt);
    const prev = e.detail?.previousPath;
    if (prev) saveScrollPosition(prev, container);
  });

  // On loading-end (new page rendered), restore scroll
  window.addEventListener('loading-end', () => {
    const path = location.pathname;
    restoreScrollPosition(path, container);
  });

  // Persist current route context on route-change
  window.addEventListener('route-change', (evt) => {
    const e = /** @type {CustomEvent} */ (evt);
    const path = location.pathname;
    const title = document.title || '';
    persistRoute({
      path,
      title,
      data: e.detail?.state || null,
    });
  });

  // On page unload, save final scroll position
  window.addEventListener('beforeunload', () => {
    saveScrollPosition(location.pathname, container);
  });

  // Persist the initial route
  persistRoute({
    path: location.pathname,
    title: document.title || '',
  });
}

// ── Deep link helpers ──────────────────────────────────────────────────

/**
 * Check if the current URL is a deep link (has persisted state from a
 * previous session or was bookmarked). Returns the persisted data if
 * available, null otherwise.
 *
 * @returns {{ title?: string, data?: object } | null}
 */
export function checkDeepLink() {
  return getPersistedRoute(location.pathname);
}

/**
 * Build a shareable deep link URL for the given path, optionally persisting
 * context data so it can be restored when someone opens the link in the
 * same browser session.
 *
 * @param {string} path
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {object} [opts.data]
 * @returns {string} The full URL
 */
export function createDeepLink(path, { title, data } = {}) {
  if (title || data) {
    persistRoute({ path, title: title || '', data });
  }
  return `${location.origin}${path}`;
}

// ── Internal ───────────────────────────────────────────────────────────

function _readEntries() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed
      : {};
  } catch (e) {
    // Corrupt storage — reset
    console.warn('[route-persistence] corrupt sessionStorage, resetting:', e);
    return {};
  }
}

function _writeEntries(entries) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Serialization must never break navigation (e.g. quota exceeded).
  }
}
