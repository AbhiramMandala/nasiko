/**
 * Queries and mutations — the only part of a surface that touches the network.
 *
 * Every fetch goes through `core/data-sources.js`, by name, never by URL. That
 * is the whole security posture in one sentence: a model-authored surface can
 * ask for `fetchUsageSummary`, and if that name is not registered the call
 * throws instead of reaching anything. It carries the user's own session, so a
 * surface reaches exactly what the user could already reach and nothing more.
 *
 * Four behaviours here are worth reading before changing anything:
 *
 *   **The cache is keyed by (source, args), the results are keyed by
 *   statement.** Worked Example 1 writes two statements over one source —
 *   `totalCostQ` and `requestCountQ` are both `fetchUsageSummary`, differing
 *   only in their dot-path. Keying the cache by statement would fetch the same
 *   summary twice on every dashboard; keying the *results* by source would
 *   give both statements the same number.
 *
 *   **Stale beats blank.** When a query's args change, the previous value stays
 *   on screen until the new one lands. The alternative is every filter click
 *   flashing the declared default — usually a zero — which reads as "the data
 *   went away" rather than "the data is loading".
 *
 *   **`@Run` forces, `$state` does not.** A `$variable` changing never
 *   re-fetches on its own (agent.yaml rule 5). `run()` bypasses the cache
 *   entry for its key so `@Set($days, 30)` then `@Run(historyQ)` genuinely
 *   re-fetches, and so that a refresh button refreshes rather than re-reading
 *   what it already has.
 *
 *   **Mutations never auto-fire.** A `Mutation(...)` statement declares a call;
 *   only `@Run(ref)` fires it. Auto-firing on materialize would mean a delete
 *   ran because a chunk of text arrived.
 *
 * @module common/surface/queries
 */

/** Cache key. Args are positional, so their order is part of identity. */
function keyOf(source, args) {
  return `${source} ${JSON.stringify(args ?? [])}`;
}

/** Walk a dot-path. A missing hop is null, not a throw — the surface still renders. */
export function selectPath(value, path) {
  if (!path) return value;
  let cur = value;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return null;
    cur = cur[part];
  }
  return cur === undefined ? null : cur;
}

/**
 * @param {{
 *   call: (name: string, ...args: unknown[]) => unknown,
 *   onChange?: () => void,
 *   onDiagnostic?: (d: object) => void,
 *   argEnums?: () => (object|null),
 * }} deps
 */
