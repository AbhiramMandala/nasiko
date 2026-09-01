/**
 * Placeholder shown when a list or view has no content yet.
 *
 * @element app-empty-state
 * @attr {string} title - Bold heading text
 * @attr {string} description - Supporting description text
 * @attr {string} icon - (markup) SVG markup string for the icon (alternative to
 *   slot). Deliberately NOT escaped: it is markup by contract. That makes it a sink,
 *   so a generated surface may not set it. The (markup) marker is what
 *   gen-catalog reads to emit `markup: true`, and gen-dsl-catalog withholds
 *   every marked attribute from the DSL vocabulary automatically. Use the
 *   `icon` slot instead — it does the same job safely.
 * @slot [slot="icon"] - Element to use as the icon
 * @slot default - Action elements (e.g. a button)
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-empty-state.css', import.meta.url));
import { escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];


export class AppEmptyState extends HTMLElement {
  #initialized = false;
  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    const children = [...this.children];
    const iconChild = children.find(n => n.getAttribute?.('slot') === 'icon');
    const actions = children.filter(n => n.getAttribute?.('slot') !== 'icon');
    const title    = this.getAttribute('title') || '';
    const desc     = this.getAttribute('description') || '';
    const iconAttr = this.getAttribute('icon') || '';
    const hasIcon  = iconAttr || iconChild;
    // `title` collides with the global HTML tooltip attribute — every
    // browser would show it as a native hover tooltip duplicating the
    // heading text below. Drop it from the DOM once consumed; it's only
    // ever read here (no observedAttributes reactivity to preserve it for).
    this.removeAttribute('title');
    this.innerHTML = `
      ${hasIcon ? `<div class="icon">${iconAttr}</div>` : ''}
      ${title ? `<p class="title">${escHtml(title)}</p>` : ''}
      ${desc  ? `<p class="desc">${escHtml(desc)}</p>`   : ''}
      <div class="action"></div>`;
    if (iconChild) {
      const iconSlot = this.querySelector('.icon');
      if (iconSlot) iconSlot.appendChild(iconChild);
    }
    const slot = this.querySelector('.action');
    actions.forEach(n => slot.appendChild(n));
  }
}
customElements.define('app-empty-state', AppEmptyState);
