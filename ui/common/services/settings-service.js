/**
 * Settings and user-search data functions.
 *
 * Split from `data-functions.js` (Phase 3B) — workspace settings CRUD and
 * user directory search for the command-F palette.
 */

import { fetchApi } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

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

// Organization-wide orchestrator rules (oss/server/src/orchestrator_rules.rs).
// Read by any authenticated user; writes are superuser-only server-side, so a
// non-admin simply never sees the editing controls.
const fetchOrchestratorRules = async () => {
  return fetchApi('/orchestrator/rules');
};

const createOrchestratorRule = async (rule) => {
  return fetchApi('/orchestrator/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  });
};

const updateOrchestratorRule = async (id, rule) => {
  return fetchApi(`/orchestrator/rules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  });
};

const deleteOrchestratorRule = async (id) => {
  return fetchApi(`/orchestrator/rules/${id}`, { method: 'DELETE' });
};

registerAll({
  fetchUserSearch,
  fetchSettings,
  saveSettings,
  fetchOrchestratorRules,
  createOrchestratorRule,
  updateOrchestratorRule,
  deleteOrchestratorRule,
}, { replace: true });
