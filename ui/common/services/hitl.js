/**
 * Human-in-the-loop (HITL) requests — the one API family that answers every
 * kind of agent pause.
 *
 * Every origin (MCP tool gate, direct chat, agent proxy, orchestrator, MAF)
 * resolves through the same four routes, and the request body depends only on
 * `kind`, never on `origin`. See FRONTEND_HITL_API_CONTRACT.md §6.
 *
 * Two things about this route family differ from the rest of the API and are
 * handled here rather than at every call site:
 *
 *  - **Responses are bare DTOs**, not the `{data, status_code, message}`
 *    envelope. Nothing unwraps `.data`.
 *  - **Errors are plain text.** `toApiError` in api.js already keeps a
 *    plain-text body as the message, so callers still get a typed `ApiError`
 *    and branch on `err.status` — 403 not yours, 404 gone, 409 the row reached
 *    a different terminal state (expired) before the click landed.
 */

import { apiFetch, fetchApi } from './api.js';

const path = (id, suffix = '') => `/hitl/${encodeURIComponent(id)}${suffix}`;

/** Full DTO for one row. Used to hydrate a stream frame, which carries only a subset. */
export function getHitl(id, opts = {}) {
  return fetchApi(path(id), opts);
}

/**
 * Record the human's decision. Body by `kind`:
 *   tool_approval  { decision: 'approve'|'reject', scope?: 'once'|'session', note? }
 *   auth_required  { auth_action: 'start'|'confirm' }   // 'start' leaves it pending
 *   input_required { answer: string }                   // non-empty after trim
 *
 * Resolving does not deliver the answer synchronously — reconnect (§20) is how
 * you see what the resumed agent actually does. A duplicate call is a 200 with
 * `already_resolved: true`, so this is safe to retry.
 */
export function resolveHitl(id, body, opts = {}) {
  return fetchApi(path(id, '/resolve'), {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(body),
  });
}

/** Withdraw a pending request. No resume is triggered — the agent is never answered. */
export function cancelHitl(id, opts = {}) {
  return fetchApi(path(id, '/cancel'), { ...opts, method: 'POST' });
}

/**
 * Attach to the events a resume produced, through the normal chat endpoint.
 *
 * Resume happens server-side, decoupled from any browser connection, so there
 * is nothing to poll for: this replays the real events already produced and
 * then live-tails, ending either in the reply or in a *new* `hitl` frame. Read
 * it with `readA2aStream`. Never triggers a second call to the agent, so it is
 * safe to retry and safe from two tabs at once.
 *
 * Always pass the id you just resolved — reconnecting with an earlier id in a
 * chain only ever replays that row's own resume (§20.5).
 *
 * @returns {Promise<Response>} the SSE response, for `readA2aStream`
 */
export function reconnectAfterHitl(id, { signal } = {}) {
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  return apiFetch('/orchestrator/a2a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // A reconnect carries no new user message, and no agent_id/session_id:
    // `reconnect_after_hitl_id` is the only thing that identifies it.
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: uuid(),
      method: 'message/stream',
      params: {
        message: { messageId: uuid(), role: 'ROLE_USER', parts: [] },
        metadata: { reconnect_after_hitl_id: id },
      },
    }),
    timeout: 0,
    signal,
  });
}

/**
 * Connector display name + logo for one agent, keyed by connector id.
 *
 * Identity only: a `tool_approval` question carries a connector *id* and a raw
 * tool slug, never a label. Never gates a card — a prompt with no connector
 * metadata still renders with the humanised slug and a letter avatar.
 */
export async function agentConnectors(agentId, opts = {}) {
  const body = await fetchApi(`/mcp/agents/${encodeURIComponent(agentId)}/connectors`, opts);
  const list = body?.data?.connectors || body?.data || [];
  return new Map(list
    .filter((c) => c && c.id)
    .map((c) => [c.id, { name: c.name || c.display_name, logo_url: c.logo_url }]));
}

/** The rows on a session-load response that still need an answer, oldest first. */
export function pendingRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.status === 'pending');
}

/**
 * Who a tool belongs to, best available answer first:
 *
 *  1. `question.connector_name` (+ `connector_logo_url`) — `tool_approval`
 *     carries its own display name, authoritative and free.
 *  2. `known` — the per-agent connector list, for rows without one.
 *  3. `question.connector` — `auth_required` only, and a *slug* (`github`),
 *     not a display name, so it is capitalised rather than shown raw.
 *
 * Null when the question names no connector at all. Deliberately does NOT fall
 * back to `connector_id`: that is a UUID, and "Create an issue from
 * 3341ca58-0c5f-…" reads worse than dropping the phrase and showing a generic
 * icon, which is what the card does with a null.
 *
 * @param {object|null} question the row's `question` payload
 * @param {Map<string, {name?: string, logo_url?: string|null}>} [known]
 */
export function connectorFor(question, known = new Map()) {
  if (question?.connector_name) {
    return { name: question.connector_name, logo_url: question.connector_logo_url || null };
  }
  const listed = question?.connector_id ? known.get(question.connector_id) : null;
  if (listed?.name) return { name: listed.name, logo_url: listed.logo_url || null };

  const slug = question?.connector;
  if (!slug) return null;
  return { name: slug.charAt(0).toUpperCase() + slug.slice(1), logo_url: null };
}

/**
 * `LINEAR_GET_PROJECT` + connector `Linear` -> `Get project from Linear`.
 *
 * The DTO carries the raw tool slug and the connector id, never a display
 * label, and §8.4's per-connector tool list would be a second round-trip for
 * one description. Deriving it locally renders immediately and is right for
 * every slug the gateway actually emits (`CONNECTOR_VERB_NOUN`).
 */
export function toolLabel(slug, connectorName) {
  if (!slug) return connectorName || 'a tool';
  let words = String(slug).split(/[_\s]+/).filter(Boolean);
  const prefix = (connectorName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (words.length > 1 && prefix && words[0].toUpperCase() === prefix) words = words.slice(1);
  const phrase = words.join(' ').toLowerCase();
  const pretty = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return connectorName ? `${pretty} from ${connectorName}` : pretty;
}

/** How many detail rows a card will render, and how much of each value. */
const MAX_DETAIL_ROWS = 8;
const MAX_DETAIL_CHARS = 200;

/**
 * `question.metadata` as label/value pairs for the card's detail table.
 *
 * The contract puts no size cap on `question.metadata` — an LLM-driven agent
 * can nest its whole tool-call history there, and it rides on every stream
 * frame. So: own keys only, primitives only, capped in both directions. A
 * nested object is summarised, never walked.
 */
export function detailRows(question) {
  const meta = question && typeof question.metadata === 'object' ? question.metadata : null;
  if (!meta) return [];
  return Object.entries(meta)
    .slice(0, MAX_DETAIL_ROWS)
    .map(([key, value]) => {
      const label = key.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
      if (value == null) return [label, '—'];
      if (typeof value === 'object') return [label, Array.isArray(value) ? `${value.length} items` : 'details'];
      return [label, String(value).slice(0, MAX_DETAIL_CHARS)];
    });
}
