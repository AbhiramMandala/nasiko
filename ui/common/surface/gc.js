/**
 * Prunes a full DSL text buffer down to only the statements still reachable
 * from `root` (plus every `$state` declaration, always kept regardless of
 * reachability). Fixes a real growth problem: without this, a statement no
 * longer referenced from `root` still never leaves the accumulated
 * `currentSurfaceText` sent back to the model every revision turn, so a
 * long session's context grows forever. Run once per turn, after the `end`
 * SSE event, before storing the new `currentSurface` for next turn.
 *
 * Ported from OpenUI Lang's real `mergeStatements()`'s GC step (session
 * research), adapted to our own "send the full raw text back" revision
 * model (no patch-merge needed — we just prune the text before storing it).
 *
 * Live-state rewrite: a `$state` declaration's stored raw text is always
 * its ORIGINAL initial-value expression (e.g. `$view = "cost"`), never what
 * the user actually changed it to via `@Set`. Sending that original text
 * back as `currentSurface` therefore silently resets every toggle/filter on
 * the very next revision turn — a real, confusing regression a user
 * reported. If a live `store` is passed, each `$state` line is rewritten to
 * the store's CURRENT value (a literal) before being sent back, so a
 * revision turn preserves what the user actually has selected.
 */

import { parseBuffer } from './parser.js';
import { walkAstRefs } from './materialize.js';

/** Serializes a simple store value back to a DSL literal. Returns `null`
 * (meaning "keep the original raw text instead") for anything that isn't a
 * plain string/number/boolean — `$variables` never hold arrays/objects by
 * design, so this should only happen if something bypassed that contract. */
function serializeLiveValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Shared reachability walk from `root`, plus every `$state` id (always
 * kept regardless of reachability). Used by both `pruneUnreachable` (drops
 * unreachable statements silently, by design — that's how GC works) and
 * `unreachableStatements` (reports them, for a caller that wants to warn
 * instead of silently accept — e.g. a button the model defined but forgot
 * to wire into any children array, which otherwise fails with zero visible
 * error: it's simply absent from the render, indistinguishable from "the
 * model chose not to build it"). */
function computeReachable(statements, byId) {
  const reachable = new Set();
  const queue = ['root'];
  while (queue.length) {
    const id = queue.pop();
    if (reachable.has(id) || !byId.has(id)) continue;
    reachable.add(id);
    walkAstRefs(byId.get(id).ast, (kind, name) => { if (kind === 'ref') queue.push(name); });
  }
  for (const s of statements) {
    if (s.id.startsWith('$')) reachable.add(s.id); // $state always kept
  }
  return reachable;
}

/**
 * Names of statements NOT reachable from `root` (excluding `$state` ids,
 * which are never considered orphaned). Diagnostic only — does not affect
 * rendering or what gets sent back to the model; call this after a turn
 * finishes and log a warning so an orphaned component is diagnosable
 * instead of silently invisible.
 * @param {string} fullText
 * @returns {string[]} unreachable statement ids, in declaration order
 */
export function unreachableStatements(fullText) {
  const { statements } = parseBuffer(fullText);
  const byId = new Map();
  for (const s of statements) byId.set(s.id, s);
  const reachable = computeReachable(statements, byId);
  const seen = new Set();
  const out = [];
  for (const s of statements) {
    if (seen.has(s.id) || reachable.has(s.id)) continue;
    seen.add(s.id);
    out.push(s.id);
  }
  return out;
}

/**
 * @param {string} fullText
 * @param {{get: (name: string) => any, has: (name: string) => boolean}} [store]
 *   optional live reactive store (store.js's createStore()) — when given,
 *   `$state` lines are rewritten to reflect the user's current live values.
 * @returns {string} pruned text — same statements, in original order, minus
 *   anything unreachable from `root`.
 */
export function pruneUnreachable(fullText, store) {
  const { statements } = parseBuffer(fullText);
  const byId = new Map();
  for (const s of statements) byId.set(s.id, s); // latest-wins, matches materialize.js's own symbol rule

  const reachable = computeReachable(statements, byId);

  const seen = new Set();
  const out = [];
  for (const s of statements) {
    if (!reachable.has(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);

    if (s.id.startsWith('$') && store?.has(s.id)) {
      const literal = serializeLiveValue(store.get(s.id));
      if (literal !== null) {
        out.push(`${s.id} = ${literal}`);
        continue;
      }
    }
    out.push(byId.get(s.id).raw); // use the LATEST raw text for this id
  }
  return out.join('\n');
}
