/**
 * Keep the caret where the user left it across a full rebuild.
 *
 * The renderer has no reconciler on purpose: every paint is
 * `container.replaceChildren()` and a fresh tree (render.js:69). That is the
 * right trade at one dashboard's size — a diffing layer's bugs all look like
 * "the screen is subtly wrong" rather than "the screen is missing" — but it
 * has one consequence the user feels directly. `store.subscribe(() => paint())`
 * means every `$state` write repaints, so an input wired to
 * `Action([@Set($q, $event)])` is destroyed and recreated on its own keystroke:
 * exactly one character lands, focus drops to <body>, and the next keystroke
 * goes nowhere. A filter box that takes one letter is not a filter box.
 *
 * This is the bounded mitigation, not the reconciler: capture where the caret
 * is before the rebuild, put it back after. Nothing else about the tree is
 * preserved or compared.
 *
 * @module common/surface/focus
 */

/**
 * Where the caret is, as a path the next tree can be asked for.
 *
 * A bare index path is what this obviously wants to be, and it is not enough.
 * If the tree reshapes between paints — a `$view` toggle swapping a table for a
 * chart — index 3 still resolves, to something else entirely, and the caret
 * lands in a different control while the user is mid-word. So each step
 * carries its tag as well, and a mismatch anywhere abandons the restore.
 *
 * Refusing is the safe failure. Focus was already going to be lost; putting it
 * somewhere wrong is worse than leaving it lost, because the user's next
 * keystrokes go into a field they did not choose.
 *
 * `statementId` is deliberately not used as the key. It is undefined for
 * everything an `@Each` produces — the rows of a generated list are exactly
 * where a repeated input shows up — so it identifies some elements and not
 * others, which is the worst property an identity can have.
 *
 * @param {Element} container
 * @param {Document} doc
 * @returns {{path: {i: number, tag: string}[], start: number|null, end: number|null, dir: string|null}|null}
 */
export function captureFocus(container, doc) {
  const active = doc?.activeElement;
  if (!active || active === container || !container?.contains?.(active)) return null;

  const path = [];
  for (let node = active; node && node !== container; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) return null; // detached mid-walk; nothing to restore to
    path.unshift({ i: [...parent.children].indexOf(node), tag: node.tagName });
  }
  if (!path.length) return null;

  // Only text-ish controls have a selection. Reading these off anything else
  // throws in some browsers, so it is a capability test, not a tag list —
  // a design-system control that starts wrapping <textarea> gets this for free.
  let start = null;
  let end = null;
  let dir = null;
  try {
    if (typeof active.selectionStart === 'number') {
      start = active.selectionStart;
      end = active.selectionEnd;
      dir = active.selectionDirection;
    }
  } catch { /* an input type that has no selection to report */ }

  return { path, start, end, dir };
}

/**
 * Put the caret back, or leave it alone.
 *
 * Called after the rebuild, with whatever `captureFocus` returned before it.
 * Every step is checked; the first surprise ends the attempt.
 *
 * @param {Element} container
 * @param {ReturnType<typeof captureFocus>} snapshot
 * @returns {boolean} whether focus was restored — for tests, and for a caller
 *   that wants to know the tree reshaped under someone's hands
 */
export function restoreFocus(container, snapshot) {
  if (!snapshot || !container) return false;

  let node = container;
  for (const step of snapshot.path) {
    const next = node.children?.[step.i];
    // The tag check is the whole point: a resolved index proves only that
    // something is there, not that it is the same something.
    if (!next || next.tagName !== step.tag) return false;
    node = next;
  }
  if (typeof node.focus !== 'function') return false;

  // preventScroll, because a repaint is not a navigation. Without it a filter
  // box below the fold drags the page to itself on every keystroke.
  node.focus({ preventScroll: true });

  if (snapshot.start !== null && typeof node.setSelectionRange === 'function') {
    // Clamped: the value can be shorter than it was, and a saved offset past
    // the end throws in some browsers rather than saturating.
    const max = typeof node.value === 'string' ? node.value.length : snapshot.end;
    const start = Math.min(snapshot.start, max);
    const end = Math.min(snapshot.end ?? snapshot.start, max);
    try {
      node.setSelectionRange(start, end, snapshot.dir || 'none');
    } catch { /* a control that reports a selection but will not take one */ }
  }
  return true;
}
