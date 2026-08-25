/**
 * Thin top-of-page progress bar driven by `loading-start` / `loading-end` document events.
 *
 * @element app-loading-bar
 * @method show() - Make the bar visible
 * @note Listens to `loading-start` / `loading-end` custom events on `document` automatically.
 * @note Place once in the page (typically inside `<app-header>`).
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-loading-bar.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];


export class AppLoadingBar extends HTMLElement {
  #handleLoadingStart = () => this.show();
  #handleLoadingEnd   = () => this.hide();

  constructor() {
    super();
    this.classList.add('app-loading-bar');
  }

  connectedCallback() {
    document.addEventListener('loading-start', this.#handleLoadingStart);
    document.addEventListener('loading-end', this.#handleLoadingEnd);
  }

  disconnectedCallback() {
    document.removeEventListener('loading-start', this.#handleLoadingStart);
    document.removeEventListener('loading-end', this.#handleLoadingEnd);
  }

  show() { this.classList.add('visible'); }
  hide() { this.classList.remove('visible'); }
}

customElements.define('app-loading-bar', AppLoadingBar);
