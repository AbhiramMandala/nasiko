/**
 * NightOwl application shell: 52px ink topbar + collapsible left icon rail.
 *
 * Renders both chrome bars from one element so existing pages keep their
 * single `<app-header>` tag. The rail lists the pages from
 * `fetchNavigation` via data-sources (or the `nav-links` attribute); Settings and the
 * identity menu pin to the rail's bottom cluster.
 *
 * @element app-header
 * @attr {string} brand-title - Application name (used for tooltips/aria)
 * @attr {string} brand-url - URL the brand mark links to (default: `/`)
 * @attr {string} nav-links - JSON array of `{title, url, icon}` objects
 * @note Includes `<app-nav-search>` and `<app-user-menu>` internally.
 * @note Dispatches `loading-start` on nav clicks (see app-loading-bar).
 */
// The composition root, which binds keys.api / keys.store / keys.notifier and
// self-invokes on import. Every page loads <app-header>, so importing it here
// is what makes `static inject = { api: keys.api }` resolvable app-wide —
// container.js and ui/AGENTS.md both already claim this file does it, and until
// now nothing did, so any component declaring `inject` threw on construction.
import "../core/bootstrap.js";
import { authService } from "../services/auth-service.js";
import { icons } from "../utils/icons.js";
import { confirmDialog } from "../design-system/app-modal/app-modal.js";
import "./app-user-menu.js";
import "./app-nav-search.js";
import "./change-password-modal.js";
import { escHtml } from '/common/utils/escape.js';
import { callOptional } from '../core/data-sources.js';
import { navigate as routerNavigate } from '../core/router.js';
// The rail writes `data-tooltip` and nothing else on a shell-only page imports
// the module that acts on it, so the collapsed rail had no labels at all —
// icon-only rows with nothing to read. It worked wherever <app-module-nav> or
// one of two pages happened to pull app-tooltip in transitively, which is why
// it survived a review. rail-tooltip.test.mjs is the test for exactly this,
// and it had never been run by any recipe.
import { scanTooltips } from '/common/design-system/app-tooltip/app-tooltip.js';

/* Collapsed is the default rail state. The key is versioned so the change reaches
   users who already toggled the old rail open — a stored `true` under the previous
   key would have kept them expanded forever. Toggling still persists per user. */
const RAIL_KEY = "app-rail-expanded-v2";
/* Nothing writes this any more; clear a value left by the old toggle so the
   pre-paint snippet in each page head stops reserving the expanded width. */
try { localStorage.removeItem(RAIL_KEY); } catch { /* private mode */ }

/* Detail pages have no nav item of their own — and they hide the module nav
   too, so the rail item for their module is the only selection the user gets.
   Without this the rail was left with nothing highlighted on every one of
   them (agent card, MCP server, workflow + its executions, build log,
   observability session…). Keys are normalized paths (#normalizePath), and
   every value must be a `module` key some nav item carries.

   A page whose module depends on its query params claims it at runtime with
   the `active-module` attribute instead — see chat-page. */
const PAGE_MODULES = {
  "/agent-card": "agents",
  "/add-agent-github": "agents",
  "/build": "agents",
  "/workflow": "orchestrator",
  "/workflow-new": "orchestrator",
  "/observability-session": "observability",
  "/session-trace": "observability",
  "/flow": "observability",
  "/mcp-detail": "mcp",
};

/* Collapsed is the default rail state. The key is versioned so the change reaches
   users who already toggled the old rail open — a stored `true` under the previous
   key would have kept them expanded forever. Toggling still persists per user. */

