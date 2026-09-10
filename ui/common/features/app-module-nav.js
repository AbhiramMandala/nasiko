/**
 * In-card module tree navigation (NightOwl): module icon + title header,
 * collapsible groups, and 28px rows with a sand-100 active state.
 *
 * Data comes from `fetchModuleNav` via data-sources (navigation.js), which
 * resolves to `{ title, icon, groups: [{ label, items }] }` where an item is
 * either `{ label, url }` (link, active by path match) or
 * `{ label, section }` (in-page section — clicking dispatches a bubbling
 * `module-nav-select` CustomEvent with `{ section }` for the host page).
 * A link item may also carry `sessionId` (orchestrator chats): that row gets a
 * delete button which removes the chat server-side and drops the row.
 *
 * Desktop (≥1024px): a 200px column pinned to the content card's left edge —
 * the host page component gets matching left padding from
 * `common/styles/page-layout.css`. Mobile: a collapsible disclosure in normal
 * flow above the page content.
 *
 * @element app-module-nav
 * @attr {string} module - Key passed to `fetchModuleNav` via data-sources.
 * @attr {string} active-section - Section key rendered as active (for pages
 *                                 whose sections are tabs, e.g. Settings).
 * @fires module-nav-select - `{ detail: { section } }` on section item click.
 */
import { navigate as routerNavigate } from '../core/router.js';
import { icons } from "../utils/icons.js";
import { escHtml } from '/common/utils/escape.js';
import { callOptional } from '../core/data-sources.js';
import { scanTooltips } from '/common/design-system/app-tooltip/app-tooltip.js';
import { initialView, syncView, VIEW_PARAM } from '../utils/module-view.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`/* Host-page layout contract: the page component that contains a module nav is
   the white content card; the nav pins inside its left padding. The gutter
   itself (the host's padding-left) is page geometry and lives in
   common/styles/page-layout.css — it has to exist at first paint, and this
   sheet only arrives with this module. What is left here is how the nav fills
   that gutter, which is inert until the nav upgrades anyway. */
@media (min-width: 1024px) {
  body:has(> app-header) > :not(app-header):has(> app-module-nav),
  body:has(> app-header) > #outlet > :has(> app-module-nav) {
    position: relative;
  }
  body:has(> app-header) > :not(app-header) > app-module-nav,
  body:has(> app-header) > #outlet > * > app-module-nav {
    position: absolute;
    top: var(--s-24);
    left: var(--s-24);
    bottom: var(--s-24);
    width: 200px;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
  }
}

app-module-nav:not(:defined) { display: block; }

