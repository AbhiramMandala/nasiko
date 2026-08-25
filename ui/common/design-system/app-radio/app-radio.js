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
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-radio.css', import.meta.url));
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppRadio extends HTMLElement {
  static get observedAttributes() {
    return ['checked', 'disabled', 'state', 'label', 'hint', 'name', 'value', 'aria-label'];
  }

  #id = `app-radio-${++uid}`;
  #wired = false;

  get checked() { return this.input ? this.input.checked : this.hasAttribute('checked'); }
  set checked(v) { v ? this.setAttribute('checked', '') : this.removeAttribute('checked'); }
  get input() { return this.querySelector('input'); }

  connectedCallback() {
    this.render();
    // Wired once: the listener sits on the host, so it survives both re-renders
    // and disconnects — re-adding it per connect stacked duplicate handlers.
    if (this.#wired) return;
    this.#wired = true;
    // Selecting this one deselects its siblings in the DOM but not their
    // `checked` attributes, so clear them across the group by name.
    this.addEventListener('change', () => {
      const name = this.getAttribute('name');
      if (name) {
        // CSS.escape: `name` is a free string, and a quote in it would throw
        // out of querySelectorAll mid-handler.
        for (const peer of document.querySelectorAll(`app-radio[name="${CSS.escape(name)}"]`)) {
          if (peer !== this) peer.removeAttribute('checked');
        }
      }
      this.checked = this.input.checked;
    });
  }

  attributeChangedCallback(attr) {
    if (!this.isConnected) return;
    // Selection changes sync in place: re-rendering would destroy the inner
    // input, dropping listeners bound to it and the keyboard focus on it.
    if (attr === 'checked' && this.input) {
      const checked = this.hasAttribute('checked');
      this.input.checked = checked;
      this.firstElementChild.classList.toggle('is-selected', checked);
      this.firstElementChild.classList.toggle('is-unselected', !checked);
      return;
    }
    this.render();
  }

  render() {
    // A re-render replaces the <input>; carry focus across so arrow-key group
    // navigation (which checks, which re-renders) doesn't strand the keyboard.
    const refocus = this.input && document.activeElement === this.input;
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
        <input id="${this.#id}" type="radio"${name ? ` name="${escAttr(name)}"` : ''}${
        aria ? ` aria-label="${escAttr(aria)}"` : ''}${
          value === null ? '' : ` value="${escAttr(value)}"`}${
          checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
        <span class="control" aria-hidden="true"><span class="dot"></span></span>
        ${label === null && hint === null ? '' : `<span class="text">
          ${label === null ? '' : `<span class="label">${escHtml(label)}</span>`}
          ${hint === null ? '' : `<span class="hint">${escHtml(hint)}</span>`}
        </span>`}
      </label>`;

    if (refocus) this.input?.focus();
  }
}
customElements.define('app-radio', AppRadio);
