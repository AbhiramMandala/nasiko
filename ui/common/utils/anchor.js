/**
 * Anchored-overlay positioning — the one flip-and-clamp engine.
 *
 * nasiko_ui has `NasikoAnchoredOverlay`, a single positioning engine that
 * popover, hover card, popup menu and context menu all share, so they flip and
 * clamp identically. This is that engine for the web side. Before it existed
 * every overlay here measured and clamped on its own (app-tooltip still does,
 * with its two fixed placements) and no two agreed on the gap or the margin.
 *
 * The surface must be `position: fixed` (or a top-layer popover, which is
 * fixed by definition). Coordinates are viewport coordinates, so scrolling
 * containers between the anchor and the body do not matter.
 *
 *   positionAnchored(surface, anchor, { side: 'bottom', align: 'start' });
 *
 * Returns the placement actually used (`{ side, align }`) so the caller can
 * reflect it — a caret, a transform-origin, an entrance direction.
 *
 * @param {HTMLElement} surface  The element to place. Measured after it is visible.
 * @param {DOMRect|HTMLElement} anchor  The element (or rect) to anchor to. Pass a
 *   zero-size rect at a pointer position for a context menu.
 * @param {object} [opts]
 * @param {'top'|'bottom'|'left'|'right'} [opts.side='bottom']  Preferred side. Flips
 *   to the opposite side when the surface's measured size does not fit.
 * @param {'start'|'center'|'end'} [opts.align='start']  Alignment along the other axis.
 * @param {number} [opts.gap=4]  Pixels between anchor and surface.
 * @param {number} [opts.margin=8]  Minimum clearance from the viewport edge.
 */
export function positionAnchored(surface, anchor, opts = {}) {
  const { side = 'bottom', align = 'start', gap = 4, margin = 8 } = opts;
  const a = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = surface.offsetWidth;
  const h = surface.offsetHeight;

  // Main axis: prefer the requested side; flip when it does not fit and the
  // opposite side has more room. Measured, not guessed.
  let s = side;
  const room = { top: a.top - margin, bottom: vh - a.bottom - margin, left: a.left - margin, right: vw - a.right - margin };
  const need = s === 'top' || s === 'bottom' ? h + gap : w + gap;
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[s];
  if (room[s] < need && room[opposite] > room[s]) s = opposite;

  let top;
  let left;
  if (s === 'top' || s === 'bottom') {
    top = s === 'bottom' ? a.bottom + gap : a.top - gap - h;
    left = align === 'start' ? a.left : align === 'end' ? a.right - w : a.left + a.width / 2 - w / 2;
  } else {
    left = s === 'right' ? a.right + gap : a.left - gap - w;
    top = align === 'start' ? a.top : align === 'end' ? a.bottom - h : a.top + a.height / 2 - h / 2;
  }

  // Cross axis (and a last-resort main axis): clamp inside the viewport.
  left = Math.max(margin, Math.min(left, vw - w - margin));
  top = Math.max(margin, Math.min(top, vh - h - margin));

  surface.style.top = `${Math.round(top)}px`;
  surface.style.left = `${Math.round(left)}px`;
  surface.style.transformOrigin = {
    top: 'bottom center', bottom: 'top center', left: 'center right', right: 'center left',
  }[s];
  return { side: s, align };
}

/**
 * Keep an anchored surface in place while it is open: re-position on scroll
 * (any ancestor, captured) and on resize. Returns a teardown function.
 *
 * @param {() => void} reposition
 */
export function followAnchor(reposition) {
  window.addEventListener('scroll', reposition, { capture: true, passive: true });
  window.addEventListener('resize', reposition);
  return () => {
    window.removeEventListener('scroll', reposition, { capture: true });
    window.removeEventListener('resize', reposition);
  };
}

/**
 * Whether the top-layer Popover API is available. Every overlay here uses
 * `popover="manual"` when it is — it escapes overflow clipping, z-index
 * stacking and, crucially, paints above an open `<dialog>` — and falls back to
 * a fixed element at --z-dropdown when it is not.
 */
export const supportsPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
