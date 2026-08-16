/**
 * Motion system — timing tokens, easing curves, and animation utilities.
 *
 * Ported from Flutter's `core/motion/app_motion.dart` and `app_transitions.dart`.
 * Every duration and curve lives as a CSS custom property so components can use
 * them in `transition:` shorthand, and as JS constants for imperative animation
 * (e.g. staggered list reveals where you need `delay = index * BASE`).
 *
 * Reduced-motion: the media query `prefers-reduced-motion: reduce` collapses
 * every duration to near-zero via a single `:root` override — components don't
 * need to check it individually.
 *
 * Token naming follows the Flutter source exactly so grepping for "motion.fast"
 * or "motion.page" finds both the Dart and JS definitions.
 */

// ── Duration tokens (ms) ────────────────────────────────────────────────

/** Tap/press response — immediate feedback. */
export const PRESSED = 100;
/** Hover highlight. */
export const HOVER   = 120;
/** Micro-interactions: chip appear, icon swap. */
export const FAST    = 150;
/** Default — input focus, toggle, tooltip fade. */
export const BASE    = 200;
/** Panel slide / sidebar resize. */
export const PANEL   = 250;
/** Page transition (fade-through + drift). */
export const PAGE    = 300;
/** Shimmer skeleton loop. */
export const SHIMMER = 1300;

// ── Easing curves (CSS cubic-bezier) ────────────────────────────────────

/** Content entering the screen — decelerating. */
export const EASE_ENTER = 'cubic-bezier(0.33, 1, 0.68, 1)';       // easeOutCubic
/** Content leaving the screen — accelerating. */
export const EASE_EXIT  = 'cubic-bezier(0.32, 0, 0.67, 0)';       // easeInCubic
/** In-place movement (expand, resize). */
export const EASE_MOVE  = 'cubic-bezier(0.65, 0, 0.35, 1)';       // easeInOutCubic
/** Emphasized (Material 3) — hero transitions, page morph. */
export const EASE_EMPHASIZED = 'cubic-bezier(0.2, 0, 0, 1)';

// ── Transition shorthands ───────────────────────────────────────────────

/**
 * Build a CSS `transition` value from token names.
 *
 * @param {string|string[]} properties  CSS property name(s) to transition
 * @param {number}          [ms=BASE]   Duration in milliseconds
 * @param {string}          [easing]    CSS timing function (defaults to EASE_MOVE)
 * @param {number}          [delay=0]   Delay in milliseconds
 * @returns {string} A CSS transition value, e.g. "width 200ms cubic-bezier(…)"
 *
 * @example
 *   el.style.transition = transition('width', PANEL, EASE_MOVE);
 *   el.style.transition = transition(['opacity', 'transform'], PAGE, EASE_ENTER);
 */
export function transition(properties, ms = BASE, easing = EASE_MOVE, delay = 0) {
  const props = Array.isArray(properties) ? properties : [properties];
  const d = delay ? ` ${delay}ms` : '';
  return props.map(p => `${p} ${ms}ms ${easing}${d}`).join(', ');
}

// ── Page transition (fade-through + upward drift) ───────────────────────

/**
 * The standard page-swap animation matching Flutter's `AppTransitions.page()`.
 *
 * Enter: fade in (0→1) + translate up 8px, over 300ms with emphasized easing,
 *        starting at 25% of the total duration.
 * Exit: fade out (1→0) over the first 40% with exit easing.
 *
 * Used by the router's View Transitions API integration. The keyframes are
 * also available as CSS (injected by `injectMotionStyles()`).
 */
export const PAGE_ENTER_KEYFRAMES = [
  { opacity: 0, transform: 'translateY(8px)' },
  { opacity: 1, transform: 'translateY(0)' },
];
export const PAGE_EXIT_KEYFRAMES = [
  { opacity: 1, transform: 'translateY(0)' },
  { opacity: 0, transform: 'translateY(-4px)' },
];

