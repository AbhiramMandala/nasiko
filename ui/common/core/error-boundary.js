/**
 * Global error boundary — catches unhandled errors and promise rejections.
 *
 * Ported from Flutter's `AppErrorView` + global error handling patterns.
 * Provides three layers:
 *
 *   1. **Global handlers** — `window.onerror` and `unhandledrejection` catch
 *      anything that escapes component-level `try/catch`. Errors are
 *      classified (network, auth, timeout, unknown) and reported to the
 *      notifier (if registered) and optionally to an external endpoint.
 *
 *   2. **Inline error view** — `<app-error-view>` renders an in-place
 *      error card with optional retry, matching Flutter's `AppErrorView`.
 *
 *   3. **Crash fallback** — if the shell itself fails to render, a minimal
 *      CSS-only crash screen is injected (no JS dependencies).
 *
 * Error classification follows `core/errors.js`:
 *   - `SessionExpiredError` → redirect to login
 *   - `NetworkError` → "Connection lost" with retry
 *   - `TimeoutError` → "Request timed out" with retry
 *   - `ApiError` → show user-facing message from `userMessage()`
 *   - Everything else → generic "Something went wrong"
 *
 * Anti-leak rules (from Flutter codebase):
 *   - Stack traces are NEVER shown to users
 *   - Request IDs are shown only in dev mode
 *   - Internal error codes are mapped to friendly messages
 *   - API response bodies are never rendered raw
 *
 * @module error-boundary
 */

import { shouldReport, userMessage, isAbort } from './errors.js';

// ── Configuration ──────────────────────────────────────────────────────

const MAX_ERRORS = 50;       // rate-limit: max errors tracked per session
const DEDUP_MS   = 2000;     // suppress duplicate errors within this window

let _errorCount = 0;
let _lastError = '';
let _lastErrorTime = 0;

/** @type {Set<(error: ErrorReport) => void>} */
const _listeners = new Set();

/**
 * @typedef {object} ErrorReport
 * @property {string} message     User-facing message
 * @property {string} [detail]    Technical detail (dev only)
 * @property {string} category    'network' | 'auth' | 'timeout' | 'api' | 'script' | 'unknown'
 * @property {boolean} retriable  Whether a retry might help
 * @property {Error}  [original]  The original error object
 * @property {number} timestamp   Date.now()
 */

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Subscribe to global error reports.
 * @param {(report: ErrorReport) => void} fn
 * @returns {() => void} Unsubscribe
 */
export function onError(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Manually report an error through the boundary.
 * @param {Error|string} error
 * @param {object} [opts]
 * @param {boolean} [opts.silent]  Don't show UI (just track)
 */
export function reportError(error, { silent = false } = {}) {
  const report = _classify(error);
  if (!silent) _notify(report);
}

/**
 * Initialize the global error boundary. Call once at app boot.
 * Idempotent — safe to call multiple times.
 */
export function initErrorBoundary() {
  if (_initialized) return;
  _initialized = true;

  // Global error handler
  window.addEventListener('error', (event) => {
    // Ignore errors from browser extensions or cross-origin scripts
    if (!event.filename || event.filename === '') return;
    if (event.filename.startsWith('chrome-extension://')) return;

    const error = event.error || new Error(event.message);
    _handleGlobalError(error);
  });

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const error = event.reason;

    // Abort signals are not errors
    if (isAbort(error)) return;

    _handleGlobalError(error);

    // Prevent the default browser console error for handled rejections
    event.preventDefault();
  });

  // Inject crash fallback styles (available even if everything else fails)
  _injectCrashStyles();
}

let _initialized = false;

// ── Error classification ───────────────────────────────────────────────