export function createQueryManager({ call, onChange, onDiagnostic, argEnums, allowMutations = true }) {
  /** key → {status, value, error, promise, generation} */
  const cache = new Map();
  /** statementId → the query declaration from the last materialization */
  const declared = new Map();
  /** statementId → mutation declaration */
  const declaredMutations = new Map();
  /** statementId → {status, data, error} */
  const mutationResults = new Map();
  /** statementIds with a mutation in flight — the double-submit guard */
  const firing = new Set();
  /** statementId → resolved, dot-path-selected value. What materialize reads. */
  const results = new Map();
  /** Statement ids whose current key is in error — see `publish`. */
  const failed = new Set();
  /** Initial requests have no data yet; refetches retain the last good data. */
  const loading = new Set();
  /**
   * statementId → the cache key whose value that statement is currently
   * showing. Usually the key its declaration hashes to — but not while a
   * `$state` filter has moved and nothing has `@Run` yet. That gap is the
   * documented stale window, and this map is where it lives.
   */
  const activeKeys = new Map();

  let generation = 0;
  let disposed = false;

  const diag = (code, message, pointer) =>
    onDiagnostic?.({ source: 'queries', code, message, pointer });

  function publish(statementId) {
    const decl = declared.get(statementId);
    const entry = cache.get(activeKeys.get(statementId));
    if (!decl || !entry) return;
    if (entry.status === 'loading' && entry.value === undefined) loading.add(statementId);
    else loading.delete(statementId);
    // Whether this statement's data is currently a failure, tracked apart from
    // the value because the two answers differ: a failed refetch keeps the last
    // good value on screen (below), so `results` alone cannot tell a component
    // it is looking at something stale. Without this a failed fetch and a
    // genuinely empty result are the same thing downstream, and the component
    // says "No data" — asserting nothing exists when it could not be loaded.
    if (entry.status === 'error') failed.add(statementId);
    else if (entry.status === 'ok') failed.delete(statementId);

    if (entry.value === undefined) return; // nothing has landed yet
    // An error keeps whatever was last good on screen rather than blanking it.
    if (entry.status === 'error' && results.has(statementId)) return;
    results.set(statementId, selectPath(entry.value, decl.select));
  }

  /** Re-publish every statement showing this key. Two statements can share one. */
  function publishKey(key) {
    for (const [statementId, active] of activeKeys) {
      if (active === key) publish(statementId);
    }
  }

  /**
   * A literal argument outside the closed set its own source declares.
   *
   * The mirror of the component-side check in render.js: the catalog says
   * `variant` is one of three, and a fourth falls back and reports. The data
   * manifest says `range` is one of three with exactly as much confidence, and
   * until this existed a fourth went out on the wire and came back 400 — a
   * generated control that looks right, renders, and returns nothing.
   *
   * The value about to be sent, whatever produced it. An earlier draft tried
   * to check model-written literals only and spare anything from `$state`, on
   * the grounds that a user's choice is not the generator's mistake — but by
   * the time a Query declaration reaches here the materializer has already
   * evaluated `$state` to a plain value, and the two are indistinguishable. A
   * distinction the layer cannot draw is worse stated than dropped, so this
   * checks what is going out. It is also the more useful reading: an invalid
   * value is a failed panel no matter who chose it.
   *
   * `undefined`, `null` and `''` are an argument left out, which every one of
   * these is allowed to be.
   *
   * What this cannot see: an option a control offers but nobody has selected.
   * Only the current value exists at this point, so a picker with one bad
   * choice among three reads clean until someone clicks it.
   *
   * No fallback, unlike the component case. A layout attribute has a sane
   * default and a half-styled component still reads; there is no safe value to
   * substitute for "which time window", and inventing one would answer a
   * question nobody asked.
   *
   * @returns {string|null} the message, or null when there is nothing wrong
   */
  function enumViolation(source, args) {
    const spec = argEnums?.()?.[source];
    if (!spec) return null;
    // Two call shapes, and reading the wrong one would check nothing while
    // looking like it checked: an options-object source takes ONE argument
    // holding every name, a positional source spreads them in `keys` order.
    const valueOf = spec.callStyle === 'object'
      ? (name) => (args?.[0] && typeof args[0] === 'object' ? args[0][name] : undefined)
      : (name) => args?.[spec.keys.indexOf(name)];
    for (const [name, allowed] of Object.entries(spec.enums)) {
      const value = valueOf(name);
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      if (allowed.includes(String(value))) continue;
      return `"${source}" takes ${name} as one of ${allowed.join(', ')} — `
        + `"${value}" is not one of them, so this fetch would fail upstream`;
    }
    return null;
  }

  function fetchKey(key, source, args, { force = false } = {}) {
    const existing = cache.get(key);
    if (existing && !force && (existing.status === 'loading' || existing.status === 'ok')) {
      return existing.promise ?? Promise.resolve(existing);
    }

    // Before the fetch, not after it: the whole value of catching this locally
    // is that the diagnostic is repairable, so the generator gets a chance to
    // fix its own argument before anyone sees a failed panel.
    const violation = enumViolation(source, args);
    if (violation) {
      // Cached as an error so `sync` does not re-report it on every streamed
      // chunk, and so `@Run` — which forces — is still able to retry once the
      // generator has rewritten the argument.
      const bad = {
        status: 'error',
        value: existing?.value,
        error: new Error(violation),
        generation: ++generation,
        promise: null,
      };
      cache.set(key, bad);
      diag('arg_enum_violation', violation, source);
      publishKey(key);
      onChange?.();
      return Promise.resolve(bad);
    }

    const gen = ++generation;
    const entry = {
      status: 'loading',
      // Stale-while-refetching: whatever was there stays there.
      value: existing?.value,
      error: null,
      generation: gen,
      promise: null,
    };
    cache.set(key, entry);
    publishKey(key);
    queueMicrotask(() => { if (!disposed) onChange?.(); });

    entry.promise = Promise.resolve()
      .then(() => call(source, ...args))
      .then((value) => ({ ok: true, value }), (err) => ({ ok: false, err }))
      .then(({ ok, value, err }) => {
        if (disposed) return entry;
        const current = cache.get(key);
        // A later force-refetch has already superseded this one. Landing now
        // would show the older args' answer under the newer args' label.
        if (!current || current.generation !== gen) return current ?? entry;
        if (ok) {
          current.status = 'ok';
          current.value = value;
          current.error = null;
        } else {
          current.status = 'error';
          current.error = err;
          diag('query_failed', `"${source}" failed: ${err?.message ?? err}`, source);
        }
        current.promise = null;
        publishKey(key);
        onChange?.();
        return current;
      });

    return entry.promise;
  }

  return {
    /** What `materialize()` reads: statementId → value. Live, not a copy. */
    results,
    /**
     * Statement ids whose data is currently a failure. Live, not a copy.
     *
     * Separate from `results` on purpose: a failed refetch deliberately keeps
     * the previous value on screen, so a statement can hold good data and still
     * be failing. Only this says so.
     */
    failed,
    loading,
    mutationResults,

    /**
     * Take the declarations from a materialization pass and start whatever is
     * not already in flight or cached.
     *
     * Called on every chunk, so it has to be idempotent — the same dashboard
     * arriving character by character must produce one fetch per key, not one
     * per keystroke. The cache is what makes that true.
     *
     * @param {Array<{statementId: string, source: string, args: unknown[], select: string|null}>} queries
     * @param {Array<{statementId: string, source: string, argsAst: object[]}>} [mutations]
     */
    sync(queries, mutations = []) {
      const seen = new Set();
      for (const q of queries) {
        const prev = declared.get(q.statementId);
        declared.set(q.statementId, q);
        seen.add(q.statementId);
        const key = keyOf(q.source, q.args);

        if (!prev) {
          // First sight of this statement — fetch it. This is every query on a
          // fresh dashboard, and it is the only automatic fetch there is.
          activeKeys.set(q.statementId, key);
          if (cache.has(key)) publish(q.statementId);
          else fetchKey(key, q.source, q.args);
          continue;
        }

        const prevKey = keyOf(prev.source, prev.args);
        if (key === prevKey) { publish(q.statementId); continue; }

        // The args moved. Which of the two reasons it was decides everything:
        //
        //   `$state` moved  — hold. agent.yaml rule 5 promises the model that
        //   a filter it forgot to `@Run` keeps showing data fetched under the
        //   old value. Fetching here would make that promise false, and would
        //   quietly paper over exactly the mistake the rule exists to catch.
        //
        //   the model rewrote the args — fetch. A revision turn that changes
        //   `[14]` to `[30]` is a new question, and there is no `@Run` coming.
        if (q.stateful) continue;

        activeKeys.set(q.statementId, key);
        if (cache.has(key)) publish(q.statementId);
        else fetchKey(key, q.source, q.args);
      }
      // A statement the generator deleted stops being a reader. Its cache entry
      // stays: revisions flip a chart back and forth and re-fetching each time
      // would make an undo cost a round trip.
      for (const id of [...declared.keys()]) {
        if (!seen.has(id)) { declared.delete(id); results.delete(id); activeKeys.delete(id); failed.delete(id); loading.delete(id); }
      }

      declaredMutations.clear();
      for (const m of mutations) declaredMutations.set(m.statementId, m);
    },

    /**
     * `@Run(ref)` — force. Resolves once the value has landed, so an Action can
     * genuinely sequence a refetch before its next step.
     */
    async run(statementId) {
      const q = declared.get(statementId);
      if (!q) {
        diag('run_unknown', `@Run(${statementId}) names nothing that is a Query or Mutation`, statementId);
        return { ok: false, reason: 'unknown' };
      }
      const key = keyOf(q.source, q.args);
      // This is where a held-back `$state` change lands: the statement starts
      // showing the new key, and the fetch under it is forced rather than
      // served from cache, so a plain refresh button refreshes.
      activeKeys.set(statementId, key);
      await fetchKey(key, q.source, q.args, { force: true });
      publish(statementId);
      const entry = cache.get(key);
      return { ok: entry?.status !== 'error', reason: entry?.status };
    },

    /** True when this name is a Query in the current pass. */
    isQuery(statementId) { return declared.has(statementId); },
    isMutation(statementId) { return declaredMutations.has(statementId); },

    /**
     * Fire a declared Mutation. Its arguments are evaluated by the caller,
     * because a mutation inside an `@Each` has to send the row that was
     * actually clicked.
     *
     * @param {string} statementId
     * @param {unknown[]} args already-evaluated positional arguments
     */
    async fireMutation(statementId, args) {
      if (!allowMutations) {
        diag('mutation_not_allowed', 'Generated surfaces have no approved mutation sources', statementId);
        return { ok: false, reason: 'not_allowed' };
      }
      const m = declaredMutations.get(statementId);
      if (!m) {
        diag('run_unknown', `@Run(${statementId}) names nothing that is a Query or Mutation`, statementId);
        return { ok: false, reason: 'unknown' };
      }
      if (firing.has(statementId)) {
        // A double-click on Delete must delete once. Reporting it beats
        // swallowing it, because the second click looked like it did nothing.
        diag('mutation_in_flight', `"${statementId}" is already running; the repeat was ignored`, statementId);
        return { ok: false, reason: 'in_flight' };
      }
      firing.add(statementId);
      mutationResults.set(statementId, { status: 'running', data: null, error: null });
      onChange?.();
      try {
        const data = await call(m.source, ...args);
        mutationResults.set(statementId, { status: 'ok', data, error: null });
        return { ok: true, data };
      } catch (err) {
        mutationResults.set(statementId, { status: 'error', data: null, error: String(err?.message ?? err) });
        diag('mutation_failed', `"${m.source}" failed: ${err?.message ?? err}`, statementId);
        return { ok: false, reason: 'error', error: err };
      } finally {
        firing.delete(statementId);
        onChange?.();
      }
    },

    /** Every in-flight fetch, for a caller that wants to await settlement. */
    async settled() {
      const pending = [...cache.values()].map((e) => e.promise).filter(Boolean);
      if (pending.length) await Promise.all(pending);
    },

    /** New conversation, new data. */
    reset() {
      cache.clear();
      declared.clear();
      declaredMutations.clear();
      mutationResults.clear();
      results.clear();
      activeKeys.clear();
      firing.clear();
      failed.clear();
      loading.clear();
    },

    dispose() { disposed = true; },
  };
}
