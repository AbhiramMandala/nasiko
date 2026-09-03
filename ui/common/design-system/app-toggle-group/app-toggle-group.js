/**
 * A row of `<app-toggle>`s with single or multiple selection.
 *
 * Ported from nasiko_ui `NasikoToggleGroup`. The group owns the selection rule
 * and the keyboard: in `single` mode pressing one item releases the others and
 * the pressed item cannot be un-pressed (a segmented control); in `multiple`
 * mode each item toggles freely. ArrowLeft/ArrowRight move focus across
 * enabled items with wrap-around, Home/End jump; Enter/Space activate (the
 * toggle's own button does that).
 *
 * Design rule carried over: items in a group share one `size`, set here.
 *
 * @element app-toggle-group
 * @attr {string} selection - `single` (default) | `multiple`
 * @attr {string} mode - (deprecated: use selection)
 * @attr {string} size - `md` (default) | `sm` | `lg` — applied to every item.
 * @attr {string} value - In `single` mode, the `value` of the pressed item.
 *   Reflected as the user picks. In `multiple` mode, a space-separated list.
 * @attr {boolean} disabled - Disables every item.
 * @attr {boolean} attached - Fuses the items into one segmented bar (shared
 *   hairlines, radius on the outer corners only). CSS-only.
 * @attr {string} label - Accessible name of the `role="group"`.
 * @slot default - `<app-toggle value="…">` children.
 * @prop {string|string[]} value - Selected value (single) or values (multiple).
 * @fires toggle-group-change - `{ value }` — a string in `single` mode, an array in `multiple`.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-toggle-group.css', import.meta.url));
import { readAttr, emit } from '../../utils/deprecate.js';
import '../app-toggle/app-toggle.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppToggleGroup extends HTMLElement {
  static get observedAttributes() { return ['selection', 'size', 'value', 'disabled', 'label', 'mode']; }

  #wired = false;

  get multiple() { return readAttr(this, 'selection', 'mode') === 'multiple'; }
  get items() { return [...this.querySelectorAll(':scope > app-toggle')]; }

  get value() {
    const pressed = this.items.filter((t) => t.pressed).map((t) => t.getAttribute('value'));
    return this.multiple ? pressed : (pressed[0] ?? null);
  }
  set value(v) {
    this.setAttribute('value', Array.isArray(v) ? v.join(' ') : (v ?? ''));
  }

  connectedCallback() {
    this.setAttribute('role', 'group');
    this.#sync();
    if (this.#wired) return;
    this.#wired = true;

    // The toggle asks before flipping; the group answers according to mode.
    this.addEventListener('toggle-request', (e) => {
      const item = e.target.closest('app-toggle');
      if (!item || item.parentElement !== this) return;
      e.preventDefault();
      if (this.multiple) {
        item.pressed = !item.pressed;
      } else {
        if (item.pressed) return; // single: cannot un-press the current one
        for (const t of this.items) t.pressed = t === item;
      }
      this.setAttribute('value', this.multiple ? this.value.join(' ') : (this.value ?? ''));
      item.emitChange();
      emit(this, 'toggle-group-change', { value: this.value }, { legacy: 'group-change' });
    });

    this.addEventListener('keydown', (e) => {
      const items = this.items.filter((t) => !t.hasAttribute('disabled'));
      if (!items.length) return;
      const i = items.indexOf(document.activeElement?.closest('app-toggle'));
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      items[((next % items.length) + items.length) % items.length].querySelector('button')?.focus();
    });
  }

  attributeChangedCallback() { if (this.isConnected) this.#sync(); }

  /** Push group-level attributes down and apply `value` to the items. */
  #sync() {
    const label = this.getAttribute('label');
    label ? this.setAttribute('aria-label', label) : this.removeAttribute('aria-label');
    const size = this.getAttribute('size');
    const disabled = this.hasAttribute('disabled');
    const selected = new Set((this.getAttribute('value') ?? '').split(/\s+/).filter(Boolean));
    for (const t of this.items) {
      size ? t.setAttribute('size', size) : t.removeAttribute('size');
      // Only undo what the group itself did — an item disabled by the page
      // stays disabled when the group is re-enabled.
      if (disabled) { t.setAttribute('disabled', ''); t.dataset.groupDisabled = ''; }
      else if ('groupDisabled' in t.dataset) { t.removeAttribute('disabled'); delete t.dataset.groupDisabled; }
      if (this.hasAttribute('value')) t.pressed = selected.has(t.getAttribute('value'));
    }
  }
}
customElements.define('app-toggle-group', AppToggleGroup);
