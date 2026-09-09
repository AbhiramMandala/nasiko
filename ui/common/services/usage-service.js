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

// `page`/`limit` are optional — a caller that omits them (e.g. a dashboard's
// first render, before any pagination control exists) used to serialize the
// literal strings "undefined"/"NaN" into the query string, which the real
// backend's `i64` deserializer always 400s on. Default to a full first page.
const DEFAULT_PAGE_LIMIT = 20;

// `??` (not a default param) so an explicit `null` — e.g. `Query(..., [null,
// null])` to skip both positionally — is defaulted too, not just an omitted
// (`undefined`) argument.
const fetchUsageByAgent = async (query, page, limit) => {
  const p = page ?? 1;
  const l = limit ?? DEFAULT_PAGE_LIMIT;
  const params = new URLSearchParams({ q: query || '', limit: l, offset: (p - 1) * l });
  return fetchApi(`/usage/by-agent?${params}`);
};

const fetchUsageByModel = async (query, page, limit) => {
  const p = page ?? 1;
  const l = limit ?? DEFAULT_PAGE_LIMIT;
  const params = new URLSearchParams({ q: query || '', limit: l, offset: (p - 1) * l });
  return fetchApi(`/usage/by-model?${params}`);
};

registerAll({
  fetchUsageSummary, fetchTokenopsDashboard,
  fetchUsageHistory, fetchUsageByAgent, fetchUsageByModel,
}, { replace: true });
