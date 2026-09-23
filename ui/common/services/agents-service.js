/**
 * Agent registry data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — agents, containers, and builds.
 *
 * Two kinds of function live here, and the difference is the signature.
 *
 * `fetchAgents` / `fetchContainers` / `fetchBuilds` take `(query, page,
 * limit)` because that is what `<app-table data-fn>` hands every data
 * function — a table protocol, not the backend's. The backend behind the
 * first two (`GET /api/agents`, `catalog::routes::ListQuery`) reads `limit`
 * and `offset` and has NO search parameter, so `query` is not sent (the
 * caller filters client-side) and `page` is turned into `offset` here. They
 * used to send `q` and `page` verbatim; the backend ignored both, which made
 * every page of the agents table page one. Silent on both sides — the class
 * of bug the data manifest's spec check now exists to catch.
 *
 * `fetchAgentList` / `fetchDeployments` are the Weave-facing sources: the
 * same endpoints, called the way the backend describes them (one options
 * object, the spec's own parameter names) and returned untouched, so the
 * manifest's declared shape IS the spec's response shape and
 * `gen-data-manifest --check` can hold the two to each other. They are
 * registered ahead of any page calling them, same as
 * `fetchFinopsAttributions` was.
 */

import { fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

const DEFAULT_LIMIT = 100;

const fetchAgents = async (query, page, limit) => {
  const l = limit ?? DEFAULT_LIMIT;
  const params = new URLSearchParams({ limit: l, offset: ((page || 1) - 1) * l });
  const agents = await fetchApi(`/agents?${params}`);
  const data = Array.isArray(agents) ? agents : agents.data || [];
  return { data, total: agents.total || data.length };
};

const fetchContainers = async (query, page, limit) => {
  const l = limit ?? DEFAULT_LIMIT;
  const params = new URLSearchParams({ limit: l, offset: ((page || 1) - 1) * l });
  const body = await fetchApi(`/agents?${params}`);
  const data = Array.isArray(body) ? body : (body.data || []);
  return { data, total: body.total || data.length };
};

// GET /api/builds (build::routes::list_all_builds) — not utoipa-annotated
// yet, so its shape cannot be spec-checked; it is exposed to pages only.
const fetchBuilds = async (query, page, limit) => {
  const params = new URLSearchParams({ limit, offset: ((page || 1) - 1) * limit });
  if (query) params.set('q', query);
  return fetchApi(`/builds?${params}`);
};

/** Drop empty params rather than send literal "undefined"/"null" query values. */
function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  return q.size ? `?${q}` : '';
}

// The agent roster — GET /api/agents. Superuser sees all; anyone else sees
// owner ∪ public ∪ granted (`agent_access_predicate`). `status` filters
// server-side; there is no name search on this endpoint, so a search box over
// the roster is a client-side @Filter on `name`, never an argument here.
const fetchAgentList = async ({ status, owner, limit, offset } = {}) => {
  return fetchApi(`/agents${qs({ status, owner, limit, offset })}`);
};

// Live deployments — GET /api/agents/deployments. Newest 50; superuser sees
// all, a deployer sees their own, and anyone below deployer gets
// `{ "available": false }` back with a 200 rather than an error
// (`nasiko_server::unavailable`), so a consumer has to treat a non-array as
// "not for you", not as "none".
const fetchDeployments = async () => {
  return fetchApi('/agents/deployments');
};

registerAll({ fetchAgents, fetchContainers, fetchBuilds, fetchAgentList, fetchDeployments }, { replace: true });
