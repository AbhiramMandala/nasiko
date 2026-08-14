/**
 * Agent registry data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — agents, containers, and builds.
 */

import { fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

const fetchAgents = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', page, limit });
  const agents = await fetchApi(`/agents?${params}`);
  return { data: Array.isArray(agents) ? agents : agents.data || [], total: agents.total || agents.length };
};

const fetchContainers = async (query, page, limit) => {
  const params = new URLSearchParams({ limit, offset: ((page || 1) - 1) * limit });
  if (query) params.set('q', query);
  const body = await fetchApi(`/agents?${params}`);
  const data = Array.isArray(body) ? body : (body.data || []);
  return { data, total: body.total || data.length };
};

const fetchBuilds = async (query, page, limit) => {
  const params = new URLSearchParams({ limit, offset: ((page || 1) - 1) * limit });
  if (query) params.set('q', query);
  return fetchApi(`/builds?${params}`);
};

registerAll({ fetchAgents, fetchContainers, fetchBuilds }, { replace: true });
