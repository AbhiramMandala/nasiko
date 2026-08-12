/**
 * The app store: shared state, cache invalidation, and cross-screen messaging.
 *
 * Problem this addresses (memo, "Screens don't share memory", severity Moderate
 * growing to High): today if a customer changes something in one place — their
 * name, a setting — every other open screen has no way to hear about it. Each
 * screen independently asks the server "what's true right now?" on its own.
 * Invisible with a handful of screens; as screens legitimately need to react to
 * each other, someone has to hand-build that communication one connection at a
 * time, because there is no shared "this changed" signal.
 *
 * Three things live here:
 *   1. `resource()` — a cached async value with explicit invalidation. Replaces
 *      the ad-hoc `sessionStorage` caches in `auth-service.js` / `app-header.js`
 *      / `app-module-nav.js`, which each hand-rolled their own read/write/sweep.
 *   2. Named app state (`currentUser`, `navTree`) built on those resources.
 *   3. `invalidate(key)` — a change signal that crosses *tabs* as well as
 *      screens, via BroadcastChannel. A mutation on one page updates the others.
 *
 * Deliberately NOT here: per-page view state (search text, which row is
 * expanded). That belongs to the component. A global store that accumulates
 * view state becomes the thing everyone is afraid to touch.
 */

import { signal, computed, batch } from './signal.js';
import { isAbort, shouldReport } from '../core/errors.js';

/** Channel name is versioned so a future shape change can't confuse old tabs. */
const CHANNEL = 'nasiko:invalidate:v1';

/** @type {BroadcastChannel|null} */
let channel = null;
/** @type {Map<string, Set<() => void>>} */
const listeners = new Map();

function ensureChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener('message', (e) => {
    const key = e?.data?.key;
    if (typeof key === 'string') notifyLocal(key);
  });
  return channel;
}

function notifyLocal(key) {
  for (const [pattern, fns] of listeners) {
    if (pattern === key || (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1)))) {
      for (const fn of fns) fn();
    }
  }
}

/**
 * Announce that something changed, so every interested resource refetches — in
 * this tab and in the user's other tabs.
 *
 * Call it after a successful mutation, with the same key the resource declared:
 *
 * ```js
 * await api.post('/teams', body);
 * invalidate('teams');
 * ```
 *
 * @param {string} key Dot-separated, coarse to fine: `agents`, `agents.42`.
 * @param {{ localOnly?: boolean }} [opts]
 */
export function invalidate(key, { localOnly = false } = {}) {
  notifyLocal(key);
  if (!localOnly) {
    try {
      ensureChannel()?.postMessage({ key, at: Date.now() });
    } catch {
      /* BroadcastChannel unavailable — local invalidation still happened */
    }
  }
}

/**
 * Subscribe to invalidation. `key` may end in `*` to match a prefix.
 * @param {string} key
 * @param {() => void} fn
 * @returns {() => void} disposer
 */
export function onInvalidate(key, fn) {
  ensureChannel();
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => {
    listeners.get(key)?.delete(fn);
    if (listeners.get(key)?.size === 0) listeners.delete(key);
  };
}

/**
 * Close the cross-tab channel. Browsers do this on page teardown, so this is a
 * test affordance: an open BroadcastChannel is a live handle that keeps a Node
 * process (and therefore a test run) from exiting.
 */
export function closeInvalidationChannel() {
  try {
    channel?.close();
  } catch {
    /* already closed */
  }
  channel = null;
  listeners.clear();
}

/**
 * A cached async value.
 *
 * ```js
 * const teams = resource('teams', () => api.get('/teams'));
 * teams.state.get();      // 'idle' | 'loading' | 'ready' | 'error'
 * await teams.load();     // cached; concurrent callers share one request
 * teams.data.get();       // the value
 * invalidate('teams');    // every tab refetches on next read
 * ```
 *
 * Properties that matter:
 *   - **Single-flight**: N concurrent `load()` calls make one request.
 *   - **Stale-while-revalidate**: after invalidation the old value stays
 *     readable while the new one loads, so lists don't flash empty.
 *   - **Invalidation-aware**: registers itself against `key` automatically.
 *   - **Abortable**: `dispose()` cancels an in-flight fetch.
 *
 * @template T
 * @param {string} key
 * @param {(ctx: { signal: AbortSignal }) => Promise<T>} loader
 * @param {{ ttlMs?: number }} [options] Optional freshness window; omit for cache-until-invalidated.
 */
