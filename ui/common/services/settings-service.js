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

registerAll({ fetchUserSearch, fetchSettings, saveSettings }, { replace: true });
