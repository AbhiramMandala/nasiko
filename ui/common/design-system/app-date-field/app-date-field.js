/**
 * Read-only date input that opens an `<app-calendar>` in a popover.
 *
 * Ported from nasiko_ui `NasikoDateField`. Shows the formatted value (or the
 * placeholder) with a trailing calendar icon, in `<app-input>`'s exact box.
 * Clicking the field — or Enter / Space / ArrowDown while it has focus — opens
 * the calendar; picking a date sets `value`, closes the popover and returns
 * focus to the field; Escape closes and restores focus.
 *
 * Why not `<input type="date">`: its picker is the browser's, unstyleable and
 * different on every platform, and it cannot take `min`/`max` from a design
 * token. This keeps the platform's form semantics (a hidden native input
 * carries `name`/`value` for submit) and owns the picker.
 *
 * @element app-date-field
 * @attr {string} value - Selected date, `YYYY-MM-DD`. Reflected on pick.
 * @attr {string} min - Earliest selectable date, `YYYY-MM-DD`.
 * @attr {string} max - Latest selectable date, `YYYY-MM-DD`.
 * @attr {string} label - Label above the box.
 * @attr {string} hint - Helper line below the box. Turns red in `state="error"`.
 * @attr {string} placeholder - Shown when empty (default: `Select date`).
 * @attr {string} state - `error` — red border. Omit for default.
 * @attr {boolean} required - Red `*` before the label.
 * @attr {boolean} disabled
 * @attr {string} size - `md` (default, 32px) | `sm` (28px)
 * @attr {string} name - Forwarded to the hidden native input for form submit.
 * @prop {string|null} value - Get/set the ISO date.
 * @fires change - `{ value }` after the user picks a day. Bubbles.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-date-field.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import { parseDate, formatDisplay } from '../../utils/date-utils.js';
import '../app-popover/app-popover.js';
import '../app-calendar/app-calendar.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppDateField extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'min', 'max', 'label', 'hint', 'placeholder', 'state', 'required', 'disabled', 'size', 'name'];
  }

  #id = `app-date-field-${++uid}`;
  #wired = false;

  get value() { return this.getAttribute('value') || null; }
  set value(v) { v ? this.setAttribute('value', v) : this.removeAttribute('value'); }

  connectedCallback() {
    this.render();
    if (this.#wired) return;
    this.#wired = true;
    // The calendar's `change` bubbles through here; re-emit as our own and close.
    this.addEventListener('change', (e) => {
      if (e.target.localName !== 'app-calendar') return;
      e.stopPropagation();
      this.setAttribute('value', e.detail.value);
      this.querySelector('app-popover')?.hide();
      this.querySelector('.field-btn')?.focus();
      this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value: e.detail.value } }));
    });
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    // Value and range changes update in place — rebuilding would close an open popover.
    if (['value', 'min', 'max'].includes(name) && this.querySelector('app-calendar')) return this.#sync();
    this.render();
  }

  #sync() {
    const cal = this.querySelector('app-calendar');
    for (const a of ['value', 'min', 'max']) {
      this.hasAttribute(a) ? cal.setAttribute(a, this.getAttribute(a)) : cal.removeAttribute(a);
    }
    const d = parseDate(this.value);
    const text = this.querySelector('.text');
    text.textContent = d ? formatDisplay(d) : (this.getAttribute('placeholder') || 'Select date');
    text.classList.toggle('is-placeholder', !d);
    const native = this.querySelector('input[type="hidden"]');
    if (native) native.value = this.value ?? '';
  }

  render() {
    const disabled = this.hasAttribute('disabled');
    const state = disabled ? 'disabled' : (this.getAttribute('state') === 'error' ? 'error' : 'default');
    const size = this.getAttribute('size') === 'sm' ? 'sm' : 'md';
    const label = this.getAttribute('label');
    const hint = this.getAttribute('hint');
    const name = this.getAttribute('name');

    this.innerHTML = `
      <div class="field is-${state} is-${size}">
        ${label === null ? '' : `<label class="label-row" for="${this.#id}">${escHtml(label)}${this.hasAttribute('required') ? '<span class="req"> *</span>' : ''}</label>`}
        <app-popover side="bottom" align="start">
          <button type="button" class="field-btn" id="${this.#id}" aria-haspopup="dialog"${disabled ? ' disabled' : ''}>
            <span class="text"></span>
            <span class="icon" aria-hidden="true">${icons.calendar()}</span>
          </button>
          <div data-slot="content"><app-calendar label="Choose a date"></app-calendar></div>
        </app-popover>
        ${name ? `<input type="hidden" name="${escAttr(name)}">` : ''}
        ${hint === null ? '' : `<div class="hint-row">${escHtml(hint)}</div>`}
      </div>`;
    unsizeIcons(this.querySelector('.field-btn'));
    this.#sync();

    // ArrowDown opens too (Enter/Space are the button's own activation).
    this.querySelector('.field-btn').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.querySelector('app-popover').show(); }
    });
    // On open, focus lands on the calendar's roving day rather than its first
    // button (the previous-month arrow), so arrow keys move dates immediately.
    this.querySelector('app-popover').addEventListener('popover-toggle', (e) => {
      if (e.detail.open) this.querySelector('app-calendar .day[tabindex="0"]')?.focus();
    });
  }
}
customElements.define('app-date-field', AppDateField);
