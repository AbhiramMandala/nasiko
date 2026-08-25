/**
 * Checkbox with an optional label and subtext, plus an indeterminate state.
 *
 * Matched to Figma "Design System V2" › ↳Checkbox › Checkbox Items (119:1379)
 * for the control and Checkbox (1815:46651) for the label layout. Figma models
 * Status × Type: Status = default | hover | focus | disabled | error, Type =
 * Selected | Unselected | Indeterminate. Hover and focus are pseudo-classes
 * here; `state` also accepts them for static rendering.
 *
 * @element app-checkbox
 * @attr {boolean} checked
 * @attr {boolean} indeterminate - Renders the dash. Wins over `checked`.
 * @attr {boolean} disabled
 * @attr {string} state - `error` | `hover` | `focus` (visual only)
 * @attr {string} label - Label text beside the box.
 * @attr {string} hint - Subtext under the label (Figma Subtext=True).
 * @attr {string} name|value|aria-label - Forwarded to the inner `<input type="checkbox">`.
 *   Pass `aria-label` when there is no visible `label`.
 * @prop {boolean} checked - Get/set checked state.
 * @prop {boolean} indeterminate - Get/set the dash state.
 * @prop {HTMLInputElement} input - The inner input.
 * @fires change - Bubbles from the inner input.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-checkbox.css', import.meta.url));
import { icons } from '../../utils/icons.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppCheckbox extends HTMLElement {
  static get observedAttributes() {
    return ['checked', 'indeterminate', 'disabled', 'state', 'label', 'hint', 'name', 'value', 'aria-label'];
  }

  #id = `app-checkbox-${++uid}`;

  get checked() { return this.input ? this.input.checked : this.hasAttribute('checked'); }
  set checked(v) { v ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }
  get indeterminate() { return this.hasAttribute('indeterminate'); }
  set indeterminate(v) { v ? this.setAttribute('indeterminate', '') : this.removeAttribute('indeterminate'); }
  get input() { return this.querySelector('input'); }

  connectedCallback() {
    this.render();
    // The user's own clicks must not be reverted by the next attribute-driven
    // re-render, so mirror the DOM state back onto the attribute.
    this.addEventListener('change', () => {
      this.removeAttribute('indeterminate');
      this.checked = this.input.checked;
    });
  }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    const disabled  = this.hasAttribute('disabled');
    const indet     = this.hasAttribute('indeterminate');
    const checked   = this.hasAttribute('checked');
    const state     = disabled ? 'disabled' : (this.getAttribute('state') || 'default');
    const type      = indet ? 'indeterminate' : checked ? 'selected' : 'unselected';
    const label     = this.getAttribute('label');
    const hint      = this.getAttribute('hint');
    const name      = this.getAttribute('name');
    // A control with no visible `label` still needs an accessible name, and the
    // inner input is what an AT reads — the host is not focusable.
    const aria      = this.getAttribute('aria-label');
    const value     = this.getAttribute('value');

    this.innerHTML = `
      <label class="row is-${state} is-${type}" for="${this.#id}">
        <input id="${this.#id}" type="checkbox"${name ? ` name="${name}"` : ''}${
        aria ? ` aria-label="${aria.replace(/"/g, '&quot;')}"` : ''}${
          value === null ? '' : ` value="${value.replace(/"/g, '&quot;')}"`}${
          checked && !indet ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span class="control" aria-hidden="true">
          ${indet ? '<span class="dash"></span>' : icons.check()}
        </span>
        ${label === null && hint === null ? '' : `<span class="text">
          ${label === null ? '' : `<span class="label">${label}</span>`}
          ${hint === null ? '' : `<span class="hint">${hint}</span>`}
        </span>`}
      </label>`;

    // Native indeterminate is a property, not an attribute — set it so the
    // control also reports the right state to assistive tech.
    this.input.indeterminate = indet;
  }
}
customElements.define('app-checkbox', AppCheckbox);
