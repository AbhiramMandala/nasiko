/**
 * Anchored popup menu: a trigger that opens a list of actions.
 *
 * Ported from nasiko_ui `NasikoPopupMenu`. Where `<app-action-menu>` is the
 * compact "⋯" row menu with plain labels, this is the full menu: items carry
 * an icon, a destructive tone, a disabled state and a keyboard shortcut hint,
 * and groups are separated by dividers. It wears the Flutter menu's inverse
 * surface — dark in light mode, the elevated surface in dark mode — which is a
 * design decision, not a theme bug.
 *
 * WAI-ARIA menu-button pattern: the trigger has `aria-haspopup="menu"`, focus
 * moves into the menu on open, ArrowUp/Down rove (wrapping), Home/End jump,
 * Enter/Space activate, Escape closes and returns focus to the trigger,
 * typing a letter jumps to the next item starting with it.
 *
 * `<app-context-menu>` renders the same items at a pointer position; both
 * import the item renderer from this module.
 *
 * @element app-menu
 * @attr {string} items - JSON array of `{ id, label, icon?, destructive?, disabled?, shortcut? }`
 *   or `{ divider: true }`. `icon` is a key of `utils/icons.js`; `shortcut` is
 *   an `<app-kbd>` keys string like `⌘ K`.
 * @attr {boolean} open - Whether the menu is showing. Reflected.
 * @attr {string} side - `bottom` (default) | `top` | `left` | `right`
 * @attr {string} align - `start` (default) | `center` | `end`
 * @attr {string} width - CSS width for the menu. Default: content, min 10rem.
 * @attr {boolean} disabled - The trigger does not open the menu.
 * @attr {string} label - Accessible name of the `role="menu"` surface, e.g. `Agent actions`.
 * @slot default - The trigger element (first child).
 * @fires menu-select - `{ id }` when an item is activated. Bubbles.
 * @fires menu-toggle - `{ open }` after every open/close. Bubbles.
 * @method show() / hide() / toggle()
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-menu.css', import.meta.url));
import { icons } from '../../utils/icons.js';
import { escAttr, escHtml, escStyleValue } from '../../utils/escape.js';
import { positionAnchored, followAnchor, supportsPopover } from '../../utils/anchor.js';
import '../app-kbd/app-kbd.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** Parse an `items` attribute leniently: bad JSON is an empty menu, not a throw. */
export function parseMenuItems(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((i) => i && typeof i === 'object') : [];
  } catch {
    console.warn('[app-menu] invalid `items` JSON — rendering an empty menu');
    return [];
  }
}

/** Render items into `role="menu"` markup. Shared with app-context-menu. */
export function renderMenuItems(items) {
  return items.map((item) => {
    if (item.divider) return '<div class="menu-divider" role="separator"></div>';
    const icon = item.icon && typeof icons[item.icon] === 'function' ? icons[item.icon]('', 16) : '';
    return `<button type="button" class="menu-item${item.destructive ? ' is-destructive' : ''}" role="menuitem"
      tabindex="-1" data-id="${escAttr(item.id)}"${item.disabled ? ' disabled aria-disabled="true"' : ''}>
      ${icon ? `<span class="menu-icon" aria-hidden="true">${icon}</span>` : ''}
      <span class="menu-label">${escHtml(item.label)}</span>
      ${item.shortcut ? `<app-kbd class="menu-shortcut" size="sm" keys="${escAttr(item.shortcut)}"></app-kbd>` : ''}
    </button>`;
  }).join('');
}

/**
 * Keyboard for a `role="menu"` surface: arrows rove with wrap, Home/End jump,
 * a printable character jumps to the next matching label. Returns true when
 * the key was handled. Shared with app-context-menu.
 */
export function menuKeydown(surface, e) {
  const items = [...surface.querySelectorAll('.menu-item:not([disabled])')];
  if (!items.length) return false;
  const i = items.indexOf(document.activeElement);
  const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (next !== undefined) {
    e.preventDefault();
    items[((next % items.length) + items.length) % items.length].focus();
    return true;
  }
  if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const ch = e.key.toLowerCase();
    const order = [...items.slice(i + 1), ...items.slice(0, i + 1)];
    const hit = order.find((el) => el.querySelector('.menu-label')?.textContent.trim().toLowerCase().startsWith(ch));
    if (hit) { e.preventDefault(); hit.focus(); return true; }
  }
  return false;
}

