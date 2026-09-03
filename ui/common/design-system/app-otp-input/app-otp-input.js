/**
 * One-time-passcode input rendered as individual character slots.
 *
 * Ported from nasiko_ui `NasikoInputOtp`. One invisible `<input>` spans the
 * whole control: clicking anywhere focuses it, typing fills slots left to
 * right, Backspace clears the last character, and a paste — or the platform's
 * one-time-code autofill (`autocomplete="one-time-code"`) — distributes the
 * characters across the slots. Selection is disabled so a code can never be
 * partially selected; input is filtered to digits unless `alphanumeric`.
 *
 * As on the Flutter side the caret cannot move into earlier slots: the
 * single-field model keeps editing at the end, so Arrow Left/Right slot
 * hopping is intentionally unsupported (Backspace already walks back).
 *
 * @element app-otp-input
 * @attr {number} length - Number of characters (default 6).
 * @attr {string} groups - Space-separated group sizes that must sum to `length`,
 *   e.g. `3 3` renders `▢▢▢ – ▢▢▢`. Omit for one run.
 * @attr {boolean} alphanumeric - Accept letters as well as digits (upper-cased).
 * @attr {boolean} disabled
 * @attr {string} state - `error` — red slot borders. Omit for default.
 * @attr {string} value - The current code. Reflected as the user types.
 * @attr {string} name|aria-label - Forwarded to the inner input
 *   (`aria-label` default: `One-time code`).
 * @prop {string} value - Get/set the code.
 * @prop {HTMLInputElement} input - The inner input.
 * @fires input - Bubbles from the inner input on every change.
 * @fires otp-complete - `{ value }` when the last slot is filled.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-otp-input.css', import.meta.url));
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppOtpInput extends HTMLElement {
  static get observedAttributes() {
    return ['length', 'groups', 'alphanumeric', 'disabled', 'state', 'value', 'name', 'aria-label'];
  }

  #wired = false;

  get input() { return this.querySelector('input'); }
  get value() { return this.input ? this.input.value : (this.getAttribute('value') ?? ''); }
  set value(v) { this.setAttribute('value', this.#clean(v ?? '')); }

  get length() { return Math.max(1, Number(this.getAttribute('length')) || 6); }

  #clean(raw) {
    const re = this.hasAttribute('alphanumeric') ? /[^a-z0-9]/gi : /\D/g;
    return String(raw).replace(re, '').toUpperCase().slice(0, this.length);
  }

  connectedCallback() {
    this.render();
    if (this.#wired) return;
    this.#wired = true;

    this.addEventListener('input', (e) => {
      if (e.target !== this.input) return;
      const cleaned = this.#clean(this.input.value);
      if (cleaned !== this.input.value) this.input.value = cleaned;
      this.setAttribute('value', cleaned);
      if (cleaned.length === this.length) {
        this.dispatchEvent(new CustomEvent('otp-complete', { bubbles: true, detail: { value: cleaned } }));
      }
    });
    // Editing always happens at the end: pin the caret there on any attempt to
    // move or select, so the slot model stays truthful.
    const pin = () => { const i = this.input; if (i) i.setSelectionRange(i.value.length, i.value.length); };
    this.addEventListener('select', pin);
    this.addEventListener('click', pin);
    this.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') pin(); });
    this.addEventListener('focusin', () => this.#paint());
    this.addEventListener('focusout', () => this.#paint());
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === 'value' && this.input) {
      const v = this.#clean(this.getAttribute('value') ?? '');
      if (this.input.value !== v) this.input.value = v;
      return this.#paint();
    }
    this.render();
  }

  #groups() {
    const n = this.length;
    const g = (this.getAttribute('groups') ?? '').split(/\s+/).map(Number).filter((x) => x > 0);
    return g.length && g.reduce((a, b) => a + b, 0) === n ? g : [n];
  }

  /** Reflect the input's value into the slots. */
  #paint() {
    const v = this.input.value;
    const focused = this.matches(':focus-within');
    const active = Math.min(v.length, this.length - 1);
    this.querySelectorAll('.slot').forEach((slot, i) => {
      slot.textContent = v[i] ?? '';
      slot.classList.toggle('is-filled', i < v.length);
      slot.classList.toggle('is-active', focused && i === active);
    });
  }

  render() {
    const refocus = this.input && document.activeElement === this.input;
    const kept = this.input ? this.input.value : this.#clean(this.getAttribute('value') ?? '');
    const disabled = this.hasAttribute('disabled');
    const state = disabled ? 'disabled' : (this.getAttribute('state') === 'error' ? 'error' : 'default');
    const name = this.getAttribute('name');
    const aria = this.getAttribute('aria-label') || 'One-time code';

    let i = 0;
    const groups = this.#groups().map((size) => {
      const slots = Array.from({ length: size }, () => `<span class="slot" data-i="${i++}"></span>`).join('');
      return `<span class="group">${slots}</span>`;
    }).join('<span class="sep" aria-hidden="true"></span>');

    this.innerHTML = `
      <div class="otp is-${state}">
        ${groups}
        <input type="text" inputmode="${this.hasAttribute('alphanumeric') ? 'text' : 'numeric'}"
          autocomplete="one-time-code" autocapitalize="characters" spellcheck="false"
          maxlength="${this.length}" aria-label="${escAttr(aria)}"${name ? ` name="${escAttr(name)}"` : ''}${
          disabled ? ' disabled' : ''}${state === 'error' ? ' aria-invalid="true"' : ''}>
      </div>`;
    this.input.value = kept;
    this.#paint();
    if (refocus) this.input.focus();
  }
}
customElements.define('app-otp-input', AppOtpInput);
