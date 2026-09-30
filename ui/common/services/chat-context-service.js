/**
 * Per-user chat-context preferences — `GET/PATCH /api/me/context-strategy`
 * and `GET/PATCH /api/me/pacms-budget` (oss/server/src/context_selection.rs).
 * Neither route is superuser-gated: every authenticated user owns their own.
 */

import { getJson, patchJson } from '/common/services/api.js';
import { registerAll } from '/common/core/data-sources.js';

const fetchContextStrategy = async () => getJson('/me/context-strategy');
const saveContextStrategy = async (strategy) => patchJson('/me/context-strategy', { strategy });

const fetchPacmsBudget = async () => getJson('/me/pacms-budget');
const savePacmsBudget = async (level) => patchJson('/me/pacms-budget', { level });

registerAll(
  { fetchContextStrategy, saveContextStrategy, fetchPacmsBudget, savePacmsBudget },
  { replace: true },
);
