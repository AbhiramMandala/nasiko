/**
 * MCP gateway data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — connectors, uploads,
 * credentials, OAuth, toolkits, connections, and per-agent access.
 * Envelope {data, status_code, message}; see /api/docs (tag "mcp").
 */

import { fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

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

registerAll({
  fetchMcpConnectors, registerMcpConnector, probeMcpConnector,
  updateMcpConnector, deleteMcpConnector,
  uploadMcpServerZip, uploadMcpServerGithub,
  fetchMcpMyUploads, fetchMcpBuildStatus, fetchMcpBuildLogs,
  fetchMcpCredentialStatus, setMcpCredential, deleteMcpCredential,
  authorizeMcpOauth, fetchMcpOauthStatus, revokeMcpOauthToken,
  fetchMcpToolkits, connectMcpService,
  fetchMcpConnections, disconnectMcpConnection,
  fetchAgentMcpConnectors, setAgentMcpConnectorAccess,
  fetchAgentMcpConnectorTools, fetchAgentMcpToolRules, saveAgentMcpToolRules,
}, { replace: true });
