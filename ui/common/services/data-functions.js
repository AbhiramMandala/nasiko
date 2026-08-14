/**
 * Shared data functions for every control-plane page, in both editions.
 *
 * These 378 lines used to live in `oss/ui/web/navigation.js` and were duplicated
 * verbatim into `ee/ui/web/navigation.js` — 450 of that file's 662 lines were an
 * exact copy. The duplication existed for a structural reason, documented in the
 * EE file's own header: `EeAssets` is resolved before `OssAssets`, and EE has no
 * HTML override for index/agents/settings/etc., so those pages load the *OSS*
 * `navigation.js`. Before the copy existed, the post-login landing page silently
 * lost every EE org nav item. Duplicating the whole file was the only way to make
 * the higher-priority overlay layer win.
 *
 * The cost of that fix was not the duplication itself but that the copy could
 * drift, and it did: `fetchTraceDetail` diverged, and the EE version spread the
 * response *envelope* instead of the trace, leaving `project_session_id`
 * undefined. Since that field is the only thing its one consumer reads, every
 * `/session-trace.html?trace_id=…` link dead-ended on EE with "This trace isn't
 * linked to a session yet" instead of redirecting. A single shared copy plus a
 * narrow extension seam (`/nav-ext.js`) removes the whole failure mode.
 *
 * All functions are registered with `core/data-sources.js` via `registerAll` at
 * the end of this file. Components resolve them through `call()` / `resolve()`.
 * Phase 3B splits this file by domain — it is deliberately a verbatim move for
 * now, so the diff that eliminates the fork is mechanical and reviewable.
 */

import { apiFetch, fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

const fetchAgents = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', page, limit });
  const agents = await fetchApi(`/agents?${params}`);
  return { data: Array.isArray(agents) ? agents : agents.data || [], total: agents.total || agents.length };
};

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

const fetchContainers = async (query, page, limit) => {
  const params = new URLSearchParams({ limit, offset: ((page || 1) - 1) * limit });
  if (query) params.set('q', query);
  const body = await fetchApi(`/agents?${params}`);
  const data = Array.isArray(body) ? body : (body.data || []);
  return { data, total: body.total || data.length };
};

const fetchFlows = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', page, limit });
  return fetchApi(`/flows?${params}`);
};

const fetchFlowDetail = async (flowId) => {
  return fetchApi(`/flows/${flowId}`);
};

// ── MAF workflows — /api/maf/* (oss/server/src/maf.rs) ───────────────────────
// Every response uses the {data, status_code, message} envelope; list
// endpoints additionally wrap the rows as data:{data:[...], total} (total is
// the page length, not the true total).
const mafRows = (body) =>
  (Array.isArray(body?.data) ? body.data : body?.data?.data) || [];

const fetchWorkflows = async (limit = 100, offset = 0) => {
  return mafRows(await fetchApi(`/maf/workflows?limit=${limit}&offset=${offset}`));
};

