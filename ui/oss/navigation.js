/**
 * Navigation for the OSS control plane, plus the seam every edition extends.
 *
 * Loaded first on every page (see the module-order note in any page's <head>):
 * it registers `fetchNavigation` / `fetchModuleNav` with the data-sources
 * registry for `<app-header>` and `<app-module-nav>`, and pulls in the shared
 * data functions.
 *
 * ─── Why the extension seam exists ─────────────────────────────────────────
 * EE used to override this entire file. `EeAssets` resolves before `OssAssets`
 * and EE has no HTML override for index/agents/settings/etc., so those pages load
 * THIS file — which meant the only way for EE to add its org nav items was to
 * ship a complete copy. 450 of that copy's 662 lines were identical, and the part
 * that wasn't had silently drifted into a user-visible bug.
 *
 * Now both editions share this file, and edition-specific navigation lives in
 * `/nav-ext.js`, resolved through the same overlay: `ui/oss/nav-ext.js` is a
 * documented no-op, `ee/ui/web/nav-ext.js` supplies the EE tree. Nothing 404s,
 * and there is exactly one copy of every data function.
 */

import '/common/services/data-functions.js';
import { registerAll, resolveOptional } from '/common/core/data-sources.js';

// rail: true → shown as a rail module icon; everything else is reachable
// through the module tree navs and the ⌘F nav search.
const BASE_ITEMS = () => [
  // rail: true → shown as a rail module icon; everything else is reachable
  // through the module tree navs and the ⌘F nav search.
  { title: "Orchestrator", url: "/", icon: "brain", rail: true },
  // On the rail: without it the only route to the workflow list was to open
  // "Create workflow" and back out of it.
  { title: "Workflows", url: "/workflows", icon: "workflow", rail: true },
  { title: "Executions", url: "/executions", icon: "play" },
  { title: "Agents", url: "/agents", icon: "bot", rail: true },
  { title: "Sessions", url: "/sessions", icon: "activity", rail: true },
  { title: "MCP gateway", url: "/mcp", icon: "server", rail: true },
  { title: "LLM router", url: "/llm-router", icon: "route", rail: true },
  { title: "TokenOps", url: "/tokenops", icon: "banknote", rail: true },
  { title: "Your Agents", url: "/your-agents", icon: "user" },
  { title: "Add Agent", url: "/add-agent", icon: "plus" },
  { title: "Set up CLI", url: "/setup-cli", icon: "terminal" },
  { title: "Flows", url: "/flows", icon: "cornerUpRight" },
  { title: "Builds", url: "/builds", icon: "cube" },
  { title: "Secrets", url: "/secrets", icon: "lock" },
  { title: "Settings", url: "/settings", icon: "settings", rail: true },
];

// In-card module tree navs (app-module-nav). Items are either page links
// ({label, url}) or in-page sections ({label, section} → the page handles
// the `module-nav-select` event). Only real pages/features appear here.
const MODULE_NAVS = {
  orchestrator: {
    title: 'Orchestrator', icon: 'brain',
    groups: [
      { label: 'Session', items: [
        { label: 'Orchestrate a task', url: '/' },
      ]},
      { label: 'Workflows', items: [
        { label: 'All workflows', url: '/workflows' },
        { label: 'Executions', url: '/executions' },
      ]},
    ],
  },
  mcp: {
    title: 'MCP gateway', icon: 'server',
    groups: [
      // Scope rows filter the unified catalog grid; ownership scopes apply
      // to custom MCP servers only (toolkits are platform-registered).
      { label: 'MCP servers', items: [
        { label: 'All', section: 'all' },
        { label: 'Created by you', section: 'created-by-you' },
        { label: 'Shared with me', section: 'shared-with-me' },
        { label: 'My uploads', section: 'uploads' },
      ]},
      { label: 'Toolkits', items: [
        { label: 'All toolkits', section: 'toolkits' },
      ]},
      { label: 'Access', items: [
        { label: 'Agent access', section: 'agent-access' },
      ]},
    ],
  },
  agents: {
    title: 'Agent registry', icon: 'bot',
    groups: [
      { label: 'Agent sources', items: [
        { label: 'Agent hub', url: '/agents' },
        { label: 'Your agents', url: '/your-agents' },
        { label: 'Import agent', url: '/add-agent' },
      ]},
      { label: 'Builds', items: [
        { label: 'All builds', url: '/builds' },
      ]},
    ],
  },
  observability: {
    title: 'Observability', icon: 'activity',
    groups: [
      { label: 'Home', items: [
        { label: 'Execution history', url: '/sessions' },
        { label: 'Live flows', url: '/flows' },
        { label: 'Resources', url: '/resources' },
      ]},
    ],
  },
  settings: {
    title: 'Settings', icon: 'settings',
    groups: [
      { label: 'Workspace', items: [
        { label: 'General', section: 'general' },
        { label: 'Flow limits', section: 'limits' },
        { label: 'Registry', section: 'registry' },
      ]},
      { label: 'Security', items: [
        { label: 'Single sign-on', section: 'sso' },
        { label: 'Secrets', url: '/secrets' },
      ]},
    ],
  },
};

/**
 * The edition extension, loaded once.
 *
 * The extension is delivered through the asset overlay (ui/oss/nav-ext.js
 * is a no-op, ee/ui/web/nav-ext.js supplies the EE hooks) and resolved
 * through the data-sources registry. The dynamic import triggers the extension
 * module's side-effect registration; the actual contract is DI-based so the
 * seam is testable and consistent with the rest of the architecture.
 *
 * @type {Promise<{ context?: () => Promise<any>, items?: Function, moduleNav?: Function }>}
 */
let extensionPromise;
const extension = () => {
  extensionPromise ??= import('/nav-ext.js')
    .then(() => resolveOptional('navExtension') || {})
    .catch((err) => {
      console.warn('[navigation] /nav-ext.js failed to load — using base navigation', err);
      return {};
    });
  return extensionPromise;
};

/**
 * Extension context (org role, feature flags), fetched at most once per page.
 *
 * Deliberately lazy: the login page has no session, and eagerly fetching this at
 * module load would 401 on every unauthenticated page load.
 */
let contextPromise;
const extensionContext = async () => {
  const ext = await extension();
  if (!ext.context) return null;
  contextPromise ??= Promise.resolve()
    .then(() => ext.context())
    .catch(() => null);
  return contextPromise;
};

const fetchNavigation = async () => {
  const base = BASE_ITEMS();
  const ext = await extension();
  if (!ext.items) return base;
  try {
    return (await ext.items(base, await extensionContext())) || base;
  } catch (err) {
    console.error('[navigation] nav extension items() failed — falling back to base', err);
    return base;
  }
};

const fetchModuleNav = async (module) => {
  const nav = MODULE_NAVS[module];
  // Observability used to append a dynamic "Recent activity" group listing the
  // five newest sessions. Dropped: on sessions.html — the only page it appeared
  // on — it restated the first five rows of the table beside it, and the table
  // is filterable, sortable and complete. Truncated duplicates of the primary
  // content are noise, and it cost an extra API call per page load.
  const base = nav ? { ...nav, groups: [...nav.groups] } : null;
  const ext = await extension();
  if (!ext.moduleNav) return base;
  try {
    return await ext.moduleNav(module, base, await extensionContext());
  } catch (err) {
    console.error('[navigation] nav extension moduleNav() failed — falling back to base', err);
    return base;
  }
};

registerAll({ fetchNavigation, fetchModuleNav }, { replace: true });

export { BASE_ITEMS, MODULE_NAVS };
