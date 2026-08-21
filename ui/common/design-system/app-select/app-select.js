/**
 * Single-select dropdown: a styled native `<select>` with the input's label,
 * hint and state treatment.
 *
 * Matched to Figma "Design System V2" › ↳Select › Select (node 4581:45). The
 * trigger is a full match: same 32/28px box, padding, radius and border ramp as
 * app-input, plus a 16px chevron in fg/default/icon-secondary (#bb8f06).
 *
 * The design also specifies a custom listbox (4569:27) and per-option states
 * (4558:61: hover, focus, selected with a gold check, disabled). A native
 * `<select>` renders the OS popup, so those option states are not reachable
 * here — that is the trade for free keyboard, mobile and screen-reader
 * behaviour. If a page needs the designed listbox, that is a separate
 * popover-based component; the option tokens are already in place
 * (--bg-surface hover, --bg-secondary-brand selected, --fg-brand check).
 *
 * @element app-select
 * @attr {string} size - `md` (default, 32px) | `sm` (28px)
 * @attr {string} state - `error` | `success` | `hover` | `focus` (visual only)
 * @attr {string} label - Label above the trigger.
 * @attr {string} hint - Helper line below. Turns red in `state="error"`.
 * @attr {string} placeholder - Renders a selected-but-disabled first option.
 * @attr {string} options - JSON array of `"value"` or `{value, label, disabled}`.
 * @attr {boolean} required|disabled
 * @attr {string} name - Forwarded to the inner `<select>`.
 * @prop {string} value - Get/set the selected value.
 * @prop {HTMLSelectElement} select - The inner select.
 * @fires change - Bubbles from the inner select.
 * @note Options can be slotted as plain `<option>` children instead of the
 *       `options` attribute; whichever is present wins, attribute first.
 */
import styles from './app-select.css' with { type: 'css' };
import { icons, unsizeIcons } from '../../utils/icons.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppSelect extends HTMLElement {
  static get observedAttributes() {
    return ['size', 'state', 'label', 'hint', 'placeholder', 'options', 'required',
            'disabled', 'name', 'value'];
  }

  #id = `app-select-${++uid}`;
  /** Slotted <option> markup, captured once — render() replaces innerHTML. */
  #slotted = null;

  get value() { return this.select?.value ?? this.getAttribute('value') ?? ''; }
  set value(v) { if (this.select) this.select.value = v; else this.setAttribute('value', v); }
  get select() { return this.querySelector('select'); }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  /** `options` JSON → <option> markup. Bad JSON renders nothing rather than throwing. */
  #optionsHtml() {
    const raw = this.getAttribute('options');
    if (!raw) return this.#slotted;
    let list;
    try { list = JSON.parse(raw); } catch { return this.#slotted; }
    if (!Array.isArray(list)) return this.#slotted;
    return list.map((o) => {
      const { value, label, disabled } = typeof o === 'object' && o !== null
        ? o : { value: o, label: o };
      return `<option value="${String(value).replace(/"/g, '&quot;')}"${
        disabled ? ' disabled' : ''}>${label ?? value}</option>`;
    }).join('');
  }

  render() {
    const prev = this.select;
    const value = prev ? prev.value : (this.getAttribute('value') ?? '');
    const refocus = prev && document.activeElement === prev;
    if (this.#slotted === null) {
      this.#slotted = [...this.querySelectorAll('option')].map((o) => o.outerHTML).join('');
    }

    const size        = this.getAttribute('size') === 'sm' ? 'sm' : 'md';
    const disabled    = this.hasAttribute('disabled');
    const state       = disabled ? 'disabled' : (this.getAttribute('state') || 'default');
    const label       = this.getAttribute('label');
    const hint        = this.getAttribute('hint');
    const placeholder = this.getAttribute('placeholder');
    const name        = this.getAttribute('name');

    this.innerHTML = `
      <div class="field is-${size} is-${state}">
        ${label === null ? '' : `<label class="label-row" for="${this.#id}">${
          this.hasAttribute('required') ? '<span class="req">*</span>' : ''}${label}</label>`}
        <div class="select-box">
          <select id="${this.#id}"${name ? ` name="${name}"` : ''}${
            disabled ? ' disabled' : ''}${this.hasAttribute('required') ? ' required' : ''}>
            ${placeholder === null ? ''
              : `<option value="" disabled selected>${placeholder}</option>`}
            ${this.#optionsHtml()}
          </select>
          <span class="chevron" aria-hidden="true">${icons.chevronDown()}</span>
        </div>
        ${hint === null ? '' : `<div class="hint-row"><span class="hint">${hint}</span></div>`}
      </div>`;

    // The chevron comes from icons.js with its size inline, which beats the
    // sheet — so app-select.css's 16/12 chevron rules only apply once dropped.
    unsizeIcons(this);

    if (value) this.select.value = value;
    if (refocus) this.select.focus();
  }
}
customElements.define('app-select', AppSelect);
