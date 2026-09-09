/**
 * Chat session data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — session listing, deletion,
 * and individual session fetch.
 */

import { apiFetch, fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

// `/chat/sessions` is keyset-paginated: pass the `next_cursor` from the previous
// response to get the following page. Returns {data, has_more, next_cursor}.
// Session deletion. This existed as a server route (DELETE /chat/sessions/{id},
// oss/server/src/chat/routes.rs:28) and as a delete button in the UI, but the
// function connecting them was never written outside a preview fixture — so the
// row disappeared and nothing was sent. See sessions-page.js#deleteSession.
const deleteSession = async (sessionId) => {
  if (!sessionId) throw new Error('deleteSession requires a session id');
  await apiFetch(`/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
};

const fetchSessions = async (_query, limit = 25, cursor = null) => {
  const params = new URLSearchParams({ limit });
  if (cursor) params.set('cursor', cursor);
  return fetchApi(`/chat/sessions?${params}`);
};

const fetchChatSession = async (sessionId) => {
  const encoded = encodeURIComponent(sessionId);
  let page = await fetchApi(`/chat/sessions/${encoded}/messages?limit=500`);
  let messages = page?.data ?? [];
  let cursor = page?.prev_cursor ?? null;
  const seen = new Set();

  for (let count = 0; page?.has_more && cursor && count < 100; count += 1) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    page = await fetchApi(
      `/chat/sessions/${encoded}/messages?limit=500&prev_cursor=${encodeURIComponent(cursor)}`,
    );
    messages = [...(page?.data ?? []), ...messages];
    cursor = page?.prev_cursor ?? null;
  }

  return { data: messages };
};

registerAll({ deleteSession, fetchSessions, fetchChatSession }, { replace: true });