export const PAGE_ENTER_OPTIONS = {
  duration: PAGE,
  easing: EASE_EMPHASIZED,
  fill: 'both',
  delay: PAGE * 0.25,
};
export const PAGE_EXIT_OPTIONS = {
  duration: PAGE * 0.4,
  easing: EASE_EXIT,
  fill: 'both',
};

// ── Dialog transition (fade + scale) ────────────────────────────────────

export const DIALOG_ENTER_KEYFRAMES = [
  { opacity: 0, transform: 'scale(0.96)' },
  { opacity: 1, transform: 'scale(1)' },
];
export const DIALOG_EXIT_KEYFRAMES = [
  { opacity: 1, transform: 'scale(1)' },
  { opacity: 0, transform: 'scale(0.96)' },
];
export const DIALOG_OPTIONS = { duration: BASE, easing: EASE_ENTER, fill: 'both' };

// ── Reveal animation (fade + slide + size) ──────────────────────────────

/**
 * Show/hide a child with fade + slide + size animation, matching Flutter's
 * `AppReveal`. Keeps the last content visible during exit for a smooth
 * out-transition (no flash to empty).
 *
 * @param {HTMLElement} el       Element to animate
 * @param {boolean}     visible  Target visibility
 * @param {object}      [opts]
 * @param {'vertical'|'horizontal'} [opts.axis='vertical']
 * @param {number}      [opts.slideOffset=0.06]  Fraction of element size
 * @param {number}      [opts.duration=PANEL]
 * @returns {Animation|null}
 */
export function reveal(el, visible, { axis = 'vertical', slideOffset = 0.06, duration = PANEL } = {}) {
  if (!el) return null;

  // Reduced motion — instant show/hide
  if (prefersReducedMotion()) {
    el.style.display = visible ? '' : 'none';
    el.style.opacity = visible ? '1' : '0';
    return null;
  }

  const prop = axis === 'vertical' ? 'translateY' : 'translateX';
  const sign = axis === 'vertical' ? -1 : -1;
  const offset = `${sign * slideOffset * 100}%`;

  if (visible) {
    el.style.display = '';
    return el.animate(
      [
        { opacity: 0, transform: `${prop}(${offset})` },
        { opacity: 1, transform: `${prop}(0)` },
      ],
      { duration, easing: EASE_ENTER, fill: 'forwards' },
    );
  }

  const anim = el.animate(
    [
      { opacity: 1, transform: `${prop}(0)` },
      { opacity: 0, transform: `${prop}(${offset})` },
    ],
    { duration, easing: EASE_EXIT, fill: 'forwards' },
  );
  anim.onfinish = () => { el.style.display = 'none'; };
  return anim;
}

// ── Stagger utility ─────────────────────────────────────────────────────

/**
 * Stagger-reveal a list of elements (fade in + slide up).
 *
 * @param {HTMLElement[]} elements
 * @param {object} [opts]
 * @param {number} [opts.stagger=50]    Delay between items (ms)
 * @param {number} [opts.duration=BASE]
 * @param {number} [opts.offset=8]      Slide distance (px)
 */
export function staggerReveal(elements, { stagger = 50, duration = BASE, offset = 8 } = {}) {
  if (prefersReducedMotion()) {
    for (const el of elements) { el.style.opacity = '1'; el.style.transform = ''; }
    return;
  }
  for (let i = 0; i < elements.length; i++) {
    elements[i].animate(
      [
        { opacity: 0, transform: `translateY(${offset}px)` },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration, delay: i * stagger, easing: EASE_ENTER, fill: 'forwards' },
    );
  }
}

// ── Reduced-motion query ────────────────────────────────────────────────

let _mql;
/** @returns {boolean} */
export function prefersReducedMotion() {
  _mql ??= window.matchMedia?.('(prefers-reduced-motion: reduce)');
  return _mql?.matches ?? false;
}

// ── CSS injection ───────────────────────────────────────────────────────

let _injected = false;

