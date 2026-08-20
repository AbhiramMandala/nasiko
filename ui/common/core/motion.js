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
/** Page transition (fade-through + drift) — total wall time of a page swap. */
export const PAGE    = 300;
/** First leg of a page swap: the outgoing page fades out. */
export const PAGE_EXIT_MS  = 90;
/** Second leg: the incoming page fades in + drifts up, starting at PAGE_EXIT_MS. */
export const PAGE_ENTER_MS = PAGE - PAGE_EXIT_MS;
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
 * Fade-through, sequenced rather than cross-faded: the outgoing page owns the
 * first PAGE_EXIT_MS, the incoming page starts when it has finished. They must
 * not overlap — both pages are painted in the same box, so any overlap draws
 * the incoming content on top of content that is still leaving.
 *
 * Exit:  fade out (1→0) over PAGE_EXIT_MS with exit easing.
 * Enter: fade in (0→1) + translate up 8px over PAGE_ENTER_MS with emphasized
 *        easing, delayed by PAGE_EXIT_MS.
 *
 * Used by the router's View Transitions API integration. These constants and
 * the `::view-transition-*(page-content)` rules injected by
 * `injectMotionStyles()` describe the same animation — change both together.
 */
export const PAGE_ENTER_KEYFRAMES = [
  { opacity: 0, transform: 'translateY(8px)' },
  { opacity: 1, transform: 'translateY(0)' },
];
export const PAGE_EXIT_KEYFRAMES = [
  { opacity: 1 },
  { opacity: 0 },
];

export const PAGE_ENTER_OPTIONS = {
  duration: PAGE_ENTER_MS,
  easing: EASE_EMPHASIZED,
  fill: 'both',
  delay: PAGE_EXIT_MS,
};
export const PAGE_EXIT_OPTIONS = {
  duration: PAGE_EXIT_MS,
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
      --motion-page-exit:  ${PAGE_EXIT_MS}ms;
      --motion-page-enter: ${PAGE_ENTER_MS}ms;
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
        --motion-page-exit:  0ms;
        --motion-page-enter: 0ms;
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

    /* ── View Transitions ───────────────────────────────────────
       Two different transitions share these pseudo-elements:

       - Cross-document, opted into by \`@view-transition { navigation: auto }\`
         in common/global.css. A real document swap, so animating the \`root\`
         group is right: everything on screen genuinely is being replaced.
       - Same-document, driven by the router's \`startViewTransition\`
         (core/router.js). Here the shell, the rail and the white content card
         are the same elements before and after — only the page element inside
         \`main#outlet\` changes.

       The router marks its own swaps with \`.vt-page-swap\` on the document
       element so the two can be told apart. They could not be before, so an
       in-app navigation ran the cross-document rules: \`root\` is a snapshot of
       the entire viewport, opaque content card included, and animating it slid
       and cross-faded the card itself over its own previous state instead of
       animating anything inside it. */

    /* Cross-document — the whole viewport drifts and fades. */
    ::view-transition-old(root) {
      animation: motion-page-exit var(--motion-page) var(--ease-exit) both;
    }
    ::view-transition-new(root) {
      animation: motion-page-enter var(--motion-page) var(--ease-emphasized) both;
      animation-delay: calc(var(--motion-page) * 0.25);
    }

    /* Same-document — the shell holds still. \`root\` is still captured (the
       header and the module nav lift themselves out of it with their own names
       in global.css), but frozen, so the only thing that moves is the page
       element the router named below. \`mix-blend-mode: normal\` because a
       frozen pair must not be blended: \`plus-lighter\` on two fully opaque
       halves washes the card out for the length of the transition. */
    :root.vt-page-swap::view-transition-old(root),
    :root.vt-page-swap::view-transition-new(root) {
      animation: none;
      mix-blend-mode: normal;
    }

    /* The routed page.

       \`animation: none\` on the group suppresses the default size/position
       morph — two pages of different heights should fade, not stretch into
       each other.

       Exit and enter are sequenced, not overlapped. The rules this replaced
       ran a 300ms exit against a 300ms enter delayed by 75ms, so for 225ms
       both pages were painted in the same box at partial opacity. That double
       exposure is what reads as the next screen printing over one that has not
       finished leaving, and it is most obvious switching between secondary-nav
       items inside a module, where the two layouts land in almost the same
       place. Now the outgoing page is fully gone at --motion-page-exit and the
       incoming one starts there. */
    ::view-transition-group(page-content) {
      animation: none;
    }
    ::view-transition-old(page-content) {
      animation: motion-fade-out var(--motion-page-exit) var(--ease-exit) both;
      mix-blend-mode: normal;
    }
    ::view-transition-new(page-content) {
      animation: motion-page-enter var(--motion-page-enter) var(--ease-emphasized) var(--motion-page-exit) both;
      mix-blend-mode: normal;
    }

    @media (prefers-reduced-motion: reduce) {
      ::view-transition-old(root),
      ::view-transition-new(root),
      ::view-transition-old(page-content),
      ::view-transition-new(page-content) {
        animation: none;
      }
    }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

// Auto-inject on import
injectMotionStyles();
