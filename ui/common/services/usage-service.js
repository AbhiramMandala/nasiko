/**
 * Usage and TokenOps data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — usage summary, history,
 * by-agent/model breakdowns, and FinOps dashboard.
 */

import { fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

const fetchUsageSummary = async () => {
  return fetchApi('/usage/summary');
};

// TokenOps dashboard — GET /api/observability/finops/dashboard
const fetchTokenopsDashboard = async (startTime, endTime) => {
  const q = new URLSearchParams();
  if (startTime) q.set('start_time', startTime);
  if (endTime) q.set('end_time', endTime);
  const params = q.size ? `?${q}` : '';
  return fetchApi(`/observability/finops/dashboard${params}`);
};

const fetchUsageHistory = async (days = 7) => {
  return fetchApi(`/usage/history?days=${days}`);
};

const fetchUsageByAgent = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', limit, offset: ((page || 1) - 1) * limit });
  return fetchApi(`/usage/by-agent?${params}`);
};

const fetchUsageByModel = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', limit, offset: ((page || 1) - 1) * limit });
  return fetchApi(`/usage/by-model?${params}`);
};

registerAll({
  fetchUsageSummary, fetchTokenopsDashboard,
  fetchUsageHistory, fetchUsageByAgent, fetchUsageByModel,
}, { replace: true });
