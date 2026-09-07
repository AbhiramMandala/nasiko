/**
 * Icon button that opens a compact dropdown list of actions.
 *
 * Pass the trigger icon as innerHTML and configure items via the `items` attribute.
 * The component captures the inner HTML on first connect as the trigger icon.
 *
 * @example
 * ```html
 * <app-action-menu trigger-title="Options" items='[{"id":"a","label":"Action A"},{"id":"b","label":"Action B"}]'>
 *   <svg ...></svg>
 * </app-action-menu>
 * ```
 *
 * @element app-action-menu
 * @attr {string} trigger-title - Tooltip text for the trigger button
 * @attr {string} items - JSON array of `{ id, label }` action items
 * @fires action-select - Item clicked; `detail: { id: string }` — bubbles
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-action-menu.css', import.meta.url));
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppActionMenu extends HTMLElement {
  #open = false;
  #outsideClickHandler = null;
  #escHandler = (e) => {
    if (e.key === 'Escape') {
      this.#close();
      // Escape hands focus back to the control that opened the menu — without
      // this, focus falls to <body> and a keyboard user starts over from the top.
      this.querySelector('.aam-trigger')?.focus();
    }
  };

  /** `items` is bound from data (a generated surface may set it), so both halves
   *  are escaped and malformed JSON degrades to an empty menu instead of
   *  throwing out of connectedCallback and killing the element. */
  #items() {
    try {
      const parsed = JSON.parse(this.getAttribute('items') || '[]');
      return Array.isArray(parsed) ? parsed.filter((i) => i && typeof i === 'object') : [];
    } catch {
      console.warn('[app-action-menu] invalid `items` JSON — rendering an empty menu');
      return [];
    }
  }

  connectedCallback() {
    // Re-connect keeps the DOM and listeners built on first connect; rebuilding
    // here would re-capture our own trigger markup as the "icon".
    if (this.querySelector('.aam-trigger')) return;
    const iconHtml = this.innerHTML.trim();
    const items = this.#items();
    const title = this.getAttribute('trigger-title') || '';

    this.innerHTML = `
      <button type="button" class="aam-trigger btn-icon" title="${escAttr(title)}"
        aria-label="${escAttr(title || 'Actions')}" aria-haspopup="menu" aria-expanded="false">
        ${iconHtml}
      </button>
      <div class="aam-menu" hidden role="menu">
        ${items.map(item => `<button type="button" class="aam-item" role="menuitem" tabindex="-1" data-id="${escAttr(item.id)}">${escHtml(item.label)}</button>`).join('')}
      </div>
    `;

    this.#bindEvents();
  }

  disconnectedCallback() {
    this.#close();
  }

  #bindEvents() {
    this.querySelector('.aam-trigger').addEventListener('click', (e) => {
      e.stopPropagation();
      this.#open ? this.#close() : this.#openMenu();
    });

    // WAI-ARIA menu-button pattern: role="menu" promises arrow-key navigation,
    // so the items deliver it — ArrowUp/Down move focus (wrapping), Home/End
    // jump, and Tab closes (a menu is not a tab stop sequence).
    this.addEventListener('keydown', (e) => {
      if (!this.#open) return;
      if (e.key === 'Tab') { this.#close(); return; }
      const items = [...this.querySelectorAll('.aam-item')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      items[((next % items.length) + items.length) % items.length].focus();
    });

    this.querySelectorAll('.aam-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // Same reason the trigger stops here: the menu usually sits inside a
        // clickable card, and the raw click would reach that card's handler and
        // open it alongside whatever action was picked. `action-select` is a
        // separate event and still bubbles.
        e.stopPropagation();
        this.#close();
        this.dispatchEvent(new CustomEvent('action-select', {
          bubbles: true,
          detail: { id: btn.dataset.id },
        }));
      });
    });
  }

  #openMenu() {
    this.#open = true;
    this.querySelector('.aam-menu').hidden = false;
    this.querySelector('.aam-trigger').setAttribute('aria-expanded', 'true');
    // Focus moves into the menu on open (menu-button pattern); Escape and the
    // arrow keys take it from there.
    this.querySelector('.aam-item')?.focus();

    this.#outsideClickHandler = (e) => { if (!this.contains(e.target)) this.#close(); };
    document.addEventListener('click', this.#outsideClickHandler);
    document.addEventListener('keydown', this.#escHandler);
  }

  #close() {
    if (!this.#open) return;
    this.#open = false;
    const menu = this.querySelector('.aam-menu');
    const trigger = this.querySelector('.aam-trigger');
    if (menu) menu.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');

    document.removeEventListener('click', this.#outsideClickHandler);
    document.removeEventListener('keydown', this.#escHandler);
    this.#outsideClickHandler = null;
  }
}

customElements.define('app-action-menu', AppActionMenu);
