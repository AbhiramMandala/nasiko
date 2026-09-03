/**
 * Two-state (pressed / unpressed) button — "Bold" in a formatting toolbar.
 *
 * Ported from nasiko_ui `NasikoToggle`. Rests like a tertiary `<app-button>`
 * (bg-base fill, border-primary hairline); when pressed it fills
 * bg-secondary-brand with the border-secondary outline. Not a switch: a switch
 * is a setting that takes effect immediately and reads on/off; a toggle is a
 * mode inside a tool and reads pressed/unpressed (`aria-pressed`).
 *
 * The label is the element's text; a leading inline `<svg>` child is the icon.
 * At least one of the two is required — pass `aria-label` for an icon-only toggle.
 *
 * @element app-toggle
 * @attr {boolean} pressed - The on state. Reflected as the user toggles.
 * @attr {boolean} disabled
 * @attr {string} size - `md` (default, 32px) | `sm` (28px) | `lg` (36px)
 * @attr {string} value - Identifier echoed by `<app-toggle-group>` in its events.
 * @attr {string} aria-label - Forwarded to the inner button. Required when icon-only.
 * @prop {boolean} pressed - Get/set the on state.
 * @fires toggle-change - `{ pressed, value }` after a user toggle. Bubbles.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-toggle.css', import.meta.url));
import { unsizeIcons } from '../../utils/icons.js';
import { escAttr } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppToggle extends HTMLElement {
  static get observedAttributes() { return ['pressed', 'disabled', 'size', 'value', 'aria-label']; }

  #content = null;

  get pressed() { return this.hasAttribute('pressed'); }
  set pressed(v) { v ? this.setAttribute('pressed', '') : this.removeAttribute('pressed'); }

  connectedCallback() { this.render(); }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    const btn = this.querySelector('button');
    if (name === 'pressed' && btn) { btn.setAttribute('aria-pressed', String(this.pressed)); return; }
    this.render();
  }

  render() {
    // Captured lazily from render(), not connectedCallback: during upgrade the
    // browser runs attributeChangedCallback (with isConnected already true)
    // BEFORE connectedCallback, so the first render can happen before a
    // connect-time capture — and would wipe the children it needed.
    if (this.#content === null) this.#content = this.innerHTML.trim();
    const btn = this.querySelector('button');
    const refocus = btn && document.activeElement === btn;
    const size = this.getAttribute('size') || 'md';
    const disabled = this.hasAttribute('disabled');
    const aria = this.getAttribute('aria-label');
    // An icon-only toggle is square, like app-button's icon-only.
    const iconOnly = /^<svg[\s\S]*<\/svg>$/.test(this.#content);

    this.innerHTML = `
      <button type="button" class="toggle is-${size}${iconOnly ? ' is-icon-only' : ''}"
        aria-pressed="${this.pressed}"${aria ? ` aria-label="${escAttr(aria)}"` : ''}${disabled ? ' disabled' : ''}>
        <span class="content">${this.#content}</span>
      </button>`;
    unsizeIcons(this);

    this.querySelector('button').addEventListener('click', () => {
      // Inside a group the group decides (single-select must not un-press the
      // only pressed item); it cancels this event and sets `pressed` itself.
      const ev = new CustomEvent('toggle-request', { bubbles: true, cancelable: true });
      if (!this.dispatchEvent(ev)) return;
      this.pressed = !this.pressed;
      this.#emit();
    });
    if (refocus) this.querySelector('button').focus();
  }

  /** Fire `toggle-change` for the current state. Used by the group as well. */
  #emit() {
    this.dispatchEvent(new CustomEvent('toggle-change', {
      bubbles: true, detail: { pressed: this.pressed, value: this.getAttribute('value') },
    }));
  }

  emitChange() { this.#emit(); }
}
customElements.define('app-toggle', AppToggle);
