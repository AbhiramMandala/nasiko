/**
 * Theme controller — light / dark / system preference.
 *
 * Ported from Flutter's `theme_controller.dart`. Provides the same
 * three-state toggle cycle: Light → Dark → System → Light.
 *
 * global.css declares `color-scheme: light dark` and `light-dark()` for
 * every semantic token, so with no stored choice the OS preference wins.
 * An explicit choice is persisted in localStorage and pinned as
 * `data-theme` on `<html>` (`:root[data-theme=…]` in global.css overrides
 * `color-scheme`).
 *
 * Importing this module applies the stored choice as a side effect, so any
 * page that loads a component importing it renders with the correct theme
 * on first paint.
 *
 * The inline `<script>` in index.html also restores the theme synchronously
 * before CSS loads, preventing a flash — this module is the authoritative
 * runtime API that matches that boot-time one-liner.
 */

const STORAGE_KEY = 'app-theme';

/** @type {'light'|'dark'|'system'} */
let _current;

/** @type {Set<(theme: 'light'|'dark'|'system') => void>} */
const _listeners = new Set();

/** @type {MediaQueryList|null} */
let _systemMql = null;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Get the current theme preference.
 * @returns {'light'|'dark'|'system'}
 */
export function getTheme() {
  return _current;
}

/**
 * Get the resolved theme (what's actually displayed).
 * 'system' resolves to the OS preference.
 * @returns {'light'|'dark'}
 */
export function getResolvedTheme() {
  if (_current === 'light' || _current === 'dark') return _current;
  return _getSystemPreference();
}

/**
 * Set the theme preference.
 * @param {'light'|'dark'|'system'} theme
 */
export function setTheme(theme) {
  _current = theme;

  if (theme === 'light' || theme === 'dark') {
    localStorage.setItem(STORAGE_KEY, theme);
    document.documentElement.dataset.theme = theme;
  } else {
    localStorage.removeItem(STORAGE_KEY);
    delete document.documentElement.dataset.theme;
  }

  // Notify listeners
  for (const fn of _listeners) {
    try { fn(theme); } catch (e) { console.error('[theme] listener error', e); }
  }
}

/**
 * Toggle cycle: Light → Dark → System → Light.
 * Matches Flutter's `ThemeController.toggleTheme()`.
 * @returns {'light'|'dark'|'system'} The new theme
 */
export function toggleTheme() {
  const cycle = { light: 'dark', dark: 'system', system: 'light' };
  const next = cycle[_current] || 'light';
  setTheme(next);
  return next;
}

/**
 * Subscribe to theme changes.
 * @param {(theme: 'light'|'dark'|'system') => void} fn
 * @returns {() => void} Unsubscribe
 */
export function onThemeChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Whether the currently resolved theme is dark.
 * @returns {boolean}
 */
export function isDark() {
  return getResolvedTheme() === 'dark';
}

// ── Icon/label helpers for UI ───────────────────────────────────────────

/**
 * Label for the current theme state.
 * @returns {string}
 */
export function themeLabel() {
  return { light: 'Light', dark: 'Dark', system: 'System' }[_current] || 'System';
}

/**
 * SVG icon path data for the current theme state.
 * Uses standard Material Symbols paths.
 * @returns {string}
 */
export function themeIcon() {
  return {
    light:  'M12 17q-2.075 0-3.537-1.463T7 12t1.463-3.537T12 7t3.538 1.463T17 12t-1.463 3.538T12 17m-7-4H1v-2h4zm18 0h-4v-2h4zM11 5V1h2v4zm0 18v-4h2v4zM6.4 7.75L3.875 5.325L5.3 3.85l2.4 2.5zm12.3 12.4l-2.4-2.5l1.35-1.425l2.525 2.425zM16.25 6.4l2.425-2.525L20.15 5.3l-2.5 2.4zM3.85 18.7l2.5-2.4l1.425 1.35l-2.425 2.525z',
    dark:   'M12 21q-3.75 0-6.375-2.625T3 12t2.625-6.375T12 3q.35 0 .688.025t.662.075q-1.025.725-1.638 1.888T11.1 7.5q0 2.25 1.575 3.825T16.5 12.9q1.375 0 2.525-.613T20.9 10.65q.05.325.075.662T21 12q0 3.75-2.625 6.375T12 21',
    system: 'M4 20q-.825 0-1.412-.587T2 18V6q0-.825.587-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm0-2h16V6H4v12',
  }[_current] || '';
}

// ── Internal ────────────────────────────────────────────────────────────

function _getSystemPreference() {
  _systemMql ??= window.matchMedia?.('(prefers-color-scheme: dark)');
  return _systemMql?.matches ? 'dark' : 'light';
}

function _init() {
  const stored = localStorage.getItem(STORAGE_KEY);
  _current = (stored === 'light' || stored === 'dark') ? stored : 'system';

  // Apply immediately
  if (_current === 'light' || _current === 'dark') {
    document.documentElement.dataset.theme = _current;
  } else {
    delete document.documentElement.dataset.theme;
  }

  // Listen for OS theme changes — re-notify listeners so components
  // that show the resolved theme update when the system switches.
  _systemMql = window.matchMedia?.('(prefers-color-scheme: dark)');
  _systemMql?.addEventListener?.('change', () => {
    if (_current === 'system') {
      for (const fn of _listeners) {
        try { fn('system'); } catch (e) { console.error('[theme] listener error', e); }
      }
    }
  });
}

// Initialize on import
_init();
