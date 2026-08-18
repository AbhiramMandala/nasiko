/**
 * `<app-scaffold>` — Root layout shell matching Flutter's `AppScaffold`.
 *
 * Arranges:  Header → Row[ Sidebar, Secondary Panel, Body (content card), Right Panel ]
 *
 * The content card is a white rounded-rect that floats on the ink backdrop.
 * Its border-radius adapts dynamically:
 *   - All 4 corners rounded when no panels are open
 *   - Right corners only when a left panel (sidebar/secondary) is open
 *   - Left corners only when a right panel is open
 *   - Top-right + bottom-right when both sides have panels
 *
 * Layout contract:
 *   - `--app-sidebar-width`  set by app-header (rail width)
 *   - `--app-panel-width`    set by app-sidebar-panel (secondary panel)
 *   - `--app-right-panel`    set by this scaffold when a right panel is shown
 *   - Content card fills the remaining space with proper padding
 *
 * The scaffold also manages the rail overlay (temporary expand-on-hover)
 * using the same asymmetric debounce as the tooltip: 120ms open / 80ms close.
 *
 * @element app-scaffold
 */

import { PANEL as PANEL_MS, EASE_MOVE } from '../core/motion.js';

// ── Shell radius (fixed px, not scaled — see Flutter comment in app_scaffold.dart) ──

const SHELL_RADIUS = 12;

// ── Styles ──────────────────────────────────────────────────────────────

