/**
 * The Action runner — what happens when a generated button is pressed.
 *
 * An `Action([...])` is a short ordered script, and the ordering is the point.
 * `agent.yaml` rule 5 makes two promises about it that this module has to keep
 * literally, because the model is told to rely on both:
 *
 *   **`@Set` then `@Run`, in one Action, re-fetches.** A `$variable` changing
 *   never re-fetches on its own. So a filter only works if both steps are in
 *   the same Action, and the `@Set` has to be visible to the `@Run` — which
 *   means the store write, a re-materialization, and only then the fetch. Skip
 *   the re-materialization and `@Run` fetches under the *old* args and the
 *   filter lies: it spins, it repaints, and it shows the same numbers.
 *
 *   **A failed mutation stops the Action.** Every step after a `@Run` of a
 *   Mutation that failed is skipped. That is what stops "delete the row, then
 *   close the dialog and refresh the list" from closing the dialog over a
 *   delete that did not happen.
 *
 * Steps are therefore run sequentially and awaited, never fired in parallel.
 *
 * `@OpenUrl` is the one step that can take the user somewhere, so it is the one
 * step with an allowlist in front of it. The path is checked against the routes
 * the app actually registered — the live router, not a copy — and anything else
 * is dropped with a diagnostic naming it. A host that passes no router refuses
 * every path, which is the right way round for a default.
 *
 * @module common/surface/actions
 */

/**
 * @param {{
 *   store: {set(name: string, value: unknown): boolean, reset(names: string[]): boolean},
 *   queries: {isQuery(id: string): boolean, isMutation(id: string): boolean,
 *             run(id: string): Promise<{ok: boolean, reason?: string}>,
 *             fireMutation(id: string, args: unknown[]): Promise<{ok: boolean}>},
 *   refresh: () => {evaluateAst?: (node: object, scope?: object|null) => unknown,
 *                   mutations?: Array<{statementId: string, argsAst: object[]}>} | void,
 *   onAssistant?: (text: string) => void,
 *   onDiagnostic?: (d: object) => void,
 *   routes?: {has(path: string): boolean},
 *   navigate?: (path: string) => void,
 * }} deps
 */
export function createActionRunner({ store, queries, refresh, onAssistant, onDiagnostic, routes, navigate }) {
  const diag = (code, message, pointer) =>
    onDiagnostic?.({ source: 'actions', code, message, pointer });

  /** One Action at a time per element — a click during a mutation is dropped. */
  const running = new Set();

  /**
   * @param {{statementId: string, steps: object[]}} action
   * @param {((node: object, scope?: object|null) => unknown)|null} [evaluator]
   * @returns {Promise<{ran: number, halted: boolean}>}
   */
  async function run(action, evaluator = null) {
    if (!action || action.type !== 'action') return { ran: 0, halted: false };
    const id = action.statementId ?? '(anonymous)';
    if (running.has(id)) {
      diag('action_in_flight', `"${id}" is still running; the repeat was ignored`, id);
      return { ran: 0, halted: false };
    }
    running.add(id);
    try {
      let ran = 0;
      // The evaluator from the pass that rendered the element that was
      // clicked. Its scope chain is the only place an `@Each` row exists, so
      // it is passed in rather than looked up — by the time a later step
      // re-materializes, that pass is gone.
      let evaluateAst = evaluator ?? action.evaluateAst ?? null;

      for (const step of action.steps ?? []) {
        const evaluate = (node, scope) => {
          if (!node) return null;
          if (!evaluateAst) return null;
          return evaluateAst(node, scope ?? null);
        };

        switch (step.kind) {
          case 'set': {
            if (!step.target) { diag('bad_set', '@Set needs a $variable as its first argument', id); break; }
            store.set(step.target, evaluate(step.valueAst, step.scope));
            // Re-walk now, so a `@Run` later in this same Action sees args
            // computed from the value just written. This is the whole of
            // Worked Example 3b.
            evaluateAst = adopt(refresh(), evaluateAst);
            ran++;
            break;
          }

          case 'reset': {
            if (!step.targets?.length) { diag('bad_reset', '@Reset needs at least one $variable', id); break; }
            store.reset(step.targets);
            evaluateAst = adopt(refresh(), evaluateAst);
            ran++;
            break;
          }

          case 'run': {
            if (!step.ref) { diag('bad_run', '@Run needs a statement name', id); break; }
            if (queries.isMutation(step.ref)) {
              const latest = refresh();
              const decl = latest?.mutations?.find((m) => m.statementId === step.ref);
              evaluateAst = adopt(latest, evaluateAst);
              const args = (decl?.argsAst ?? []).map((node) => evaluate(node, step.scope));
              const res = await queries.fireMutation(step.ref, args);
              ran++;
              if (!res.ok) {
                // Rule 5: every step after a failed mutation is skipped.
                diag('action_halted', `"${id}" stopped after @Run(${step.ref}) failed`, id);
                return { ran, halted: true };
              }
              evaluateAst = adopt(refresh(), evaluateAst);
              break;
            }
            if (queries.isQuery(step.ref)) {
              await queries.run(step.ref);
              evaluateAst = adopt(refresh(), evaluateAst);
              ran++;
              break;
            }
            diag('run_unknown', `@Run(${step.ref}) names nothing that is a Query or Mutation`, id);
            break;
          }

          case 'toAssistant': {
            const text = evaluate(step.messageAst, step.scope);
            const message = text === null || text === undefined ? '' : String(text);
            if (!message) { diag('bad_to_assistant', '@ToAssistant needs a message', id); break; }
            onAssistant?.(message);
            ran++;
            break;
          }

          case 'openUrl': {
            const path = String(evaluate(step.urlAst, step.scope) ?? '');
            // Checked against the routes the app actually registered. This was
            // refused outright until there was something to check against —
            // shipping navigation with nothing validating the string is how a
            // generated surface leaves the application.
            if (!routes?.has(path)) {
              diag('route_not_allowed', `@OpenUrl(${JSON.stringify(path)}) is not a route this app has`, id);
              break;
            }
            if (!navigate) {
              diag('no_navigator', `@OpenUrl(${JSON.stringify(path)}) is allowed but this host wired no navigator`, id);
              break;
            }
            navigate(path);
            ran++;
            break;
          }

          default:
            diag('unknown_step', `"${step.kind}" is not an Action step`, id);
            break;
        }
      }
      return { ran, halted: false };
    } finally {
      running.delete(id);
    }
  }

  return { run };
}

/** Take the new pass's evaluator when there is one, else keep the old. */
function adopt(out, previous) {
  return out && typeof out.evaluateAst === 'function' ? out.evaluateAst : previous;
}
