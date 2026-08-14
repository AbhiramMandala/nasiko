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

registerAll({
  fetchLlmConfigs, createLlmConfig, deleteLlmConfig,
  setDefaultLlmConfig, clearDefaultLlmConfig,
  fetchLlmProviders, fetchSecretsList,
}, { replace: true });
