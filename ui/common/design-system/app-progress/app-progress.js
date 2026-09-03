/**
 * Horizontal progress bar — determinate or indeterminate.
 *
 * Ported from nasiko_ui `NasikoProgress`. Pass `value` (0–100) for a
 * determinate bar; omit it for the looping indeterminate form. The fill is
 * fg-primary — the same ink the primary button uses for its background — over
 * a bg-surface track, clipped to a pill. Value changes animate at motion base.
 *
 * `<app-loading-bar>` is the page-level network indicator pinned under the
 * header; this one is content — an upload, a quota, a step of a wizard.
 *
 * @element app-progress
 * @attr {number} value - Percent complete, 0–100. Omit for indeterminate.
 * @attr {string} size - `md` (default, 6px) | `sm` (4px) | `lg` (8px)
 * @attr {string} label - Accessible name, e.g. `Upload progress`. Required for
 *   the bar to be announced meaningfully.
 * @attr {boolean} show-value - Prints the percentage to the right of the bar.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-progress.css', import.meta.url));
import { escAttr } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppProgress extends HTMLElement {
  static get observedAttributes() { return ['value', 'size', 'label', 'show-value']; }

  get value() {
    const v = this.getAttribute('value');
    if (v === null || v === '') return null;
    return Math.min(100, Math.max(0, Number(v) || 0));
  }
  set value(v) { v === null || v === undefined ? this.removeAttribute('value') : this.setAttribute('value', String(v)); }

  connectedCallback() { this.render(); }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    // A value tick only moves the fill — rebuilding the DOM would restart the
    // width transition and the bar would jump instead of glide.
    if (name === 'value' && this.querySelector('.track')) return this.#sync();
    this.render();
  }

  #sync() {
    const value = this.value;
    const track = this.querySelector('.track');
    track.classList.toggle('is-indeterminate', value === null);
    if (value === null) {
      track.removeAttribute('aria-valuenow');
    } else {
      track.setAttribute('aria-valuenow', String(Math.round(value)));
      track.style.setProperty('--progress', `${value}%`);
    }
    const out = this.querySelector('.value');
    if (out) out.textContent = value === null ? '' : `${Math.round(value)}%`;
  }

  render() {
    const label = this.getAttribute('label');
    const showValue = this.hasAttribute('show-value');
    this.innerHTML = `
      <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100"${
        label ? ` aria-label="${escAttr(label)}"` : ''}>
        <div class="fill"></div>
      </div>
      ${showValue ? '<span class="value"></span>' : ''}`;
    this.#sync();
  }
}
customElements.define('app-progress', AppProgress);
