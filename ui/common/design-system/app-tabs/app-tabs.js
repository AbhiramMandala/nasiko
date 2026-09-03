/**
 * Tab bar in two shapes:
 *
 * - **Panels** (default) — `[data-tab]` (or `[data-slot]`) children are the
 *   panels; the strip is generated from their `data-label` — or from the `tabs`
 *   attribute, which is how a generated surface names them — and the component
 *   owns which one shows.
 * - **Strip** (`<app-tabs strip>`) — the page renders its own
 *   `<button class="tab" data-key aria-selected>` children and owns the content
 *   below. For data-driven tab sets (catalog/status filters with live counts)
 *   that re-render the strip; the sliding indicator follows.
 *
 * @element app-tabs
 * @attr {boolean} strip - Strip-only mode (see above)
 * @attr {string} tabs - JSON array of `{ key, label }` naming the panels (panels mode).
 *   Each key matches a child's `data-tab` or `data-slot`. Optional: without it
 *   the strip reads each panel's `data-label`, falling back to the key.
 * @attr {string} active - Key of the active tab (panels mode). Reflected as the user switches.
 * @attr {string} query-param - URL param kept in sync with the active tab (panels mode)
 * @attr {string} label - Accessible name of the tablist, e.g. `Agent sections`.
 * @slot default - The panels, each marked `data-tab="key"` or `data-slot="key"`.
 * @children *
 * @childattr {string} data-tab - The panel's key; matches a `tabs` entry. `data-slot` is the same thing.
 * @childattr {string} data-label - Strip label for the panel when `tabs` does not name it.
 * @fires tabs-change - Tab switched; `detail: { key: string }` — bubbles
 */
import { attachSlidingIndicator } from '../../utils/tab-indicator.js';
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-tabs.css', import.meta.url));
import { setSearchParams } from '../../utils/url-policy.js';
import { emit } from '../../utils/deprecate.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** Arrow/Home/End roving focus across a tablist's tabs. */
function roveFocus(e, strip) {
  const tabs = [...strip.querySelectorAll('[role="tab"], .tab')];
  const i = tabs.indexOf(document.activeElement);
  const map = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i };
  if (map[e.key] === undefined) return;
  e.preventDefault();
  tabs[(i + map[e.key] + tabs.length) % tabs.length]?.focus();
}

export class AppTabs extends HTMLElement {
  #initialized = false;
  #strip;
  #panels;
  #qp = null;
  #activeKey = null;
  #indicator;
  #resizeObserver = null;

  connectedCallback() {
    if (this.hasAttribute("strip")) return this.#initStrip();

    if (!this.#initialized) {
      this.#initialized = true;
      // A panel is a child with `data-tab`; `data-slot` is the same thing in the
      // generated-surface vocabulary (Slot("overview") → data-slot="overview").
      const panels = [...this.children].filter((el) => el.dataset.tab || el.dataset.slot);
      if (!panels.length) return;
      for (const p of panels) if (!p.dataset.tab) p.dataset.tab = p.dataset.slot;
      let named = [];
      try { named = JSON.parse(this.getAttribute('tabs') || '[]'); } catch { console.warn('[app-tabs] invalid `tabs` JSON'); }
      const labelFor = new Map((Array.isArray(named) ? named : []).filter((t) => t && t.key).map((t) => [String(t.key), String(t.label ?? t.key)]));
      // `tabs` also orders the strip when it is given.
      if (labelFor.size) panels.sort((a, b) => [...labelFor.keys()].indexOf(a.dataset.tab) - [...labelFor.keys()].indexOf(b.dataset.tab));

      const qp = this.getAttribute("query-param");
      const fromUrl = qp ? new URLSearchParams(location.search).get(qp) : null;
      const active =
        fromUrl || this.getAttribute("active") || panels[0].dataset.tab;
      this.#activeKey = active;
      const uid = Math.random().toString(36).slice(2, 8);

      const strip = document.createElement("div");
      strip.className = "strip";
      strip.setAttribute("role", "tablist");
      if (this.getAttribute("label")) strip.setAttribute("aria-label", this.getAttribute("label"));

      panels.forEach((panel) => {
        const key = panel.dataset.tab;
        const label = labelFor.get(key) || panel.dataset.label || key;
        const tabId = `tab-${uid}-${key}`;
        const panelId = `panel-${uid}-${key}`;

        panel.id = panelId;
        panel.className = (panel.className + " panel").trim();
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tabId);
        panel.hidden = key !== active;

        const btn = document.createElement("button");
        Object.assign(btn, {
          id: tabId,
          type: "button",
          textContent: label,
          className: "tab",
        });
        btn.setAttribute("role", "tab");
        btn.setAttribute("aria-selected", String(key === active));
        btn.setAttribute("aria-controls", panelId);
        btn.dataset.key = key;
        strip.appendChild(btn);
      });

      const indicator = document.createElement("div");
      indicator.className = "indicator";
      strip.appendChild(indicator);

      strip.addEventListener("click", (e) => {
        const btn = e.target.closest('[role="tab"]');
        if (btn) this.#activate(btn.dataset.key);
      });
      strip.addEventListener("keydown", (e) => roveFocus(e, strip));

      this.prepend(strip);
      this.#strip = strip;
      this.#panels = panels;
      this.#qp = qp;
      this.#indicator = indicator;
    }