const fetchWorkflow = async (id) => {
  return (await fetchApi(`/maf/workflow/${encodeURIComponent(id)}`)).data;
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

const fetchTraceDetail = async (traceId) => {
  // Server route: GET /api/observability/trace/{id} (same as `nasiko observe trace`).
  // Envelope {data:{trace}}; trace.spans is a nested tree (children embedded).
  const resp = await fetchApi(`/observability/trace/${traceId}`);
  return resp.data?.trace ?? resp.trace ?? resp;
};

// Observability — execution history + per-session traces (see /api/docs)
// Paged: every row costs the server one trace-store lookup, so asking for the
// whole history is what made Execution history slow to appear.
const fetchObservabilitySessions = async (limit = 25, offset = 0) => {
  const params = new URLSearchParams({ limit, offset });
  return fetchApi(`/observability/session/list?${params}`);
};

const fetchObservabilitySession = async (sessionId) => {
  return fetchApi(`/observability/session/${encodeURIComponent(sessionId)}`);
};

// Resource usage — host + per-container CPU/memory/IO (admin-only endpoint).
const fetchResourceStats = async () => {
  return fetchApi('/observability/resources');
};

// Owner-scoped: usage for a single agent. Accepts a UUID or an agent name.
const fetchAgentResourceStats = async (agentRef) => {
  return fetchApi(`/observability/agent/${encodeURIComponent(agentRef)}/resources`);
};

const fetchObservabilityTrace = async (traceId) => {
  const resp = await fetchApi(`/observability/trace/${encodeURIComponent(traceId)}`);
  return resp.data?.trace ?? resp.trace ?? resp;
};

const fetchSpanDetail = async (traceId, spanId) => {
  return fetchApi(`/observability/span/${encodeURIComponent(traceId)}/${encodeURIComponent(spanId)}`);
};

const fetchChatSession = async (sessionId) => {
  return fetchApi(`/chat/sessions/${encodeURIComponent(sessionId)}`);
};

// LLM router — routing configs + provider/model catalog (see /api/docs)
const fetchLlmConfigs = async () => {
  return fetchApi('/llm-configs');
};

const createLlmConfig = async (body) => {
  return fetchApi('/llm-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const deleteLlmConfig = async (id) => {
  return fetchApi(`/llm-configs/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

const setDefaultLlmConfig = async (id) => {
  return fetchApi(`/llm-configs/${encodeURIComponent(id)}/default`, { method: 'POST' });
};

const clearDefaultLlmConfig = async (id) => {
  return fetchApi(`/llm-configs/${encodeURIComponent(id)}/default`, { method: 'DELETE' });
};

const fetchLlmProviders = async () => {
  return fetchApi('/llm-router/providers');
};

const fetchSecretsList = async () => fetchApi('/secrets');

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

const fetchBuilds = async (query, page, limit) => {
  const params = new URLSearchParams({ limit, offset: ((page || 1) - 1) * limit });
  if (query) params.set('q', query);
  return fetchApi(`/builds?${params}`);
};

// User directory search for the ⌘F palette (GET /api/search/users, an OSS
// route — org-scoped on EE). A 404 hides the palette's Users section.
const fetchUserSearch = async (query) => {
  const params = new URLSearchParams({ q: query || '' });
  return fetchApi(`/search/users?${params}`);
};

const fetchSettings = async () => {
  return fetchApi('/settings');
};

const saveSettings = async (settings) => {
  return fetchApi('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
};

// ── MCP gateway — connectors, uploads, credentials, per-agent access ─────────
// Envelope {data, status_code, message}; see /api/docs (tag "mcp").
const fetchMcpConnectors = async () => {
  return fetchApi('/mcp/connectors');
};

const registerMcpConnector = async (body) => {
  return fetchApi('/mcp/connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const probeMcpConnector = async (url) => {
  return fetchApi('/mcp/connectors/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
};

const updateMcpConnector = async (connectorId, body) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const deleteMcpConnector = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}`, { method: 'DELETE' });
};

const uploadMcpServerZip = async (formData) => {
  // Multipart fields: name, version_tag, env (JSON string), file.
  return fetchApi('/mcp/connectors/upload', { method: 'POST', body: formData });
};

const uploadMcpServerGithub = async (body) => {
  return fetchApi('/mcp/connectors/upload-github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const fetchMcpMyUploads = async () => {
  return fetchApi('/mcp/connectors/my-uploads');
};

const fetchMcpBuildStatus = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/build-status`);
};

const fetchMcpBuildLogs = async (connectorId, tail = 200) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/build-logs?tail=${tail}`);
};

const fetchMcpCredentialStatus = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/credential/status`);
};

const setMcpCredential = async (connectorId, value) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/credential`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
};

const deleteMcpCredential = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/credential`, { method: 'DELETE' });
};

const authorizeMcpOauth = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/authorize`, { method: 'POST' });
};

const fetchMcpOauthStatus = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/status`);
};

const revokeMcpOauthToken = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/token`, { method: 'DELETE' });
};

// Toolkits — platform Composio connectables the caller can connect to.
const fetchMcpToolkits = async () => {
  return fetchApi('/mcp/composio/toolkits');
};

