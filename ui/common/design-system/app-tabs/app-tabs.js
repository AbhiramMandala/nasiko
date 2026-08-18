/**
 * Tab bar that fires events on switch — the consumer is responsible for showing/hiding panels.
 *
 * @element app-tabs
 * @attr {string} active - Key of the initially active tab
 * @fires tab-change - Tab switched; `detail: { key: string }` — bubbles
 * @slot default - `<button data-key="…">Label</button>` elements define the tabs
 * @note Tab panels are not managed by this component — hide/show them yourself on `tab-change`.
 */
import styles from './app-tabs.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppTabs extends HTMLElement {
  #initialized = false;
  #strip;
  #panels;
  #qp = null;
  #activeKey = null;
  #indicator;
  #resizeObserver = null;

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      const panels = [...this.children].filter((el) => el.dataset.tab);
      if (!panels.length) return;

      const qp = this.getAttribute("query-param");
      const fromUrl = qp ? new URLSearchParams(location.search).get(qp) : null;
      const active =
        fromUrl || this.getAttribute("active") || panels[0].dataset.tab;
      this.#activeKey = active;
      const uid = Math.random().toString(36).slice(2, 8);

      const strip = document.createElement("div");
      strip.className = "strip";
      strip.setAttribute("role", "tablist");

      panels.forEach((panel) => {
        const key = panel.dataset.tab;
        const label = panel.dataset.label || key;
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
      strip.addEventListener("keydown", (e) => {
        const tabs = [...strip.querySelectorAll('[role="tab"]')];
        const i = tabs.indexOf(document.activeElement);
        const map = {
          ArrowRight: 1,
          ArrowLeft: -1,
          Home: -i,
          End: tabs.length - 1 - i,
        };
        if (map[e.key] !== undefined) {
          e.preventDefault();
          tabs[(i + map[e.key] + tabs.length) % tabs.length]?.focus();
        }
      });

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
    this.dispatchEvent(
      new CustomEvent("tab-change", { detail: { key }, bubbles: true }),
    );
    if (this.#qp) {
      const url = new URL(location.href);
      url.searchParams.set(this.#qp, key);
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }
}
customElements.define("app-tabs", AppTabs);