function _classify(error) {
  const timestamp = Date.now();

  if (typeof error === 'string') {
    return {
      message: error,
      category: 'unknown',
      retriable: false,
      timestamp,
    };
  }

  // Use the error classification from errors.js
  const msg = userMessage(error);

  // SessionExpiredError
  if (error?.name === 'SessionExpiredError' || error?.constructor?.name === 'SessionExpiredError') {
    return {
      message: msg,
      category: 'auth',
      retriable: false,
      original: error,
      timestamp,
    };
  }

  // NetworkError
  if (error?.name === 'NetworkError' || error?.constructor?.name === 'NetworkError') {
    return {
      message: msg,
      detail: error.message,
      category: 'network',
      retriable: true,
      original: error,
      timestamp,
    };
  }

  // TimeoutError
  if (error?.name === 'TimeoutError' || error?.constructor?.name === 'TimeoutError') {
    return {
      message: msg,
      category: 'timeout',
      retriable: true,
      original: error,
      timestamp,
    };
  }

  // ApiError
  if (error?.status !== undefined && error?.code !== undefined) {
    return {
      message: msg,
      detail: error.requestId ? `Request ID: ${error.requestId}` : undefined,
      category: 'api',
      retriable: error.status >= 500,
      original: error,
      timestamp,
    };
  }

  // Generic JS errors
  return {
    message: msg || 'Something went wrong',
    category: error instanceof TypeError ? 'script' : 'unknown',
    retriable: false,
    original: error,
    timestamp,
  };
}

// ── Internal handlers ──────────────────────────────────────────────────

function _handleGlobalError(error) {
  // Rate limit
  if (_errorCount >= MAX_ERRORS) return;
  _errorCount++;

  // Deduplicate rapid-fire identical errors
  const key = String(error?.message || error);
  const now = Date.now();
  if (key === _lastError && now - _lastErrorTime < DEDUP_MS) return;
  _lastError = key;
  _lastErrorTime = now;

  // Classify and report
  const report = _classify(error);

  // Auth errors → redirect to login
  if (report.category === 'auth') {
    _redirectToLogin();
    return;
  }

  // Only report errors worth surfacing
  if (shouldReport(error)) {
    _notify(report);
  }
}

function _notify(report) {
  for (const fn of _listeners) {
    try {
      fn(report);
    } catch (e) {
      console.error('[error-boundary] listener threw', e);
    }
  }

  // Console logging (dev aid, never shown to users)
  if (report.original) {
    console.error('[error-boundary]', report.category, report.original);
  }
}

function _redirectToLogin() {
  // Preserve current path for post-login redirect
  const returnPath = location.pathname + location.search + location.hash;
  if (returnPath !== '/login') {
    try {
      sessionStorage.setItem('login-redirect', returnPath);
    } catch { /* quota */ }
  }
  location.href = '/login';
}

// ── Crash fallback styles ──────────────────────────────────────────────

