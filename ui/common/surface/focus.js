/**
 * Focus and cursor-position preservation across a full clear-and-rebuild
 * render.
 *
 * render.js's `render()` does `container.replaceChildren()` on every pass —
 * deliberate, no reconciler (see render.js's own module docstring). That is
 * invisible right up until something the user is actively typing into gets
 * destroyed and recreated mid-keystroke: the new element is never the same
 * node the browser had focused, so every render after the first character
 * silently drops focus back to `<body>`. `$event` (materialize.js/actions.js)
 * is what makes a real re-render actually fire from typing at all, so this is
 * the other half of making live input usable — a bounded fix for this one
 * symptom, not a reconciler.
 *
 * Every design-system component is light DOM (`ui-lint`'s
 * `no-attach-shadow` is a hard 0), so `document.activeElement` for a form
 * control's inner native input is that input itself, not a shadow host —
 * this needs no shadow-piercing.
 *
 * The path is structural (child index at each level from the container down
 * to the focused element), because nothing else survives a full rebuild: no
 * stable id, no object identity, nothing but position in the tree — and a
 * generated surface's shape does not change between one keystroke and the
 * next, so position is a reliable enough key for this one render.
 *
 * @module common/surface/focus
 */

/**
 * Child-index path from `root` down to `el`.
 * @param {Element} root
 * @param {Element|null} el
 * @returns {number[]|null} null if `el` is not inside `root`, or is `root` itself.
 */
export function capturePathTo(root, el) {
  if (!el || el === root || !root.contains(el)) return null;
  const path = [];
  for (let node = el; node && node !== root; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
  }
  return path;
}

/**
 * The element `path` resolves to under `root`, or null if the new tree has
 * nothing at that position (a revision turn changed the shape).
 * @param {Element} root
 * @param {number[]|null} path
 * @returns {Element|null}
 */
export function resolvePath(root, path) {
  if (!path) return null;
  let node = root;
  for (const index of path) {
    node = node?.children?.[index];
    if (!node) return null;
  }
  return node;
}

/**
 * Call before `render()` clears `container`.
 * @param {Element} container
 * @returns {{path: number[], selectionStart: number|null, selectionEnd: number|null}|null}
 */
export function saveFocus(container) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const path = capturePathTo(container, active);
  if (!path) return null;
  const hasSelection = 'selectionStart' in active;
  return {
    path,
    selectionStart: hasSelection ? active.selectionStart : null,
    selectionEnd: hasSelection ? active.selectionEnd : null,
  };
}

/**
 * Call after `render()` rebuilds `container`, with whatever `saveFocus`
 * returned beforehand (including `null` — a no-op, nothing was focused).
 * @param {Element} container
 * @param {ReturnType<saveFocus>} saved
 */
export function restoreFocus(container, saved) {
  if (!saved) return;
  const el = resolvePath(container, saved.path);
  if (!el || typeof el.focus !== 'function') return;
  el.focus();
  if (saved.selectionStart === null || typeof el.setSelectionRange !== 'function') return;
  try {
    el.setSelectionRange(saved.selectionStart, saved.selectionEnd ?? saved.selectionStart);
  } catch {
    // Not every focusable, selection-capable-looking element accepts a range
    // (e.g. an <input type="email">) — losing the cursor position is fine,
    // losing the focus itself would not be.
  }
}