export class AppMenu extends HTMLElement {
  static get observedAttributes() { return ['items', 'open', 'side', 'align', 'width', 'disabled', 'label']; }

  #trigger = null;
  #surface = null;
  #built = false;
  #unfollow = null;
  #onDocClick = (e) => {
    if (this.contains(e.target) || this.#surface.contains(e.target)) return;
    this.hide();
  };
  #onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); this.hide(); this.#focusTrigger(); return; }
    if (e.key === 'Tab') { this.hide(); return; }
    if (this.#surface.contains(document.activeElement)) menuKeydown(this.#surface, e);
  };

  get open() { return this.hasAttribute('open'); }
  set open(v) { v ? this.setAttribute('open', '') : this.removeAttribute('open'); }
  show() { if (!this.hasAttribute('disabled')) this.open = true; }
  hide() { this.open = false; }
  toggle() { this.open ? this.hide() : this.show(); }

  connectedCallback() {
    this.#build();
    this.#sync();
  }

  disconnectedCallback() {
    this.#teardown();
    this.#surface?.remove();
  }

  attributeChangedCallback(name) {
    if (!this.#built) return;
    if (name === 'open') return this.#sync();
    if (name === 'items') this.#renderItems();
    if (name === 'width') this.#applyWidth();
    if (name === 'label') this.#applyLabel();
    if (this.open) this.#place();
  }

  #applyLabel() {
    const l = this.getAttribute('label');
    l ? this.#surface.setAttribute('aria-label', l) : this.#surface.removeAttribute('aria-label');
  }

  #build() {
    if (this.#built) return;
    this.#built = true;
    this.#trigger = this.firstElementChild;

    const surface = document.createElement('div');
    surface.className = 'app-menu-surface';
    surface.setAttribute('role', 'menu');
    surface.hidden = true;
    if (supportsPopover) surface.popover = 'manual';
    document.body.append(surface);
    this.#surface = surface;
    this.#renderItems();
    this.#applyWidth();
    this.#applyLabel();

    surface.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item || item.disabled) return;
      e.stopPropagation();
      this.hide();
      this.#focusTrigger();
      this.dispatchEvent(new CustomEvent('menu-select', { bubbles: true, detail: { id: item.dataset.id } }));
    });

    if (this.#trigger) {
      this.#trigger.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
      // ArrowDown on the trigger opens (menu-button pattern).
      this.#trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' && !this.open) { e.preventDefault(); this.show(); }
      });
      const focusable = this.#trigger.querySelector('button, a, [tabindex]') ?? this.#trigger;
      focusable.setAttribute('aria-haspopup', 'menu');
      focusable.setAttribute('aria-expanded', 'false');
    }
  }

  #focusTrigger() {
    (this.#trigger?.querySelector('button, a, [tabindex]') ?? this.#trigger)?.focus?.();
  }

  #renderItems() {
    this.#surface.innerHTML = renderMenuItems(parseMenuItems(this.getAttribute('items')));
  }

  #applyWidth() {
    const w = this.getAttribute('width');
    this.#surface.style.width = w ? escStyleValue(w) : '';
  }

  #place() {
    const { side } = positionAnchored(this.#surface, this.#trigger ?? this, {
      side: this.getAttribute('side') || 'bottom',
      align: this.getAttribute('align') || 'start',
    });
    this.#surface.dataset.side = side;
  }

  #sync() {
    const open = this.open;
    const s = this.#surface;
    if (open === !s.hidden) return;
    if (open) {
      s.hidden = false;
      if (supportsPopover) s.showPopover();
      this.#place();
      this.#unfollow = followAnchor(() => this.#place());
      document.addEventListener('click', this.#onDocClick, true);
      document.addEventListener('keydown', this.#onKey);
      s.querySelector('.menu-item:not([disabled])')?.focus();
    } else {
      this.#teardown();
      if (supportsPopover && s.matches(':popover-open')) s.hidePopover();
      s.hidden = true;
    }
    (this.#trigger?.querySelector('button, a, [tabindex]') ?? this.#trigger)?.setAttribute?.('aria-expanded', String(open));
    this.dispatchEvent(new CustomEvent('menu-toggle', { bubbles: true, detail: { open } }));
  }

  #teardown() {
    this.#unfollow?.(); this.#unfollow = null;
    document.removeEventListener('click', this.#onDocClick, true);
    document.removeEventListener('keydown', this.#onKey);
  }
}
customElements.define('app-menu', AppMenu);
