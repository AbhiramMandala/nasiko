/**
 * Typed error model for the control-plane UI.
 *
 * Why this exists: `fetchApi` used to `throw new Error(await res.text())`, so
 * every caller received the raw response *body* as `err.message` and had no
 * access to the status or the machine-readable `code` that
 * `oss/docs/API_CONVENTIONS.md` §2 defines. The measurable result was that
 * `error.code` was read in exactly zero places across ~48k LOC of UI, and a
 * JSON error body reached the user as a literal JSON string in a toast.
 *
 * Everything here is plain ES2022 — no dependencies, safe to import from any
 * layer including the legacy non-Lit components.
 */

/** Wire shape produced by the server: `{ error: string, code?: string, details?: unknown }`. */
export class ApiError extends Error {
  /**
   * @param {object} init
   * @param {number} init.status        HTTP status.
   * @param {string} init.message       Human-readable message (server `error`, or a fallback).
   * @param {string} [init.code]        Stable machine slug (server `code`) — switch on this, never on `message`.
   * @param {unknown} [init.details]    Optional structured payload from the server.
   * @param {string} [init.path]        Request path, for logs.
   * @param {string} [init.method]      Request method, for logs.
   * @param {string} [init.requestId]   `x-request-id` if the server sent one.
   */
  constructor({ status, message, code, details, path, method, requestId }) {
    super(message || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? null;
    this.details = details ?? null;
    this.path = path ?? null;
    this.method = method ?? 'GET';
    this.requestId = requestId ?? null;
  }

  /** 4xx that the user could plausibly fix by changing input. */
  get isClientError() {
    return this.status >= 400 && this.status < 500;
  }

  get isNotFound() {
    return this.status === 404;
  }

  get isForbidden() {
    return this.status === 403;
  }

  /** 5xx, or a gateway/timeout status — retrying may help. */
  get isRetryable() {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }

  /** Seconds the server asked us to wait, if it sent `Retry-After`. */
  get retryAfterSeconds() {
    return this.details && typeof this.details === 'object' && 'retryAfter' in this.details
      ? Number(this.details.retryAfter) || null
      : null;
  }
}

/**
 * The session cookie is missing or expired. The API layer navigates the page
 * when this happens, but it now *also* rejects with this error so that callers'
 * `finally` blocks run (clearing skeletons, re-enabling buttons, dispatching
 * `loading-end`). Previously the 401 path returned a promise that never
 * settled, which stranded every one of those cleanup paths mid-flight.
 *
 * Do not surface this to the user — the page is already leaving. `shouldReport`
 * returns false for it.
 */
export class SessionExpiredError extends ApiError {
  constructor(init) {
    super({ ...init, message: init?.message || 'Session expired' });
    this.name = 'SessionExpiredError';
  }
}

/** The request never reached the server (offline, DNS, TLS, CORS preflight). */
export class NetworkError extends Error {
  /**
   * @param {string} [message]
   * @param {{ cause?: unknown, path?: string, method?: string }} [opts]
   */
  constructor(message, { cause, path, method } = {}) {
    super(message || 'Network request failed');
    this.name = 'NetworkError';
    this.cause = cause ?? null;
    this.path = path ?? null;
    this.method = method ?? 'GET';
    this.status = 0;
    this.code = 'network_error';
  }

  get isRetryable() {
    return true;
  }
}

/** Our own deadline fired before the server answered. */
export class TimeoutError extends Error {
  /**
   * @param {number} ms
   * @param {{ path?: string, method?: string }} [opts]
   */
  constructor(ms, { path, method } = {}) {
    super(`Request timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = ms;
    this.path = path ?? null;
    this.method = method ?? 'GET';
    this.status = 0;
    this.code = 'timeout';
  }

  get isRetryable() {
    return true;
  }
}

/**
 * True when a rejection is an intentional cancellation rather than a failure —
 * an `AbortController` we aborted ourselves, e.g. from `disconnectedCallback`
 * or a superseded search keystroke. Never toast these.
 */
export function isAbort(err) {
  return (
    err instanceof DOMException
      ? err.name === 'AbortError'
      : err?.name === 'AbortError' || err?.code === 'ABORT_ERR'
  );
}

/**
 * Whether an error is worth showing the user at all. Cancellations and
 * session-expiry are both invisible by design: one is us, the other is a
 * navigation already in progress.
 */
export function shouldReport(err) {
  return !isAbort(err) && !(err instanceof SessionExpiredError);
}

/**
 * The string to put in front of a user. Prefers the server's message, falls
 * back to something status-shaped, and never leaks a raw JSON body or a stack.
 *
 * @param {unknown} err
 * @param {string} [fallback] Copy to use when we have nothing specific.
 */
export function userMessage(err, fallback = 'Something went wrong. Please try again.') {
  if (!err) return fallback;
  if (err instanceof TimeoutError) return 'That took too long to respond. Please try again.';
  if (err instanceof NetworkError) return "Couldn't reach the server. Check your connection.";
  if (err instanceof ApiError) {
    if (err.isNotFound) return 'Not found.';
    if (err.isForbidden) return "You don't have access to that.";
    if (err.status === 429) return 'Too many requests — please wait a moment.';
    if (err.status >= 500) return 'The server had a problem. Please try again.';
    // A message the server wrote for a human is better than anything generic,
    // but a JSON blob or a stack trace is not — those are a server bug, and
    // showing them to a user is worse than showing the fallback.
    const m = (err.message || '').trim();
    if (m && m.length <= 300 && !m.startsWith('{') && !m.startsWith('<')) return m;
    return fallback;
  }
  const m = ((/** @type {any} */ (err).message) || String(err)).trim();
  return m && m.length <= 300 && !m.startsWith('{') && !m.startsWith('<') ? m : fallback;
}
