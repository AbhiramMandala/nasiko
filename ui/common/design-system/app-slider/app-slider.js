/**
 * Horizontal slider for a value in a range, continuous or stepped.
 *
 * Ported from nasiko_ui `NasikoSlider`, built on a native `<input type="range">`
 * so it is a real form control (name/value submit, `input`/`change` events,
 * screen-reader slider semantics) and only the paint is ours: an 8px track
 * with a brand fill, a 20px thumb in a 28px box that permanently reserves the
 * focus-ring space so focusing never moves the thumb, and tick marks when
 * `step` divides the range.
 *
 * Keyboard comes from the native input — arrows step, PageUp/PageDown step
 * ×10, Home/End jump — which matches the Flutter component's contract.
 *
 * @element app-slider
 * @attr {number} value - Current value. Reflected back as the user drags.
 * @attr {number} min - Range start (default 0).
 * @attr {number} max - Range end (default 100).
 * @attr {number} step - Step size. Omit for continuous (1% of the range per arrow
 *   press). With a step that yields ≤ 20 divisions, tick marks are drawn.
 * @attr {boolean} disabled
 * @attr {boolean} show-value - Floating value label above the thumb while
 *   dragging or focused.
 * @attr {string} name|aria-label - Forwarded to the inner input. Pass
 *   `aria-label` (or wrap in `<app-field label>`) — the thumb has no visible label.
 * @prop {number} value - Get/set the numeric value.
 * @prop {HTMLInputElement} input - The inner range input.
 * @fires input - Bubbles from the inner input, on every move.
 * @fires change - Bubbles from the inner input, on release.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-slider.css', import.meta.url));
import { escAttr } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const MAX_TICKS = 20;

export class AppSlider extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'min', 'max', 'step', 'disabled', 'show-value', 'name', 'aria-label'];
  }

  #wired = false;

  get input() { return this.querySelector('input'); }
  get value() { return this.input ? Number(this.input.value) : Number(this.getAttribute('value')) || 0; }
  set value(v) { this.setAttribute('value', String(v)); }

  connectedCallback() {
    this.render();
    if (this.#wired) return;
    this.#wired = true;
    // Mirror the DOM value onto the attribute so a re-render never reverts
    // the user's drag — same rule as app-checkbox.
    this.addEventListener('input', () => {
      this.setAttribute('value', this.input.value);
    });
  }

  attributeChangedCallback(name) {
    if (!this.isConnected || !this.input) return;
    // Value ticks (including our own mirror above) only move the fill.
    if (name === 'value') {
      if (this.input.value !== this.getAttribute('value')) this.input.value = this.getAttribute('value') ?? '0';
      return this.#paint();
    }
    this.render();
  }

  #range() {
    const min = Number(this.getAttribute('min') ?? 0) || 0;
    const max = Number(this.getAttribute('max') ?? 100);
    return { min, max: Number.isFinite(max) && max > min ? max : min + 100 };
  }

  #paint() {
    const { min, max } = this.#range();
    const v = Math.min(max, Math.max(min, Number(this.input.value)));
    this.style.setProperty('--slider-frac', String((v - min) / (max - min)));
    const out = this.querySelector('.bubble');
    if (out) out.textContent = String(v);
  }

  render() {
    const refocus = this.input && document.activeElement === this.input;
    const { min, max } = this.#range();
    const step = this.getAttribute('step');
    const disabled = this.hasAttribute('disabled');
    const value = this.getAttribute('value') ?? String(min);
    const forwarded = ['name', 'aria-label'].filter((a) => this.hasAttribute(a))
      .map((a) => ` ${a}="${escAttr(this.getAttribute(a))}"`).join('');

    // Ticks: only when the step divides the range into a readable number.
    const stepN = Number(step);
    const divisions = step && stepN > 0 ? Math.round((max - min) / stepN) : 0;
    const ticks = divisions > 0 && divisions <= MAX_TICKS
      ? `<div class="ticks" aria-hidden="true">${Array.from({ length: divisions + 1 }, () => '<span></span>').join('')}</div>`
      : '';

    this.innerHTML = `
      <div class="control${disabled ? ' is-disabled' : ''}">
        <div class="track"><div class="fill"></div>${ticks}</div>
        ${this.hasAttribute('show-value') ? '<output class="bubble" aria-hidden="true"></output>' : ''}
        <input type="range" min="${min}" max="${max}"${step ? ` step="${escAttr(step)}"` : ' step="any"'}
          value="${escAttr(value)}"${forwarded}${disabled ? ' disabled' : ''}>
      </div>`;
    this.#paint();
    if (refocus) this.input.focus();
  }
}
customElements.define('app-slider', AppSlider);
