/**
 * MAF workflow data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — workflow CRUD, execution
 * listing, and AI-powered workflow generation.
 *
 * Every MAF response uses the {data, status_code, message} envelope; list
 * endpoints additionally wrap the rows as data:{data:[...], total} (total is
 * the page length, not the true total).
 */

import { apiFetch, fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

// `mafs.status` is 'draft' | 'active' | 'deleted'; deleted rows never reach a
// read path, so anything that isn't a draft is deployed. Rows from older
// callers that carry no status at all read as deployed.
export const isDeployed = (wf) => (wf.status ?? 'active') !== 'draft';

const mafRows = (body) =>
  (Array.isArray(body?.data) ? body.data : body?.data?.data) || [];

const fetchWorkflows = async (limit = 100, offset = 0) => {
  return mafRows(await fetchApi(`/maf/workflows?limit=${limit}&offset=${offset}`));
};

const fetchWorkflow = async (id) => {
  return (await fetchApi(`/maf/workflow/${encodeURIComponent(id)}`)).data;
};

// Everything that BEGAN as a draft, promoted ones included — the Drafts tab
// filters those back out with `isDeployed`.
const fetchDrafts = async (limit = 100, offset = 0) => {
  return mafRows(await fetchApi(`/maf/workflow/drafts?limit=${limit}&offset=${offset}`));
};

// Pass `draft_id` to overwrite the row a previous save returned instead of
// piling up a new draft each time. 404 = that draft was deleted or promoted,
// so the caller should drop the id and save again as a new one.
const saveDraft = async (body) => {
  return (await fetchApi('/maf/workflow/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).data;
};

// Draft → runnable workflow. Keeps the same id, so every link to the draft
// stays valid. Slow (decomposer + per-step routing) and rate-limited to 10/min.
const promoteWorkflow = async (id) => {
  return (await fetchApi(`/maf/workflow/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
  })).data;
};

const createWorkflow = async (body) => {
  return (await fetchApi('/maf/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).data;
};

const updateWorkflow = async (id, body) => {
  return (await fetchApi(`/maf/workflow/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).data;
};

const deleteWorkflow = async (id) => {
  return fetchApi(`/maf/workflow/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

const runWorkflow = async (id) => {
  // 202 Accepted → data: {execution_id, execution_number, execution_count}
  return (await fetchApi(`/maf/workflow/${encodeURIComponent(id)}/run`, { method: 'POST' })).data;
};

const fetchExecution = async (id) => {
  return (await fetchApi(`/maf/execution/${encodeURIComponent(id)}`)).data;
};

const fetchWorkflowExecutions = async (id, limit = 50, offset = 0) => {
  return mafRows(await fetchApi(
    `/maf/workflow/${encodeURIComponent(id)}/executions?limit=${limit}&offset=${offset}`,
  ));
};

const fetchAllExecutions = async (limit = 100, offset = 0) => {
  return mafRows(await fetchApi(`/maf/executions?limit=${limit}&offset=${offset}`));
};

// The create page branches on the failure mode (503 = no LLM key configured,
// 400 = user has no agents, 422 = planner failure), so surface the status.
const generateWorkflow = async (description) => {
  const res = await apiFetch('/maf/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body?.data;
};

registerAll({
  fetchWorkflows, fetchWorkflow, fetchDrafts, saveDraft, promoteWorkflow,
  createWorkflow, updateWorkflow, deleteWorkflow,
  runWorkflow, fetchExecution, fetchWorkflowExecutions, fetchAllExecutions,
  generateWorkflow,
}, { replace: true });
