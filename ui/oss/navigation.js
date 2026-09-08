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
import { call, registerAll, resolveOptional } from '/common/core/data-sources.js';
import { ensureViews, hasSavedViews } from '/common/state/weave-views.js';

// rail: true → shown as a rail module icon; everything else is reachable
// through the module tree navs and the ⌘F nav search.
const BASE_ITEMS = () => [
  // rail: true → shown as a rail module icon; everything else is reachable
  // through the module tree navs and the ⌘F nav search.
  //
  // module → which MODULE_NAVS tree a page belongs to. The rail item carrying
  // the same key stays selected while any of its children is open, so a child
  // page never leaves the rail with nothing highlighted.
  { title: "Orchestrator", url: "/", icon: "brain", rail: true, module: "orchestrator" },
  // Not on the rail: workflows are the Orchestrator module's second group, and
  // a second rail icon into the same tree read as a separate module.
  { title: "Workflows", url: "/workflows", icon: "workflow", module: "orchestrator" },
  { title: "Executions", url: "/executions", icon: "play", module: "orchestrator" },
  { title: "Agents", url: "/agents", icon: "bot", rail: true, module: "agents" },
  { title: "Sessions", url: "/sessions", icon: "activity", rail: true, module: "observability" },
  { title: "MCP gateway", url: "/mcp", icon: "server", rail: true, module: "mcp" },
  { title: "LLM router", url: "/llm-router", icon: "route", rail: true },
  { title: "TokenOps", url: "/tokenops", icon: "banknote", rail: true },
  { title: "Weave", url: "/weave", icon: "sparkles", rail: true },
  { title: "Your Agents", url: "/your-agents", icon: "user", module: "agents" },
  { title: "Add Agent", url: "/add-agent", icon: "plus", module: "agents" },
  { title: "Set up CLI", url: "/setup-cli", icon: "terminal" },
  { title: "Flows", url: "/flows", icon: "cornerUpRight", module: "observability" },
  // In the Observability module tree but missing here, so ⌘F couldn't find it
  // and the rail lost its selection on the page.
  { title: "Resources", url: "/resources", icon: "activity", module: "observability" },
  { title: "Builds", url: "/builds", icon: "cube", module: "agents" },
  { title: "Secrets", url: "/secrets", icon: "lock", module: "settings" },
  { title: "Settings", url: "/settings", icon: "settings", rail: true, module: "settings" },
];

// Rail entry for the views Weave generated and the user chose to keep. Absent
// until the first save, because a rail icon leading to an empty shelf is a
// promise the product has not made yet — <app-header> re-reads the nav on
// `nav-refresh`, which generated-view-page fires the moment one is saved.
const CUSTOM_VIEWS_ITEM = { title: "Custom Views", url: "/custom-views", icon: "layers", rail: true };

// In-card module tree navs (app-module-nav). Items are either page links
// ({label, url}) or in-page sections ({label, section} → the page handles
// the `module-nav-select` event). Only real pages/features appear here.
const MODULE_NAVS = {
  orchestrator: {
    title: 'Orchestrator', icon: 'brain',
    groups: [
      // A group with a url and no items is a heading-level link (see
      // app-module-nav's #groupHtml) — the entry point sits above the session
      // list, not inside it.
      { label: 'Orchestrate a task', url: '/' },
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
      // Every `section` here must be a key of CATALOG_SCOPES in
      // common/pages/mcp-page.js — a row naming anything else highlights and
      // then does nothing, which is what `created-by-you` and `uploads` did.
      // No separate uploads row: an upload IS a custom server, so it is already
      // under "My servers", carrying its own "Setting up" / "Build failed" chip.
      { label: 'MCP servers', items: [
        { label: 'All', section: 'all' },
        { label: 'My servers', section: 'my-servers' },
        { label: 'Shared with me', section: 'shared-with-me' },
      ]},
      { label: 'Toolkits', items: [
        { label: 'All toolkits', section: 'toolkits' },
      ]},
      // No "Agent access" row: access is granted per connector on
      // /mcp-detail (Access & security) and per agent on the agent card's
      // Configure tab. There is no page-level view of it for a row to open.
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
        { label: 'Resources', url: '/resources' },
      ]},
    ],
  },
  settings: {
    title: 'Settings', icon: 'settings',
    groups: [
      // `url` on a section item names the page that owns the panels. Secrets is
      // a sibling route, not a panel of this page, so from /secrets there is no
      // settings-page listening for `module-nav-select` — without the url these
      // four rows highlighted and did nothing, pinning the content to Secrets.
      { label: 'Workspace', items: [
        { label: 'General', section: 'general', url: '/settings' },
        { label: 'Flow limits', section: 'limits', url: '/settings' },
        { label: 'Registry', section: 'registry', url: '/settings' },
      ]},
      { label: 'Security', items: [
        { label: 'Single sign-on', section: 'sso', url: '/settings' },
        { label: 'Secrets', url: '/secrets' },
      ]},
    ],
  },
};

// Orchestrator chats listed under the Session group. `agent_name: null` is the
// marker for a session the orchestrator routed (a direct agent chat carries the
// agent's name and belongs to that agent, not here). The API has no filter for
// it, so over-fetch one page and filter client-side.
const ORCH_SESSION_ROWS = 15;
const orchestratorSessionItems = async () => {
  try {
    const res = await call('fetchSessions', '', 50);
    return (res?.data || [])
      .filter((s) => !s.agent_name)
      .slice(0, ORCH_SESSION_ROWS)
      .map((s) => ({
        // Present ⇒ app-module-nav renders the row's delete affordance.
        sessionId: s.session_id,
        // Titles are auto-generated and often the literal "New chat", which
        // makes every row look the same — fall back to the last message.
        // Sliced: a last_message is a whole markdown answer, and the row
        // ellipsises anyway — no reason to carry KBs of it through the cache.
        label: ((s.title && s.title !== 'New chat' ? s.title : s.last_message) || 'New chat')
          .replace(/\s+/g, ' ').trim().slice(0, 60),
        // Same target as an Execution history row: chat-page loads the
        // transcript and posts to /orchestrator/a2a when there's no agent_id.
        url: `/chat?session_id=${encodeURIComponent(s.session_id)}&agent_name=Orchestrator`,
      }));
  } catch {
    return []; // a flaky request must not blank the sidebar
  }
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
  // The saved list lives on the server, so the rail cannot know whether the
  // Custom views entry belongs until it has been fetched. `ensureViews` does it
  // once per load and never rejects; on the OSS build it answers 404, the list
  // stays empty and the entry simply never appears — which is correct, because
  // the routes it leads to are not there either.
  await ensureViews();
  if (hasSavedViews()) base.push(CUSTOM_VIEWS_ITEM);
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
  let base = nav ? { ...nav, groups: [...nav.groups] } : null;
  if (module === 'orchestrator' && base) {
    const sessions = await orchestratorSessionItems();
    // Last, below Workflows; omitted entirely when empty, since a group with
    // no items and no url renders as a stray heading.
    if (sessions.length) base = { ...base, groups: [...base.groups, { label: 'Session', items: sessions }] };
  }
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
