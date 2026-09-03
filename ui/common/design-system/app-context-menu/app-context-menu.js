/**
 * Right-click (or long-press) menu at the pointer position.
 *
 * Ported from nasiko_ui `NasikoContextMenu`. Wrap the thing that has a context
 * menu — a file row, a canvas node, a card — and describe the actions in
 * `items`; the menu opens where the pointer is, prefers below-right of it and
 * flips/clamps against the viewport. Surface, items and keyboard are the same
 * as `<app-menu>` (imported from it), so the two look and behave identically.
 *
 * Touch: a 500ms long-press opens it, as on the Flutter side. The native
 * browser context menu is suppressed only while this element has items.
 *
 * @element app-context-menu
 * @attr {string} items - JSON array of `{ id, label, icon?, destructive?, disabled?, shortcut? }`
 *   or `{ divider: true }` — the `<app-menu>` format.
 * @attr {boolean} disabled - Right-click falls through to the browser.
 * @attr {string} label - Accessible name of the `role="menu"` surface.
 * @slot default - The element(s) the menu is attached to.
 * @fires menu-select - `{ id }` when an item is activated. Bubbles.
 * @fires menu-toggle - `{ open }` after every open/close. Bubbles.
 * @method openAt(x, y) - Open at viewport coordinates programmatically.
 * @method hide()
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-context-menu.css', import.meta.url));
import { positionAnchored, supportsPopover } from '../../utils/anchor.js';
import { parseMenuItems, renderMenuItems, menuKeydown } from '../app-menu/app-menu.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const LONG_PRESS_MS = 500;

export class AppContextMenu extends HTMLElement {
  static get observedAttributes() { return ['items', 'disabled', 'label']; }

  #surface = null;
  #built = false;
  #open = false;
  #restoreFocus = null;
  #pressTimer = null;
  #onDocClick = (e) => { if (!this.#surface.contains(e.target)) this.hide(); };
  #onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); this.hide(); return; }
    if (e.key === 'Tab') { this.hide(); return; }
    menuKeydown(this.#surface, e);
  };
  #onScroll = () => this.hide();

  connectedCallback() { this.#build(); }

  disconnectedCallback() {
    this.hide();
    this.#surface?.remove();
  }

  attributeChangedCallback(name) {
    if (!this.#built) return;
    if (name === 'items') this.#surface.innerHTML = renderMenuItems(parseMenuItems(this.getAttribute('items')));
    if (name === 'label') this.#applyLabel();
  }

  #applyLabel() {
    const l = this.getAttribute('label');
    l ? this.#surface.setAttribute('aria-label', l) : this.#surface.removeAttribute('aria-label');
  }

  #build() {
    if (this.#built) return;
    this.#built = true;
    const surface = document.createElement('div');
    surface.className = 'app-menu-surface app-context-menu-surface';
    surface.setAttribute('role', 'menu');
    surface.hidden = true;
    if (supportsPopover) surface.popover = 'manual';
    surface.innerHTML = renderMenuItems(parseMenuItems(this.getAttribute('items')));
    document.body.append(surface);
    this.#surface = surface;
    this.#applyLabel();

    surface.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item || item.disabled) return;
      e.stopPropagation();
      this.hide();
      this.dispatchEvent(new CustomEvent('menu-select', { bubbles: true, detail: { id: item.dataset.id } }));
    });

    this.addEventListener('contextmenu', (e) => {
      if (this.hasAttribute('disabled') || !parseMenuItems(this.getAttribute('items')).length) return;
      e.preventDefault();
      this.openAt(e.clientX, e.clientY);
    });

    // Long-press for touch.
    this.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this.hasAttribute('disabled')) return;
      clearTimeout(this.#pressTimer);
      this.#pressTimer = setTimeout(() => this.openAt(e.clientX, e.clientY), LONG_PRESS_MS);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointermove']) {
      this.addEventListener(ev, () => { clearTimeout(this.#pressTimer); this.#pressTimer = null; });
    }
  }

  openAt(x, y) {
    const s = this.#surface;
    if (!s.querySelector('.menu-item')) return;
    this.#restoreFocus = document.activeElement;
    if (!this.#open) {
      this.#open = true;
      s.hidden = false;
      if (supportsPopover) s.showPopover();
      document.addEventListener('click', this.#onDocClick, true);
      document.addEventListener('keydown', this.#onKey);
      window.addEventListener('scroll', this.#onScroll, { capture: true, passive: true });
    }
    // Anchor to a zero-size rect at the pointer; the engine prefers below-right
    // and flips/clamps like every other overlay.
    const rect = { top: y, bottom: y, left: x, right: x, width: 0, height: 0 };
    const { side } = positionAnchored(s, rect, { side: 'bottom', align: 'start', gap: 2 });
    s.dataset.side = side;
    s.querySelector('.menu-item:not([disabled])')?.focus();
    this.dispatchEvent(new CustomEvent('menu-toggle', { bubbles: true, detail: { open: true } }));
  }

  hide() {
    if (!this.#open) return;
    this.#open = false;
    document.removeEventListener('click', this.#onDocClick, true);
    document.removeEventListener('keydown', this.#onKey);
    window.removeEventListener('scroll', this.#onScroll, { capture: true });
    const s = this.#surface;
    if (supportsPopover && s.matches(':popover-open')) s.hidePopover();
    s.hidden = true;
    // Escape and item activation both put focus back where it lived.
    this.#restoreFocus?.focus?.();
    this.#restoreFocus = null;
    this.dispatchEvent(new CustomEvent('menu-toggle', { bubbles: true, detail: { open: false } }));
  }
}
customElements.define('app-context-menu', AppContextMenu);