    if (this.#strip) {
      this.#resizeObserver = new ResizeObserver(() => {
        if (this.#activeKey) this.#moveIndicator(this.#activeKey);
      });
      this.#resizeObserver.observe(this.#strip);

      // Position indicator after layout is ready
      requestAnimationFrame(() => {
        if (this.#activeKey) this.#moveIndicator(this.#activeKey);
      });
    }
  }

  disconnectedCallback() {
    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }
  }

  // Strip-only mode: the page owns the buttons and the content below, so all
  // we add is the tablist semantics, the sliding indicator and the event. The
  // indicator's own MutationObserver survives the page re-rendering the strip.
  #initStrip() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.setAttribute("role", "tablist");
    if (this.getAttribute("label")) this.setAttribute("aria-label", this.getAttribute("label"));
    attachSlidingIndicator(this, ".tab", '[aria-selected="true"]');
    this.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn || btn.getAttribute("aria-selected") === "true") return;
      // Flip selection now so the indicator slides on click, even if the page
      // re-renders the strip from its own state a moment later.
      this.querySelectorAll(".tab").forEach((b) =>
        b.setAttribute("aria-selected", String(b === btn)),
      );
      emit(this, "tabs-change", { key: btn.dataset.key }, { legacy: "tab-change" });
    });
    this.addEventListener("keydown", (e) => roveFocus(e, this));
  }

  #moveIndicator(key) {
    const btn = this.#strip?.querySelector(`[data-key="${key}"]`);
    if (!btn || !this.#indicator) return;
    this.#indicator.style.width = `${btn.offsetWidth}px`;
    this.#indicator.style.transform = `translateX(${btn.offsetLeft}px)`;
  }

  #activate(key) {
    this.#activeKey = key;
    this.#panels.forEach((p) => {
      const isActive = p.dataset.tab === key;
      p.hidden = !isActive;
      if (isActive) {
        // Trigger enter animation on the newly revealed panel
        p.classList.remove("is-entering");
        p.classList.add("is-entering");
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          p.classList.remove("is-entering");
        };
        p.addEventListener("animationend", cleanup, { once: true });
        setTimeout(cleanup, 250);
      }
    });
    this.#strip.querySelectorAll('[role="tab"]').forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.key === key));
    });
    this.#moveIndicator(key);
    if (this.getAttribute("active") !== key) this.setAttribute("active", key);
    emit(this, "tabs-change", { key }, { legacy: "tab-change" });
    if (this.#qp) {
      // Through the policy layer, not history.replaceState directly: every URL
      // write goes past the utils/url-policy.js allowlist, and a `query-param`
      // that isn't an approved key fails loudly in dev instead of shipping.
      setSearchParams({ [this.#qp]: key });
    }
  }
}
customElements.define("app-tabs", AppTabs);
