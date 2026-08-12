/**
 * The composition root for the UI.
 *
 * This is the single place where interfaces are bound to implementations —
 * the frontend equivalent of what `oss/server/src/main.rs` does for the Rust
 * side, and the reason a component can declare `static inject = { api: keys.api }`
 * and receive something swappable rather than importing `fetchApi` by path.
 *
 * Import it once per page. In practice you don't have to think about it:
 * `app-header.js` imports it and every page loads `app-header`.
 *
 * Ordering rule: nothing here may import a *component*. Bootstrap sits in the
 * Platform layer, and the dependency direction is
 * Application → Domain → Components → Design System → Platform, never upward.
 * The notifier is therefore bound lazily via a factory, so the toast module is
 * only pulled in if something actually reports an error.
 */

import { keys, register, registerFactory, isRegistered } from './container.js';
import { api } from '../services/api.js';
import { connectSSE } from '../services/sse.js';
import { dataSources } from './data-sources.js';
import { events } from './events.js';
import { createStore } from '../state/store.js';

let booted = false;

/**
 * Bind the real implementations. Idempotent — safe to import from several
 * modules on the same page.
 *
 * @param {{ overrides?: Array<[import('./container.js').InjectionKey, unknown]> }} [opts]
 */
export function bootstrap({ overrides = [] } = {}) {
  if (!booted) {
    booted = true;

    register(keys.api, api);
    register(keys.sse, { connect: connectSSE });
    register(keys.dataSources, dataSources);
    register(keys.events, events);
    register(keys.clock, {
      now: () => Date.now(),
      date: () => new Date(),
    });
    register(keys.config, {
      /** Multi-tenant seam — see services/api.js. Resolved per read, never cached. */
      get apiBase() {
        return window.nasikoConfig?.apiBase || '';
      },
      /** Server-injected chrome hints (multi-tenant shell). */
      get chrome() {
        return window.nasikoChrome || null;
      },
    });

    // The store needs the api, so build it after — and lazily, because a page
    // that never reads shared state shouldn't open a BroadcastChannel.
    registerFactory(keys.store, () => createStore({ api }));

    // Lazy so the Platform layer never statically imports a component.
    registerFactory(keys.notifier, () => createNotifier());
  }

  for (const [key, value] of overrides) register(key, value);
}

/**
 * Bridge to whichever toast implementation the page has.
 *
 * There are currently two — `utils/toast.js#showToast` (20 importers, inline
 * styles) and `components/app-toast.js` (1 importer, proper adopted sheet).
 * Consolidating them is a Design-System task; until then this indirection means
 * components call `this.report(err)` and are not coupled to which one wins.
 */
function createNotifier() {
  const load = () => import('../utils/toast.js').then((m) => m.showToast).catch(() => null);
  const say = async (message) => {
    const showToast = await load();
    if (showToast) showToast(message);
    else console.warn('[notifier]', message);
  };
  return {
    error: (message) => say(message),
    success: (message) => say(message),
    info: (message) => say(message),
  };
}

// Bind on import. Explicit `bootstrap()` remains available for tests that want
// to install overrides before anything resolves.
bootstrap();

export { keys, isRegistered };
