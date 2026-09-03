/**
 * Circular indeterminate spinner that waits before appearing.
 *
 * Ported from nasiko_ui `NasikoSpinner`. The one behaviour worth keeping from
 * the Flutter side is the `delay`: a fast response should never flash a
 * spinner, so the ring stays invisible for the first 300ms and then fades in.
 * Under reduced motion the fade is skipped (the ring appears after the delay)
 * and the rotation slows to a gentle pulse rather than a spin.
 *
 * Not the same thing as `<app-loading-bar>` (page-level, driven by document
 * events) or `<app-button loading>` (a dot inside the control). This is the
 * standalone "this region is loading" mark.
 *
 * @element app-spinner
 * @attr {string} size - `md` (default, 24px) | `sm` (16px) | `lg` (32px)
 * @attr {number} delay - Milliseconds before the ring becomes visible (default 300).
 *   `0` shows immediately.
 * @attr {string} label - Accessible name (default: `Loading`). Announced via
 *   `role="status"`; the ring itself is aria-hidden.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-spinner.css', import.meta.url));
import { escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppSpinner extends HTMLElement {
  static get observedAttributes() { return ['size', 'delay', 'label']; }

  #timer = null;

  connectedCallback() {
    this.render();
    this.#arm();
  }

  disconnectedCallback() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    this.render();
    if (name === 'delay') this.#arm();
  }

  #arm() {
    clearTimeout(this.#timer);
    this.classList.remove('is-visible');
    const delay = Math.max(0, Number(this.getAttribute('delay') ?? 300) || 0);
    if (delay === 0) { this.classList.add('is-visible'); return; }
    this.#timer = setTimeout(() => this.classList.add('is-visible'), delay);
  }

  render() {
    const label = this.getAttribute('label') || 'Loading';
    this.innerHTML = `
      <span class="ring" aria-hidden="true"></span>
      <span class="sr-only">${escHtml(label)}</span>`;
    this.setAttribute('role', 'status');
  }
}
customElements.define('app-spinner', AppSpinner);
