/**
 * Reactive `$variable` store — flat, global (not per-row; per-row loop
 * variables from `@Each` are plain lexical refs, never `$`-prefixed, see
 * builtins.js/materialize.js), ported directly from OpenUI Lang's real
 * `store.ts` (session research). One store instance per live surface
 * session, created and held by the production integration point (poc.html
 * today), passed into every `materialize()` call so `$variable` values
 * survive across re-renders within the same session.
 */

export function createStore() {
  const state = new Map();
  const listeners = new Set();

  function get(name) {
    return state.has(name) ? state.get(name) : null;
  }

  function set(name, value) {
    const existing = state.get(name);
    if (Object.is(existing, value)) return;
    if (
      value && existing && typeof value === 'object' && typeof existing === 'object' &&
      !Array.isArray(value) && !Array.isArray(existing)
    ) {
      const a = Object.keys(value);
      const b = Object.keys(existing);
      if (a.length === b.length && a.every((k) => Object.is(value[k], existing[k]))) return;
    }
    state.set(name, value);
    for (const l of listeners) l();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Only fills in keys not already present — never overwrites a value the
   * user (or `@Set`) already changed. Matches OpenUI's real semantics. */
  function initialize(defaults) {
    for (const k of Object.keys(defaults)) {
      if (!state.has(k)) state.set(k, defaults[k]);
    }
  }

  function has(name) {
    return state.has(name);
  }

  return { get, set, subscribe, initialize, has };
}