export function resource(key, loader, { ttlMs = 0 } = {}) {
  const data = signal(undefined, `${key}.data`);
  const state = signal('idle', `${key}.state`);
  const error = signal(null, `${key}.error`);
  const isStale = signal(true, `${key}.stale`);

  let inflight = null;
  let controller = null;
  let loadedAt = 0;

  const unsubscribe = onInvalidate(key, () => {
    isStale.set(true);
    // Do not refetch eagerly: an invalidated resource nobody is looking at
    // should cost nothing. The next `load()` picks it up.
  });

  function fresh() {
    if (isStale.peek()) return false;
    if (!ttlMs) return true;
    return Date.now() - loadedAt < ttlMs;
  }

  async function load({ force = false } = {}) {
    if (!force && fresh() && state.peek() === 'ready') return data.peek();
    if (inflight) return inflight;

    controller = new AbortController();
    // 'loading' only when we have nothing to show; otherwise stay 'ready' and
    // let the old value render (stale-while-revalidate) so the UI doesn't blink.
    if (state.peek() !== 'ready') state.set('loading');
    error.set(null);

    inflight = (async () => {
      try {
        const value = await loader({ signal: controller.signal });
        batch(() => {
          data.set(value);
          state.set('ready');
          isStale.set(false);
          error.set(null);
        });
        loadedAt = Date.now();
        return value;
      } catch (err) {
        if (isAbort(err)) return data.peek();
        batch(() => {
          error.set(err);
          if (shouldReport(err)) state.set('error');
        });
        throw err;
      } finally {
        inflight = null;
        controller = null;
      }
    })();

    return inflight;
  }

  return {
    key,
    data,
    state,
    error,
    isStale,
    load,
    /** Force a refetch now. */
    reload: () => load({ force: true }),
    /** Write a known value without a request (e.g. from a mutation response). */
    set(value) {
      batch(() => {
        data.set(value);
        state.set('ready');
        isStale.set(false);
        error.set(null);
      });
      loadedAt = Date.now();
    },
    /** Cancel in flight work and stop listening. Page teardown / tests. */
    dispose() {
      controller?.abort();
      inflight = null;
      unsubscribe();
    },
  };
}

/**
 * Build the app store. A factory rather than module-level singletons so tests
 * (and a future per-tenant panel) can construct an isolated one.
 *
 * @param {{ api: import('../services/api.js').api }} deps
 */
export function createStore({ api }) {
  /**
   * The signed-in user. Previously cached by hand in
   * `sessionStorage['nasiko-current-user']` by `auth-service.js`, with a
   * separate manual sweep on logout; now one resource with one invalidation key.
   */
  const currentUser = resource('currentUser', ({ signal }) => api.get('/me', { signal }));

  /** Rail + topbar nav tree (role-derived, hence invalidated with the user). */
  const navTree = resource('navTree', async ({ signal }) => {
    // `window.fetchNavigation` is still the definition site for the tree itself
    // during the migration; Phase 3 moves it into a data-source module.
    const fn = /** @type {any} */ (window).fetchNavigation;
    return typeof fn === 'function' ? fn({ signal }) : [];
  });

  /** Per-module nav trees, one resource per module, created on demand. */
  const moduleNavs = new Map();
  function moduleNav(module) {
    if (!moduleNavs.has(module)) {
      moduleNavs.set(
        module,
        resource(`moduleNav.${module}`, async () => {
          const fn = /** @type {any} */ (window).fetchModuleNav;
          return typeof fn === 'function' ? fn(module) : [];
        }),
      );
    }
    return moduleNavs.get(module);
  }

  /** Derived: is the current user a superuser? Read by role-gated UI. */
  const isSuperuser = computed(() => Boolean(currentUser.data.get()?.is_superuser), 'isSuperuser');

  /**
   * Clear every identity-derived cache. Called on logout and on a 401-driven
   * re-auth, replacing `auth-service.js#clearShellCache()`'s manual
   * `sessionStorage` key sweep — which had to know each key by name, and so
   * silently missed any new one.
   */
  function clearIdentity() {
    batch(() => {
      invalidate('currentUser');
      invalidate('navTree');
      invalidate('moduleNav.*');
    });
    // Drop the legacy sessionStorage keys too, for as long as any un-migrated
    // component still reads them.
    for (const k of ['nasiko-current-user', 'app-header-nav']) {
      try {
        sessionStorage.removeItem(k);
      } catch {
        /* storage disabled */
      }
    }
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith('app-module-nav:')) sessionStorage.removeItem(k);
      }
    } catch {
      /* storage disabled */
    }
  }

  return Object.freeze({
    currentUser,
    navTree,
    moduleNav,
    isSuperuser,
    clearIdentity,
    invalidate,
    onInvalidate,
  });
}
