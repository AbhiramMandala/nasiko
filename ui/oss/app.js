/**
 * OSS control-plane SPA entry point.
 *
 * Boots the data-sources registry, loads navigation, defines page routes,
 * and starts the client-side router. This is the single `<script>` each
 * page loads; everything else is lazy-imported on first visit.
 *
 * Module execution order (guaranteed by `type="module"` in document order):
 *   1. navigation.js  — registers fetchNavigation / fetchModuleNav + data-functions
 *   2. app-header.js  — renders the persistent shell (imports bootstrap.js)
 *   3. app.js (this)  — defines routes and starts the router
 */

import { router } from '/common/core/router.js';
import { resolveOptional } from '/common/core/data-sources.js';

// ── Base route table ────────────────────────────────────────────────────
// Each route maps a clean URL to a lazy-loaded page component.
// `module` is the ES module path (dynamic-imported on first visit).
// `tag` is the custom element tag name created in the outlet.

const BASE_ROUTES = [
  { path: '/',                tag: 'orchestrator-page',        module: '/common/components/orchestrator-page.js',        title: 'Nasiko' },
  { path: '/agents',          tag: 'agents-page',              module: '/common/components/agents-page.js',              title: 'Nasiko — Agents' },
  { path: '/your-agents',     tag: 'your-agents-page',         module: '/common/components/your-agents-page.js',         title: 'Nasiko — Your Agents' },
  { path: '/add-agent',       tag: 'add-agent-page',           module: '/common/components/add-agent-page.js',           title: 'Nasiko — Add Agent' },
  { path: '/add-agent-github',tag: 'add-agent-github-page',    module: '/common/components/add-agent-github-page.js',    title: 'Nasiko — Import from GitHub' },
  { path: '/agent-card',      tag: 'agent-card-page',          module: '/common/components/agent-card-page.js',          title: 'Nasiko — Agent' },
  { path: '/chat',            tag: 'chat-page',                module: '/common/components/chat-page.js',                title: 'Nasiko — Chat' },
  { path: '/workflows',       tag: 'workflow-list-page',       module: '/common/components/workflow-list-page.js',       title: 'Nasiko — Workflows' },
  { path: '/workflow-new',    tag: 'workflow-new-page',         module: '/common/components/workflow-new-page.js',        title: 'Nasiko — New Workflow' },
  { path: '/workflow',        tag: 'workflow-detail-page',      module: '/common/components/workflow-detail-page.js',     title: 'Nasiko — Workflow' },
  { path: '/executions',      tag: 'executions-page',          module: '/common/components/executions-page.js',          title: 'Nasiko — Executions' },
  { path: '/sessions',        tag: 'sessions-page',            module: '/common/components/sessions-page.js',            title: 'Nasiko — Sessions' },
  { path: '/session-trace',   tag: 'session-trace-page',       module: '/common/components/session-trace-page.js',       title: 'Nasiko — Session Trace' },
  { path: '/observability-session', tag: 'observability-session-page', module: '/common/components/observability-session-page.js', title: 'Nasiko — Session' },
  { path: '/mcp',             tag: 'mcp-page',                 module: '/common/components/mcp-page.js',                 title: 'Nasiko — MCP Gateway' },
  { path: '/llm-router',      tag: 'llm-router-page',          module: '/common/components/llm-router-page.js',          title: 'Nasiko — LLM Router' },
  { path: '/tokenops',        tag: 'tokenops-page',            module: '/common/components/tokenops-page.js',            title: 'Nasiko — TokenOps' },
  { path: '/flows',           tag: 'flows-page',               module: '/common/components/flows-page.js',               title: 'Nasiko — Flows' },
  { path: '/flow',            tag: 'flow-detail-page',         module: '/common/components/flow-detail-page.js',         title: 'Nasiko — Flow' },
  { path: '/builds',          tag: 'builds-page',              module: '/common/components/builds-page.js',              title: 'Nasiko — Builds' },
  { path: '/build',           tag: 'build-detail-page',        module: '/common/components/build-detail-page.js',        title: 'Nasiko — Build' },
  { path: '/secrets',         tag: 'secrets-page',             module: '/common/components/secrets-page.js',             title: 'Nasiko — Secrets' },
  { path: '/settings',        tag: 'settings-page',            module: '/common/components/settings-page.js',            title: 'Nasiko — Settings' },
  { path: '/setup-cli',       tag: 'setup-cli-page',           module: '/common/components/setup-cli-page.js',           title: 'Nasiko — Set up CLI' },
  { path: '/resources',       tag: 'resources-page',           module: '/common/components/resources-page.js',           title: 'Nasiko — Resources' },
];

// ── Route extension seam (same pattern as nav-ext.js) ───────────────────
// On OSS, /routes-ext.js is a no-op. On EE, the asset overlay serves
// ee/ui/web/routes-ext.js which registers additional routes (users,
// departments, teams, access-control, etc.) via the data-sources registry.

let extPromise;
async function loadExtensionRoutes() {
  extPromise ??= import('/routes-ext.js')
    .then(() => resolveOptional('routeExtension'))
    .catch((err) => {
      console.warn('[app] /routes-ext.js failed to load — using base routes', err);
      return null;
    });
  return extPromise;
}

// ── Boot ────────────────────────────────────────────────────────────────

async function boot() {
  // Register base routes
  router.addAll(BASE_ROUTES);

  // Load edition extension routes (EE pages like /users, /departments, etc.)
  const ext = await loadExtensionRoutes();
  if (ext?.routes) {
    router.addAll(ext.routes());
  }

  // Exclude paths that should trigger full page loads
  router.exclude('/login');
  router.excludePrefix('/api/', '/v1/', '/v2/', '/auth/', '/common/', '/mcp/');

  // Start the router
  const outlet = document.getElementById('outlet');
  if (!outlet) {
    console.error('[app] #outlet element not found');
    return;
  }
  router.start(outlet);
}

boot();
