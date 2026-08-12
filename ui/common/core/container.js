/**
 * Dependency injection for the control-plane UI.
 *
 * The problem this solves (memo: "No dependency injection — components reach
 * out and grab what they need"): 25+ components `import { fetchApi } from
 * '/common/services/api.js'` by path. That is fine at today's size and becomes
 * a real cost the moment something must behave differently per tenant or per
 * environment, or the moment anyone wants to unit-test a component's logic
 * without standing up a whole page. Today the only way to substitute a
 * dependency is a global override inside the preview tool — good for
 * screenshots, not a substitute for testing actual logic.
 *
 * Design constraints that shaped this:
 *   - It must work for the 69 existing non-Lit components without rewriting
 *     them, so it cannot be Lit-only.
 *   - It must not become a service locator that hides dependencies. Components
 *     declare what they need (`static inject`), and `NasikoElement` resolves
 *     that list once on connect — so a component's dependencies are readable at
 *     the top of the file, not scattered through its methods.
 *   - Per-subtree override (one tenant's API base inside one panel) must be
 *     possible later, which is why the keys double as `@lit/context` contexts.
 *
 * Import a *key* (not an implementation) and resolve it. Never import a service
 * module directly from a component again.
 */

/** @typedef {{ id: symbol, description: string }} InjectionKey */

const registry = new Map();
const factories = new Map();

/**
 * Declare an injectable slot. The returned key is what components import.
 * Also usable directly as an `@lit/context` context object — the `id` symbol
 * is the context identity, so `ContextProvider`/`ContextConsumer` interop for
 * free without a second parallel set of keys to keep in sync.
 *
 * @param {string} description Stable, human-readable — appears in error text.
 * @returns {InjectionKey}
 */
export function createKey(description) {
  return Object.freeze({ id: Symbol(description), description });
}

/** The application's injectable surface. Add here, never invent keys ad hoc. */
export const keys = Object.freeze({
  /** `services/api.js` — the HTTP funnel. */
  api: createKey('api'),
  /** `core/data-sources.js` — named list/detail fetchers (replaces `window.fetch*`). */
  dataSources: createKey('dataSources'),
  /** `state/store.js` — the app store (signals). */
  store: createKey('store'),
  /** `services/sse.js` — server-sent-event factory. */
  sse: createKey('sse'),
  /** `core/events.js` — the typed cross-domain event bus. */
  events: createKey('events'),
  /** Injectable clock, so time-dependent logic is testable. */
  clock: createKey('clock'),
  /** `{ apiBase, edition, features }` — resolved runtime config. */
  config: createKey('config'),
  /** Toast/notification sink, so tests can assert on user-facing messages. */
  notifier: createKey('notifier'),
});

/**
 * Bind a key to a concrete value.
 * @template T
 * @param {InjectionKey} key
 * @param {T} value
 */
export function register(key, value) {
  assertKey(key);
  registry.set(key.id, value);
  return value;
}

/**
 * Bind a key to a lazily-constructed singleton. The factory runs at most once,
 * on first `inject`. Use this when construction has a cost (opening a
 * BroadcastChannel, reading config) that a page which never touches the
 * dependency shouldn't pay.
 *
 * @param {InjectionKey} key
 * @param {() => unknown} factory
 */
export function registerFactory(key, factory) {
  assertKey(key);
  if (typeof factory !== 'function') {
    throw new TypeError(`registerFactory(${key.description}) requires a function`);
  }
  factories.set(key.id, factory);
  return factory;
}

/**
 * Resolve a dependency. Throws a pointed error if nothing is bound — a loud
 * failure at construction time is strictly better than the silent `undefined`
 * that the `window.*` lookup pattern produced (a permanently empty table with
 * nothing in the console).
 *
 * @template T
 * @param {InjectionKey} key
 * @returns {T}
 */
export function inject(key) {
  assertKey(key);
  if (registry.has(key.id)) return registry.get(key.id);
  if (factories.has(key.id)) {
    const value = factories.get(key.id)();
    registry.set(key.id, value);
    factories.delete(key.id);
    return value;
  }
  throw new Error(
    `No provider registered for "${key.description}". ` +
      `Import '/common/core/bootstrap.js' once per page (app-header.js already does), ` +
      `or register(keys.${key.description}, …) in a test setup.`,
  );
}

/**
 * Resolve without throwing. For genuinely optional collaborators only — if a
 * component cannot function without something, use `inject` and fail loudly.
 *
 * @template T
 * @param {InjectionKey} key
 * @param {T} [fallback]
 * @returns {T|undefined}
 */
export function injectOptional(key, fallback = undefined) {
  try {
    return inject(key);
  } catch {
    return fallback;
  }
}

/** True if something is bound (or bindable) for this key. */
export function isRegistered(key) {
  assertKey(key);
  return registry.has(key.id) || factories.has(key.id);
}

/**
 * Swap dependencies for the duration of `fn`, then restore — the primitive the
 * whole testing story rests on.
 *
 * ```js
 * await withOverrides([[keys.api, fakeApi]], async () => {
 *   const el = document.createElement('agents-page');
 *   document.body.append(el);
 *   await el.updateComplete;
 *   assert.equal(el.querySelectorAll('tr').length, 3);
 * });
 * ```
 *
 * @param {Array<[InjectionKey, unknown]>} overrides
 * @param {() => T|Promise<T>} fn
 * @template T
 * @returns {Promise<T>}
 */
export async function withOverrides(overrides, fn) {
  const saved = [];
  for (const [key, value] of overrides) {
    assertKey(key);
    saved.push([key.id, registry.has(key.id), registry.get(key.id), factories.get(key.id)]);
    factories.delete(key.id);
    registry.set(key.id, value);
  }
  try {
    return await fn();
  } finally {
    for (const [id, had, prev, prevFactory] of saved) {
      if (had) registry.set(id, prev);
      else registry.delete(id);
      if (prevFactory) factories.set(id, prevFactory);
    }
  }
}

/** Drop every binding. Test teardown only. */
export function resetContainer() {
  registry.clear();
  factories.clear();
}

/**
 * Resolve a `static inject` declaration into a plain object.
 * `NasikoElement` calls this for you; legacy components can call it directly:
 *
 * ```js
 * const { api, store } = resolveAll({ api: keys.api, store: keys.store });
 * ```
 *
 * @param {Record<string, InjectionKey>} spec
 */
export function resolveAll(spec) {
  const out = {};
  for (const [name, key] of Object.entries(spec || {})) out[name] = inject(key);
  return out;
}

function assertKey(key) {
  if (!key || typeof key !== 'object' || typeof key.id !== 'symbol') {
    throw new TypeError('Expected an injection key from createKey() / keys.*');
  }
}
