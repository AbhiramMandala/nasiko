/**
 * Vertical list of `<app-list-item>`s with roving keyboard focus.
 *
 * Ported from nasiko_ui `NasikoList` + `NasikoListItem`. The list is the
 * container and the keyboard owner: ArrowUp/ArrowDown move focus across
 * enabled items (wrapping), Home/End jump, and the items themselves handle
 * Enter/Space. Selection is the caller's: listen for `list-select` and set
 * `selected` on the item you consider current — the list never mutates state
 * on its own (the same controlled-component rule as the Flutter side).
 *
 * `<app-list-item>` attributes: `heading`, `description`, `value`, `image`, `indent` (0–n),
 * `selected`, `disabled`, `expandable`, `expanded`, `status-dot`, `badge`.
 * A leading inline `<svg>` child becomes the item's icon.
 *
 * @element app-list
 * @attr {string} label - Accessible name for the `role="listbox"`.
 * @attr {boolean} dense - Tighter vertical padding (s4 instead of s8).
 * @slot default - `<app-list-item>` children.
 * @children app-list-item
 * @fires list-select - `{ id, index }` bubbled from an item's `item-select`.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-list.css', import.meta.url));
import '../app-list-item/app-list-item.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppList extends HTMLElement {
  static get observedAttributes() { return ['label', 'dense']; }

  #wired = false;

  connectedCallback() {
    this.setAttribute('role', 'listbox');
    this.#syncLabel();
    if (this.#wired) return;
    this.#wired = true;

    this.addEventListener('keydown', (e) => {
      const items = this.#focusable();
      if (!items.length) return;
      const i = items.indexOf(document.activeElement?.closest('app-list-item'));
      const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      items[((next % items.length) + items.length) % items.length].focusRow();
    });

    this.addEventListener('list-item-select', (e) => {
      e.stopPropagation();
      const items = [...this.querySelectorAll(':scope > app-list-item')];
      this.dispatchEvent(new CustomEvent('list-select', {
        bubbles: true,
        detail: { id: e.detail.id, index: items.indexOf(e.target) },
      }));
    });
  }

  attributeChangedCallback() { if (this.isConnected) this.#syncLabel(); }

  #syncLabel() {
    const label = this.getAttribute('label');
    label ? this.setAttribute('aria-label', label) : this.removeAttribute('aria-label');
  }

  #focusable() {
    return [...this.querySelectorAll(':scope > app-list-item:not([disabled])')];
  }
}
customElements.define('app-list', AppList);
