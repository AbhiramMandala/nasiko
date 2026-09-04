/**
 * `$state` — the only thing a surface remembers between interactions.
 *
 * A flat, global, per-session map of `$name` → scalar. Three properties of it
 * are load-bearing and none of them are accidents:
 *
 *   **Flat, not per-row.** `agent.yaml` says state values are scalars, never
 *   arrays or objects. A per-row store would be the natural way to write
 *   "expand this row", but the grammar cannot express it — there is no way for
 *   a model to name a row's identity in `@Set`. Keeping the store flat means
 *   the model can only build what it was taught to build, and a surface that
 *   looks like it has per-row state is a bug we can see rather than one that
 *   half-works.
 *
 *   **Declared defaults live in the DSL, not here.** `$days = 7` is an ordinary
 *   statement; `initialize()` copies those values in so `@Reset` has something
 *   to reset *to*. The store never invents a default of its own, because then
 *   two sources of truth would disagree the moment a revision turn changed one.
 *
 *   **A write that changes nothing notifies nobody.** Every notify costs a full
 *   re-walk and repaint of the tree (materialize.js has no partial update
 *   path). `@Set($view, "cost")` fired twice from the same button must be free
 *   the second time, or a double-click repaints for no reason.
 *
 * @module common/surface/store
 */

/** Same-value test. Scalars only, so `Object.is` is the whole story — except
 *  that `Object.is(NaN, NaN)` is `true`, which is what we want here. */
function same(a, b) {
  return Object.is(a, b);
}

/**
 * @returns {{
 *   get(name: string): unknown,
 *   has(name: string): boolean,
 *   set(name: string, value: unknown): boolean,
 *   reset(names: string[]): boolean,
 *   initialize(defaults: Map<string, unknown>|Record<string, unknown>): void,
 *   subscribe(fn: (change: {names: string[]}) => void): () => void,
 *   snapshot(): Record<string, unknown>,
 *   defaults(): Record<string, unknown>,
 *   clear(): void,
 * }}
 */
export function createStore() {
  /** @type {Map<string, unknown>} */
  const values = new Map();
  /** @type {Map<string, unknown>} */
  const declared = new Map();
  /** @type {Set<(change: {names: string[]}) => void>} */
  const listeners = new Set();

  function notify(names) {
    if (!names.length) return;
    for (const fn of [...listeners]) {
      try { fn({ names }); } catch { /* a bad listener must not stop the others */ }
    }
  }

  return {
    get(name) {
      if (values.has(name)) return values.get(name);
      return declared.has(name) ? declared.get(name) : undefined;
    },

    /**
     * Whether this store speaks for `name` at all — a value the user set, or
     * one a statement declared. gc.js asks before rewriting a `$state` line
     * for the model: a name the store knows nothing about must keep whatever
     * the DSL text already said rather than being flattened to null.
     */
    has(name) {
      return values.has(name) || declared.has(name);
    },


    set(name, value) {
      if (typeof name !== 'string' || !name) return false;
      const prev = this.get(name);
      if (same(prev, value)) return false;
      values.set(name, value);
      notify([name]);
      return true;
    },

    /**
     * `@Reset($a, $b)` — back to the value the DSL declared, not to null. A
     * variable with no declaring statement resets to undefined, which reads the
     * same as never having been set.
     */
    reset(names) {
      const changed = [];
      for (const name of names) {
        const prev = this.get(name);
        const next = declared.has(name) ? declared.get(name) : undefined;
        if (same(prev, next)) continue;
        if (declared.has(name)) values.set(name, declared.get(name));
        else values.delete(name);
        changed.push(name);
      }
      notify(changed);
      return changed.length > 0;
    },

    /**
     * Take the declared defaults from the current materialization.
     *
     * Called on every pass, because a revision turn can redeclare `$days = 30`
     * and that has to become the new reset target. It does *not* overwrite a
     * value the user has since set — a filter the user moved must survive the
     * generator re-emitting the statement it was declared in, otherwise every
     * revision turn silently snaps every control back.
     */
    initialize(defaults) {
      const entries = defaults instanceof Map ? defaults.entries() : Object.entries(defaults ?? {});
      const changed = [];
      for (const [name, value] of entries) {
        const hadDeclared = declared.has(name);
        const prev = declared.get(name);
        declared.set(name, value);
        // A default becoming known for the first time changes nothing on
        // screen — materialize.js already falls back to the declaring
        // statement when the store has no value, so the rendered result is
        // identical. Notifying there would repaint every first pass forever.
        // A default that *moved* is different: a revision turn redeclaring
        // `$days = 30` must show 30 for anyone who never touched the filter.
        if (hadDeclared && !values.has(name) && !same(prev, value)) changed.push(name);
      }
      notify(changed);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    snapshot() {
      const out = {};
      for (const [k, v] of declared) out[k] = v;
      for (const [k, v] of values) out[k] = v;
      return out;
    },

    defaults() {
      return Object.fromEntries(declared);
    },

    clear() {
      values.clear();
      declared.clear();
    },
  };
}