@scope (app-module-nav) {
  :scope {
    display: block;
    font-family: var(--font-sans);
  }

  .mod-head {
    display: flex;
    align-items: center;
    gap: var(--s-8);
    height: var(--control-h-sm);
    padding: 0 var(--s-4);
    color: var(--fg-primary);
  }
  .mod-head svg { flex-shrink: 0; color: var(--fg-primary); }
  .mod-title {
    font-size: 14px;
    line-height: 20px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mod-groups {
    display: flex;
    flex-direction: column;
    gap: var(--s-8);
    margin-top: var(--s-8);
  }

  .group { display: flex; flex-direction: column; gap: var(--s-4); }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h-sm);
    min-height: var(--control-h-sm);
    padding: 0 var(--s-8);
    border: none;
    border-radius: var(--r-8);
    background: transparent;
    font-family: inherit;
    font-size: 13px;
    line-height: 18px;
    letter-spacing: 0.16px;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    color: var(--fg-secondary);
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .row:hover { background: var(--bg-input); }
  .row:focus-visible {
    outline: 2px solid var(--fg-brand);
    outline-offset: -2px;
  }
  .row .row-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .group-head {
    color: var(--fg-primary);
    font-weight: 500;
  }
  .group-head .chev {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--fg-secondary);
    transition: rotate var(--transition-fast);
  }
  .group.is-collapsed .group-head .chev { rotate: -90deg; }

  /* Collapsible children: grid-rows 1fr→0fr animates without JS measuring */
  .group-items {
    display: grid;
    grid-template-rows: 1fr;
    transition: grid-template-rows var(--transition-base);
  }
  .group.is-collapsed .group-items { grid-template-rows: 0fr; }
  .group-items > .items-clip {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    min-height: 0;
    overflow: hidden;
  }

  .child { padding-left: 26px; }
  /* Keyed on .row, not .child: an itemless group renders as a heading-level
     link row (#groupHtml) and takes the same active state. */
  .row.is-active {
    background: var(--bg-surface-hover);
    color: var(--fg-primary);
    font-weight: 500;
  }
  .row.is-active:hover { background: var(--bg-surface-hover); }

  /* A row with a delete button (orchestrator session rows). The button is a
     sibling of the link, not a child: interactive content cannot nest inside an
     anchor. It overlays the row's right edge and appears only while that row is
     hovered or holds focus, so forty chat titles are not forty trash icons.

     One block on purpose. This was two: a later one added inset-block: 0 and a
     new width without clearing the earlier one's height: 20px, top: 50% and
     translate: 0 -50%. Over-constrained top/bottom/height resolves in favour of
     height, so the surviving translate lifted every session row's button half
     its height above the row it belonged to — the trash icon sat clipped against
     the row above. Keep the geometry in one place.

     No backticks in this sheet, ever: it is a template literal, so one closes
     the string and the module stops parsing. */
  .row-del-wrap {
    position: relative;
    display: flex;
    min-width: 0;
  }
  /* Reserved always, not on hover. Padding that arrives with the button
     re-truncates the title under the cursor, which reads as the text twitching. */
  .row-del-wrap .row { flex: 1; min-width: 0; padding-right: 26px; }
  .row-del {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    padding: 0;
    border: none;
    border-radius: var(--r-6);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    opacity: 0;
    /* A control nobody can see must not be clickable. The button sits over the
       row's last 26px whether or not it is showing, so without this the right
       edge of every session row swallowed the click that was meant to open the
       chat and ran delete instead — the row looked inert when the delete call
       did not succeed. Focus still reaches it by keyboard: pointer-events does
       not affect Tab, and :focus-within re-enables it anyway. */
    pointer-events: none;
    transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  }
  .row-del-wrap:hover .row-del,
  .row-del-wrap:focus-within .row-del { opacity: 1; pointer-events: auto; }
  /* Coarse pointers never hover, so a reveal-on-hover control is either
     permanently invisible or — before the rule above — an invisible tap target
     that deleted the chat the user was trying to open. Show it outright there
     and let the row's reserved padding hold it. */
  @media (hover: none) {
    .row-del { opacity: 1; pointer-events: auto; }
  }
  .row-del:hover { background: var(--bg-input); color: var(--color-error); }
  .row-del:focus-visible {
    opacity: 1;
    outline: 2px solid var(--fg-brand);
    outline-offset: -2px;
  }
  .row-del[disabled] { opacity: 0.4; cursor: progress; }

  /* Skeleton while fetchModuleNav resolves */
  .skel-row {
    height: var(--control-h-sm);
    border-radius: var(--r-8);
    background: var(--bg-input);
    animation: amn-pulse 1.4s ease-in-out infinite;
  }
  .skel-row.is-head { width: 70%; }

  /* Mobile: disclosure above the page content */
  .mobile-toggle { display: none; }
  @media (max-width: 1023.98px) {
    :scope {
      margin-bottom: var(--s-16);
      border: 1px solid var(--border-primary);
      border-radius: var(--r-8);
      padding: var(--s-8);
    }
    .mobile-toggle {
      display: flex;
      width: 100%;
      align-items: center;
      gap: var(--s-8);
      border: none;
      background: transparent;
      font-family: inherit;
      cursor: pointer;
      padding: 0 var(--s-4);
    }
    .mobile-toggle .chev {
      display: inline-flex;
      margin-left: auto;
      color: var(--fg-secondary);
      transition: rotate var(--transition-fast);
    }
    :scope:not(.mobile-open) .mod-head { display: none; }
    :scope:not(.mobile-open) .mod-groups { display: none; }
    :scope.mobile-open .mobile-toggle .chev { rotate: 180deg; }
    :scope.mobile-open .mod-head { display: none; }
  }
  @media (min-width: 1024px) {
    .mobile-toggle { display: none !important; }
  }

  @media (prefers-reduced-motion: reduce) {
    .row, .row-del, .group-head .chev, .group-items, .mobile-toggle .chev { transition: none; }
    .skel-row { animation: none; opacity: 0.6; }
  }
}

@keyframes amn-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/* Collapsed groups outlive the element. 20 page components render
   `<app-module-nav>` inside their own innerHTML, so every data refresh
   destroys this element and builds a new one — per-instance state meant a
   group the user had closed sprang back open each time, which reads as the
   sidebar resetting itself.
   ponytail: keyed by module in memory, which is all an MPA page lifetime
   needs. The structural fix is to stop page components owning this markup —
   see the note on #load(). */
