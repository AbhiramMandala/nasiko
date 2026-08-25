/**
 * `<app-tooltip>` — Lightweight tooltip with asymmetric hover debounce.
 *
 * Ported from Flutter's `NasikoTooltip` + the asymmetric debounce in
 * `sidebar_navigation_cubit.dart`. Shows a single-line label anchored
 * below (default) or above the trigger element.
 *
 * Debounce behaviour (from sidebar cubit):
 *   - Open delay:  120ms  (prevents accidental reveals on fast mouse passes)
 *   - Close delay:  80ms  (snappy dismiss, but survives jitter between
 *                          trigger and tooltip gap)
 *
 * Positioning:
 *   - Defaults to below the trigger with 4px gap
 *   - Flips above when the tooltip would overflow the viewport bottom
 *   - Horizontally centered on the trigger, clamped to viewport edges
 *   - `data-tooltip-placement="right"` instead anchors to the trigger's right
 *     edge, vertically centred, flipping to the left when there is no room.
 *     That is the icon-rail case: a 32px button in a 32px-wide column has no
 *     room below it, and a label beside it is what the user is reading anyway.
 *
 * The tooltip is rendered as a singleton floating `<div>` appended to
 * `<body>` (portal pattern) — avoids overflow:hidden clipping from any
 * ancestor, and means zero DOM weight when no tooltip is visible.
 *
 * Usage:
 *   import { attachTooltip } from '/common/design-system/app-tooltip/app-tooltip.js';
 *
 *   // Imperative — attach to any element:
 *   attachTooltip(buttonEl, 'Search · ⌘K');
 *
 *   // Declarative — via data attribute (auto-scanned):
 *   <button data-tooltip="Settings">⚙</button>
 *
 * @module app-tooltip
 */

import { FAST, EASE_ENTER, EASE_EXIT } from '../../core/motion.js';

// ── Timing (from sidebar_navigation_cubit.dart) ────────────────────────

const OPEN_DELAY  = 120;   // ms — debounce before showing
const CLOSE_DELAY = 80;    // ms — debounce before hiding
const GAP         = 4;     // px between trigger and tooltip
const MARGIN      = 8;     // px minimum clearance from the viewport edge
const FADE_MS     = FAST;  // 150ms fade

// ── Singleton tooltip element ──────────────────────────────────────────

let _el = null;
let _currentTrigger = null;
let _openTimer = null;
let _closeTimer = null;
let _visible = false;

function _getEl() {
  if (_el) return _el;

  _el = document.createElement('div');
  _el.setAttribute('role', 'tooltip');
  _el.className = 'app-tooltip';
  // Styling lives in app-tooltip.css. Only the fade duration stays here,
  // because it is read from the motion module that also drives the JS timers —
  // splitting it would let the CSS transition and the JS timeout drift apart.
  _el.style.setProperty('--tooltip-fade', `${FADE_MS}ms ${EASE_ENTER}`);

  return _el;
}

// ── Light-theme override ───────────────────────────────────────────────

