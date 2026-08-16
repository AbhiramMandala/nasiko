/**
 * Responsive breakpoint system.
 *
 * Ported from Flutter's `core/responsive/breakpoints.dart` and
 * `clamped_screen_util.dart`. Provides named breakpoints, media-query
 * matchers, and a `responsive()` helper that picks a value for the current
 * viewport width — the same API shape as the Flutter `ResponsiveContext`
 * extension, but in plain JS.
 *
 * CSS custom properties for each breakpoint are injected onto `:root` so
 * stylesheets can use `@media (min-width: var(--bp-md))` via container
 * queries or direct comparison.
 *
 * Design reference dimensions (for clamped scaling):
 *   width: 1512   height: 1024
 *   UI scale clamp: 0.85 – 1.12
 */

// ── Breakpoint tokens (px) ──────────────────────────────────────────────

export const BP = Object.freeze({
  xs:   480,
  sm:   768,
  md:   1024,
  lg:   1280,
  xl:   1536,
  xxl:  1920,
  max:  2560,
});

// ── Content constraints ─────────────────────────────────────────────────

/** Max width for form-heavy content (login, settings, create forms). */
export const FORM_CONTENT_MAX_WIDTH = 840;
/** Max width for full-page content (dashboards, tables). */
export const PAGE_CONTENT_MAX_WIDTH = 1600;

// ── Card grid metrics (from Flutter's ui_helpers.dart) ──────────────────

export const CARD_GRID = Object.freeze({
  gap: 20,
  minItemWidth: 148,
  /**
   * Column count for a given viewport width.
   * @param {number} width
   * @returns {number}
   */
  columns(width) {
    if (width >= 2080) return 5;
    if (width >= 1500) return 4;
    if (width >= 640) return 3;
    if (width >= 400) return 2;
    return 1;
  },
  /**
   * Horizontal padding for a given viewport width.
   * @param {number} width
   * @returns {number}
   */
  padding(width) {
    if (width >= 1500) return 120;
    if (width >= 900) return 80;
    if (width >= 600) return 40;
    return 20;
  },
});

// ── Clamped UI scaling ──────────────────────────────────────────────────

const DESIGN_WIDTH = 1512;
const SCALE_MIN = 0.85;
const SCALE_MAX = 1.12;

/**
 * Compute a clamped UI scale factor for the given viewport width.
 * Returns a value between 0.85 and 1.12, with 1.0 at the design
 * reference width of 1512px.
 *
 * @param {number} [viewportWidth]
 * @returns {number}
 */
export function uiScale(viewportWidth) {
  const w = viewportWidth ?? window.innerWidth;
  const raw = w / DESIGN_WIDTH;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, raw));
}

// ── Media query matchers ────────────────────────────────────────────────

/** @type {Map<string, MediaQueryList>} */
const _mqls = new Map();

/**
 * Get a cached `MediaQueryList` for a named breakpoint.
 * @param {'xs'|'sm'|'md'|'lg'|'xl'|'xxl'|'max'} name
 * @returns {MediaQueryList}
 */
function mql(name) {
  if (!_mqls.has(name)) {
    _mqls.set(name, window.matchMedia(`(min-width: ${BP[name]}px)`));
  }
  return _mqls.get(name);
}

/** True when viewport width is below `xs` (480px). */
export function isXs()      { return !mql('xs').matches; }
/** True when below `sm` (768px) — phone-class. */
export function isCompact() { return !mql('sm').matches; }
/** True when between `sm` and `md` — tablet-class. */
export function isTablet()  { return mql('sm').matches && !mql('md').matches; }
/** True when at or above `md` (1024px). */
export function isDesktop() { return mql('md').matches; }
/** True when at or above `xl` (1536px). */
export function isWide()    { return mql('xl').matches; }

/**
 * Pick a value based on the current viewport width.
 * Mirrors Flutter's `context.responsive<T>()`.
 *
 * @template T
 * @param {T} base                    Default / mobile-first value
 * @param {object} [overrides]
 * @param {T} [overrides.xs]          ≥ 480px
 * @param {T} [overrides.sm]          ≥ 768px
 * @param {T} [overrides.md]          ≥ 1024px
 * @param {T} [overrides.lg]          ≥ 1280px
 * @param {T} [overrides.xl]          ≥ 1536px
 * @param {T} [overrides.xxl]         ≥ 1920px
 * @returns {T}
 */
export function responsive(base, overrides = {}) {
  const w = window.innerWidth;
  const order = ['xxl', 'xl', 'lg', 'md', 'sm', 'xs'];
  for (const bp of order) {
    if (overrides[bp] !== undefined && w >= BP[bp]) return overrides[bp];
  }
  return base;
}

/**
 * Watch a breakpoint boundary. Calls `fn(matches)` immediately and on
 * every cross.
 *
 * @param {'xs'|'sm'|'md'|'lg'|'xl'|'xxl'|'max'} name
 * @param {(matches: boolean) => void} fn
 * @returns {() => void} Cleanup function
 */
export function onBreakpoint(name, fn) {
  const q = mql(name);
  const handler = (e) => fn(e.matches);
  q.addEventListener('change', handler);
  fn(q.matches);
  return () => q.removeEventListener('change', handler);
}

// ── CSS injection ───────────────────────────────────────────────────────

let _injected = false;

/**
 * Inject responsive CSS custom properties and utility classes.
 * Idempotent — safe to call from multiple modules.
 */
export function injectResponsiveStyles() {
  if (_injected) return;
  _injected = true;

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :root {
      /* ── Breakpoint tokens ── */
      --bp-xs:  ${BP.xs}px;
      --bp-sm:  ${BP.sm}px;
      --bp-md:  ${BP.md}px;
      --bp-lg:  ${BP.lg}px;
      --bp-xl:  ${BP.xl}px;
      --bp-xxl: ${BP.xxl}px;
      --bp-max: ${BP.max}px;

      /* ── Content constraints ── */
      --form-content-max-width: ${FORM_CONTENT_MAX_WIDTH}px;
      --page-content-max-width: ${PAGE_CONTENT_MAX_WIDTH}px;

      /* ── Card grid ── */
      --card-grid-gap: ${CARD_GRID.gap}px;
      --card-grid-min-item: ${CARD_GRID.minItemWidth}px;
    }

    /* ── Responsive visibility utilities ── */
    .hide-below-sm { display: none; }
    .hide-below-md { display: none; }
    .hide-below-lg { display: none; }

    @media (min-width: ${BP.sm}px) {
      .hide-below-sm { display: revert; }
      .show-below-sm { display: none; }
    }

    @media (min-width: ${BP.md}px) {
      .hide-below-md { display: revert; }
      .show-below-md { display: none; }
    }

    @media (min-width: ${BP.lg}px) {
      .hide-below-lg { display: revert; }
      .show-below-lg { display: none; }
    }

    /* ── Card grid auto-layout ── */
    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(${CARD_GRID.minItemWidth}px, 1fr));
      gap: ${CARD_GRID.gap}px;
    }

    @media (min-width: ${BP.xl}px) {
      .card-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
    }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

// Auto-inject on import
injectResponsiveStyles();
