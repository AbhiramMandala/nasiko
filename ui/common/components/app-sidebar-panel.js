/**
 * `<app-sidebar-panel>` — Resizable secondary navigation panel.
 *
 * Ported from Flutter's `secondary_sidebar.dart`. Sits between the primary
 * rail (rendered by app-header) and the content card. Shows contextual
 * navigation for the active module — e.g. the agent list when on Agent
 * Registry, or recent sessions when on Observability.
 *
 * Features:
 *   - Drag-to-resize with a 6px invisible handle on the right edge
 *   - Per-panel width memory (persisted to localStorage)
 *   - Width clamped: min(saved, max(160, 30% viewport))
 *   - Double-tap on the drag handle resets width to default (200px)
 *   - Skeleton loading state (8 shimmer rows with alternating widths)
 *   - Smooth animated show/hide (250ms horizontal slide)
 *
 * Layout contract:
 *   body padding-left includes the rail width. When a panel is visible,
 *   `--app-panel-width` is set on the root so the content card adjusts.
 *   The panel itself is position: fixed, left: var(--app-sidebar-width).
 *
 * @element app-sidebar-panel
 * @attr {string} panel-id - Unique key for width persistence (e.g. "agent-registry")
 * @attr {string} title    - Panel header text
 * @fires panel-resize     - `{ detail: { width } }` on drag-end
 */

import { EASE_MOVE, PANEL as PANEL_MS } from '../core/motion.js';

// ── Metrics (from Flutter sidebar_layout_metrics.dart) ───────────────────

const DEFAULT_WIDTH = 200;
const MIN_WIDTH     = 160;
const MAX_WIDTH     = 320;

const STORAGE_PREFIX = 'app-panel-width:';

// ── Styles ──────────────────────────────────────────────────────────────