// body: {connector_id} (+ optional credentials: {value} for api_key flows).
// data.status: connected | initiated (oauth_url) | oauth_required (authorization_url).
const connectMcpService = async (body) => {
  return fetchApi('/mcp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const fetchMcpConnections = async () => {
  return fetchApi('/mcp/connections');
};

const disconnectMcpConnection = async (connectorId) => {
  return fetchApi(`/mcp/connections/${encodeURIComponent(connectorId)}`, { method: 'DELETE' });
};

const fetchAgentMcpConnectors = async (agentId) => {
  return fetchApi(`/mcp/agents/${encodeURIComponent(agentId)}/connectors`);
};

const setAgentMcpConnectorAccess = async (agentId, connectorId, enabled) => {
  return fetchApi(
    `/mcp/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
  );
};

const fetchAgentMcpConnectorTools = async (agentId, connectorId) => {
  return fetchApi(
    `/mcp/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}/tools`,
  );
};

const fetchAgentMcpToolRules = async (agentId) => {
  return fetchApi(`/mcp/agents/${encodeURIComponent(agentId)}/tools`);
};

const saveAgentMcpToolRules = async (agentId, rules) => {
  return fetchApi(`/mcp/agents/${encodeURIComponent(agentId)}/tools`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules }),
  });
};

// ── Register with the typed registry ─────────────────────────────────────────
// The `window.*` assignments above keep every existing `data-fn=` attribute
// working during the migration. Registering the same functions with
// core/data-sources.js means new code can resolve them properly, and a missing
// or misspelled name throws with a suggestion instead of rendering an empty view
// forever.
//
// The list is explicit rather than derived by scanning `window`: enumerating a
// real Window walks every global, and some of those are getters that throw or are
// expensive to touch. An explicit list is also the thing a reviewer can check.
/**
 * Every data function defined above, by name.
 *
 * Explicit rather than derived by scanning `window`: enumerating a real Window
 * walks every global, some of which are getters that throw. It is also the thing
 * a reviewer can check against the assignments.
 */
registerAll({
  fetchAgents,
  deleteSession,
  fetchSessions,
  fetchContainers,
  fetchFlows,
  fetchFlowDetail,
  fetchWorkflows,
  fetchWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  runWorkflow,
  fetchExecution,
  fetchWorkflowExecutions,
  fetchAllExecutions,
  generateWorkflow,
  fetchTraceDetail,
  fetchObservabilitySessions,
  fetchObservabilitySession,
  fetchResourceStats,
  fetchAgentResourceStats,
  fetchObservabilityTrace,
  fetchSpanDetail,
  fetchChatSession,
  fetchLlmConfigs,
  createLlmConfig,
  deleteLlmConfig,
  setDefaultLlmConfig,
  clearDefaultLlmConfig,
  fetchLlmProviders,
  fetchSecretsList,
  fetchUsageSummary,
  fetchTokenopsDashboard,
  fetchUsageHistory,
  fetchUsageByAgent,
  fetchUsageByModel,
  fetchBuilds,
  fetchUserSearch,
  fetchSettings,
  saveSettings,
  fetchMcpConnectors,
  registerMcpConnector,
  probeMcpConnector,
  updateMcpConnector,
  deleteMcpConnector,
  uploadMcpServerZip,
  uploadMcpServerGithub,
  fetchMcpMyUploads,
  fetchMcpBuildStatus,
  fetchMcpBuildLogs,
  fetchMcpCredentialStatus,
  setMcpCredential,
  deleteMcpCredential,
  authorizeMcpOauth,
  fetchMcpOauthStatus,
  revokeMcpOauthToken,
  fetchMcpToolkits,
  connectMcpService,
  fetchMcpConnections,
  disconnectMcpConnection,
  fetchAgentMcpConnectors,
  setAgentMcpConnectorAccess,
  fetchAgentMcpConnectorTools,
  fetchAgentMcpToolRules,
  saveAgentMcpToolRules,
}, { replace: true });

