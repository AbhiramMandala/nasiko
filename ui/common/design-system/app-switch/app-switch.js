/**
 * On/off toggle with an optional label and subtext.
 *
 * Matched to Figma "Design System V2" › ↳Toggle › Toggle Item (88:822) for the
 * control and Toggle (88:945) for the two label layouts. Figma models
 * Size × Type × Status: Size = Large | Small, Type = On | Off, Status = default
 * | hover | focus | disabled.
 *
 * @element app-switch
 * @attr {boolean} checked
 * @attr {boolean} disabled
 * @attr {string} size - `lg` (default, 40×24) | `sm` (36×20)
 * @attr {string} state - `hover` | `focus` (visual only)
 * @attr {string} label - Label text beside the track.
 * @attr {string} hint - Subtext under the label (Figma Subtext=True).
 * @attr {string} layout - `inline` (default, control then label) |
 *   `settings` (label left, control pushed to the far right — Figma
 *   Layout=Settings, for settings rows).
 * @attr {string} name|value|aria-label - Forwarded to the inner `<input type="checkbox">`.
 *   Pass `aria-label` when there is no visible `label`.
 * @prop {boolean} checked - Get/set on state.
 * @prop {HTMLInputElement} input - The inner input.
 * @fires change - Bubbles from the inner input.
 */
import styles from './app-switch.css' with { type: 'css' };
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppSwitch extends HTMLElement {
  static get observedAttributes() {
    return ['checked', 'disabled', 'size', 'state', 'label', 'hint', 'layout', 'name', 'value', 'aria-label'];
  }

  #id = `app-switch-${++uid}`;

  get checked() { return this.input ? this.input.checked : this.hasAttribute('checked'); }
  set checked(v) { v ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }
  get input() { return this.querySelector('input'); }

  connectedCallback() {
    this.render();
    this.addEventListener('change', () => { this.checked = this.input.checked; });
  }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    const disabled = this.hasAttribute('disabled');
    const checked  = this.hasAttribute('checked');
    const size     = this.getAttribute('size') === 'sm' ? 'sm' : 'lg';
    const state    = disabled ? 'disabled' : (this.getAttribute('state') || 'default');
    const layout   = this.getAttribute('layout') === 'settings' ? 'settings' : 'inline';
    const label    = this.getAttribute('label');
    const hint     = this.getAttribute('hint');
    const name     = this.getAttribute('name');
    // A control with no visible `label` still needs an accessible name, and the
    // inner input is what an AT reads — the host is not focusable.
    const aria     = this.getAttribute('aria-label');
    const value    = this.getAttribute('value');

    const control = `
      <input id="${this.#id}" type="checkbox" role="switch"${name ? ` name="${escAttr(name)}"` : ''}${
        aria ? ` aria-label="${aria.replace(/"/g, '&quot;')}"` : ''}${
        value === null ? '' : ` value="${value.replace(/"/g, '&quot;')}"`}${
        checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span class="track" aria-hidden="true"><span class="thumb"></span></span>`;

    const text = label === null && hint === null ? '' : `<span class="text">
        ${label === null ? '' : `<span class="label">${escHtml(label)}</span>`}
        ${hint === null ? '' : `<span class="hint">${escHtml(hint)}</span>`}
      </span>`;

    this.innerHTML = `
      <label class="row is-${size} is-${state} is-${layout} is-${checked ? 'on' : 'off'}"
        for="${this.#id}">
        ${layout === 'settings' ? text + control : control + text}
      </label>`;
  }
}
customElements.define('app-switch', AppSwitch);
