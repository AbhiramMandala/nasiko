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
 * These are assigned to `window` because that is still how `data-fn=` resolves
 * during the migration; they are also registered with `core/data-sources.js`, so
 * new code can resolve them properly and a missing name fails loudly. Phase 3B
 * splits this file by domain — it is deliberately a verbatim move for now, so the
 * diff that eliminates the fork is mechanical and reviewable.
 */

import { apiFetch, fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

window.fetchAgents = async (query, page, limit) => {
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
window.deleteSession = async (sessionId) => {
  if (!sessionId) throw new Error('deleteSession requires a session id');
  await apiFetch(`/chat/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
};

window.fetchSessions = async (_query, limit = 25, cursor = null) => {
  const params = new URLSearchParams({ limit });
  if (cursor) params.set('cursor', cursor);
  return fetchApi(`/chat/sessions?${params}`);
};

window.fetchContainers = async (query, page, limit) => {
  const params = new URLSearchParams({ limit, offset: ((page || 1) - 1) * limit });
  if (query) params.set('q', query);
  const body = await fetchApi(`/agents?${params}`);
  const data = Array.isArray(body) ? body : (body.data || []);
  return { data, total: body.total || data.length };
};

window.fetchFlows = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', page, limit });
  return fetchApi(`/flows?${params}`);
};

window.fetchFlowDetail = async (flowId) => {
  return fetchApi(`/flows/${flowId}`);
};

// ── MAF workflows — /api/maf/* (oss/server/src/maf.rs) ───────────────────────
// Every response uses the {data, status_code, message} envelope; list
// endpoints additionally wrap the rows as data:{data:[...], total} (total is
// the page length, not the true total).
const mafRows = (body) =>
  (Array.isArray(body?.data) ? body.data : body?.data?.data) || [];

window.fetchWorkflows = async (limit = 100, offset = 0) => {
  return mafRows(await fetchApi(`/maf/workflows?limit=${limit}&offset=${offset}`));
};

window.fetchWorkflow = async (id) => {
  return (await fetchApi(`/maf/workflow/${encodeURIComponent(id)}`)).data;
};

window.createWorkflow = async (body) => {
  return (await fetchApi('/maf/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).data;
};

window.updateWorkflow = async (id, body) => {
  return (await fetchApi(`/maf/workflow/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).data;
};

window.deleteWorkflow = async (id) => {
  return fetchApi(`/maf/workflow/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

window.runWorkflow = async (id) => {
  // 202 Accepted → data: {execution_id, execution_number, execution_count}
  return (await fetchApi(`/maf/workflow/${encodeURIComponent(id)}/run`, { method: 'POST' })).data;
};

window.fetchExecution = async (id) => {
  return (await fetchApi(`/maf/execution/${encodeURIComponent(id)}`)).data;
};

window.fetchWorkflowExecutions = async (id, limit = 50, offset = 0) => {
  return mafRows(await fetchApi(
    `/maf/workflow/${encodeURIComponent(id)}/executions?limit=${limit}&offset=${offset}`,
  ));
};

window.fetchAllExecutions = async (limit = 100, offset = 0) => {
  return mafRows(await fetchApi(`/maf/executions?limit=${limit}&offset=${offset}`));
};

// The create page branches on the failure mode (503 = no LLM key configured,
// 400 = user has no agents, 422 = planner failure), so surface the status.
window.generateWorkflow = async (description) => {
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

window.fetchTraceDetail = async (traceId) => {
  // Server route: GET /api/observability/trace/{id} (same as `nasiko observe trace`).
  // Envelope {data:{trace}}; trace.spans is a nested tree (children embedded).
  const resp = await fetchApi(`/observability/trace/${traceId}`);
  return resp.data?.trace ?? resp.trace ?? resp;
};

// Observability — execution history + per-session traces (see /api/docs)
// Paged: every row costs the server one trace-store lookup, so asking for the
// whole history is what made Execution history slow to appear.
window.fetchObservabilitySessions = async (limit = 25, offset = 0) => {
  const params = new URLSearchParams({ limit, offset });
  return fetchApi(`/observability/session/list?${params}`);
};

window.fetchObservabilitySession = async (sessionId) => {
  return fetchApi(`/observability/session/${encodeURIComponent(sessionId)}`);
};

// Resource usage — host + per-container CPU/memory/IO (admin-only endpoint).
window.fetchResourceStats = async () => {
  return fetchApi('/observability/resources');
};

// Owner-scoped: usage for a single agent. Accepts a UUID or an agent name.
window.fetchAgentResourceStats = async (agentRef) => {
  return fetchApi(`/observability/agent/${encodeURIComponent(agentRef)}/resources`);
};

window.fetchObservabilityTrace = async (traceId) => {
  const resp = await fetchApi(`/observability/trace/${encodeURIComponent(traceId)}`);
  return resp.data?.trace ?? resp.trace ?? resp;
};

window.fetchSpanDetail = async (traceId, spanId) => {
  return fetchApi(`/observability/span/${encodeURIComponent(traceId)}/${encodeURIComponent(spanId)}`);
};

window.fetchChatSession = async (sessionId) => {
  return fetchApi(`/chat/sessions/${encodeURIComponent(sessionId)}`);
};

// LLM router — routing configs + provider/model catalog (see /api/docs)
window.fetchLlmConfigs = async () => {
  return fetchApi('/llm-configs');
};

window.createLlmConfig = async (body) => {
  return fetchApi('/llm-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

window.deleteLlmConfig = async (id) => {
  return fetchApi(`/llm-configs/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

window.setDefaultLlmConfig = async (id) => {
  return fetchApi(`/llm-configs/${encodeURIComponent(id)}/default`, { method: 'POST' });
};

window.clearDefaultLlmConfig = async (id) => {
  return fetchApi(`/llm-configs/${encodeURIComponent(id)}/default`, { method: 'DELETE' });
};

window.fetchLlmProviders = async () => {
  return fetchApi('/llm-router/providers');
};

window.fetchSecretsList = async () => fetchApi('/secrets');

window.fetchUsageSummary = async () => {
  return fetchApi('/usage/summary');
};

// TokenOps dashboard — GET /api/observability/finops/dashboard
window.fetchTokenopsDashboard = async (startTime, endTime) => {
  const q = new URLSearchParams();
  if (startTime) q.set('start_time', startTime);
  if (endTime) q.set('end_time', endTime);
  const params = q.size ? `?${q}` : '';
  return fetchApi(`/observability/finops/dashboard${params}`);
};

window.fetchUsageHistory = async (days = 7) => {
  return fetchApi(`/usage/history?days=${days}`);
};

window.fetchUsageByAgent = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', limit, offset: ((page || 1) - 1) * limit });
  return fetchApi(`/usage/by-agent?${params}`);
};

window.fetchUsageByModel = async (query, page, limit) => {
  const params = new URLSearchParams({ q: query || '', limit, offset: ((page || 1) - 1) * limit });
  return fetchApi(`/usage/by-model?${params}`);
};

window.fetchBuilds = async (query, page, limit) => {
  const params = new URLSearchParams({ limit, offset: ((page || 1) - 1) * limit });
  if (query) params.set('q', query);
  return fetchApi(`/builds?${params}`);
};

// User directory search for the ⌘F palette (GET /api/search/users, an OSS
// route — org-scoped on EE). A 404 hides the palette's Users section.
window.fetchUserSearch = async (query) => {
  const params = new URLSearchParams({ q: query || '' });
  return fetchApi(`/search/users?${params}`);
};

window.fetchSettings = async () => {
  return fetchApi('/settings');
};

window.saveSettings = async (settings) => {
  return fetchApi('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
};

// ── MCP gateway — connectors, uploads, credentials, per-agent access ─────────
// Envelope {data, status_code, message}; see /api/docs (tag "mcp").
window.fetchMcpConnectors = async () => {
  return fetchApi('/mcp/connectors');
};

window.registerMcpConnector = async (body) => {
  return fetchApi('/mcp/connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

window.probeMcpConnector = async (url) => {
  return fetchApi('/mcp/connectors/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
};

window.updateMcpConnector = async (connectorId, body) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

window.deleteMcpConnector = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}`, { method: 'DELETE' });
};

window.uploadMcpServerZip = async (formData) => {
  // Multipart fields: name, version_tag, env (JSON string), file.
  return fetchApi('/mcp/connectors/upload', { method: 'POST', body: formData });
};

window.uploadMcpServerGithub = async (body) => {
  return fetchApi('/mcp/connectors/upload-github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

window.fetchMcpMyUploads = async () => {
  return fetchApi('/mcp/connectors/my-uploads');
};

window.fetchMcpBuildStatus = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/build-status`);
};

window.fetchMcpBuildLogs = async (connectorId, tail = 200) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/build-logs?tail=${tail}`);
};

window.fetchMcpCredentialStatus = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/credential/status`);
};

window.setMcpCredential = async (connectorId, value) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/credential`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
};

window.deleteMcpCredential = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/credential`, { method: 'DELETE' });
};