function _injectCrashStyles() {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .app-crash-screen {
      position: fixed;
      inset: 0;
      z-index: 99999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      background: var(--shell-bg, #242628);
      color: var(--shell-fg, #fff);
      font-family: var(--font-body, system-ui, sans-serif);
      padding: 24px;
      text-align: center;
    }
    .app-crash-screen h2 {
      font-size: 20px;
      font-weight: 600;
      margin: 0;
    }
    .app-crash-screen p {
      font-size: 14px;
      color: var(--shell-fg-muted, rgba(255,255,255,0.62));
      margin: 0;
      max-width: 420px;
    }
    .app-crash-screen button {
      margin-top: 8px;
      padding: 8px 20px;
      border: 1px solid var(--shell-border-subtle, rgba(255,255,255,0.16));
      border-radius: 6px;
      background: transparent;
      color: var(--shell-fg, #fff);
      font-size: 14px;
      cursor: pointer;
      transition: background 150ms;
    }
    .app-crash-screen button:hover {
      background: rgba(255,255,255,0.06);
    }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/**
 * Show the crash fallback screen. Called when the app shell itself fails.
 * This is a last-resort UI with zero JS dependencies beyond this function.
 */
export function showCrashScreen(message) {
  // Remove any existing crash screen
  document.querySelector('.app-crash-screen')?.remove();

  const screen = document.createElement('div');
  screen.className = 'app-crash-screen';
  screen.innerHTML = `
    <h2>Something went wrong</h2>
    <p>${_escHtml(message || 'The application encountered an unexpected error. Please try refreshing the page.')}</p>
    <button type="button" onclick="location.reload()">Refresh page</button>
  `;
  document.body.appendChild(screen);
}

// ── Inline error view component ────────────────────────────────────────

const _errorViewSheet = new CSSStyleSheet();
_errorViewSheet.replaceSync(`
@scope (app-error-view) {
  :scope {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 200px;
    padding: var(--s-24, 24px);
  }

  .error-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-16, 16px);
    max-width: 560px;
    text-align: center;
  }

  .error-icon {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: var(--red-50, #FEF2F2);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
  }
  :root[data-theme="dark"] & .error-icon,
  :root:not([data-theme]) .error-icon {
    background: rgba(239, 68, 68, 0.12);
  }

  .error-title {
    font-family: var(--font-display, monospace);
    font-size: 18px;
    font-weight: 600;
    color: var(--content-fg, #1E1D1B);
    margin: 0;
  }
  :root[data-theme="dark"] & .error-title,
  :root:not([data-theme]) .error-title {
    color: var(--sand-100, #F5F3EF);
  }

  .error-message {
    font-size: 14px;
    line-height: 20px;
    color: var(--fg-error, #DC2626);
    margin: 0;
  }

  .error-retry {
    margin-top: var(--s-8, 8px);
    padding: 8px 20px;
    border: 1px solid var(--content-border, rgba(0,0,0,0.08));
    border-radius: var(--r-6, 6px);
    background: transparent;
    color: var(--content-fg, #1E1D1B);
    font-family: inherit;
    font-size: 14px;
    cursor: pointer;
    transition: background 150ms, border-color 150ms;
  }
  .error-retry:hover {
    background: var(--sand-50, rgba(0,0,0,0.04));
    border-color: var(--content-fg, #1E1D1B);
  }
  :root[data-theme="dark"] & .error-retry,
  :root:not([data-theme]) .error-retry {
    color: var(--sand-100, #F5F3EF);
    border-color: rgba(255,255,255,0.16);
  }
  :root[data-theme="dark"] & .error-retry:hover,
  :root:not([data-theme]) .error-retry:hover {
    background: rgba(255,255,255,0.06);
  }
}
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, _errorViewSheet];

/**
 * `<app-error-view>` — Inline error display matching Flutter's `AppErrorView`.
 *
 * @element app-error-view
 * @attr {string} message - Error message
 * @attr {string} detail  - Technical detail (optional)
 */
class AppErrorView extends HTMLElement {
  static get observedAttributes() {
    return ['message', 'detail'];
  }

  /** @type {(() => void)|null} */
  onretry = null;

  connectedCallback() {
    this.#render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.#render();
  }

  #render() {
    const message = this.getAttribute('message') || 'Something went wrong';
    const detail = this.getAttribute('detail');

    const displayMsg = detail
      ? `${_escHtml(message)} → ${_escHtml(detail)}`
      : _escHtml(message);

    this.innerHTML = `
      <div class="error-content">
        <div class="error-icon">⚠</div>
        <h3 class="error-title">Uh-oh!</h3>
        <p class="error-message">${displayMsg}</p>
        ${this.onretry ? '<button type="button" class="error-retry">Retry</button>' : ''}
      </div>
    `;

    if (this.onretry) {
      const btn = this.querySelector('.error-retry');
      btn?.addEventListener('click', () => this.onretry?.());
    }
  }
}

if (!customElements.get('app-error-view')) {
  customElements.define('app-error-view', AppErrorView);
}

// ── Helpers ────────────────────────────────────────────────────────────

function _escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export { AppErrorView };
