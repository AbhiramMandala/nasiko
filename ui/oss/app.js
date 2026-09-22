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

import { createApp } from '/common/core/create-app.js';
import { resolveOptional } from '/common/core/data-sources.js';
import { dismissSplash } from '/common/features/app-splash.js';

// ── Base route table ────────────────────────────────────────────────────
// Each route maps a clean URL to a lazy-loaded page component.
// `module` is the ES module path (dynamic-imported on first visit).
// `tag` is the custom element tag name created in the outlet.

const BASE_ROUTES = [
  { path: '/',                tag: 'overview-page',            module: '/common/pages/overview-page.js',            title: 'Nasiko — Overview' },
  { path: '/orchestrator',    tag: 'orchestrator-page',        module: '/common/pages/orchestrator-page.js',        title: 'Nasiko — Orchestrator' },
  { path: '/agents',          tag: 'agents-page',              module: '/common/pages/agents-page.js',              title: 'Nasiko — Agents' },
  { path: '/your-agents',     tag: 'your-agents-page',         module: '/common/pages/your-agents-page.js',         title: 'Nasiko — Your Agents' },
  { path: '/add-agent',       tag: 'add-agent-page',           module: '/common/pages/add-agent-page.js',           title: 'Nasiko — Add Agent' },
  { path: '/add-agent-github',tag: 'add-agent-github-page',    module: '/common/pages/add-agent-github-page.js',    title: 'Nasiko — Import from GitHub' },
  { path: '/agent-card',      tag: 'agent-card-page',          module: '/common/pages/agent-card-page.js',          title: 'Nasiko — Agent' },
  { path: '/chat',            tag: 'chat-page',                module: '/common/pages/chat-page.js',                title: 'Nasiko — Chat' },
  // Same page, second entry point: the Sessions module. Its module nav lists
  // every agent's chats and it opens the newest one when the url names none.
  { path: '/chats',           tag: 'chat-page',                module: '/common/pages/chat-page.js',                title: 'Nasiko — Sessions' },
  { path: '/workflows',       tag: 'workflows-page',           module: '/common/pages/workflows-page.js',            title: 'Nasiko — Workflows' },
  { path: '/workflow-new',    tag: 'workflow-new-page',         module: '/common/pages/workflow-new-page.js',        title: 'Nasiko — New Workflow' },
  { path: '/workflow',        tag: 'workflow-detail-page',      module: '/common/pages/workflow-detail-page.js',     title: 'Nasiko — Workflow' },
  { path: '/executions',      tag: 'executions-page',          module: '/common/pages/executions-page.js',          title: 'Nasiko — Executions' },
  { path: '/sessions',        tag: 'sessions-page',            module: '/common/pages/sessions-page.js',            title: 'Nasiko — Session history' },
  { path: '/session-trace',   tag: 'session-trace-page',       module: '/common/pages/session-trace-page.js',       title: 'Nasiko — Session Trace' },
  { path: '/observability-session', tag: 'observability-session-page', module: '/common/pages/observability-session-page.js', title: 'Nasiko — Session' },
  { path: '/mcp',             tag: 'mcp-page',                 module: '/common/pages/mcp-page.js',                 title: 'Nasiko — MCP Gateway' },
  { path: '/mcp-detail',      tag: 'mcp-detail-page',          module: '/common/pages/mcp-detail-page.js',          title: 'Nasiko — MCP Server' },
  { path: '/llm-router',      tag: 'llm-router-page',          module: '/common/pages/llm-router-page.js',          title: 'Nasiko — LLM Router' },
  { path: '/tokenops',        tag: 'tokenops-page',            module: '/common/pages/tokenops-page.js',            title: 'Nasiko — TokenOps' },
  { path: '/flows',           tag: 'flows-page',               module: '/common/pages/flows-page.js',               title: 'Nasiko — Flows' },
  { path: '/flow',            tag: 'flow-detail-page',         module: '/common/pages/flow-detail-page.js',         title: 'Nasiko — Flow' },
  { path: '/builds',          tag: 'builds-page',              module: '/common/pages/builds-page.js',              title: 'Nasiko — Builds' },
  { path: '/build',           tag: 'build-detail-page',        module: '/common/pages/build-detail-page.js',        title: 'Nasiko — Build' },
  { path: '/secrets',         tag: 'secrets-page',             module: '/common/pages/secrets-page.js',             title: 'Nasiko — Secrets' },
  { path: '/settings',        tag: 'settings-page',            module: '/common/pages/settings-page.js',            title: 'Nasiko — Settings' },
  { path: '/setup-cli',       tag: 'setup-cli-page',           module: '/common/pages/setup-cli-page.js',           title: 'Nasiko — Set up CLI' },
  { path: '/resources',       tag: 'resources-page',           module: '/common/pages/resources-page.js',           title: 'Nasiko — Resources' },
  { path: '/design-system',   tag: 'design-system-page',       module: '/common/pages/design-system-page.js',       title: 'Nasiko — Design System' },
  // Weave. These three are EE features — the surface stream and the saved-view
  // store are mounted by ee/server only — but they stay in BASE_ROUTES because
  // gen-dsl-catalog.mjs parses this table into the allowlist of routes a
  // generated surface may link to, and hashes it into `catalogVersion`. Moving
  // them to /routes-ext.js drops /view and /custom-views out of that allowlist
  // and moves the catalog version. Everything else that surfaced Weave on OSS
  // — the nav item, the page shell, the dock — is gone; see nav-ext.js and
  // routes-ext.js. Closing this last gap needs the allowlist to learn about
  // editions, which is its own change.
  { path: '/weave',           tag: 'weave-page',               module: '/common/pages/weave-page.js',               title: 'Nasiko — Weave' },
  { path: '/view',            tag: 'generated-view-page',      module: '/common/pages/generated-view-page.js',      title: 'Nasiko — View' },
  { path: '/custom-views',    tag: 'custom-views-page',        module: '/common/pages/custom-views-page.js',        title: 'Nasiko — Custom Views' },
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
// The sequence itself lives in core/create-app.js — see the note there on why
// the splash and the dock arrive through `onReady` rather than being imported
// by it.

createApp({
  routes: BASE_ROUTES,
  extensionRoutes: loadExtensionRoutes,
  // A full page load: no app-header, and it does OAuth redirects.
  exclude: ['/login'],
  excludePrefix: ['/api/', '/v1/', '/v2/', '/auth/', '/common/', '/mcp/'],
  async onReady() {
    // The route extension gets the same seam for boot work that it has for
    // routes: anything an edition mounts outside the outlet — a launcher, a
    // drawer — belongs to whichever edition can actually serve it, not here.
    // On OSS `/routes-ext.js` is a no-op and nothing mounts.
    //
    // `loadExtensionRoutes` is memoised, so this is the module createApp
    // already resolved, not a second fetch.
    try {
      await (await loadExtensionRoutes())?.onReady?.();
    } catch (err) {
      console.warn('[app] route extension onReady() failed', err);
    }
    // Everything is wired — drop the splash screen and reveal the app.
    dismissSplash();
  },
});
