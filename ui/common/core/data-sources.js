/**
 * Named data sources — the typed replacement for `window.fetch*`.
 *
 * What it replaces, and why that mattered: ~107 data functions were assigned
 * onto `window` by whichever `navigation.js` / `services/*.js` the server
 * happened to serve, and components reached them by *string name* —
 * `data-fn="fetchUsers"` resolved as `window[name]`. Nothing imported anything;
 * the dependency was positional in the page's `<script>` order. Three concrete
 * costs, all observed in the tree:
 *
 *   1. **Silent failure.** An unresolved name made `refresh()` return early with
 *      no error, producing a permanent skeleton and nothing in the console. This
 *      was the single most common failure mode in the UI and it was invisible.
 *   2. **Undetectable name drift.** `window.deleteSession` was read by
 *      `sessions-page` and defined *only* in a preview fixture, so deleting a
 *      session removed the row and sent nothing to the server — and previewed
 *      as working.
 *   3. **Collisions decided by load order.** `fetchDepartmentList` and
 *      `fetchTeamList` were each defined three times across the EE service
 *      modules with different normalisation; whichever `<script>` loaded last won.
 *
 * The registry fixes 1 and 3 outright (duplicate registration is an error;
 * missing resolution throws with a suggestion), and makes 2 detectable by a
 * static check because registration is a real call site, not a property write.
 *
 * Migration is incremental and non-breaking: `resolve()` falls back to
 * `window[name]` with a one-time warning, so a page whose functions have not
 * been ported yet keeps working exactly as before.
 */

/** @typedef {(query: string, page: number, limit: number, opts?: { signal?: AbortSignal }) => Promise<{data: any[], total: number}>} ListFn */

/** @type {Map<string, Function>} */
const sources = new Map();
/** @type {Set<string>} */
const warnedLegacy = new Set();
/** @type {Set<string>} */
const missing = new Set();

/**
 * Register a data source under a stable name.
 *
 * Re-registering the same name throws, because the old `window` assignment
 * silently overwrote and the failure surfaced later as "wrong data on one page".
 * Pass `{ replace: true }` when overriding on purpose (tests, a page-scoped
 * filter variant — this replaces the per-page `window.fetch*` monkey-patching
 * that used to do the same job).
 *
 * @param {string} name
 * @param {Function} fn
 * @param {{ replace?: boolean }} [opts]
 */
export function register(name, fn, { replace = false } = {}) {
  if (typeof name !== 'string' || !name) throw new TypeError('register() needs a name');
  if (typeof fn !== 'function') throw new TypeError(`register("${name}") needs a function`);
  if (sources.has(name) && !replace) {
    throw new Error(
      `Data source "${name}" is already registered. Two definitions of the same name used to be ` +
        `resolved by <script> load order, which is how fetchDepartmentList/fetchTeamList ended up ` +
        `with three different implementations each. Pass { replace: true } if the override is deliberate.`,
    );
  }
  sources.set(name, fn);
  return fn;
}

/**
 * Register many at once — the shape a service module exports.
 * @param {Record<string, Function>} map
 * @param {{ replace?: boolean }} [opts]
 */
export function registerAll(map, opts) {
  for (const [name, fn] of Object.entries(map)) {
    if (typeof fn === 'function') register(name, fn, opts);
  }
}

/** Temporarily override a source; returns a restore function. For tests. */
export function override(name, fn) {
  const had = sources.has(name);
  const prev = sources.get(name);
  sources.set(name, fn);
  return () => {
    if (had) sources.set(name, prev);
    else sources.delete(name);
  };
}

/**
 * Resolve a data source by name.
 *
 * Resolution order: the registry, then `window[name]` (legacy, warns once).
 * Throws when neither has it — a loud failure beats a permanent skeleton.
 *
 * @param {string} name
 * @returns {Function}
 */
export function resolve(name) {
  const fn = resolveOptional(name);
  if (fn) return fn;
  missing.add(name);
  throw new Error(
    `No data source named "${name}". ${suggest(name)}\n` +
      `Register it with registerAll({ ${name}: … }) in the page's service module, ` +
      `or check the name for a typo — this used to fail silently and render an empty view forever.`,
  );
}

/**
 * Resolve without throwing. Only for genuinely optional sources — e.g. the ⌘F
 * palette, which renders whichever sections happen to exist.
 *
 * @param {string} name
 * @returns {Function|undefined}
 */
export function resolveOptional(name) {
  if (sources.has(name)) return sources.get(name);
  const legacy = /** @type {any} */ (globalThis)[name];
  if (typeof legacy === 'function') {
    if (!warnedLegacy.has(name)) {
      warnedLegacy.add(name);
      console.warn(
        `[data-sources] "${name}" resolved from window — legacy path. ` +
          `Move it into a service module and call registerAll({ ${name} }).`,
      );
    }
    return legacy;
  }
  return undefined;
}

/** True when a name can be resolved (registry or legacy window). */
export function has(name) {
  return Boolean(resolveOptional(name));
}

/**
 * Call a source, resolving it lazily at call time.
 *
 * Lazy resolution is deliberate and load-bearing: it is what let a late-loading
 * service module recover, and what makes a page-scoped `override()` take effect
 * without re-rendering. Keep it.
 *
 * @param {string} name
 * @param {...unknown} args
 */
export function call(name, ...args) {
  return resolve(name)(...args);
}

/** Same, but returns `undefined` instead of throwing when absent. */
export function callOptional(name, ...args) {
  const fn = resolveOptional(name);
  return fn ? fn(...args) : undefined;
}

/** Registered names — used by the dev overlay and by tests. */
export function registered() {
  return [...sources.keys()].sort();
}

/**
 * Names that some component asked for and we could not resolve. The dev-time
 * check in `scripts/ui-lint.mjs` reads this after driving a page, turning the
 * old invisible failure into a build error.
 */
export function unresolved() {
  return [...missing].sort();
}

/** Test teardown. */
export function reset() {
  sources.clear();
  warnedLegacy.clear();
  missing.clear();
}

/** Cheap "did you mean" so a typo is a five-second fix, not a debugging session. */
function suggest(name) {
  const lower = name.toLowerCase();
  const near = registered().filter((n) => {
    const l = n.toLowerCase();
    return l.includes(lower) || lower.includes(l) || levenshteinLite(l, lower) <= 2;
  });
  if (!near.length) return `Nothing similar is registered (${sources.size} sources total).`;
  return `Did you mean: ${near.slice(0, 5).join(', ')}?`;
}

/** Bounded edit distance — good enough for typo hints, cheap enough to be free. */
function levenshteinLite(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** The injectable surface bound to `keys.dataSources`. */
export const dataSources = Object.freeze({
  register,
  registerAll,
  override,
  resolve,
  resolveOptional,
  has,
  call,
  callOptional,
  registered,
  unresolved,
  reset,
});

// ── Test bridge ─────────────────────────────────────────────────────────────
// Preview fixtures run inside `page.evaluate()`, which executes in the
// browser's global scope — not as an ES module. They need to override
// registered data sources to inject mock data, but `registerAll` is a module
// export and invisible from `page.evaluate`. This bridge exposes the registry
// API on `window.__dataSources` so fixture code can write:
//
//   await page.evaluate(() => {
//     __dataSources.registerAll({ fetchAgents: async () => ({ data: [], total: 0 }) }, { replace: true });
//   });
//
// The bridge is always present (it costs nothing) and serves the same role as
// the `window.__STORE_DEV__` pattern used by state management libraries.
if (typeof globalThis !== 'undefined') {
  globalThis.__dataSources = dataSources;
}
