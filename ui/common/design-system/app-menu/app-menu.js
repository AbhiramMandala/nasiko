/**
 * Anchored popup menu: a trigger that opens a list of actions.
 *
 * The one menu. It is the former `<app-action-menu>` (the "⋯" row menu, whose
 * light surface and item paint this keeps) merged with nasiko_ui's
 * `NasikoPopupMenu` behaviours: items carry an icon, a destructive tone, a
 * disabled state and a keyboard-shortcut hint; groups are separated by
 * dividers; the surface is a top-layer popover placed by `utils/anchor.js`
 * (flip + clamp, follows the anchor), so it paints above an open dialog and is
 * never clipped by an `overflow: hidden` card — the two failures the old
 * `position: absolute` dropdown had.
 *
 * Two ways to give it a trigger:
 *  - **Your element** as the first child — normally an `<app-button>`.
 *  - **Nothing but an icon** (an inline `<svg>`, or no children at all): the menu
 *    renders its own ghost icon button, `trigger-label` names it, and the
 *    default glyph is the vertical ellipsis. This is the row-actions form.
 *
 * WAI-ARIA menu-button pattern: `aria-haspopup="menu"` on the trigger, focus
 * moves into the menu on open, ArrowUp/Down rove (wrapping), Home/End jump,
 * a typed letter jumps to the next matching item, Enter/Space activate, Tab
 * and Escape close, Escape and selection return focus to the trigger.
 *
 * `<app-context-menu>` renders the same items at the pointer position; it
 * imports the item renderer and keyboard handler from this module.
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
 * @attr {string} trigger-label - Accessible name of the built-in icon trigger
 *   (default: `Actions`). Ignored when you supply your own trigger element.
 * @attr {string} trigger-title - (deprecated: use trigger-label) The old name.
 * @slot default - The trigger element (first child), or a bare `<svg>` for the built-in trigger.
 * @fires menu-select - `{ id }` when an item is activated. Bubbles.
 * @fires menu-toggle - `{ open }` after every open/close. Bubbles.
 * @method show() / hide() / toggle()
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-menu.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml, escStyleValue } from '../../utils/escape.js';
import { positionAnchored, followAnchor, supportsPopover } from '../../utils/anchor.js';
import { readAttr, emit, warnOnce } from '../../utils/deprecate.js';
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
  static get observedAttributes() {
    return ['items', 'open', 'side', 'align', 'width', 'disabled', 'label', 'trigger-label', 'trigger-title'];
  }

  #trigger = null;      // the element that opens the menu (yours, or the built-in button)
  #ownTrigger = false;  // true when the component rendered the trigger itself
  #surface = null;
  #built = false;
  #unfollow = null;
  #onDocClick = (e) => { if (!this.contains(e.target)) this.hide(); };
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
    if (this.open) this.removeAttribute('open');
  }

  attributeChangedCallback(name) {
    if (!this.#built) return;
    if (name === 'open') return this.#sync();
    if (name === 'items') this.#renderItems();
    if (name === 'width') this.#applyWidth();
    if (name === 'label') this.#applyLabel();
    if (name === 'trigger-label' || name === 'trigger-title') this.#applyTriggerLabel();
    if (name === 'disabled') this.#focusable()?.toggleAttribute('disabled', this.hasAttribute('disabled') && this.#ownTrigger);
    if (this.open) this.#place();
  }

  /** The element inside the trigger that actually takes focus and ARIA. */
  #focusable() {
    return this.#trigger?.matches('button, a, [tabindex]') ? this.#trigger
      : (this.#trigger?.querySelector('button, a, [tabindex]') ?? this.#trigger);
  }

  #focusTrigger() { this.#focusable()?.focus?.(); }

  #applyLabel() {
    const l = this.getAttribute('label');
    l ? this.#surface.setAttribute('aria-label', l) : this.#surface.removeAttribute('aria-label');
  }

  #applyTriggerLabel() {
    if (!this.#ownTrigger) return;
    const l = readAttr(this, 'trigger-label', 'trigger-title') || 'Actions';
    this.#trigger.setAttribute('aria-label', l);
    this.#trigger.setAttribute('title', l);
  }

  #build() {
    if (this.#built) return;
    this.#built = true;

    // A trigger you supplied is the first element child that is not an svg.
    // Otherwise the component renders its own ghost icon button around the
    // svg you passed (or the default ⋯ glyph) — the row-actions form.
    const supplied = [...this.children].find((el) => el.localName !== 'svg');
    if (supplied) {
      this.#trigger = supplied;
    } else {
      const glyph = this.querySelector(':scope > svg')?.outerHTML ?? icons.moreVertical('', 16);
      this.replaceChildren();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-trigger';
      btn.innerHTML = glyph;
      this.append(btn);
      unsizeIcons(btn);
      this.#trigger = btn;
      this.#ownTrigger = true;
      if (this.hasAttribute('disabled')) btn.disabled = true;
    }

    // The surface stays inside the host: the Popover API lifts it to the top
    // layer from here, and events keep bubbling through the host.
    const surface = document.createElement('div');
    surface.className = 'app-menu-surface';
    surface.setAttribute('role', 'menu');
    surface.hidden = true;
    if (supportsPopover) surface.popover = 'manual';
    this.append(surface);
    this.#surface = surface;
    this.#renderItems();
    this.#applyWidth();
    this.#applyLabel();
    this.#applyTriggerLabel();

    surface.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item || item.disabled) return;
      // The menu usually sits inside a clickable card; the raw click must not
      // reach the card's handler and open it alongside the action.
      e.stopPropagation();
      this.hide();
      this.#focusTrigger();
      emit(this, 'menu-select', { id: item.dataset.id }, { legacy: 'action-select' });
    });

    this.#trigger.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    // ArrowDown on the trigger opens (menu-button pattern).
    this.#trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && !this.open) { e.preventDefault(); this.show(); }
    });
    const f = this.#focusable();
    f?.setAttribute('aria-haspopup', 'menu');
    f?.setAttribute('aria-expanded', 'false');
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
    this.#focusable()?.setAttribute?.('aria-expanded', String(open));
    emit(this, 'menu-toggle', { open });
  }

  #teardown() {
    this.#unfollow?.(); this.#unfollow = null;
    document.removeEventListener('click', this.#onDocClick, true);
    document.removeEventListener('keydown', this.#onKey);
  }
}
customElements.define('app-menu', AppMenu);

/**
 * Deprecated alias. `<app-action-menu>` IS `<app-menu>` now — same class, same
 * markup (icon child, `items`), same light surface. It logs once and is removed
 * next release. Not catalogued: a generated surface only learns `app-menu`.
 */
class AppActionMenuAlias extends AppMenu {
  connectedCallback() {
    warnOnce('app-action-menu', '<app-action-menu> is deprecated — use <app-menu>. Same attributes; `trigger-title` is now `trigger-label`, `action-select` is now `menu-select`.');
    super.connectedCallback();
  }
}
if (!customElements.get('app-action-menu')) customElements.define('app-action-menu', AppActionMenuAlias);
