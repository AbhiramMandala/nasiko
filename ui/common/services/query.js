/**
 * Paginated / searchable list fetching, in one place.
 *
 * The memo's first DRY finding: the same few lines — build a query string,
 * convert a 1-based page to an offset, call the shared fetch helper, normalise
 * the envelope — are retyped by hand nine times for the query-string part
 * alone, across just under fifty functions in one file. That is not a style
 * complaint. It means a bug in how pagination or search is built has to be
 * found and fixed in every copy, and an agent asked to "add a filter" has to
 * find and correctly repeat the pattern rather than call one function that
 * already does it right.
 *
 * `listFetcher()` is that one function. Every `data-fn` should be built with it.
 *
 * ─── The envelope contract, settled ────────────────────────────────────────
 * `smart-table` and `data-view` read `response.data` and `response.total`, and
 * also accept a bare array. Their own JSDoc claimed `{items, total}`; `items`
 * was never read by either component. CONTROL_PLANE_UI.md §"Data" was right.
 * This module always produces `{ data, total }`, so the ambiguity is gone at
 * the source rather than being re-litigated per call site.
 */

import { fetchApi } from './api.js';

/**
 * @typedef {object} ListResult
 * @property {any[]} data   The rows.
 * @property {number} total Total matching rows on the server (pre-pagination).
 */

/**
 * Build a query string from a plain object, dropping empty values.
 *
 * Empty-dropping is the part every hand-written copy got subtly differently:
 * some sent `q=`, some omitted it, and the server treats those differently for
 * some routes. One behaviour, defined here: `null`, `undefined` and `''` are
 * omitted; `0` and `false` are sent.
 *
 * @param {Record<string, unknown>} params
 * @returns {string} Including the leading `?`, or `''` when there is nothing to send.
 */
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Convert the `(query, page, limit)` triple that `data-fn` is called with into
 * the `limit`/`offset` pair the API expects.
 *
 * `page` is 1-based by convention — `smart-table` starts at 1 — and a missing
 * or bogus page must not produce `offset=NaN`, which is what a couple of the
 * hand-written copies did when called with `undefined`.
 *
 * @param {number} [page]
 * @param {number} [limit]
 */
export function pageToRange(page, limit) {
  const safeLimit = Number.isFinite(+limit) && +limit > 0 ? Math.floor(+limit) : 10;
  const safePage = Number.isFinite(+page) && +page > 0 ? Math.floor(+page) : 1;
  return { limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

/**
 * Normalise whatever a route returned into `{ data, total }`.
 *
 * Three server shapes exist in this codebase and each is documented at its
 * call site today: `{data,total}` (most), `{teams,total}` / `{departments,total}`
 * (org routes), and a bare array (`/infra/clusters`). Rather than each service
 * module reimplementing the unwrap — which produced four spellings of the same
 * three lines — name the collection key once via `collection`.
 *
 * @param {unknown} body
 * @param {string} [collection] Key holding the array, when it isn't `data`.
 * @returns {ListResult}
 */
export function normalizeList(body, collection) {
  if (Array.isArray(body)) return { data: body, total: body.length };
  if (!body || typeof body !== 'object') return { data: [], total: 0 };
  // Server shapes vary by route (see the doc comment above); `any` here is the
  // honest description of an unvalidated response body, and every read below is
  // guarded by Array.isArray or ??.
  const b = /** @type {any} */ (body);
  const rows =
    (collection && Array.isArray(b[collection]) && b[collection]) ||
    (Array.isArray(b.data) && b.data) ||
    // `items` is not a shape any component reads, but a couple of routes emit
    // it; accept it here so nobody is tempted to "fix" a component instead.
    (Array.isArray(b.items) && b.items) ||
    [];
  const total =
    b.total ??
    b.total_count ?? // API_CONVENTIONS §1 canonical name; no component read it before
    rows.length;
  return { data: rows, total: Number(total) || 0 };
}

/**
 * Build a `data-fn`-compatible list fetcher.
 *
 * ```js
 * export const fetchAgents = listFetcher('/agents');
 * export const fetchTeams  = listFetcher('/teams', { collection: 'teams' });
 * export const fetchFlows  = listFetcher('/flows', {
 *   // Extra server-side filters, resolved per call.
 *   params: () => ({ status: currentStatus.get() }),
 * });
 * ```
 *
 * The returned function has the exact signature the table components call:
 * `(query, page, limit, opts?) => Promise<{data, total}>`. The optional 4th
 * argument carries an `AbortSignal`, so a superseded search keystroke cancels
 * its in-flight request instead of racing it.
 *
 * @param {string} path API path relative to `/api`.
 * @param {object} [options]
 * @param {string} [options.collection]      Key holding the array, if not `data`.
 * @param {string} [options.searchParam='q'] Query-string name for the search term.
 * @param {Record<string, unknown>|(() => Record<string, unknown>)} [options.params]
 *   Extra params, static or resolved per call.
 * @param {(rows: any[]) => any[]} [options.mapRows] Row transform (shape adaptation only — no filtering).
 * @param {number} [options.timeout]
 */
export function listFetcher(path, options = {}) {
  const { collection, searchParam = 'q', params, mapRows, timeout } = options;

  /**
   * @param {string} [query]
   * @param {number} [page] 1-based.
   * @param {number} [limit]
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<ListResult>}
   */
  return async function fetchList(query, page, limit, { signal } = {}) {
    const range = pageToRange(page, limit);
    const extra = typeof params === 'function' ? params() : params || {};
    const search = qs({ ...range, [searchParam]: query, ...extra });
    const body = await fetchApi(`${path}${search}`, { signal, timeout });
    const result = normalizeList(body, collection);
    return mapRows ? { data: mapRows(result.data), total: result.total } : result;
  };
}

/**
 * Build a cursor-paginated fetcher.
 *
 * API_CONVENTIONS.md §1 specifies cursor pagination "from day one" with
 * `has_more` / `next_cursor`, while CONTROL_PLANE_UI.md codifies `limit`+
 * `offset` and the code is offset-based everywhere except one `next_cursor`
 * read in `sessions-page`. That conflict is real and unresolved; this helper
 * exists so that routes which genuinely are cursor-based have somewhere correct
 * to live, instead of each growing its own partial handling.
 *
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.collection]
 * @param {number} [options.limit=25]
 */
export function cursorFetcher(path, options = {}) {
  const { collection, limit: defaultLimit = 25 } = options;

  /**
   * @param {{ cursor?: string|null, limit?: number, signal?: AbortSignal }} [opts]
   */
  return async function fetchPage({ cursor = null, limit = defaultLimit, signal } = {}) {
    const body = await fetchApi(`${path}${qs({ limit, cursor })}`, { signal });
    const { data } = normalizeList(body, collection);
    return {
      data,
      nextCursor: body?.next_cursor ?? null,
      prevCursor: body?.prev_cursor ?? null,
      hasMore: body?.has_more ?? Boolean(body?.next_cursor),
    };
  };
}

/**
 * Fetch a single entity by id. Trivial, but it removes the last reason for a
 * service module to import `fetchApi` directly and hand-build a path.
 *
 * @param {string} path Base path, e.g. `/agents`.
 */
export function detailFetcher(path) {
  /**
   * @param {string} id
   * @param {{ signal?: AbortSignal, params?: Record<string, unknown> }} [opts]
   */
  return (id, { signal, params } = {}) =>
    fetchApi(`${path}/${encodeURIComponent(id)}${qs(params || {})}`, { signal });
}
