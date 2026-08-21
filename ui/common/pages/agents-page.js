import { icons } from "/common/utils/icons.js";
import { attachSlidingIndicator } from "/common/utils/tab-indicator.js";
import "/common/design-system/app-card/app-card.js";
import "/common/design-system/app-empty-state/app-empty-state.js";
import "/common/design-system/app-skeleton/app-skeleton.js";
import "/common/features/app-module-nav.js";
import { escHtml, escAttr } from '/common/utils/escape.js';
import { call, callOptional } from '../core/data-sources.js';


// In MPA mode, agents-page.css was <link>ed in the HTML for instant pre-upgrade
// styling. In SPA mode, the router lazy-loads this module, so we adopt the sheet
// here too. The CSS import assertion returns the same CSSStyleSheet instance on
// repeat calls (module caching), so double-adoption is harmless.
import agentsStyles from './agents-page.css' with { type: 'css' };
if (!document.adoptedStyleSheets.includes(agentsStyles)) {
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, agentsStyles];
}

class AgentsPage extends HTMLElement {
  #initialized = false;
  #agents = [];
  #activeCategory = "all";
  #pinnedTabs = [];

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    // The host page owns the shell (web/agents.html) so it paints styled before
    // this module arrives; here we only bind to it and fill the API-fed regions.
    // Fallback for hosts that don't supply it (e.g. an element created in JS).
    if (!this.querySelector("#agents-grid")) this.insertAdjacentHTML("afterbegin", this.#shell());

    this.querySelector("#search-input").addEventListener("input", () => {
      this.#updateClearBtn();
      this.#renderGrid();
    });

    this.querySelector("#search-clear").addEventListener("click", () => {
      const input = this.querySelector("#search-input");
      input.value = "";
      this.#updateClearBtn();
      this.#renderGrid();
      input.focus();
    });

    // Category tab clicks are delegated — tabs re-render after data loads.
    attachSlidingIndicator(this.querySelector("#category-tabs"), ".type-tab", ".active");
    this.querySelector("#category-tabs").addEventListener("click", (e) => {
      const tab = e.target.closest(".type-tab");
      if (!tab) return;
      this.#activeCategory = tab.dataset.category;
      this.#renderFilter();
      this.#renderGrid();
    });

    // Card activation (click / Enter) is owned by <app-card>.

    this.#loadAgents();
  }

  async #loadAgents() {
    const result = await call('fetchAgents', "", 1, 100);
    this.#agents = result.data || [];
    await this.#loadPinnedTabs();
    this.#renderFilter();
    this.#renderGrid();
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
      `<button class="type-tab ${this.#activeCategory === key ? "active" : ""}" role="tab"
        aria-selected="${this.#activeCategory === key}" data-category="${escHtml(key)}">
        ${escHtml(label)}<span class="n">${n}</span></button>`;
    this.querySelector("#category-tabs").innerHTML =
      tab("all", "All", this.#agents.length) +
      cats.map(([c, n]) => tab(c, c.charAt(0).toUpperCase() + c.slice(1), n)).join("");
  }

  #updateClearBtn() {
    const input = this.querySelector("#search-input");
    const btn = this.querySelector("#search-clear");
    btn.style.display = input.value ? "" : "none";
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
        <div class="search-wrap">
          <span class="search-icon">${icons.search("", 18)}</span>
          <input type="search" id="search-input" placeholder="Search agents by name, skill, or capability" />
          <button class="search-clear" id="search-clear" aria-label="Clear search" style="display:none">${icons.x("", 16)}</button>
        </div>
      </div>
      <div class="type-tabs" id="category-tabs" role="tablist">${this.#skeletonTabs()}</div>
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
            title="No agents found"
            description="Try adjusting your search or filter criteria."
            icon='${icons.layers("", 40)}'>
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
