/**
 * Minimal reactive primitives — signals, computeds, effects.
 *
 * Why hand-written rather than a dependency: the memo's suggested fix for
 * "screens don't share memory" is "a small signals/store library (e.g. Preact
 * Signals, nanostores) added incrementally, only where two screens actually
 * need to talk." The requirement is genuinely small — subscribe, notify, derive,
 * batch — and this file is ~120 lines with no build step, no bare-specifier
 * imports, and no version to keep in sync with the vendored Lit bundle. If the
 * needs outgrow it (async transitions, resources with suspense), swap in
 * nanostores behind the same three exports; nothing outside this file knows.
 *
 * Semantics, chosen deliberately:
 *   - Reads inside a `computed`/`effect` are tracked automatically.
 *   - Notification is synchronous but de-duplicated within a `batch`.
 *   - `Object.is` equality gates notification, so setting the same value twice
 *     does not re-render.
 *   - Effects return a disposer. Every caller in a component MUST keep it and
 *     call it in `disconnectedCallback`. `NasikoElement.watch()` does this for
 *     you and is the preferred entry point.
 */

/** @type {{ deps: Set<Signal>, run: () => void }|null} */
let activeObserver = null;
let batchDepth = 0;
/** @type {Set<{ run: () => void }>} */
const pendingObservers = new Set();

class Signal {
  #value;
  #observers = new Set();
  #name;

  constructor(value, name) {
    this.#value = value;
    this.#name = name || 'signal';
  }

  /** Read, registering a dependency if we're inside a computed/effect. */
  get() {
    if (activeObserver) {
      this.#observers.add(activeObserver);
      activeObserver.deps.add(this);
    }
    return this.#value;
  }

  /** Write. No-ops when the value is `Object.is`-equal to the current one. */
  set(next) {
    const value = typeof next === 'function' ? next(this.#value) : next;
    if (Object.is(value, this.#value)) return value;
    this.#value = value;
    this.#notify();
    return value;
  }

  /** Shallow-merge for object-valued signals — the common store update. */
  update(patch) {
    return this.set((current) =>
      current && typeof current === 'object' && !Array.isArray(current)
        ? { ...current, ...patch }
        : patch,
    );
  }

  /** Read without subscribing. Use inside an effect that must not re-run on this. */
  peek() {
    return this.#value;
  }

  /**
   * Subscribe explicitly. Returns a disposer.
   * @param {(value: unknown) => void} fn
   * @param {{ immediate?: boolean }} [opts]
   */
  subscribe(fn, { immediate = false } = {}) {
    const observer = { deps: new Set(), run: () => fn(this.#value) };
    this.#observers.add(observer);
    observer.deps.add(this);
    if (immediate) fn(this.#value);
    return () => {
      this.#observers.delete(observer);
    };
  }

  #notify() {
    const observers = [...this.#observers];
    if (batchDepth > 0) {
      for (const o of observers) pendingObservers.add(o);
      return;
    }
    for (const o of observers) o.run();
  }

  /** Detach one observer. Called by an effect's disposer. */
  removeObserver(observer) {
    this.#observers.delete(observer);
  }

  /** Detach every observer. Used by `resource()` teardown and tests. */
  clearObservers() {
    this.#observers.clear();
  }

  /** Observer count — for leak assertions in tests. */
  get observerCount() {
    return this.#observers.size;
  }

  get name() {
    return this.#name;
  }

  toString() {
    return `Signal(${this.#name})`;
  }
}

/**
 * Create a writable signal.
 * @template T
 * @param {T} initial
 * @param {string} [name] For debugging — shows in `toString()`.
 * @returns {Signal}
 */
export function signal(initial, name) {
  return new Signal(initial, name);
}

/**
 * Derived, lazily-recomputed value. Recomputes when any signal it read changes.
 *
 * @template T
 * @param {() => T} fn
 * @param {string} [name]
 */
export function computed(fn, name) {
  const out = new Signal(undefined, name || 'computed');
  let disposed = false;
  const observer = {
    deps: new Set(),
    run: () => {
      if (disposed) return;
      const previous = activeObserver;
      activeObserver = observer;
      try {
        out.set(fn());
      } finally {
        activeObserver = previous;
      }
    },
  };
  // Compute eagerly once so `.get()` is always valid, then stay reactive.
  observer.run();

  return {
    get: () => out.get(),
    peek: () => out.peek(),
    subscribe: (f, o) => out.subscribe(f, o),
    /**
     * Detach from every source signal.
     *
     * A module-level computed (`isSuperuser` in the store) lives for the page's
     * lifetime and never needs this. A computed created *inside a component*
     * does: without disposal it stays attached to its sources, and because its
     * closure captures the component, a module-level signal keeps that component
     * alive after it has been removed from the DOM. `NasikoElement#compute()`
     * calls this for you — prefer it over bare `computed()` in a component.
     */
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const dep of observer.deps) dep.removeObserver(observer);
      observer.deps.clear();
      out.clearObservers();
    },
    get observerCount() {
      return out.observerCount;
    },
    toString: () => `Computed(${name || 'computed'})`,
  };
}

/**
 * Run `fn` now, and again whenever any signal it read changes.
 * @param {() => void|(() => void)} fn May return its own cleanup function.
 * @returns {() => void} Disposer — ALWAYS call this in `disconnectedCallback`.
 */
export function effect(fn) {
  let cleanup;
  let disposed = false;
  const observer = {
    deps: new Set(),
    run: () => {
      if (disposed) return;
      if (typeof cleanup === 'function') cleanup();
      const previous = activeObserver;
      activeObserver = observer;
      try {
        cleanup = fn();
      } finally {
        activeObserver = previous;
      }
    },
  };
  observer.run();
  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof cleanup === 'function') cleanup();
    // Detach from every signal we read, or the observer (and the closure it
    // holds, which for a component effect is the component itself) stays
    // reachable from module-level signals for the life of the page.
    for (const dep of observer.deps) dep.removeObserver(observer);
    observer.deps.clear();
    pendingObservers.delete(observer);
  };
}

/**
 * Coalesce writes so observers run once at the end.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function batch(fn) {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      const queued = [...pendingObservers];
      pendingObservers.clear();
      for (const o of queued) o.run();
    }
  }
}

export { Signal };