const _sheet = new CSSStyleSheet();
_sheet.replaceSync(`
@scope (app-sidebar-panel) {
  :scope {
    display: flex;
    flex-direction: column;
    position: fixed;
    top: var(--shell-topbar-height, 52px);
    bottom: var(--s-12, 12px);
    left: var(--app-sidebar-width, 56px);
    width: var(--panel-width, ${DEFAULT_WIDTH}px);
    background: var(--shell-bg, #242628);
    color: var(--shell-fg, #fff);
    z-index: var(--z-raised, 1);
    overflow: hidden;
    /* Prevent sub-pixel bleed from content card behind */
    border-right: 1px solid var(--shell-border-subtle, rgba(255,255,255,0.08));
  }

  /* ── Panel header ── */
  .panel-header {
    display: flex;
    align-items: center;
    gap: var(--s-8, 8px);
    padding: var(--s-12, 12px) var(--s-12, 12px) var(--s-8, 8px);
    flex-shrink: 0;
  }
  .panel-title {
    font-family: var(--font-display, monospace);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.16px;
    color: var(--shell-fg-muted, rgba(255,255,255,0.62));
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Panel body ── */
  .panel-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0 var(--s-8, 8px) var(--s-12, 12px);
    scrollbar-width: thin;
    scrollbar-color: var(--shell-scrollbar, rgba(255,255,255,0.18)) transparent;
  }
  .panel-body::-webkit-scrollbar { width: 4px; }
  .panel-body::-webkit-scrollbar-thumb {
    background: var(--shell-scrollbar, rgba(255,255,255,0.18));
    border-radius: 2px;
  }

  /* ── Drag handle ── */
  .drag-handle {
    position: absolute;
    top: 0;
    right: -3px;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 2;
    /* Invisible grab strip */
    background: transparent;
    transition: background var(--motion-fast, 150ms);
  }
  .drag-handle:hover,
  .drag-handle.is-dragging {
    background: var(--fg-brand, #EAB308);
    opacity: 0.6;
  }
  .drag-handle.is-dragging {
    opacity: 1;
  }

  /* ── Skeleton loading ── */
  .skel-row {
    height: 28px;
    border-radius: var(--r-6, 6px);
    background: var(--shell-control, #3A3430);
    margin-bottom: var(--s-4, 4px);
    animation: sp-pulse 1.4s ease-in-out infinite;
  }
  @keyframes sp-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skel-row { animation: none; opacity: 0.5; }
  }

  /* ── Panel items ── */
  .panel-item {
    display: flex;
    align-items: center;
    gap: var(--s-8, 8px);
    height: 28px;
    padding: 0 var(--s-8, 8px);
    border: none;
    border-radius: var(--r-6, 6px);
    background: transparent;
    color: var(--shell-fg-muted, rgba(255,255,255,0.62));
    font-family: inherit;
    font-size: 13px;
    line-height: 18px;
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background var(--motion-fast, 150ms), color var(--motion-fast, 150ms);
    width: 100%;
    text-align: left;
  }
  .panel-item:hover {
    background: var(--shell-hover, rgba(255,255,255,0.06));
    color: var(--shell-fg, #fff);
  }
  .panel-item.is-active {
    background: var(--yellow-100, #FBF0CE);
    color: var(--sand-900, #242628);
    font-weight: 500;
  }
  .panel-item:focus-visible {
    outline: 2px solid var(--shell-selected, #F7E19C);
    outline-offset: -2px;
  }

  /* ── Hide on mobile ── */
  @media (max-width: 1023.98px) {
    :scope { display: none; }
  }
}
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, _sheet];

// ── Component ───────────────────────────────────────────────────────────

class AppSidebarPanel extends HTMLElement {
  #width = DEFAULT_WIDTH;
  #dragging = false;
  #startX = 0;
  #startWidth = 0;
  #lastTapTime = 0;
  #handle = null;

  static get observedAttributes() {
    return ['panel-id', 'title'];
  }

  connectedCallback() {
    this.#loadWidth();
    this.#applyWidth();
    this.#renderStructure();
    this.#attachDrag();
    this.#updateBodyPadding();
  }

  disconnectedCallback() {
    this.#detachDrag();
    this.#clearBodyPadding();
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === 'panel-id') {
      this.#loadWidth();
      this.#applyWidth();
    }
    if (name === 'title') {
      const titleEl = this.querySelector('.panel-title');
      if (titleEl) titleEl.textContent = this.getAttribute('title') || '';
    }
  }

  /** Set panel content (array of { label, url?, section?, icon? } items). */
  set items(list) {
    const body = this.querySelector('.panel-body');
    if (!body) return;

    if (!list || !list.length) {
      body.innerHTML = `<div style="padding: var(--s-16); color: var(--shell-fg-muted); font-size: 13px;">No items</div>`;
      return;
    }

    body.innerHTML = list.map(item => {
      const active = item.url && this.#isActive(item.url);
      const cls = `panel-item${active ? ' is-active' : ''}`;
      if (item.url) {
        return `<a class="${cls}" href="${_esc(item.url)}" ${active ? 'aria-current="page"' : ''}>${_esc(item.label)}</a>`;
      }
      return `<button type="button" class="${cls}" data-section="${_esc(item.section || '')}">${_esc(item.label)}</button>`;
    }).join('');
  }

  /** Show skeleton loading state. */
  showSkeleton() {
    const body = this.querySelector('.panel-body');
    if (!body) return;
    const widths = [0.82, 0.64, 0.74, 0.56, 0.82, 0.68, 0.78, 0.60];
    body.innerHTML = widths.map(w =>
      `<div class="skel-row" style="width: ${w * 100}%"></div>`
    ).join('');
  }

  // ── Width management ────────────────────────────────────────────────

  #loadWidth() {
    const id = this.getAttribute('panel-id');
    if (!id) return;
    try {
      const saved = localStorage.getItem(STORAGE_PREFIX + id);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
          this.#width = parsed;
        }
      }
    } catch { /* ignore */ }
  }

  #saveWidth() {
    const id = this.getAttribute('panel-id');
    if (!id) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + id, String(this.#width));
    } catch { /* quota */ }
  }

  #clampWidth(w) {
    const maxViewport = Math.min(MAX_WIDTH, window.innerWidth * 0.3);
    return Math.round(Math.max(MIN_WIDTH, Math.min(w, maxViewport)));
  }

  #applyWidth() {
    this.#width = this.#clampWidth(this.#width);
    this.style.setProperty('--panel-width', `${this.#width}px`);
  }

  #updateBodyPadding() {
    document.documentElement.style.setProperty('--app-panel-width', `${this.#width}px`);
  }

  #clearBodyPadding() {
    document.documentElement.style.removeProperty('--app-panel-width');
  }

  // ── Drag-to-resize ──────────────────────────────────────────────────

  #attachDrag() {
    this.#handle = this.querySelector('.drag-handle');
    if (!this.#handle) return;
    this.#handle.addEventListener('pointerdown', this.#onPointerDown);
    this.#handle.addEventListener('dblclick', this.#onDoubleClick);
  }

  #detachDrag() {
    if (!this.#handle) return;
    this.#handle.removeEventListener('pointerdown', this.#onPointerDown);
    this.#handle.removeEventListener('dblclick', this.#onDoubleClick);
    document.removeEventListener('pointermove', this.#onPointerMove);
    document.removeEventListener('pointerup', this.#onPointerUp);
  }

  #onPointerDown = (e) => {
    e.preventDefault();
    this.#dragging = true;
    this.#startX = e.clientX;
    this.#startWidth = this.#width;
    this.#handle.classList.add('is-dragging');
    this.#handle.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', this.#onPointerMove);
    document.addEventListener('pointerup', this.#onPointerUp);
    // Prevent text selection during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  #onPointerMove = (e) => {
    if (!this.#dragging) return;
    const delta = e.clientX - this.#startX;
    this.#width = this.#clampWidth(this.#startWidth + delta);
    this.#applyWidth();
    this.#updateBodyPadding();
  };

  #onPointerUp = (e) => {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#handle.classList.remove('is-dragging');
    this.#handle.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', this.#onPointerMove);
    document.removeEventListener('pointerup', this.#onPointerUp);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    this.#saveWidth();
    this.dispatchEvent(new CustomEvent('panel-resize', {
      bubbles: true,
      detail: { width: this.#width },
    }));
  };

  #onDoubleClick = () => {
    this.#width = DEFAULT_WIDTH;
    this.#applyWidth();
    this.#updateBodyPadding();
    this.#saveWidth();
  };

  // ── Helpers ─────────────────────────────────────────────────────────

  #isActive(url) {
    const path = url.split('?')[0].replace(/\.html$/, '').replace(/\/+$/, '') || '/';
    const current = location.pathname.replace(/\.html$/, '').replace(/\/+$/, '') || '/';
    return path === current;
  }

  #renderStructure() {
    const title = this.getAttribute('title') || '';
    this.innerHTML = `
      <div class="panel-header">
        <span class="panel-title">${_esc(title)}</span>
      </div>
      <div class="panel-body"></div>
      <div class="drag-handle" role="separator" aria-orientation="vertical"
           aria-label="Resize panel" tabindex="0"></div>
    `;
  }
}

function _esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

if (!customElements.get('app-sidebar-panel')) {
  customElements.define('app-sidebar-panel', AppSidebarPanel);
}

export { AppSidebarPanel };