const _sheet = new CSSStyleSheet();
_sheet.replaceSync(`
@scope (app-scaffold) {
  :scope {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
    background: var(--shell-bg, #242628);
    color: var(--content-fg, #1E1D1B);
  }

  /* ── Main row: sidebar + body + right panel ── */
  .scaffold-row {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
    /* Bottom + right margin for the ink bleed around the content card */
    margin: 0 var(--s-12, 12px) var(--s-12, 12px) 0;
  }

  /* ── Content card ── */
  .scaffold-body {
    flex: 1;
    min-width: 0;
    position: relative;
    background: var(--content-bg, #FFFFFF);
    border: 1px solid var(--content-border, rgba(0,0,0,0.08));
    overflow: hidden;
    overflow-y: auto;
    /* Smooth radius transitions when panels open/close */
    transition: border-radius ${PANEL_MS}ms ${EASE_MOVE};
    scrollbar-width: thin;
    scrollbar-color: var(--content-scrollbar, rgba(0,0,0,0.15)) transparent;
  }
  .scaffold-body::-webkit-scrollbar { width: 6px; }
  .scaffold-body::-webkit-scrollbar-thumb {
    background: var(--content-scrollbar, rgba(0,0,0,0.15));
    border-radius: 3px;
  }

  /* ── Border-radius states ── */
  .scaffold-body.radius-all {
    border-radius: ${SHELL_RADIUS}px;
  }
  .scaffold-body.radius-right {
    border-radius: 0 ${SHELL_RADIUS}px ${SHELL_RADIUS}px 0;
  }
  .scaffold-body.radius-left {
    border-radius: ${SHELL_RADIUS}px 0 0 ${SHELL_RADIUS}px;
  }
  .scaffold-body.radius-right-only {
    border-radius: 0 ${SHELL_RADIUS}px ${SHELL_RADIUS}px 0;
  }
  .scaffold-body.radius-none {
    border-radius: 0;
  }

  /* ── Dark theme overrides ── */
  :root[data-theme="dark"] & .scaffold-body,
  :root:not([data-theme]) .scaffold-body {
    background: var(--content-bg, #2C2A28);
    border-color: var(--content-border, rgba(255,255,255,0.08));
  }
  :root[data-theme="dark"] & .scaffold-body::-webkit-scrollbar-thumb,
  :root:not([data-theme]) .scaffold-body::-webkit-scrollbar-thumb {
    background: var(--content-scrollbar, rgba(255,255,255,0.15));
  }

  /* ── Body padding ── */
  .scaffold-body-inner {
    padding: var(--s-24, 24px);
    min-height: 100%;
  }
  @media (max-width: 767.98px) {
    .scaffold-body-inner {
      padding: var(--s-16, 16px);
    }
  }
  @media (max-width: 479.98px) {
    .scaffold-body-inner {
      padding: var(--s-12, 12px);
    }
  }

  /* ── Right panel slot ── */
  .scaffold-right-panel {
    overflow: hidden;
    transition: width ${PANEL_MS}ms ${EASE_MOVE};
    flex-shrink: 0;
  }
  .scaffold-right-panel:empty {
    width: 0 !important;
  }
  .scaffold-right-panel .right-panel-inner {
    border: 1px solid var(--content-border, rgba(0,0,0,0.08));
    border-radius: ${SHELL_RADIUS}px 0 0 ${SHELL_RADIUS}px;
    background: var(--content-bg, #FFFFFF);
    height: 100%;
    overflow: hidden;
    overflow-y: auto;
  }
  :root[data-theme="dark"] & .scaffold-right-panel .right-panel-inner,
  :root:not([data-theme]) .scaffold-right-panel .right-panel-inner {
    background: var(--content-bg, #2C2A28);
    border-color: var(--content-border, rgba(255,255,255,0.08));
  }

  /* ── Rail overlay (temporary expand-on-hover) ── */
  .rail-overlay {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--shell-rail-expanded, 240px);
    background: var(--shell-bg, #242628);
    z-index: var(--z-overlay, 50);
    border-right: 1px solid var(--shell-border-subtle, rgba(255,255,255,0.08));
    transform: translateX(-100%);
    opacity: 0;
    transition: transform ${PANEL_MS}ms ${EASE_MOVE}, opacity ${PANEL_MS}ms ${EASE_MOVE};
    pointer-events: none;
  }
  .rail-overlay.is-open {
    transform: translateX(0);
    opacity: 1;
    pointer-events: auto;
  }
  .rail-overlay-backdrop {
    position: absolute;
    inset: 0;
    background: transparent;
    z-index: calc(var(--z-overlay, 50) - 1);
    display: none;
  }
  .rail-overlay-backdrop.is-open {
    display: block;
  }

  /* ── Mobile: stack vertically ── */
  @media (max-width: 1023.98px) {
    .scaffold-row {
      flex-direction: column;
      margin: 0;
    }
    .scaffold-body {
      border-radius: 0 !important;
      border-left: none;
      border-right: none;
    }
    .scaffold-right-panel {
      width: 100% !important;
    }
    .scaffold-right-panel .right-panel-inner {
      border-radius: 0;
    }
  }
}
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, _sheet];

// ── Component ───────────────────────────────────────────────────────────

class AppScaffold extends HTMLElement {
  #hasLeftPanel = false;
  #hasRightPanel = false;
  #observer = null;

  connectedCallback() {
    this.#render();
    this.#observePanels();
    this.#updateRadius();

    // Listen for panel-resize events from app-sidebar-panel
    this.addEventListener('panel-resize', () => this.#updateRadius());

    // Listen for CSS custom property changes via attribute observer on root
    this.#watchCssProperties();
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /** Slot content into the body area. */
  set bodyContent(el) {
    const inner = this.querySelector('.scaffold-body-inner');
    if (!inner) return;
    inner.innerHTML = '';
    if (el) inner.appendChild(el);
  }

  /** Set or clear the right panel content. */
  set rightPanel(el) {
    const slot = this.querySelector('.scaffold-right-panel');
    if (!slot) return;
    slot.innerHTML = '';
    if (el) {
      const wrapper = document.createElement('div');
      wrapper.className = 'right-panel-inner';
      wrapper.appendChild(el);
      slot.appendChild(wrapper);
      slot.style.width = '320px';
      this.#hasRightPanel = true;
    } else {
      slot.style.width = '0';
      this.#hasRightPanel = false;
    }
    this.#updateRadius();
  }

  // ── Radius adaptation ──────────────────────────────────────────────

  #updateRadius() {
    const body = this.querySelector('.scaffold-body');
    if (!body) return;

    // Check if sidebar panel is present
    const panel = document.querySelector('app-sidebar-panel');
    this.#hasLeftPanel = !!panel;

    body.classList.remove('radius-all', 'radius-right', 'radius-left', 'radius-right-only', 'radius-none');

    if (this.#hasLeftPanel && this.#hasRightPanel) {
      body.classList.add('radius-none');
    } else if (this.#hasLeftPanel) {
      body.classList.add('radius-right-only');
    } else if (this.#hasRightPanel) {
      body.classList.add('radius-left');
    } else {
      body.classList.add('radius-all');
    }
  }

  // ── Panel observation ──────────────────────────────────────────────

  #observePanels() {
    // Watch for app-sidebar-panel being added/removed from the DOM
    this.#observer = new MutationObserver(() => this.#updateRadius());
    this.#observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  #watchCssProperties() {
    // Periodically check if --app-panel-width is set (lightweight poll)
    // This covers the case where the panel resizes without DOM changes
    const check = () => {
      if (!this.isConnected) return;
      const panelWidth = getComputedStyle(document.documentElement)
        .getPropertyValue('--app-panel-width').trim();
      const hadLeft = this.#hasLeftPanel;
      this.#hasLeftPanel = !!panelWidth;
      if (hadLeft !== this.#hasLeftPanel) this.#updateRadius();
    };

    // Check on route changes
    window.addEventListener('route-change', check);
    // Initial check after a tick
    requestAnimationFrame(check);
  }

  // ── Render ─────────────────────────────────────────────────────────

  #render() {
    this.innerHTML = `
      <slot name="header"></slot>
      <div class="scaffold-row">
        <slot name="sidebar"></slot>
        <div class="scaffold-body radius-all">
          <div class="scaffold-body-inner">
            <slot></slot>
          </div>
        </div>
        <div class="scaffold-right-panel"></div>
      </div>
    `;
  }
}

if (!customElements.get('app-scaffold')) {
  customElements.define('app-scaffold', AppScaffold);
}

export { AppScaffold, SHELL_RADIUS };