import { loadCss } from '/common/utils/css.js';
const _sheet = await loadCss(new URL('./app-tooltip.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, _sheet];

// ── Positioning ────────────────────────────────────────────────────────

function _position(trigger) {
  const el = _getEl();
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // The placement is reflected onto the tooltip as well as read from the
  // trigger, because the box itself differs: a side-anchored tooltip labels an
  // icon and is sized as a label (app-tooltip.css). Set it BEFORE measuring —
  // reading offsetHeight first measured the default box and left the tooltip
  // 2px off-centre against the item it was labelling.
  const side = trigger.dataset.tooltipPlacement === 'right' ? 'right' : 'below';
  el.dataset.placement = side;

  const tipW = el.offsetWidth;
  const tipH = el.offsetHeight;

  if (side === 'right') {
    // Beside the trigger, vertically centred on it.
    let left = rect.right + GAP;
    let transformOrigin = 'center left';
    // Flip to the left edge when the tooltip would run off the right.
    if (left + tipW > vw - MARGIN) {
      left = rect.left - GAP - tipW;
      transformOrigin = 'center right';
    }
    const top = Math.max(
      MARGIN,
      Math.min(rect.top + rect.height / 2 - tipH / 2, vh - tipH - MARGIN),
    );
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(Math.max(MARGIN, left))}px`;
    el.style.transformOrigin = transformOrigin;
    return;
  }

  // Prefer below
  let top = rect.bottom + GAP;
  let transformOrigin = 'top center';

  // Flip above if overflows bottom
  if (top + tipH > vh - MARGIN) {
    top = rect.top - GAP - tipH;
    transformOrigin = 'bottom center';
  }

  // Center horizontally on trigger, clamp to viewport
  let left = rect.left + rect.width / 2 - tipW / 2;
  left = Math.max(MARGIN, Math.min(left, vw - tipW - MARGIN));

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
  el.style.transformOrigin = transformOrigin;
}

// ── Show / hide ────────────────────────────────────────────────────────

/** `text` may be a string or a getter, resolved when the tooltip is shown. */
function _resolve(text) {
  return (typeof text === 'function' ? text() : text) ?? '';
}

function _show(trigger, text) {
  // Resolved before anything else: a trigger whose label has gone away is a
  // trigger with nothing to say. app-header drops `data-tooltip` from its rail
  // items while the rail is expanded — the row shows the label itself there, so
  // a tooltip would be repeating it — and this is what makes that take effect
  // without re-attaching listeners.
  const label = _resolve(text);
  if (!label) {
    if (_visible && _currentTrigger === trigger) _hideImmediate();
    return;
  }

  clearTimeout(_closeTimer);
  _closeTimer = null;

  if (_currentTrigger === trigger && _visible) return;

  // If already showing for a different trigger, switch instantly
  if (_currentTrigger && _currentTrigger !== trigger && _visible) {
    _hideImmediate();
  }

  _currentTrigger = trigger;

  clearTimeout(_openTimer);
  _openTimer = setTimeout(() => {
    _openTimer = null;
    const el = _getEl();
    el.textContent = label;

    if (!el.parentNode) document.body.appendChild(el);

    // Force layout so we can measure
    el.style.opacity = '0';
    el.style.transform = 'scale(0.95)';
    el.offsetHeight; // reflow

    _position(trigger);

    // Reduced motion — instant
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      el.style.transition = 'none';
      el.style.opacity = '1';
      el.style.transform = 'scale(1)';
    } else {
      el.style.transition = `opacity ${FADE_MS}ms ${EASE_ENTER}, transform ${FADE_MS}ms ${EASE_ENTER}`;
      requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.style.transform = 'scale(1)';
      });
    }

    _visible = true;

    // Set aria-describedby on trigger
    const id = 'app-tooltip-singleton';
    el.id = id;
    trigger.setAttribute('aria-describedby', id);
  }, OPEN_DELAY);
}

function _hide(trigger) {
  clearTimeout(_openTimer);
  _openTimer = null;

  if (!_visible || _currentTrigger !== trigger) return;

  clearTimeout(_closeTimer);
  _closeTimer = setTimeout(() => {
    _closeTimer = null;
    _hideImmediate();
  }, CLOSE_DELAY);
}

function _hideImmediate() {
  if (!_el) return;

  if (_currentTrigger) {
    _currentTrigger.removeAttribute('aria-describedby');
  }

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    _el.style.opacity = '0';
    _el.style.transform = 'scale(0.95)';
    if (_el.parentNode) _el.remove();
  } else {
    _el.style.transition = `opacity ${FADE_MS}ms ${EASE_EXIT}, transform ${FADE_MS}ms ${EASE_EXIT}`;
    _el.style.opacity = '0';
    _el.style.transform = 'scale(0.95)';

    // Remove from DOM after fade
    const ref = _el;
    setTimeout(() => {
      if (ref.style.opacity === '0' && ref.parentNode) ref.remove();
    }, FADE_MS + 20);
  }

  _visible = false;
  _currentTrigger = null;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Attach tooltip behaviour to an element.
 *
 * @param {HTMLElement} el              Trigger element
 * @param {string|(() => string|undefined)} text  Label, or a getter for it
 * @param {object}      [opts]
 * @param {boolean}     [opts.forceBelow]  Always position below (no flip)
 * @returns {() => void} Cleanup function (removes listeners)
 */
export function attachTooltip(el, text, opts = {}) {
  const onEnter = () => _show(el, text);
  const onLeave = () => _hide(el);
  const onFocus = () => _show(el, text);
  const onBlur  = () => _hide(el);

  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('focus', onFocus);
  el.addEventListener('blur', onBlur);

  // Hide on click (tooltip shouldn't persist after activation)
  const onClick = () => {
    clearTimeout(_openTimer);
    if (_visible && _currentTrigger === el) _hideImmediate();
  };
  el.addEventListener('pointerdown', onClick);

  return () => {
    el.removeEventListener('pointerenter', onEnter);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('focus', onFocus);
    el.removeEventListener('blur', onBlur);
    el.removeEventListener('pointerdown', onClick);
    if (_currentTrigger === el) _hideImmediate();
  };
}

/**
 * Update the text of a tooltip already attached to an element.
 * If the tooltip is currently showing for that element, the text updates live.
 *
 * @param {HTMLElement} el
 * @param {string}      text
 */
export function updateTooltipText(el, text) {
  if (_currentTrigger === el && _visible && _el) {
    _el.textContent = text;
    _position(el);
  }
}

// ── Auto-scan for data-tooltip attributes ──────────────────────────────

const _tracked = new WeakSet();

/**
 * Scan a subtree for `[data-tooltip]` elements and attach tooltip behaviour.
 * Idempotent per element (uses a WeakSet guard).
 *
 * @param {HTMLElement} [root=document.body]
 */
export function scanTooltips(root = document.body) {
  for (const el of root.querySelectorAll('[data-tooltip]')) {
    if (_tracked.has(el)) continue;
    _tracked.add(el);
    // A getter, not the value: the attribute may be added and removed over the
    // element's life (see _show), and re-reading it costs nothing.
    attachTooltip(el, () => el.dataset.tooltip);
  }
}

// Auto-scan on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => scanTooltips(), { once: true });
} else {
  // Defer to next microtask so elements are in the DOM
  queueMicrotask(() => scanTooltips());
}

// Watch for dynamically added [data-tooltip] elements
let _observer = null;

export function observeTooltips() {
  if (_observer) return;
  _observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.dataset?.tooltip && !_tracked.has(node)) {
          _tracked.add(node);
          attachTooltip(node, () => node.dataset.tooltip);
        }
        // Also scan children
        if (node.querySelectorAll) {
          for (const child of node.querySelectorAll('[data-tooltip]')) {
            if (_tracked.has(child)) continue;
            _tracked.add(child);
            attachTooltip(child, () => child.dataset.tooltip);
          }
        }
      }
    }
  });
  _observer.observe(document.body, { childList: true, subtree: true });
}

// Start observing automatically
if (typeof window !== 'undefined') {
  if (document.body) {
    observeTooltips();
  } else {
    document.addEventListener('DOMContentLoaded', () => observeTooltips(), { once: true });
  }
}