window.authorizeMcpOauth = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/authorize`, { method: 'POST' });
};

window.fetchMcpOauthStatus = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/status`);
};

window.revokeMcpOauthToken = async (connectorId) => {
  return fetchApi(`/mcp/connectors/${encodeURIComponent(connectorId)}/oauth/token`, { method: 'DELETE' });
};

// Toolkits — platform Composio connectables the caller can connect to.
window.fetchMcpToolkits = async () => {
  return fetchApi('/mcp/composio/toolkits');
};

// body: {connector_id} (+ optional credentials: {value} for api_key flows).
// data.status: connected | initiated (oauth_url) | oauth_required (authorization_url).
window.connectMcpService = async (body) => {
  return fetchApi('/mcp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

window.fetchMcpConnections = async () => {
  return fetchApi('/mcp/connections');
};

window.disconnectMcpConnection = async (connectorId) => {
  return fetchApi(`/mcp/connections/${encodeURIComponent(connectorId)}`, { method: 'DELETE' });
};

window.fetchAgentMcpConnectors = async (agentId) => {
  return fetchApi(`/mcp/agents/${encodeURIComponent(agentId)}/connectors`);
};

window.setAgentMcpConnectorAccess = async (agentId, connectorId, enabled) => {
  return fetchApi(
    `/mcp/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
  );
};

window.fetchAgentMcpConnectorTools = async (agentId, connectorId) => {
  return fetchApi(
    `/mcp/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}/tools`,
  );
};

window.fetchAgentMcpToolRules = async (agentId) => {
  return fetchApi(`/mcp/agents/${encodeURIComponent(agentId)}/tools`);
};

window.saveAgentMcpToolRules = async (agentId, rules) => {
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
registerAll(
  {
  authorizeMcpOauth, clearDefaultLlmConfig, connectMcpService, createLlmConfig,
  createWorkflow, deleteLlmConfig, deleteMcpConnector, deleteMcpCredential,
  deleteSession, deleteWorkflow, disconnectMcpConnection, fetchAgentMcpConnectorTools,
  fetchAgentMcpConnectors, fetchAgentMcpToolRules, fetchAgentResourceStats, fetchAgents,
  fetchAllExecutions, fetchBuilds, fetchChatSession, fetchContainers,
  fetchExecution, fetchFlowDetail, fetchFlows, fetchLlmConfigs,
  fetchLlmProviders, fetchMcpBuildLogs, fetchMcpBuildStatus, fetchMcpConnections,
  fetchMcpConnectors, fetchMcpCredentialStatus, fetchMcpMyUploads, fetchMcpOauthStatus,
  fetchMcpToolkits, fetchObservabilitySession, fetchObservabilitySessions, fetchObservabilityTrace,
  fetchResourceStats, fetchSecretsList, fetchSessions, fetchSettings,
  fetchSpanDetail, fetchTokenopsDashboard, fetchTraceDetail, fetchUsageByAgent,
  fetchUsageByModel, fetchUsageHistory, fetchUsageSummary, fetchUserSearch,
  fetchWorkflow, fetchWorkflowExecutions, fetchWorkflows, generateWorkflow,
  probeMcpConnector, registerMcpConnector, revokeMcpOauthToken, runWorkflow,
  saveAgentMcpToolRules, saveSettings, setAgentMcpConnectorAccess, setDefaultLlmConfig,
  setMcpCredential, updateMcpConnector, updateWorkflow, uploadMcpServerGithub,
  uploadMcpServerZip,
  },
  { replace: true },
);
