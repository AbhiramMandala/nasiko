import { icons } from "/common/utils/icons.js";
import "/common/design-system/app-card/app-card.js";
import "/common/design-system/app-search/app-search.js";
import "/common/design-system/app-empty-state/app-empty-state.js";
import "/common/design-system/app-skeleton/app-skeleton.js";
import "/common/design-system/app-tabs/app-tabs.js";
import "/common/features/app-module-nav.js";
import { escHtml, escAttr } from '/common/utils/escape.js';
import { call, callOptional } from '../core/data-sources.js';


// In MPA mode, agents-page.css was <link>ed in the HTML for instant pre-upgrade
// styling. In SPA mode, the router lazy-loads this module, so we adopt the sheet
// here too. The CSS import assertion returns the same CSSStyleSheet instance on
// repeat calls (module caching), so double-adoption is harmless.
import { loadCss } from '/common/utils/css.js';
const agentsStyles = await loadCss(new URL('./agents-page.css', import.meta.url));
if (!document.adoptedStyleSheets.includes(agentsStyles)) {
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, agentsStyles];
}

// The category tab is a tag, not an enum, so it must stay out of the URL (see
// utils/url-policy.js: a URL is copied, logged, screenshotted and sent to third
// parties in Referer, and a tag is author-supplied text). It still has to
// survive a trip to an agent card and back, so it lives in sessionStorage —
// same tab, same session, never leaves the browser.
const CATEGORY_KEY = "agents-page:category";
const storedCategory = () => {
  try { return sessionStorage.getItem(CATEGORY_KEY) || "all"; } catch { return "all"; }
};
const storeCategory = (key) => {
  try { sessionStorage.setItem(CATEGORY_KEY, key); } catch { /* private mode / quota */ }
};

class AgentsPage extends HTMLElement {
  #initialized = false;
  #agents = [];
  #activeCategory = storedCategory();
  #pinnedTabs = [];

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    // The host page owns the shell (web/agents.html) so it paints styled before
    // this module arrives; here we only bind to it and fill the API-fed regions.
    // Fallback for hosts that don't supply it (e.g. an element created in JS).
    if (!this.querySelector("#agents-grid")) this.insertAdjacentHTML("afterbegin", this.#shell());

    // <app-search> owns the clear button and re-fires `input` after clearing,
    // so one listener covers typing and clearing alike.
    this.querySelector("#search-input").addEventListener("input", () => this.#renderGrid());

    // <app-tabs strip> owns the tablist semantics and the sliding indicator;
    // the tab set itself is data-driven, so this page renders the buttons.
    this.querySelector("#category-tabs").addEventListener("tabs-change", (e) => {
      this.#activeCategory = e.detail.key;
      storeCategory(e.detail.key);
      this.#renderFilter();
      this.#renderGrid();
    });

    // Card activation (click / Enter) is owned by <app-card>.

    this.#loadAgents();
  }

  async #loadAgents() {
    let result;
    try {
      result = await call('fetchAgents', "", 1, 100);
    } catch (e) {
      // Without this, a rejected fetch left the tab/grid skeletons drawn in
      // #shell() on screen forever — nothing ever replaced them.
      console.error('AgentsPage: failed to load agents:', e);
      this.#renderLoadFailure();
      return;
    }
    this.#agents = result.data || [];
    await this.#loadPinnedTabs();
    this.#dropStaleCategory();
    this.#renderFilter();
    this.#renderGrid();
  }

  /**
   * One request fills this grid, so one block says it failed — there are no
   * cards to hang a per-card state on. `variant="error"` rather than a
   * hand-passed alert icon: the variant is what makes this the same failure
   * the charts, tables and stat strips draw, and it carries the icon, the
   * tint and `role="alert"` with it.
   */
  #renderLoadFailure() {
    this.querySelector("#category-tabs").innerHTML = "";
    this.querySelector("#agents-grid").innerHTML = `
      <div class="empty-wrap">
        <app-empty-state variant="error"
          heading="Couldn't load agents"
          description="Something went wrong loading the agent catalog.">
          <app-button id="agents-retry" variant="tertiary">Retry</app-button>
        </app-empty-state>
      </div>`;
    this.querySelector("#agents-retry")?.addEventListener("click", () => this.#loadAgents());
  }

