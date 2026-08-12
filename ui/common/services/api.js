// Single funnel for control-plane API calls.
//
// Every request to /api/* must go through this module so that "session missing
// or expired", timeouts, cancellation, and error shape are handled in exactly
// one place. Do not call window.fetch('/api/...') directly from components.
//
// The auth cookie is HttpOnly — the UI cannot inspect it, so auth state is
// only ever discovered from a server response. A server-side redirect would
// be wrong for API calls (fetch() follows it transparently and hands the
// caller login-page HTML), so the API returns 401 and we navigate the page.
//
// ─── What changed in Phase 1, and why ──────────────────────────────────────
//
// 1. Errors are typed. `fetchApi` used to `throw new Error(await res.text())`,
//    so callers got the raw response body as `err.message` and had no access to
//    the status or to the machine-readable `code` that API_CONVENTIONS.md §2
//    defines. Measured result: `error.code` was read in zero places across the
//    whole UI, and JSON error bodies reached users as literal JSON in toasts.
//    See core/errors.js.
//
// 2. The 401 path settles. It used to `return new Promise(() => {})` — a
//    promise that never resolves — on the reasoning that the page is navigating
//    away anyway. The cost was invisible but real: callers' `finally` blocks
//    never ran, so skeletons stayed up, buttons stayed disabled, and the
//    `loading-end` counterpart to `loading-start` was never dispatched. It now
//    rejects with SessionExpiredError, which `shouldReport()` filters out of
//    user-facing error handling, so cleanup runs and nothing is shown.
//
// 3. Cancellation and deadlines exist. There was no AbortController anywhere in
//    the UI and no timeout, so a hung request hung its component forever and a
//    component removed mid-flight kept writing into detached DOM. Every call
//    now takes an optional `signal` and gets a default deadline.

import {
  ApiError,
  NetworkError,
  SessionExpiredError,
  TimeoutError,
  isAbort,
} from '../core/errors.js';

/// Multi-tenant seam: the BFF dashboard injects
/// `window.nasikoConfig = { apiBase: "https://<sub>.nasiko.dev", ... }` at
/// serve time (docs/MULTITENANT.md §9). Empty/absent = same-origin (single
/// tenant, today's behavior). Resolved per call — never cached — so an
/// in-SPA workspace switch re-points every subsequent request.
function apiBase() {
  return window.nasikoConfig?.apiBase || '';
}

/// Default deadline for a normal request. Generous enough that a slow-but-alive
/// backend still succeeds, short enough that a black-holed connection surfaces
/// as an error the user can act on instead of an indefinite skeleton. Streaming
/// and long-poll callers pass `timeout: 0` to opt out.
const DEFAULT_TIMEOUT_MS = 30_000;

/// Set once we begin navigating away on a 401. Everything in flight will fail;
/// `core/errors.js#shouldReport` and the toast helpers consult this so a
/// screenful of "Failed to load" never flashes on top of a login redirect.
let navigatingAway = false;

/** True while a session-expiry navigation is in progress. */
export function isNavigatingAway() {
  return navigatingAway;
}

/**
 * Compose caller cancellation with our deadline. `AbortSignal.any` is the right
 * primitive and is widely available, but this file has no build step and no
 * polyfill pipeline, so fall back manually rather than assume it.
 *
 * @returns {{ signal: AbortSignal|undefined, cleanup: () => void, timedOut: () => boolean }}
 */
function withDeadline(callerSignal, timeoutMs) {
  if (!timeoutMs) {
    return { signal: callerSignal, cleanup: () => {}, timedOut: () => false };
  }
  const ctrl = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    ctrl.abort();
  }, timeoutMs);

  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort();
    else callerSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => clearTimeout(timer),
    timedOut: () => didTimeout,
  };
}

/**
 * Turn a non-2xx response into a typed ApiError.
 *
 * API_CONVENTIONS.md §2 says errors are always JSON `{error, code}`. Reality
 * includes handlers that return plain text and one route family that returns
 * `{data, status_code, message}`, so parse defensively and record what we got.
 */
