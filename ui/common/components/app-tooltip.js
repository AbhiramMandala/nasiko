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
 *
 * The tooltip is rendered as a singleton floating `<div>` appended to
 * `<body>` (portal pattern) — avoids overflow:hidden clipping from any
 * ancestor, and means zero DOM weight when no tooltip is visible.
 *
 * Usage:
 *   import { attachTooltip } from '/common/components/app-tooltip.js';
 *
 *   // Imperative — attach to any element:
 *   attachTooltip(buttonEl, 'Search · ⌘K');
 *
 *   // Declarative — via data attribute (auto-scanned):
 *   <button data-tooltip="Settings">⚙</button>
 *
 * @module app-tooltip
 */

import { FAST, EASE_ENTER, EASE_EXIT } from '../core/motion.js';

// ── Timing (from sidebar_navigation_cubit.dart) ────────────────────────

const OPEN_DELAY  = 120;   // ms — debounce before showing
const CLOSE_DELAY = 80;    // ms — debounce before hiding
const GAP         = 4;     // px between trigger and tooltip
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
  _el.style.cssText = `
    position: fixed;
    z-index: var(--z-tooltip, 9000);
    pointer-events: none;
    opacity: 0;
    /* Layout */
    max-width: 280px;
    padding: 4px 8px;
    /* Visual */
    background: var(--sand-900, #242628);
    color: var(--sand-100, #F5F3EF);
    font-family: var(--font-body, sans-serif);
    font-size: 12px;
    line-height: 16px;
    font-weight: 500;
    border-radius: var(--r-4, 4px);
    box-shadow: 0 2px 8px rgba(0,0,0,0.28);
    white-space: nowrap;
    /* Motion */
    transition: opacity ${FADE_MS}ms ${EASE_ENTER};
    will-change: opacity, transform;
  `;

  return _el;
}

// ── Light-theme override ───────────────────────────────────────────────

const _sheet = new CSSStyleSheet();
_sheet.replaceSync(`
  :root[data-theme="light"] .app-tooltip {
    background: var(--sand-800, #3A3430);
    color: var(--sand-50, #FAF9F6);
    box-shadow: 0 2px 8px rgba(0,0,0,0.16);
  }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, _sheet];

// ── Positioning ────────────────────────────────────────────────────────

function _position(trigger) {
  const el = _getEl();
  const rect = trigger.getBoundingClientRect();
  const tipW = el.offsetWidth;
  const tipH = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer below
  let top = rect.bottom + GAP;
  let transformOrigin = 'top center';

  // Flip above if overflows bottom
  if (top + tipH > vh - 8) {
    top = rect.top - GAP - tipH;
    transformOrigin = 'bottom center';
  }

  // Center horizontally on trigger, clamp to viewport
  let left = rect.left + rect.width / 2 - tipW / 2;
  left = Math.max(8, Math.min(left, vw - tipW - 8));

  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
  el.style.transformOrigin = transformOrigin;
}

// ── Show / hide ────────────────────────────────────────────────────────

function _show(trigger, text) {
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
    el.textContent = text;

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
 * @param {HTMLElement} el       Trigger element
 * @param {string}      text     Tooltip label
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
    attachTooltip(el, el.dataset.tooltip);
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
          attachTooltip(node, node.dataset.tooltip);
        }
        // Also scan children
        if (node.querySelectorAll) {
          for (const child of node.querySelectorAll('[data-tooltip]')) {
            if (_tracked.has(child)) continue;
            _tracked.add(child);
            attachTooltip(child, child.dataset.tooltip);
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