/**
 * Inject the motion CSS custom properties and keyframes onto the document.
 * Idempotent — safe to call from multiple modules.
 *
 * Called automatically when this module is imported, so components can
 * reference `var(--motion-base)` without ceremony.
 */
export function injectMotionStyles() {
  if (_injected) return;
  _injected = true;

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :root {
      /* ── Motion duration tokens ── */
      --motion-pressed: ${PRESSED}ms;
      --motion-hover:   ${HOVER}ms;
      --motion-fast:    ${FAST}ms;
      --motion-base:    ${BASE}ms;
      --motion-panel:   ${PANEL}ms;
      --motion-page:    ${PAGE}ms;
      --motion-shimmer: ${SHIMMER}ms;

      /* ── Easing curves ── */
      --ease-enter:      ${EASE_ENTER};
      --ease-exit:       ${EASE_EXIT};
      --ease-move:       ${EASE_MOVE};
      --ease-emphasized: ${EASE_EMPHASIZED};

      /* ── Composed transitions (shorthand aliases) ── */
      --t-fast:  ${FAST}ms ${EASE_MOVE};
      --t-base:  ${BASE}ms ${EASE_MOVE};
      --t-panel: ${PANEL}ms ${EASE_MOVE};
      --t-page:  ${PAGE}ms ${EASE_EMPHASIZED};
    }

    /* Reduced motion: collapse durations to near-instant */
    @media (prefers-reduced-motion: reduce) {
      :root {
        --motion-pressed: 0ms;
        --motion-hover:   0ms;
        --motion-fast:    0ms;
        --motion-base:    0ms;
        --motion-panel:   0ms;
        --motion-page:    0ms;
        --motion-shimmer: 0ms;

        --t-fast:  0ms ${EASE_MOVE};
        --t-base:  0ms ${EASE_MOVE};
        --t-panel: 0ms ${EASE_MOVE};
        --t-page:  0ms ${EASE_EMPHASIZED};
      }
    }

    /* ── Page transition keyframes ── */
    @keyframes motion-page-enter {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes motion-page-exit {
      from { opacity: 1; transform: translateY(0); }
      to   { opacity: 0; transform: translateY(-4px); }
    }

    /* ── Dialog keyframes ── */
    @keyframes motion-dialog-enter {
      from { opacity: 0; transform: scale(0.96); }
      to   { opacity: 1; transform: scale(1); }
    }
    @keyframes motion-dialog-exit {
      from { opacity: 1; transform: scale(1); }
      to   { opacity: 0; transform: scale(0.96); }
    }

    /* ── Reveal keyframes (vertical) ── */
    @keyframes motion-reveal-in {
      from { opacity: 0; transform: translateY(-6%); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes motion-reveal-out {
      from { opacity: 1; transform: translateY(0); }
      to   { opacity: 0; transform: translateY(-6%); }
    }

    /* ── Fade-through (cross-fade with stagger) ── */
    @keyframes motion-fade-in  { from { opacity: 0; } to { opacity: 1; } }
    @keyframes motion-fade-out { from { opacity: 1; } to { opacity: 0; } }

    /* ── Shimmer skeleton pulse ── */
    @keyframes motion-shimmer {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.35; }
    }

    /* ── Popover entry (4px drop) ── */
    @keyframes motion-popover-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ── Spinner delayed appearance (150ms) ── */
    @keyframes motion-spinner-in {
      0%   { opacity: 0; }
      100% { opacity: 1; }
    }

    /* View Transition API overrides — page swap uses our tokens */
    ::view-transition-old(root) {
      animation: motion-page-exit var(--motion-page) var(--ease-exit) both;
    }
    ::view-transition-new(root) {
      animation: motion-page-enter var(--motion-page) var(--ease-emphasized) both;
      animation-delay: calc(var(--motion-page) * 0.25);
    }

    @media (prefers-reduced-motion: reduce) {
      ::view-transition-old(root),
      ::view-transition-new(root) {
        animation: none;
      }
    }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

// Auto-inject on import
injectMotionStyles();