async function toApiError(res, { path, method }) {
  const requestId = res.headers.get('x-request-id') || null;
  let message = '';
  let code;
  let details;

  const raw = await res.text().catch(() => '');
  if (raw) {
    try {
      const body = JSON.parse(raw);
      if (body && typeof body === 'object') {
        // `error` per API_CONVENTIONS §2; `message` for the /api/maf and
        // /api/mcp envelope; `error.message` for JSON-RPC (orchestrator a2a).
        message =
          (typeof body.error === 'string' && body.error) ||
          (body.error && typeof body.error.message === 'string' && body.error.message) ||
          (typeof body.message === 'string' && body.message) ||
          '';
        code = body.code ?? body.error?.code ?? undefined;
        details = body.details ?? undefined;
      }
    } catch {
      // Plain-text body. Keep it only if it looks like prose, not markup.
      message = raw.startsWith('<') ? '' : raw.trim();
    }
  }

  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) details = { ...(details && typeof details === 'object' ? details : {}), retryAfter };

  const init = { status: res.status, message: message || res.statusText, code, details, path, method, requestId };
  return res.status === 401 ? new SessionExpiredError(init) : new ApiError(init);
}

/**
 * Begin the session-recovery navigation for a 401, then let the caller's
 * promise reject so cleanup can run.
 *
 * Behaviour is unchanged from before Phase 1 — same redirect-and-return dance,
 * same loop guard — only the promise contract differs.
 */
function beginSessionRecovery() {
  if (navigatingAway) return;
  if (window.location.pathname.startsWith('/login')) return;
  navigatingAway = true;

  const base = apiBase();
  let restart = '/login.html';

  if (base) {
    // A 401 from the workspace control plane means its session cookie is
    // missing or expired. Bootstrap it via redirect-and-return
    // (docs/MULTITENANT.md §4.4): hand the browser to the BFF's /api/enter,
    // which sends it into the workspace's own SSO (silent — the IdP session is
    // live), the CP sets its host-only cookie, and we land back here.
    //
    // Remember the deep link: OIDC returns straight to it via /api/enter's
    // redirect param; GitHub returns to `/`, where the injected restore
    // snippet reads this and replaces to the deep link.
    try {
      sessionStorage.setItem(
        'nasiko:returnTo',
        JSON.stringify({ p: location.pathname + location.search, t: Date.now() }),
      );
    } catch {
      /* storage disabled — still redirect */
    }
    // Loop guard: if an entry attempt just happened and we're STILL 401 (e.g.
    // admission rejected the account), fall back to a full BFF re-auth instead
    // of bouncing through /api/enter forever.
    let lastEnter = 0;
    try {
      lastEnter = +(sessionStorage.getItem('nasiko:enterAt') || 0);
    } catch {
      /* ignore */
    }
    if (Date.now() - lastEnter < 15000) {
      try {
        sessionStorage.removeItem('nasiko:enterAt');
      } catch {
        /* ignore */
      }
    } else {
      try {
        sessionStorage.setItem('nasiko:enterAt', String(Date.now()));
      } catch {
        /* ignore */
      }
      restart = '/api/enter?return_to=' + encodeURIComponent(location.pathname + location.search);
    }
  }
  window.location.href = restart;
}