const COLLAPSED = new Map();

export class AppModuleNav extends HTMLElement {
  #nav = null;
  #mobileOpen = false;
  #tooltipFrame = 0;
  /** Session whose chat is open in a page that is not /chat — the orchestrator
   *  page holds a live chat at its own url, so its row cannot be found by the
   *  href match every other row uses. */
  #activeSessionId = null;

  get #collapsed() {
    const module = this.getAttribute("module") || "";
    let set = COLLAPSED.get(module);
    if (!set) COLLAPSED.set(module, (set = new Set()));
    return set;
  }

  static get observedAttributes() {
    return ["module", "active-section"];
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === "module") this.#load();
    else this.#applyActiveSection();
  }

  /** The active section is only ever a class on one row, so move the class
   *  instead of rebuilding the whole tree on every section click. */
  #applyActiveSection() {
    const active = this.getAttribute("active-section");
    for (const row of this.querySelectorAll("[data-section]")) {
      const on = row.dataset.section === active;
      row.classList.toggle("is-active", on);
      if (on) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    }
  }

  connectedCallback() {
    this.addEventListener("click", this.#handleClick);
    this.addEventListener("keydown", this.#handleKeyDown);
    // SPA: update active state when the router changes page
    document.removeEventListener("route-change", this.#onRouteChange);
    document.addEventListener("route-change", this.#onRouteChange);
    // A chat started on this page mints a session server-side; without this the
    // Session group only appeared on the next load of the tree (a nav or a
    // refresh), so the chat the user was looking at was missing from the list.
    document.addEventListener("session-created", this.#onSessionCreated);
    this.#load();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.#handleClick);
    this.removeEventListener("keydown", this.#handleKeyDown);
    document.removeEventListener("session-created", this.#onSessionCreated);
    cancelAnimationFrame(this.#tooltipFrame);
  }

  /** Pages may set data directly instead of going through fetchModuleNav. */
  set nav(value) {
    this.#nav = value;
    this.#render();
  }

  async #load() {
    const module = this.getAttribute("module");
    if (!module) {
      this.#nav = null;
      this.#render();
      return;
    }

    // Per-tab cache, same reasoning as app-header's: this is an MPA, so
    // without it every navigation shows a skeleton and then swaps in an
    // identical tree. It is also what makes a content refresh invisible —
    // 20 page components render this element inside their own innerHTML, so
    // an API-driven re-render destroys and recreates it, and the cache lets
    // the replacement paint the same tree synchronously instead of flashing a
    // skeleton. Role-gated trees are dropped on logout by `clearShellCache`.
    const cacheKey = `app-module-nav:${module}`;
    let cached = null;
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) cached = JSON.parse(raw);
    } catch { /* ignore bad cache */ }

    // `.groups?.length` rather than a plain truthiness check: a previous run
    // could have written a degraded (or literal `null`) tree here.
    if (cached?.groups?.length) {
      this.#nav = cached;
      this.#render();
    } else {
      cached = null;
      this.#renderSkeleton();
    }

    let fresh = null;
    try {
      // Into `fresh`, not `this.#nav`: the empty-answer guard below reads `fresh`,
      // so assigning the fetch to `this.#nav` left `fresh` permanently null. Every
      // cold-cache load therefore fell into that guard, overwrote the tree it had
      // just fetched with null and deleted the element. It only ever survived on a
      // warm sessionStorage cache — which is why the module nav was there on a
      // second visit and gone on the first. Nor is the answer cached here: the
      // guard exists precisely to keep a degraded one out of the cache.
      fresh = await callOptional('fetchModuleNav', module);
    } catch (e) {
      console.warn("fetchModuleNav failed:", e);
    }

    // An empty answer is transient far more often than it is real. EE's
    // fetchModuleNav awaits `/org/context` over the network and degrades to a
    // thinner tree (or nothing) whenever that request wobbles, and #render()
    // deletes this element when handed nothing — which is why the nested
    // sidebar sometimes vanished mid-session on an API call. One flaky request
    // is not a reason to delete a sidebar: keep what is on screen, don't cache
    // the degraded answer over the good one, and let the next load correct it.
    if (!fresh?.groups?.length) {
      if (!cached) {
        this.#nav = fresh;
        this.#render();
      }
      return;
    }

    try {
      sessionStorage.setItem(cacheKey, JSON.stringify(fresh));
    } catch { /* quota exceeded */ }

    // Skip the repaint when the freshly fetched tree matches what's rendered.
    if (cached && JSON.stringify(cached) === JSON.stringify(fresh)) return;
    this.#nav = fresh;
    this.#render();
  }

  /** Re-fetch the tree so a just-created chat shows up in the Session group.
   *  #load() repaints from the cache first, so the visible rows never flash. */
  #onSessionCreated = (e) => {
    this.#activeSessionId = e.detail?.sessionId || null;
    this.#load();
  };

  #onRouteChange = () => {
    // Leaving the page drops the in-page chat that row stood for.
    this.#activeSessionId = null;
    // Re-evaluate which link is active after SPA navigation
    this.querySelectorAll("a.row[href]").forEach((a) => {
      const active = this.#isActive(a.getAttribute("href"));
      a.classList.toggle("is-active", active);
      a.setAttribute("aria-current", active ? "page" : "false");
    });
  };

  /**
   * The rows are a list, so Up and Down walk it and Home/End jump to its ends;
   * Right and Left open and close a group, and Left from a child jumps to the
   * group heading that owns it. Enter and Space stay native — every row is a
   * real link or button, and this only adds the axis a list implies.
   *
   * Tab order is untouched: this is a shortcut for someone already inside the
   * nav, not a roving-tabindex widget, so nothing about reaching or leaving the
   * nav from the keyboard changes.
   */
  #handleKeyDown = (e) => {
    const row = e.target.closest(".row");
    if (!row) return;

    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (row.matches(".group-head") && row.dataset.group) {
        const wantCollapsed = e.key === "ArrowLeft";
        if (wantCollapsed === this.#collapsed.has(row.dataset.group)) return;
        e.preventDefault();
        row.click();
        return;
      }
      if (e.key === "ArrowLeft") {
        const owner = row.closest(".group")?.querySelector(".group-head");
        if (owner) { e.preventDefault(); owner.focus(); }
      }
      return;
    }

    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    const rows = this.#reachableRows();
    if (!rows.length) return;
    e.preventDefault();
    if (e.key === "Home") { rows[0].focus(); return; }
    if (e.key === "End") { rows[rows.length - 1].focus(); return; }
    const at = rows.indexOf(row);
    rows[Math.min(rows.length - 1, Math.max(0, at + step))]?.focus();
  };

  /** Rows the user can actually reach — a collapsed group's children cannot. */
  #reachableRows() {
    return [...this.querySelectorAll(".row")].filter(
      (r) => r.matches(".group-head") || !r.closest(".group.is-collapsed"),
    );
  }

  #handleClick = (e) => {
    const del = e.target.closest("[data-delete-session]");
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      this.#deleteSession(del);
      return;
    }
    if (e.target.closest("[data-mobile-toggle]")) {
      this.#mobileOpen = !this.#mobileOpen;
      this.classList.toggle("mobile-open", this.#mobileOpen);
      return;
    }
    const head = e.target.closest("[data-group]");
    if (head) {
      const label = head.dataset.group;
      this.#collapsed.has(label) ? this.#collapsed.delete(label) : this.#collapsed.add(label);
      head.closest(".group")?.classList.toggle("is-collapsed", this.#collapsed.has(label));
      head.setAttribute("aria-expanded", String(!this.#collapsed.has(label)));
      // Rows that were inside a 0fr grid track have a width to measure now.
      this.#scheduleOverflowTooltips();
      return;
    }
    const section = e.target.closest("[data-section]");
    if (section) {
      // A section row may carry a `url` (its sections live on another page of
      // the module — Settings' panels next to the sibling /secrets route). From
      // that other page there is nothing here to switch, so route to the owning
      // page and let it pick the section out of `?view=`; swallowing the click
      // was what used to pin the content to one panel. Path only, not
      // `#isActive`: the href always names a *different* view of the same page,
      // so a query-aware match would report "not here" and reload the page it
      // is already on.
      const href = section.getAttribute("href");
      if (href && !this.#isSamePath(href)) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent("loading-start", { bubbles: true }));
        routerNavigate(href);
        return;
      }
      this.setAttribute("active-section", section.dataset.section);
      // Name the view in the URL so the row the user is looking at is what a
      // copied link opens. replaceState, not pushState: a section is a view of
      // this page, not a place in history.
      syncView(section.dataset.section);
      this.dispatchEvent(new CustomEvent("module-nav-select", {
        bubbles: true,
        detail: { section: section.dataset.section },
      }));
      return;
    }
    const link = e.target.closest("a.row[href]");
    if (link && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) {
      e.preventDefault();
      routerNavigate(link.href);
    }
  };

  /** Delete the chat session a row points at (orchestrator session rows).
   *  The rendered tree is also the cached tree, so drop the row from `#nav`
   *  and rewrite the cache — otherwise the next page load repaints it. */
  async #deleteSession(btn) {
    const sessionId = btn.dataset.deleteSession;
    const wrap = btn.closest(".row-del-wrap");
    btn.disabled = true;
    try {
      await callOptional('deleteSession', sessionId);
    } catch (e) {
      console.warn("deleteSession failed:", e);
      btn.disabled = false;
      return;
    }

    wrap?.remove();
    if (this.#nav?.groups) {
      this.#nav = {
        ...this.#nav,
        groups: this.#nav.groups
          .map((g) => (g.items ? { ...g, items: g.items.filter((i) => i.sessionId !== sessionId) } : g))
          // A group emptied by the deletion would render as a stray heading,
          // the same reason fetchModuleNav omits it when there are no sessions.
          .filter((g) => !g.items || g.items.length),
      };
      this.#render();
      try {
        sessionStorage.setItem(
          `app-module-nav:${this.getAttribute("module")}`,
          JSON.stringify(this.#nav),
        );
      } catch { /* quota exceeded */ }
    }

    // Deleting the chat that is on screen leaves a transcript with no session
    // behind it — send the user back to the orchestrator entry point.
    if (new URLSearchParams(window.location.search).get("session_id") === sessionId) {
      routerNavigate('/orchestrator');
    }
  }


  #normalizePath(p) {
    return p
      .replace(/\/index\.html$/, "/")
      .replace(/\.html$/, "")
      .replace(/\/+$/, "") || "/";
  }

  /** Same page, ignoring the query — "does this url land on the document we
   *  are already in". */
  #isSamePath(url) {
    return this.#normalizePath(url.split("?")[0])
      === this.#normalizePath(window.location.pathname);
  }

  #isActive(url) {
    const [, query] = url.split("?");
    if (!this.#isSamePath(url)) return false;
    if (!query) return true;
    const want = new URLSearchParams(query);
    const have = new URLSearchParams(window.location.search);
    return [...want].every(([k, v]) => have.get(k) === v);
  }

  /** A 200px column ellipsises long labels — an orchestrator chat title nearly
   *  always. The full text then exists nowhere the user can reach, so give the
   *  rows that actually overflowed the design system's tooltip. Measured rather
   *  than applied to every row: a tooltip repeating a label already legible in
   *  full is noise, which is exactly how a blanket `title` reads. */
  #applyOverflowTooltips() {
    if (!this.isConnected) return;
    for (const label of this.querySelectorAll(".row > .row-label")) {
      const row = label.parentElement;
      // +1 because scrollWidth and clientWidth are integers rounded from
      // fractional layout: an exactly-fitting label can report 1px of overflow,
      // and then every row in the tree gets a tooltip.
      if (label.scrollWidth > label.clientWidth + 1) {
        row.dataset.tooltip = label.textContent;
        row.dataset.tooltipPlacement = "right";
      } else {
        delete row.dataset.tooltip;
        delete row.dataset.tooltipPlacement;
      }
    }
    // app-tooltip's MutationObserver only sees `data-tooltip` on a node as it is
    // inserted; these rows are already in the document, so attach explicitly.
    // scanTooltips tracks in a WeakSet, so re-running it is free and idempotent.
    scanTooltips(this);
  }

  /** Measured after paint: the nav is absolutely positioned inside the content
   *  card, so its width is not final at the moment innerHTML lands. Coalesced,
   *  because a group toggle can land in the same frame as a re-render. */
  #scheduleOverflowTooltips() {
    cancelAnimationFrame(this.#tooltipFrame);
    this.#tooltipFrame = requestAnimationFrame(() => this.#applyOverflowTooltips());
  }

  #renderSkeleton() {
    this.innerHTML = `
      <div class="mod-groups" aria-hidden="true" aria-busy="true">
        <div class="skel-row is-head"></div>
        ${Array.from({ length: 4 }, () => `<div class="skel-row"></div>`).join("")}
      </div>`;
  }

  /** `cls` is the row's second class — `child` for a group item, `group-head`
   *  for an itemless group rendered as a single heading-level row. */
  #itemHtml(item, cls = "child") {
    if (item.section != null) {
      const active = this.getAttribute("active-section") === item.section;
      // `url` names the page that owns the sections: a real link so the row
      // works from anywhere in the module (and middle-click/copy-link do the
      // right thing), while on the owning page the click handler switches the
      // panel in place. The section travels as `?view=` — the one spelling
      // module-view.js, app-tabs and every linking page already agree on.
      // ponytail: plain concatenation, since an owning-page url never carries a
      // query of its own; build it with `new URL()` the day one does.
      const tag = item.url
        ? `a href="${escHtml(`${item.url}?${VIEW_PARAM}=${encodeURIComponent(item.section)}`)}"`
        : `button type="button"`;
      return `<${tag} class="row ${cls}${active ? " is-active" : ""}"
        data-section="${escHtml(item.section)}" ${active ? 'aria-current="true"' : ""}>
        <span class="row-label">${escHtml(item.label)}</span></${item.url ? "a" : "button"}>`;
    }
    // A live in-page chat owns the highlight outright (see #activeSessionId):
    // its row is not reachable by the href match, and leaving "Orchestrate a
    // task" lit alongside it would highlight two rows at once.
    const active = this.#activeSessionId
      ? item.sessionId === this.#activeSessionId
      : this.#isActive(item.url);
    const link = `<a class="row ${cls}${active ? " is-active" : ""}" href="${escHtml(item.url)}"
      ${active ? 'aria-current="page"' : ""}><span class="row-label">${escHtml(item.label)}</span></a>`;
    if (item.sessionId == null) return link;
    return `<div class="row-del-wrap">${link}
      <button type="button" class="row-del" data-delete-session="${escHtml(item.sessionId)}"
        title="Delete chat" aria-label="Delete chat ${escHtml(item.label)}">${icons.trash("", 13)}</button>
    </div>`;
  }

  /** A group with no items is a single heading-level row, not a collapsible
   *  group (Orchestrator's "Orchestrate a task") — no chevron, since there is
   *  nothing to collapse. It takes either form an item can: a `section` (a view
   *  of this same document) or a plain `url`. */
  #groupHtml(g) {
    if (!g.items?.length && (g.url || g.section != null)) {
      return this.#itemHtml(g, "group-head");
    }
    return `
      <div class="group${this.#collapsed.has(g.label) ? " is-collapsed" : ""}">
        <button type="button" class="row group-head" data-group="${escHtml(g.label)}"
          aria-expanded="${!this.#collapsed.has(g.label)}">
          <span class="chev">${icons.chevronDown("", 12)}</span>
          <span class="row-label">${escHtml(g.label)}</span>
        </button>
        <div class="group-items">
          <div class="items-clip">
            ${(g.items || []).map((item) => this.#itemHtml(item)).join("")}
          </div>
        </div>
      </div>`;
  }

  #render() {
    const nav = this.#nav;
    if (!nav || !nav.groups?.length) {
      // Remove entirely — a hidden element would still match the host page's
      // `:has(> app-module-nav)` padding rule and leave a dead gutter.
      this.remove();
      return;
    }

    // Active section, in precedence order: whatever the host already set (a
    // module-shell resolves this before the nav loads, and it owns the answer),
    // then `?view=` so a shared link highlights the row it opened, then the
    // first section item. Sections owned by another page are skipped — one
    // would otherwise light up next to that page's own active row.
    if (!this.getAttribute("active-section")) {
      const sections = nav.groups
        // `|| []`: an itemless group is a heading-level link row, and
        // flatMapping its undefined `items` used to throw in the filter below.
        .flatMap((g) => g.items || [])
        .filter((i) => i.section != null && (!i.url || this.#isActive(i.url)))
        .map((i) => i.section);
      if (sections.length) {
        this.setAttribute("active-section", initialView(sections));
      }
    }

    const iconHtml = nav.icon && icons[nav.icon] ? icons[nav.icon]("", 14) : "";
    this.innerHTML = `
      <button class="mobile-toggle" data-mobile-toggle type="button"
        aria-expanded="${this.#mobileOpen}">
        ${iconHtml}
        <span class="mod-title">${escHtml(nav.title)}</span>
        <span class="chev">${icons.chevronDown("", 14)}</span>
      </button>
      <div class="mod-head">
        ${iconHtml}
        <span class="mod-title">${escHtml(nav.title)}</span>
      </div>
      <nav class="mod-groups" aria-label="${escHtml(nav.title)} navigation">
        ${nav.groups.map((g) => this.#groupHtml(g)).join("")}
      </nav>`;

    this.#scheduleOverflowTooltips();
  }
}

customElements.define("app-module-nav", AppModuleNav);
