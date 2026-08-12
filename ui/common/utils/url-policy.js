/**
 * What is allowed to appear in a URL.
 *
 * The memo names this a must-resolve with a policy fix rather than a library
 * fix, and the reasoning is worth keeping next to the code: a URL is copied,
 * saved, put in browser history, captured in a shared screenshot, recorded in a
 * screen recording, and written to a third party's access log the moment a page
 * loads one image or script from outside. In-memory state is none of those
 * things. So anything placed in a query string should be treated as if a
 * stranger could read it.
 *
 * Today's usage is fine — pages write only opaque IDs and a tab name. This file
 * exists so that stays true as pages get added, and so a violation is caught by
 * a failing check rather than by a customer.
 *
 * Enforcement is two-layered:
 *   1. This module, at runtime in dev: `setSearchParams` refuses to write a
 *      param that is not on the allowlist and logs loudly.
 *   2. `scripts/ui-lint.mjs` (Phase 6), statically: flags `location.search`
 *      writes and `URLSearchParams.set` calls with a literal key that is not
 *      registered here.
 *
 * The technical backstop for what leaks *out* is the `Referrer-Policy:
 * same-origin` header, set server-side in `oss/server/src/lib.rs`.
 */

import { violation } from '../core/env.js';

/**
 * Params any page may write. Keep this list short and keep every entry opaque:
 * an ID, an enum, a page number. Never a name, an email, a free-text query, a
 * token, or anything a human typed.
 *
 * Derived from an audit of what pages already write, so adopting this file is
 * not a behaviour change.
 */
export const ALLOWED_PARAMS = Object.freeze({
  // Entity identifiers — opaque UUIDs, already used by these pages.
  id: 'Entity UUID (agent, workflow, build, flow, trace).',
  agent_id: 'Agent UUID.',
  agent_name: 'Agent slug — not user-authored free text.',
  session_id: 'Chat session UUID (A2A contextId).',
  context_id: 'A2A context UUID.',
  trace_id: 'Trace UUID.',
  span_id: 'Span UUID.',
  exec: 'Workflow execution UUID.',
  name: 'Registry artifact slug — opaque, not a person or customer name.',
  owner: 'Registry namespace slug.',
  // View state — enums and small integers.
  tab: 'Active tab key (enum, declared by the page).',
  page: 'Page number (integer).',
  period: 'Chart period enum (24h | 7d | 30d).',
  // Auth/return plumbing owned by the server, not by page code.
  return_to: 'Server-owned post-auth redirect path.',
  token: 'Server-owned SSO handoff (Flutter mount only — do not add new uses).',
  run_error: 'Opaque error key for a failed workflow run.',
});

/**
 * Params that must never appear, with the reason. Checked before the allowlist
 * so a typo like `q` cannot be waved through by adding it to the allowlist
 * without a conversation.
 */
export const FORBIDDEN_PARAMS = Object.freeze({
  q: 'Free-text search. Keep search terms in memory; they are user-authored content.',
  query: 'Free-text search — see `q`.',
  search: 'Free-text search — see `q`.',
  filter: 'May contain free text. Encode as an enum, or keep in memory.',
  email: 'Personal data.',
  user: 'Personal data — use an opaque UUID.',
  username: 'Personal data — use an opaque UUID.',
  password: 'Never.',
  secret: 'Never.',
  api_key: 'Never.',
  access_token: 'Never — the session lives in an HttpOnly cookie by design.',
  jwt: 'Never.',
  prompt: 'User-authored content.',
  message: 'User-authored content.',
});

/**
 * Validate one param name. Returns `null` when acceptable, else the reason.
 * @param {string} name
 * @returns {string|null}
 */
export function checkParam(name) {
  const key = String(name);
  if (key in FORBIDDEN_PARAMS) {
    return `"${key}" must never appear in a URL: ${FORBIDDEN_PARAMS[key]}`;
  }
  if (!(key in ALLOWED_PARAMS)) {
    return (
      `"${key}" is not an allowed URL param. Add it to ALLOWED_PARAMS in ` +
      `/common/utils/url-policy.js with a one-line justification, and only if the ` +
      `value is opaque (an ID, an enum, an integer) — never user-authored text.`
    );
  }
  return null;
}

/**
 * Write view state into the address bar, policy-checked.
 *
 * Uses `replaceState` by default: a filter or tab change is not a navigation
 * the Back button should have to walk through.
 *
 * @param {Record<string, string|number|null|undefined>} params
 *   Keys with `null`/`undefined`/`''` are removed.
 * @param {{ push?: boolean, url?: URL }} [opts]
 */
export function setSearchParams(params, { push = false, url = new URL(location.href) } = {}) {
  for (const [name, value] of Object.entries(params)) {
    const problem = checkParam(name);
    if (problem) {
      // Loud in dev, skipped-but-recorded in production: a policy slip should
      // fail the developer who introduced it, not the customer's page.
      violation(`[url-policy] ${problem}`);
      continue;
    }
    if (value === null || value === undefined || value === '') url.searchParams.delete(name);
    else url.searchParams.set(name, String(value));
  }
  const next = url.pathname + (url.searchParams.size ? `?${url.searchParams}` : '') + url.hash;
  history[push ? 'pushState' : 'replaceState'](history.state, '', next);
  return next;
}

/**
 * Read allowed params as a plain object. Unknown params are ignored rather than
 * returned, so a page cannot accidentally start honouring something a link
 * smuggled in.
 *
 * @param {string[]} names
 * @param {string} [search]
 * @returns {Record<string, string>}
 */
export function readSearchParams(names, search = location.search) {
  const sp = new URLSearchParams(search);
  const out = {};
  for (const name of names) {
    if (checkParam(name)) continue;
    const v = sp.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}
