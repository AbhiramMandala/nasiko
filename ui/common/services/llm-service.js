/**
 * LLM router data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — routing configs, provider
 * catalog, and secrets listing.
 */

import { fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

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

const updateLlmConfig = async (id, body) => {
  return fetchApi(`/llm-configs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
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

/* ── Custom (DB-registered) LLM providers ──────────────────────────────────── */

const fetchCustomProviders = async () => {
  return fetchApi('/custom-providers');
};

const createCustomProvider = async (body) => {
  return fetchApi('/custom-providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const updateCustomProvider = async (id, body) => {
  return fetchApi(`/custom-providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const deleteCustomProvider = async (id) => {
  return fetchApi(`/custom-providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

const syncCustomProvider = async (id) => {
  return fetchApi(`/custom-providers/${encodeURIComponent(id)}/sync`, { method: 'POST' });
};

const fetchCustomProviderModels = async (id) => {
  return fetchApi(`/custom-providers/${encodeURIComponent(id)}/models`);
};

registerAll({
  fetchLlmConfigs, createLlmConfig, updateLlmConfig, deleteLlmConfig,
  setDefaultLlmConfig, clearDefaultLlmConfig,
  fetchLlmProviders, fetchSecretsList,
  fetchCustomProviders, createCustomProvider, updateCustomProvider,
  deleteCustomProvider, syncCustomProvider, fetchCustomProviderModels,
}, { replace: true });
