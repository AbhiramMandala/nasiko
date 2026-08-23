/**
 * Radio button with an optional label and subtext.
 *
 * Matched to Figma "Design System V2" › ↳Radio Button › Radio Button (88:1274)
 * for the control and Radio Field (1815:31229) for the label layout. Figma
 * models Status × Type: Status = default | hover | focus | disabled | error,
 * Type = Selected | Unselected.
 *
 * Grouping is the native one: give every radio in a group the same `name` and
 * the browser handles exclusivity and arrow-key navigation. Figma's Radio Group
 * (420:21019) is that plus a 16px vertical gap, which is a layout concern —
 * stack them with `<app-stack gap="md">`.
 *
 * @element app-radio
 * @attr {boolean} checked
 * @attr {boolean} disabled
 * @attr {string} state - `error` | `hover` | `focus` (visual only)
 * @attr {string} label - Label text beside the control.
 * @attr {string} hint - Subtext under the label (Figma Subtext=Yes).
 * @attr {string} name|value|aria-label - Forwarded to the inner `<input type="radio">`.
 *   Pass `aria-label` when there is no visible `label`.
 * @prop {boolean} checked - Get/set checked state.
 * @prop {HTMLInputElement} input - The inner input.
 * @fires change - Bubbles from the inner input.
 */
import styles from './app-radio.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppRadio extends HTMLElement {
  static get observedAttributes() {
    return ['checked', 'disabled', 'state', 'label', 'hint', 'name', 'value', 'aria-label'];
  }

  #id = `app-radio-${++uid}`;

  get checked() { return this.input ? this.input.checked : this.hasAttribute('checked'); }
  set checked(v) { v ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }
  get input() { return this.querySelector('input'); }

  connectedCallback() {
    this.render();
    // Selecting this one deselects its siblings in the DOM but not their
    // `checked` attributes, so clear them across the group by name.
    this.addEventListener('change', () => {
      const name = this.getAttribute('name');
      if (name) {
        for (const peer of document.querySelectorAll(`app-radio[name="${name}"]`)) {
          if (peer !== this) peer.removeAttribute('checked');
        }
      }
      this.checked = this.input.checked;
    });
  }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    const disabled = this.hasAttribute('disabled');
    const checked  = this.hasAttribute('checked');
    const state    = disabled ? 'disabled' : (this.getAttribute('state') || 'default');
    const label    = this.getAttribute('label');
    const hint     = this.getAttribute('hint');
    const name     = this.getAttribute('name');
    // A control with no visible `label` still needs an accessible name, and the
    // inner input is what an AT reads — the host is not focusable.
    const aria     = this.getAttribute('aria-label');
    const value    = this.getAttribute('value');

    this.innerHTML = `
      <label class="row is-${state} is-${checked ? 'selected' : 'unselected'}" for="${this.#id}">
        <input id="${this.#id}" type="radio"${name ? ` name="${name}"` : ''}${
        aria ? ` aria-label="${aria.replace(/"/g, '&quot;')}"` : ''}${
          value === null ? '' : ` value="${value.replace(/"/g, '&quot;')}"`}${
          checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span class="control" aria-hidden="true"><span class="dot"></span></span>
        ${label === null && hint === null ? '' : `<span class="text">
          ${label === null ? '' : `<span class="label">${label}</span>`}
          ${hint === null ? '' : `<span class="hint">${hint}</span>`}
        </span>`}
      </label>`;
  }
}
customElements.define('app-radio', AppRadio);
