/**
 * Flow data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — flow listing and detail.
 */

import { fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

const fetchFlows = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', page, limit });
  return fetchApi(`/flows?${params}`);
};

const fetchFlowDetail = async (flowId) => {
  return fetchApi(`/flows/${flowId}`);
};

registerAll({ fetchFlows, fetchFlowDetail }, { replace: true });