/**
 * Low-level: performs the request. Returns the raw Response for callers that
 * stream, read text, or branch on status themselves.
 *
 * A 401 starts the login navigation and rejects with SessionExpiredError.
 * Any other non-2xx is returned as-is — this function does not throw on HTTP
 * status, exactly as before, so existing `if (!res.ok)` branches still work.
 *
 * @param {string} path Path relative to `/api` (e.g. `/agents`, not `/api/agents`).
 * @param {RequestInit & { timeout?: number }} [opts]
 *   `timeout` in ms; `0` disables the deadline (use for streaming responses).
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, opts = {}) {
  const base = apiBase();
  const { timeout = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = opts;
  const method = (rest.method || 'GET').toUpperCase();
  const deadline = withDeadline(callerSignal, timeout);

  // Cross-origin CP calls ride the CP's host-only session cookie.
  const init = base ? { credentials: 'include', ...rest } : { ...rest };
  if (deadline.signal) init.signal = deadline.signal;

  let res;
  try {
    res = await fetch(`${base}/api${path}`, init);
  } catch (err) {
    deadline.cleanup();
    if (deadline.timedOut()) throw new TimeoutError(timeout, { path, method });
    if (isAbort(err)) throw err; // caller cancelled on purpose — propagate as-is
    throw new NetworkError(err?.message, { cause: err, path, method });
  }
  deadline.cleanup();

  if (res.status === 401) {
    beginSessionRecovery();
    throw await toApiError(res, { path, method });
  }
  return res;
}

/**
 * Convenience: JSON out, throws a typed ApiError on any non-2xx.
 *
 * Note this does NOT serialize a request body — historically it never did, and
 * 200+ call sites hand-write `headers`/`body`. Use `postJson`/`patchJson`/
 * `putJson` below for that; they exist precisely so nobody has to retype the
 * `Content-Type` + `JSON.stringify` pair again.
 *
 * @template T
 * @param {string} path
 * @param {RequestInit & { timeout?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function fetchApi(path, opts = {}) {
  const res = await apiFetch(path, opts);
  if (!res.ok) throw await toApiError(res, { path, method: (opts.method || 'GET').toUpperCase() });
  if (res.status === 204) return /** @type {T} */ (undefined);
  const text = await res.text();
  if (!text) return /** @type {T} */ (undefined);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ApiError({
      status: res.status,
      message: 'Server returned a malformed JSON body',
      code: 'malformed_response',
      details: { snippet: text.slice(0, 200) },
      path,
      method: (opts.method || 'GET').toUpperCase(),
    });
  }
}

/** JSON body helper — sets the header and stringifies exactly once, here. */
function jsonInit(method, body, opts = {}) {
  return {
    ...opts,
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** @template T @returns {Promise<T>} */
export const getJson = (path, opts) => fetchApi(path, opts);
/** @template T @returns {Promise<T>} */
export const postJson = (path, body, opts) => fetchApi(path, jsonInit('POST', body, opts));
/** @template T @returns {Promise<T>} */
export const patchJson = (path, body, opts) => fetchApi(path, jsonInit('PATCH', body, opts));
/** @template T @returns {Promise<T>} */
export const putJson = (path, body, opts) => fetchApi(path, jsonInit('PUT', body, opts));
/** @template T @returns {Promise<T>} */
export const deleteJson = (path, opts) => fetchApi(path, { ...opts, method: 'DELETE' });

/**
 * Open a streaming response (SSE-over-POST, as used by the A2A dispatch route).
 * Deadline is disabled — a stream is expected to stay open — so the caller MUST
 * pass a `signal` and abort it in `disconnectedCallback`.
 *
 * @param {string} path
 * @param {RequestInit & { signal: AbortSignal }} opts
 * @returns {Promise<Response>}
 */
export async function openStream(path, opts) {
  if (!opts?.signal) {
    throw new TypeError(
      'openStream requires an AbortSignal — abort it in disconnectedCallback, ' +
        'or the reader keeps pulling into detached DOM after the component is gone.',
    );
  }
  const res = await apiFetch(path, { ...opts, timeout: 0 });
  if (!res.ok) throw await toApiError(res, { path, method: (opts.method || 'POST').toUpperCase() });
  return res;
}

/** The injectable API surface. Components receive this via `keys.api`. */
export const api = Object.freeze({
  raw: apiFetch,
  json: fetchApi,
  get: getJson,
  post: postJson,
  patch: patchJson,
  put: putJson,
  del: deleteJson,
  stream: openStream,
  base: apiBase,
  isNavigatingAway,
});
