/**
 * What happened on a turn, in a shape you can count.
 *
 * Diagnostics were already well-formed — `source`, `code`, `message`,
 * `pointer` — and they already reached the screen. What they never reached was
 * anywhere you could ask a question of. So nobody could answer "how often does
 * a generation name a source that does not exist", or "which component does the
 * model get wrong most", and every prompt change was evaluated by opening a
 * browser and forming an impression.
 *
 * This turns each turn into one record. Two decisions in it are load-bearing:
 *
 *   **Codes and counts, never content.** A prompt is something a person typed
 *   about their own data, and generated DSL quotes it back — labels, filters,
 *   whole sentences. None of that leaves the page. What leaves is the shape:
 *   which diagnostic codes fired and how many times, how long it took, how many
 *   statements came out. That is enough to find a regression and not enough to
 *   reconstruct anything private.
 *
 *   **One record per turn, not per diagnostic.** The runtime re-walks the whole
 *   tree on every chunk, so a single bad statement emits the same diagnostic
 *   dozens of times in two seconds. Reported raw, that reads as a catastrophe
 *   and drowns the turn that produced one real error. Aggregated, the count is
 *   the interesting part.
 *
 * @module common/surface/telemetry
 */

/** Nothing here is a secret, but a `pointer` is a statement name the model chose. */
function summarize(diagnostics) {
  const byKey = new Map();
  for (const d of diagnostics) {
    const key = `${d.source ?? 'unknown'}/${d.code ?? 'unknown'}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  return [...byKey.entries()]
    .map(([key, count]) => {
      const [source, code] = key.split('/');
      return { source, code, count };
    })
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * @param {{
 *   report?: (record: object) => void,
 *   now?: () => number,
 * }} [deps]
 */
export function createSurfaceTelemetry({ report, now = () => Date.now() } = {}) {
  /** @type {Set<(record: object) => void>} */
  const listeners = new Set();
  if (report) listeners.add(report);

  let turn = null;

  function emit(record) {
    for (const fn of [...listeners]) {
      try { fn(record); } catch { /* a sink must never break a render */ }
    }
  }

  return {
    /** Subscribe. The real sink attaches here once NAS-211 lands. */
    onTurn(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * @param {{promptLength?: number, catalogVersion?: string|null}} [meta]
     */
    begin(meta = {}) {
      turn = {
        startedAt: now(),
        promptLength: meta.promptLength ?? 0,
        catalogVersion: meta.catalogVersion ?? null,
        generatorCatalogVersion: null,
        surfaceId: null,
        chunks: 0,
        diagnostics: [],
      };
    },

    /** From the `surface` frame — the generator identifying itself. */
    identify({ surfaceId, catalogVersion }) {
      if (!turn) return;
      turn.surfaceId = surfaceId ?? null;
      turn.generatorCatalogVersion = catalogVersion ?? null;
    },

    chunk() { if (turn) turn.chunks++; },

    record(diagnostics) {
      if (!turn || !diagnostics?.length) return;
      turn.diagnostics.push(...diagnostics);
    },

    /**
     * Close the turn and emit exactly one record.
     *
     * @param {{status: string, statements?: number, rendered?: boolean}} outcome
     */
    end(outcome) {
      if (!turn) return null;
      const record = {
        kind: 'weave-surface-turn',
        surfaceId: turn.surfaceId,
        status: outcome.status,
        elapsedMs: now() - turn.startedAt,
        chunks: turn.chunks,
        statements: outcome.statements ?? 0,
        rendered: Boolean(outcome.rendered),
        promptLength: turn.promptLength,
        catalogVersion: turn.catalogVersion,
        generatorCatalogVersion: turn.generatorCatalogVersion,
        diagnostics: summarize(turn.diagnostics),
        // The single number worth alerting on: a turn that finished and drew
        // nothing is a failure the user definitely saw, whatever `status` says.
        emptyRender: outcome.status === 'ok' && !outcome.rendered,
      };
      turn = null;
      emit(record);
      return record;
    },
  };
}