  /** Admin-pinned tab list (Settings → `catalog_tabs`, comma-separated tags). */
  async #loadPinnedTabs() {
    try {
      const settings = await callOptional('fetchSettings');
      this.#pinnedTabs = (settings?.catalog_tabs || "")
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    } catch {
      this.#pinnedTabs = [];
    }
  }

  /**
   * A remembered category can vanish between visits — the last agent carrying
   * the tag was deleted, the tag was renamed, an admin unpinned it. Fall back to
   * "All" rather than opening on a tab whose grid is empty. Pinned tabs are kept
   * even at zero: an admin pinned them on purpose.
   */
  #dropStaleCategory() {
    if (this.#activeCategory === "all") return;
    const known = this.#pinnedTabs.includes(this.#activeCategory)
      || this.#agents.some((a) =>
        (a.tags || []).some((t) => t.toLowerCase() === this.#activeCategory));
    if (!known) {
      this.#activeCategory = "all";
      storeCategory("all");
    }
  }

  #renderFilter() {
    const counts = new Map();
    for (const a of this.#agents) {
      for (const t of a.tags || []) {
        const key = t.toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    let cats;
    if (this.#pinnedTabs.length) {
      // Admin-pinned tab list (Settings → catalog_tabs) shown as-is, in order.
      cats = this.#pinnedTabs.map((c) => [c, counts.get(c) || 0]);
    } else {
      // Top categories only — every distinct tag as a tab sprawls on big
      // fleets. Long-tail tags stay reachable through search (matches tags).
      cats = [...counts.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, 5);
    }
    // Keep a selected long-tail category visible while it's active.
    if (this.#activeCategory !== "all" && !cats.some(([c]) => c === this.#activeCategory)) {
      cats.push([this.#activeCategory, counts.get(this.#activeCategory) || 0]);
    }
    const tab = (key, label, n) =>
      `<button class="tab" type="button" role="tab"
        aria-selected="${this.#activeCategory === key}" data-key="${escAttr(key)}">
        ${escHtml(label)}<span class="n">${n}</span></button>`;
    this.querySelector("#category-tabs").innerHTML =
      tab("all", "All", this.#agents.length) +
      cats.map(([c, n]) => tab(c, c.charAt(0).toUpperCase() + c.slice(1), n)).join("");
  }

  /** Fallback shell — mirrors the static markup in web/agents.html. */
  #shell() {
    return `
      <app-module-nav module="agents"></app-module-nav>
      <div class="page-top">
        <h1 class="title-page">Agent hub</h1>
        <!-- Deliberately count-free: the fleet size lands in the "All N" tab.
             Injecting it here reflowed the description (2 → 3 lines on mobile)
             the moment the API answered. -->
        <p class="subtitle">Discover and chat with the agents deployed on this cluster.</p>
      </div>
      <div class="controls">
        <app-search id="search-input" class="search-wrap" size="md"
          placeholder="Search agents by name, skill, or capability"
          aria-label="Search agents"></app-search>
      </div>
      <app-tabs strip id="category-tabs">${this.#skeletonTabs()}</app-tabs>
      <div class="grid" id="agents-grid">${this.#skeletonCards()}</div>
    `;
  }

  #skeletonTabs() {
    return Array.from({ length: 6 }, () => `<div class="skel-tab"></div>`).join("");
  }

  #skeletonCards() {
    // The skeleton is the same component in its loading state, so the card's
    // geometry is defined once and cannot drift from the loaded card.
    return Array.from({ length: 6 }, () => `<app-card loading></app-card>`).join("");
  }

  #renderGrid() {
    const q = (this.querySelector("#search-input")?.value || "").toLowerCase();
    let filtered = this.#agents;

    if (this.#activeCategory !== "all") {
      filtered = filtered.filter((a) =>
        (a.tags || []).some((t) => t.toLowerCase() === this.#activeCategory),
      );
    }
    if (q) {
      filtered = filtered.filter(
        (a) =>
          (a.display_name || a.name || "").toLowerCase().includes(q) ||
          (a.description || "").toLowerCase().includes(q) ||
          (a.tags || []).some((t) => t.toLowerCase().includes(q)),
      );
    }

    const grid = this.querySelector("#agents-grid");
    if (!filtered.length) {
      grid.innerHTML = `
        <div class="empty-wrap">
          <app-empty-state
            heading="No agents found"
            description="Try adjusting your search or filter criteria."
            icon='${icons.layers("", 40)}'>
            <app-button variant="primary" href="/add-agent">Import agent</app-button>
          </app-empty-state>
        </div>`;
      return;
    }

    grid.innerHTML = filtered
      .map(
        (a) => `
        <app-card
          agent-id="${escAttr(a.id)}"
          name="${escAttr(a.display_name || a.name)}"
          ${a.version ? `version="${escAttr(String(a.version))}"` : ""}
          ${a.status ? `status="${escAttr(a.status)}"` : ""}
          description="${escAttr(a.description || "")}"
          tags="${escAttr(JSON.stringify(a.tags || []))}"></app-card>`,
      )
      .join("");
  }

}

customElements.define("agents-page", AgentsPage);