const styles = new CSSStyleSheet();
styles.replaceSync(`@keyframes ah-skel-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* view-transition-name + the frozen ::view-transition-old/new rules for this
   element live in common/global.css, NOT here. This sheet is adopted when the
   module evaluates, which is after the incoming document is snapshotted for a
   cross-document transition — naming the header here meant it had no group on
   the new page and the whole shell cross-faded on every navigation. */

@scope (app-header) {
  :scope {
    display: block;
    position: sticky;
    top: 0;
    z-index: 100;

    @media (min-width: 1024px) {
      position: fixed;
      inset: 0 0 auto 0;
      height: var(--shell-topbar-height);
    }
  }

  /* ── Topbar ─────────────────────────────────────────────────────────── */
  .topbar {
    display: flex;
    align-items: center;
    gap: var(--s-12);
    height: var(--shell-topbar-height);
    padding: 0 var(--s-12);
    background: var(--shell-bg);
    color: var(--shell-fg);
  }

  /* Dark-chrome control recipe — every topbar/rail control shares it */
  .chrome-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--s-8);
    height: var(--control-h-sm);
    min-width: var(--control-h-sm);
    padding: 0;
    border: none;
    border-radius: var(--r-6);
    background: var(--shell-control);
    color: var(--shell-fg);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background var(--transition-fast);
  }
  .chrome-btn:hover { background: var(--shell-control-hover); }
  .chrome-btn:active { background: var(--shell-control-active); }
  .chrome-btn.is-labeled { padding: 0 var(--s-12); }
  .chrome-btn:focus-visible {
    outline: 2px solid var(--shell-selected);
    outline-offset: 1px;
  }
  a.chrome-btn { text-decoration: none; color: var(--shell-fg); }

  .identity-chip {
    width: 36px;
    height: 36px;
    border-radius: var(--r-8);
    background: var(--blue-600);
    color: var(--white);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 600;
    flex-shrink: 0;
    user-select: none;
  }

  .nav-cluster {
    display: flex;
    align-items: center;
    gap: var(--s-12);
  }

  .search-field {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    width: 280px;
    height: var(--control-h-sm);
    padding: 0 var(--s-12);
    border: none;
    border-radius: var(--r-8);
    background: var(--shell-control);
    color: var(--shell-fg);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .search-field:hover { background: var(--shell-control-hover); }
  .search-field .placeholder {
    flex: 1;
    color: var(--shell-fg-muted);
    white-space: nowrap;
    overflow: hidden;
  }
  .search-field .kbd-hint { color: var(--shell-fg-muted); font-size: 13px; }
  .search-field svg { color: var(--shell-fg-muted); }

  .topbar-spacer { flex: 1; }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: var(--s-12);
  }

  /* Small screens: drop the history cluster, let search flex, keep menu */
  @media (max-width: 1023.98px) {
    .nav-cluster { display: none; }
    /* Rail is hidden below 1024px, so its toggle would just duplicate the
       mobile menu button. */
    [data-rail-toggle] { display: none; }
    .search-field { width: auto; flex: 1; min-width: 0; }
    .search-field .kbd-hint { display: none; }
    .topbar-spacer { display: none; }
    .topbar-right a.chrome-btn.is-labeled { display: none; }
  }

  /* ── Rail ───────────────────────────────────────────────────────────── */
  .rail {
    display: none;

    @media (min-width: 1024px) {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: var(--s-12);
      position: fixed;
      top: var(--shell-topbar-height);
      bottom: 0;
      /* Floats inside the shell gutter rather than sitting flush at left:0, so
         the ink frame around the content card is even on all three open sides.
         Width is the 32px button column only — the gutters live outside it. */
      left: var(--shell-gutter);
      width: var(--app-sidebar-width);
      /* Top gutter matches the design's padding-top:12px on both rails — the
         first item sits 12px below the topbar, not flush against it. */
      padding: var(--shell-gutter) 0;
      background: var(--shell-bg);
      color: var(--shell-fg);
      /* Collapsed rail must not clip: the hover pill sits outside its 32px column,
         and any scroll container here would cut it off.
         ponytail: an icon-only rail is short enough not to scroll. If a deployment
         ever exceeds a viewport of rail items, move the pill to the top layer
         (popover / anchor positioning) and put overflow-y:auto back. */
      overflow: visible;
      scrollbar-width: none;
      transition: width var(--transition-base);
    }

    @media (prefers-reduced-motion: reduce) {
      .rail { transition: none; }
    }
  }
  .rail::-webkit-scrollbar { display: none; }

  .rail-item {
    display: flex;
    align-items: center;
    gap: var(--s-12);
    height: var(--control-h-md);
    min-height: var(--control-h-md);
    width: var(--control-h-md);
    padding: 0;
    justify-content: center;
    border: none;
    border-radius: var(--r-8);
    /* Selection is a fill, not a hue shift. The old rail had it inverted —
       every *inactive* item carried a raised chip and the active one was the
       only bare surface, so at 18px the pale-gold glyph was the sole signal and
       it failed first without colour vision. Rest is now bare, hover raises,
       active fills gold — which is also what the expanded rail already did, so
       the two rails finally agree instead of contradicting each other. */
    background: transparent;
    color: var(--shell-fg-muted);
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
    white-space: nowrap;
  }
  .rail-item:hover { background: var(--shell-control-hover); color: var(--shell-fg); }
  .rail-item:active { background: var(--shell-control-active); }
  .rail-item.is-active {
    background: var(--shell-selected);
    color: var(--sand-900);
  }
  .rail-item.is-active:hover {
    background: var(--shell-selected);
    color: var(--sand-900);
  }
  /* White, not --shell-selected: the ring sits 1px outside the item, so gold
     merged into the gold fill on the one item most likely to be focused. */
  .rail-item:focus-visible {
    outline: 2px solid var(--shell-fg);
    outline-offset: 1px;
  }
  .rail-item .rail-label { display: none; }

  /* Instant hover label for the collapsed rail comes from the data-tooltip
     attribute and app-tooltip.js — the native title= tip only appears after ~1s, too late to
     be the label. No ::after pill here: this sheet used to draw one from
     attr(data-tip), an attribute the markup never emitted, so every rail item
     grew an empty dark box on hover beside the real tooltip.

     It anchors to the right (data-tooltip-placement) rather than below: the
     collapsed rail is a 32px column against the viewport's left edge, so below
     the item there is another item, and beside it there is the whole page. The
     expanded rail drops the attribute entirely — see #applyExpanded. */
  .rail-item { position: relative; }

  /* Expanded rail keeps its scroll container — labelled rows are tall, no pill. */
  :scope.is-expanded .rail {
    overflow-y: auto;
    overflow-x: hidden;
  }
  :scope.is-expanded .rail-item {
    width: 100%;
    justify-content: flex-start;
    padding: 0 var(--s-8);
  }
  :scope.is-expanded .rail-item .rail-label { display: inline; }

  /* Labels fade in when the user TOGGLES the rail open — gated on .is-toggling,
     which only the toggle handler sets. Ungated, this replayed on every fresh
     render, so each MPA navigation held every label at opacity 0 for 60ms and
     then faded it back in: the expanded rail blinked on every click. It also
     meant the incoming page was snapshotted for the cross-document view
     transition with invisible labels. */
  :scope.is-expanded.is-toggling .rail-item .rail-label,
  :scope.is-expanded.is-toggling .rail-identity .user-info {
    animation: panel-in var(--transition-base) 60ms backwards;
  }

  @media (prefers-reduced-motion: reduce) {
    :scope.is-expanded.is-toggling .rail-item .rail-label,
    :scope.is-expanded.is-toggling .rail-identity .user-info { animation: none; }
  }

  .rail-bottom {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: var(--s-12);
  }

  .rail-identity {
    display: flex;
    align-items: center;
  }
  /* The menu button IS the row — it renders the name itself when the rail is
     expanded. It used to be a 32px avatar next to an inert .identity-name
     span, so two thirds of the row swallowed clicks. */
  .rail-identity app-user-menu {
    flex: 1;
    min-width: 0;
    /* Match the 32px rail buttons: square avatar aligned to the icon column. */
    --user-btn-w: var(--control-h-md);
    --user-btn-h: var(--control-h-md);
    --user-avatar-size: 30px;
    --user-avatar-radius: var(--r-6);
    --user-name-display: none;
    /* The rail scroll-clips absolute descendants — open the menu as a
       viewport-fixed flyout beside the rail's bottom cluster instead.
       ('auto', not 'unset': a CSS-wide keyword in a custom property makes it
       guaranteed-invalid, so var() would take its fallback instead.) */
    --user-dropdown-position: fixed;
    --user-dropdown-top: auto;
    --user-dropdown-bottom: var(--s-12);
    --user-dropdown-left: calc(var(--shell-gutter) + var(--app-sidebar-width) + var(--s-4));
    --user-dropdown-right: auto;
  }
  /* Expanded: the trigger stretches to the full rail width and shows the name,
     email and chevron, so the whole row is one hit target. */
  :scope.is-expanded .rail-identity app-user-menu {
    --user-name-display: flex;
    --user-btn-w: 100%;
    --user-btn-h: auto;
    --user-btn-justify: flex-start;
    --user-btn-padding: var(--s-4) var(--s-8);
  }

  /* ── Mobile ─────────────────────────────────────────────────────────── */
  .mobile-nav {
    display: none;
  }
  :scope.mobile-open .mobile-nav {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-8) var(--s-12) var(--s-12);
    background: var(--shell-bg);
  }
  .mobile-nav .rail-item {
    width: 100%;
    justify-content: flex-start;
    padding: 0 var(--s-8);
  }
  .mobile-nav .rail-item .rail-label { display: inline; }

  /* The account row, same as the rail's bottom cluster — the rail is
     display:none below 1024px, so this was the one thing on it with no other
     way in: no user menu meant no sign out on a small screen at all. Styled
     like the expanded rail (full-width row, name visible) and left with the
     default dropdown position: the sheet sits at the top of the page, so the
     rail's viewport-bottom flyout would open nowhere near its button. */
  .mobile-nav .rail-identity {
    margin-top: var(--s-8);
    padding-top: var(--s-8);
    border-top: 1px solid var(--shell-border-subtle, rgba(255,255,255,0.08));
  }
  .mobile-nav .rail-identity app-user-menu {
    --user-name-display: flex;
    --user-btn-w: 100%;
    --user-btn-h: auto;
    --user-btn-justify: flex-start;
    --user-btn-padding: var(--s-4) var(--s-8);
    --user-dropdown-position: absolute;
    --user-dropdown-top: calc(100% + var(--s-4));
    --user-dropdown-bottom: auto;
    --user-dropdown-left: 0;
    --user-dropdown-right: 0;
  }

  .mobile-menu-btn { display: inline-flex; }

  @media (min-width: 1024px) {
    .mobile-menu-btn { display: none; }
    .mobile-nav, :scope.mobile-open .mobile-nav { display: none; }
  }

  /* ── Skeleton ───────────────────────────────────────────────────────── */
  .rail-skel {
    height: var(--control-h-md);
    width: var(--control-h-md);
    border-radius: var(--r-8);
    background: var(--shell-control);
    animation: ah-skel-pulse 1.4s ease-in-out infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
      opacity: 0.4;
    }
  }
}`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppHeader extends HTMLElement {
  /* The rail is collapsed, full stop — the expand toggle is commented out
     below (button markup, click branch, ⌘B). Restore all four together if the
     expanded rail comes back; everything that renders it (.is-expanded CSS,
     #applyExpanded, #syncRailTooltips) is left intact and simply unreached.
     ponytail: the stored flag is dropped rather than honoured, so the
     pre-paint snippet in every page head stops widening the gutter for users
     who had toggled it open. */
  #expanded = false;
  #mobileOpen = false;
  #toggleTimer = 0;

  #handleKeyDown = (e) => {
    // ⌘B is the conventional sidebar toggle and the browser does not bind it.
    // Additive only — the topbar button is unchanged and remains the discoverable
    // way in; this is the shortcut people expect to already work.
    // if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
    //   e.preventDefault();
    //   this.#toggleRail();
    //   return;
    // }
    const isShortcut =
      ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "f")) || e.key === "\\";
    if (isShortcut) {
      const navSearch = this.querySelector("app-nav-search");
      if (!navSearch) return;
      e.preventDefault();
      if (!navSearch.querySelector("[data-nav-dialog]")?.open) navSearch.open();
    }
  };

  /** Route pattern of the last route-change, so the handler can tell a real
   *  page change from a query-only one (/chat?session_id=A → …=B, which the
   *  router serves by updating the mounted page rather than remounting it). */
  #lastPattern = null;

  /** Drop the per-tab nav cache and repaint. See the listener in connectedCallback. */
  #onNavRefresh = async () => {
    try { sessionStorage.removeItem("app-header-nav"); } catch { /* private mode */ }
    await this.loadNavigation();
    this.render();
  };

  #onRouteChange = (e) => {
    // `active-module` belongs to the page that set it, and the page that set it
    // sets it once, from connectedCallback. Clearing it on every route-change
    // would therefore strip the rail highlight when the user moves between two
    // sessions of the same page; not clearing it at all leaves Orchestrator lit
    // next to the rail item of whatever page came after the chat. Clear it when
    // the pattern actually changes — the router dispatches this before it mounts
    // the next page, so the new page's own write always lands after.
    const pattern = e?.detail?.pattern ?? null;
    if (this.#lastPattern !== null && pattern !== this.#lastPattern) {
      if (this.hasAttribute("active-module")) this.removeAttribute("active-module");
    }
    this.#lastPattern = pattern;

    // Update rail active indicators and mobile nav highlights.
    // The module fallback has to be reapplied here, not just in #railItem:
    // under the client router the rail is rendered once and only this handler
    // runs on navigation, so recomputing from #isActive alone dropped the
    // parent highlight and left the rail blank on every child route.
    const activeModule = this.#activeModule(this.#navLinks());
    this.querySelectorAll(".rail-item").forEach((a) => {
      const module = a.dataset.module;
      const active = this.#isActive(a.getAttribute("href"))
        || (!!module && module === activeModule);
      a.classList.toggle("is-active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    // Close mobile nav on navigation
    if (this.#mobileOpen) {
      this.#mobileOpen = false;
      this.classList.remove("mobile-open");
    }
  };

  #handleClick = (e) => {
    // if (e.target.closest("[data-rail-toggle]")) {
    //   this.#toggleRail();
    //   return;
    // }
    if (e.target.closest("[data-mobile-menu]")) {
      this.#mobileOpen = !this.#mobileOpen;
      this.classList.toggle("mobile-open", this.#mobileOpen);
      return;
    }
    if (e.target.closest("[data-search-trigger]")) {
      this.querySelector("app-nav-search")?.open();
      return;
    }
    if (e.target.closest("[data-nav-back]")) { window.history.back(); return; }
    if (e.target.closest("[data-nav-fwd]")) { window.history.forward(); return; }
    const link = e.target.closest(".rail-item[href]");
    if (link && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) {
      e.preventDefault();
      routerNavigate(link.href);
    }
  };

  /** The button and ⌘B are the same action, so they share one path.
   *  Unreached while the toggle is commented out — see #expanded. */
  // #toggleRail() {
  //   this.#expanded = !this.#expanded;
  //   localStorage.setItem(RAIL_KEY, this.#expanded);
  //   this.#applyExpanded({ animate: true });
  // }

  /**
   * Up and Down walk the rail, Home/End jump to its ends — the same axis the
   * module nav answers to, since to the user they are one column of navigation.
   * Tab order is untouched; this only adds the keys a list implies.
   */
  #handleRailKeyDown = (e) => {
    const item = e.target.closest(".rail-item");
    if (!item) return;
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    const items = [...this.querySelectorAll(".rail .rail-item")];
    if (!items.length) return;
    e.preventDefault();
    if (e.key === "Home") { items[0].focus(); return; }
    if (e.key === "End") { items[items.length - 1].focus(); return; }
    const at = items.indexOf(item);
    items[Math.min(items.length - 1, Math.max(0, at + step))]?.focus();
  };

  /** `animate` is the user hitting the toggle; a page load must not animate. */
  #applyExpanded({ animate = false } = {}) {
    if (animate) {
      this.classList.add("is-toggling");
      // ponytail: a timer, not animationend — the labels animate as one group
      // with a 60ms delay, so one fixed clear beats N listeners. Bump if
      // panel-in's duration/delay changes.
      clearTimeout(this.#toggleTimer);
      this.#toggleTimer = setTimeout(() => this.classList.remove("is-toggling"), 400);
    }
    this.classList.toggle("is-expanded", this.#expanded);
    this.querySelector("[data-rail-toggle]")?.setAttribute("aria-expanded", String(this.#expanded));
    this.#syncRailTooltips();
    document.documentElement.style.setProperty(
      "--app-sidebar-width",
      this.#expanded ? "var(--app-sidebar-width-expanded)" : "var(--app-sidebar-width-collapsed)"
    );
  }

  /**
   * A rail item labels itself with a tooltip only while it is an icon.
   *
   * Expanded, the row carries the label, so a tooltip repeats it on top of the
   * page — and toggling the rail does not re-render, so the attribute is synced
   * here rather than only being decided in #railItem. The label is read from
   * aria-label, which every rail item carries and which never changes.
   */
  #syncRailTooltips() {
    for (const item of this.querySelectorAll(".rail .rail-item")) {
      if (this.#expanded) {
        item.removeAttribute("data-tooltip");
        continue;
      }
      const label = item.getAttribute("aria-label");
      if (label) item.dataset.tooltip = label;
      item.dataset.tooltipPlacement = "right";
    }
    // app-tooltip's MutationObserver only sees `data-tooltip` on a node as it
    // is inserted. A rail that first painted expanded carries no attribute at
    // that moment, so collapsing it later has to attach explicitly. scanTooltips
    // tracks what it has bound in a WeakSet, so re-running it is idempotent.
    if (!this.#expanded) scanTooltips(this);
  }

  static get observedAttributes() {
    return ["nav-links", "brand-title", "brand-url", "active-module"];
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  async connectedCallback() {
    this.#applyExpanded();
    document.removeEventListener("keydown", this.#handleKeyDown);
    this.removeEventListener("click", this.#handleClick);
    this.addEventListener("click", this.#handleClick);
    this.removeEventListener("keydown", this.#handleRailKeyDown);
    this.addEventListener("keydown", this.#handleRailKeyDown);
    // SPA: re-render active states when the router changes the page
    document.removeEventListener("route-change", this.#onRouteChange);
    document.addEventListener("route-change", this.#onRouteChange);
    // The nav is cached per tab, so anything that *changes* what belongs in it
    // has to say so — the rail can't discover a new entry on its own. First
    // caller: saving a generated view, which creates the Custom Views entry.
    document.removeEventListener("nav-refresh", this.#onNavRefresh);
    document.addEventListener("nav-refresh", this.#onNavRefresh);
    if (this.getAttribute("nav-links")) {
      this.render();
      document.addEventListener("keydown", this.#handleKeyDown);
      return;
    }
    const cached = sessionStorage.getItem("app-header-nav");
    if (cached) {
      try { this.navItems = JSON.parse(cached); } catch { /* ignore bad cache */ }
    }
    // Identity comes from a per-tab cache too, so a warm shell renders
    // complete on the first pass — see auth-service.
    const hadUser = authService.isAuthenticated();
    const renderedFromCache = Boolean(this.navItems?.length);
    if (renderedFromCache) {
      this.render();
    } else {
      this.#renderSkeleton();
    }

    const before = renderedFromCache ? JSON.stringify(this.navItems) : null;
    await Promise.all([this.loadNavigation(), authService.fetchCurrentUser()]);

    // Re-rendering an identical shell is what made the sidebar visibly rebuild
    // on every MPA navigation (losing hover/focus and flashing). Only repaint
    // when the nav or the identity actually changed.
    const navChanged = before !== JSON.stringify(this.navItems);
    const userArrived = !hadUser && authService.isAuthenticated();
    if (!renderedFromCache || navChanged || userArrived) {
      this.render();
    }
    document.addEventListener("keydown", this.#handleKeyDown);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.#handleKeyDown);
    document.removeEventListener("nav-refresh", this.#onNavRefresh);
    this.removeEventListener("click", this.#handleClick);
    this.removeEventListener("keydown", this.#handleRailKeyDown);
    clearTimeout(this.#toggleTimer);
  }

  async loadNavigation() {
    if (this.getAttribute("nav-links")) return;
    try {
      const nav = await callOptional('fetchNavigation');
      if (nav) {
        this.navItems = nav;
        try { sessionStorage.setItem("app-header-nav", JSON.stringify(this.navItems)); } catch { /* quota exceeded */ }
      } else {
        if (!this.navItems) this.navItems = [];
      }
    } catch (e) {
      console.warn("fetchNavigation failed:", e);
      if (!this.navItems) this.navItems = [];
    }
  }

  #normalizePath(p) {
    return p
      .replace(/\/index\.html$/, "/")
      .replace(/\.html$/, "")
      .replace(/\/+$/, "") || "/";
  }

  /** Returns true if href matches the current page, tolerating user-prefix differences. */
  #isActive(href) {
    const current = this.#normalizePath(window.location.pathname);
    const target = this.#normalizePath(href);
    if (target === current) return true;
    const currentBase = current.split("/").pop();
    const targetBase = target.split("/").pop();
    return !!currentBase && currentBase === targetBase;
  }

  #initials() {
    const user = authService.getCurrentUser() || "";
    const parts = user.split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return "N";
    return parts.slice(0, 2).map(p => p[0].toUpperCase()).join("");
  }

  #navLinks() {
    const navLinksJson = this.getAttribute("nav-links");
    if (navLinksJson) {
      try { return JSON.parse(navLinksJson); } catch (e) {
        console.error("Invalid nav-links JSON:", e);
        return [];
      }
    }
    return this.navItems || [];
  }

  /** Nav `module` of the page being viewed, so its rail parent stays selected.
   *
   *  A path match wins. Where there is none the page may name its own module
   *  through the `active-module` attribute: a chat transcript is a session
   *  rather than a place, so `/chat` is deliberately absent from
   *  `fetchNavigation`, and chat-page.js:55 has always set that attribute for
   *  exactly this. `observedAttributes` listed it from the start and nothing
   *  ever read it, so the write only triggered a re-render that recomputed the
   *  same empty answer — which is why opening a session left the rail with
   *  nothing selected. `#onRouteChange` drops the attribute when the route
   *  pattern changes, so it cannot outlive the page that claimed it. */
  #activeModule(navLinks) {
    return navLinks.find(l => this.#isActive(l.url))?.module
      || this.getAttribute("active-module")
      || PAGE_MODULES[this.#normalizePath(window.location.pathname)]
      || undefined;
  }

  /** `tooltip: false` for the mobile sheet — those rows show their own labels. */
  #railItem(link, activeModule, { tooltip = true } = {}) {
    const href = link.url;
    // A child page (Workflows, Builds, Import agent, Secrets, Team access …)
    // has no rail item of its own; the rail item for its module carries the
    // selection instead, so the rail is never left with nothing highlighted.
    const active = this.#isActive(href) || (!!link.module && link.module === activeModule);
    const titleEsc = escHtml(link.title);
    // Chrome icons (rail + topbar) render at 1px stroke per the NightOwl weight rule.
    // Rail glyphs: 1.25 stroke — the mockup's 1px chrome weight reads wispy at
    // 18px on the ink rail; topbar utility icons stay at 1.
    const iconHtml = link.icon && icons[link.icon] ? icons[link.icon]('', 18, 1.75) : icons.cube('', 18, 1.75);
    // No data-tooltip while the rail is expanded: the row is already showing
    // this exact string, so a tooltip would only cover the page with it. The
    // attribute is also synced on toggle (#applyExpanded), since toggling does
    // not re-render.
    const tip = tooltip && !this.#expanded
      ? ` data-tooltip="${titleEsc}" data-tooltip-placement="right"`
      : "";
    return `<a href="${escHtml(href)}" class="rail-item${active ? " is-active" : ""}"
      aria-label="${titleEsc}"${tip}${link.module ? ` data-module="${escHtml(link.module)}"` : ""} ${active ? 'aria-current="page"' : ""}>${iconHtml}<span class="rail-label">${titleEsc}</span></a>`;
  }

  #renderSkeleton() {
    this.innerHTML = `
      <header class="topbar" role="banner">
        <span class="identity-chip" aria-hidden="true"></span>
      </header>
      <nav class="rail" aria-label="Main navigation" aria-busy="true">
        ${Array.from({ length: 6 }, () => `<span class="rail-skel" aria-hidden="true"></span>`).join("")}
      </nav>
    `;
  }

  render() {
    const navLinks = this.#navLinks().filter((link) => {
      if (link.hidden) return false;
      const urlLower = (link.url || "").toLowerCase();
      return !urlLower.includes("/login") && !urlLower.includes("/admin");
    });
    const isAuthenticated = authService.isAuthenticated();
    const currentUser = authService.getCurrentUser();

    const settingsLinks = navLinks.filter(l => /settings/i.test(l.title));
    const mainLinks = navLinks.filter(l => !settingsLinks.includes(l));
    const addAgent = mainLinks.find(l => /add agent/i.test(l.title));
    // Rail shows module-level entries (rail: true); when no item carries the
    // flag (attribute-driven navs, EE overrides) every link is a rail item.
    const hasRailFlags = mainLinks.some(l => l.rail);
    const railLinks = mainLinks.filter(l => l !== addAgent && (!hasRailFlags || l.rail));
    const activeModule = this.#activeModule(navLinks);

    this.innerHTML = `
      <a href="#main-content" class="sr-only is-focusable">Skip to main content</a>
      <header class="topbar" role="banner">
        ${window.nasikoChrome?.workspaceSwitcher
          ? `<workspace-switcher></workspace-switcher>`
          : `<span class="identity-chip" title="${escHtml(currentUser || "Nasiko")}">${escHtml(this.#initials())}</span>`}
        <!-- <button class="chrome-btn" data-rail-toggle aria-label="Toggle sidebar" type="button"
          aria-expanded="\${this.#expanded}">
          \${icons.panelLeft("", 16, 1)}
        </button> -->
        <div class="nav-cluster">
          <button class="chrome-btn" data-nav-back aria-label="Back" type="button">${icons.chevronLeft("", 16, 1)}</button>
          <button class="chrome-btn" data-nav-fwd aria-label="Forward" type="button">${icons.chevronRight("", 16, 1)}</button>
        </div>
        ${navLinks.length ? `
        <button class="search-field" data-search-trigger type="button" aria-label="Search pages">
          ${icons.search("", 16, 1)}
          <span class="placeholder">Search anything...</span>
          <span class="kbd-hint">\u2318F</span>
        </button>` : ""}
        <span class="topbar-spacer"></span>
        <div class="topbar-right">
          ${addAgent ? `<a href="${escHtml(addAgent.url)}" class="chrome-btn is-labeled">${icons.plus("", 16, 1)} Import agent</a>` : ""}
          <button class="chrome-btn mobile-menu-btn" data-mobile-menu aria-label="Menu" type="button">${icons.menu("", 16, 1)}</button>
        </div>
      </header>
      <nav class="rail" aria-label="Main navigation">
        ${railLinks.map(l => this.#railItem(l, activeModule)).join("")}
        <div class="rail-bottom">
          ${settingsLinks.map(l => this.#railItem(l, activeModule)).join("")}
          ${isAuthenticated ? `
          <div class="rail-identity">
            <app-user-menu current-user="${escHtml(currentUser)}"></app-user-menu>
          </div>` : ""}
        </div>
      </nav>
      <!-- Same set as the rail, not every link: the sheet used to list all of
           them, so two rows of one module (Secrets and Settings both carry
           module "settings") lit up together — a selection the rail can never
           show. Non-rail pages are reached the way they are on desktop, through
           the module navs and the search field. -->
      <div class="mobile-nav">
        ${railLinks.concat(settingsLinks).map(l => this.#railItem(l, activeModule, { tooltip: false })).join("")}
        ${isAuthenticated ? `
        <div class="rail-identity">
          <app-user-menu current-user="${escHtml(currentUser)}"></app-user-menu>
        </div>` : ""}
      </div>
      ${navLinks.length ? `<app-nav-search></app-nav-search>` : ""}
    `;

    // The skip link above targets #main-content, which no page actually
    // declares — adopt the page component instead of editing 40 HTML files.
    // tabindex=-1 so the link moves focus, not just the scroll position.
    const main = this.nextElementSibling;
    if (main && !main.id) {
      main.id = "main-content";
      main.tabIndex = -1;
    }

    // Two instances now — the rail's and the mobile sheet's, each visible at
    // its own width. querySelector wired only the first, so whichever one the
    // viewport was actually showing could be the inert one.
    for (const userMenu of this.querySelectorAll("app-user-menu")) {
      userMenu.users = authService.getUsers();
      userMenu.addEventListener("user-remove", (e) =>
        this.#removeUser(e.detail.username),
      );
      userMenu.addEventListener("user-add-account", () => this.#addAccount());
      userMenu.addEventListener("user-change-password", () => this.#changePassword());
      userMenu.addEventListener("user-logout", () => this.#logout());
    }

    const navSearch = this.querySelector("app-nav-search");
    if (navSearch) {
      navSearch.navLinks = navLinks;
      navSearch.userPrefix = "";
      // The palette drops down anchored under the topbar search field.
      navSearch.anchorEl = this.querySelector("[data-search-trigger]");
      navSearch.addEventListener("navigate", (e) => {
        e.detail.newTab
          ? window.open(e.detail.url, "_blank")
          : routerNavigate(e.detail.url);
      });
    }
  }

  async #removeUser(username) {
    const confirmed = await confirmDialog({
      title: 'Remove account',
      message: `Remove the saved session for <strong>${username}</strong>?`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (confirmed) {
      authService.removeUserSession(username);
      const users = authService.getUsers();
      for (const userMenu of this.querySelectorAll("app-user-menu")) userMenu.users = users;
    }
  }

  #addAccount() {
    window.location.href =
      "/login/?add_account=true&redirect=" +
      encodeURIComponent(window.location.pathname);
  }

  /// Lazily mounted on first use and kept for the life of the header — both
  /// `app-user-menu` instances (mobile and desktop) share the one dialog.
  #changePassword() {
    let modal = document.querySelector("change-password-modal");
    if (!modal) {
      modal = document.createElement("change-password-modal");
      document.body.appendChild(modal);
    }
    modal.open();
  }

  async #logout() {
    const currentUser = authService.getCurrentUser();
    if (currentUser) {
      const confirmed = await confirmDialog({
        title: 'Sign out',
        message: 'Are you sure you want to sign out?',
        confirmLabel: 'Sign out',
      });
      if (!confirmed) return;
    }
    authService.logout();
  }
}

customElements.define("app-header", AppHeader);
