/**
 * Page-level announcement built around one action.
 *
 * Ported from nasiko_ui `NasikoBanner`. Where `<app-alert>` is a status callout
 * that sits inline with content, a banner is elevated (card surface + shadow),
 * leads with an optional icon or image, and exists to carry a call to action —
 * "Connect GitHub", "Upgrade plan", "Finish setup". Two layouts: `horizontal`
 * puts the action on the trailing edge for wide slots; `vertical` stacks
 * title → content → action into a fixed 280px card for rails and sidebars.
 *
 * @element app-banner
 * @attr {string} type - `horizontal` (default) | `vertical`
 * @attr {string} title - Heading text.
 * @attr {string} content - Body text under the heading.
 * @attr {string} image - src for a 24px leading image (a provider logo). Wins
 *   over the icon slot when both are present.
 * @attr {boolean} closable - Appends a trailing × button (horizontal only, as in
 *   the Flutter component). Fires `banner-close`; the element removes itself
 *   unless the event is cancelled.
 * @slot [data-slot="icon"] - Leading inline `<svg>` when there is no `image`.
 * @slot [data-slot="action"] - The call to action — normally one `<app-button>`.
 * @fires banner-close - Cancelable. The element removes itself unless
 *   `preventDefault()` is called.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-banner.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppBanner extends HTMLElement {
  static get observedAttributes() {
    return ['type', 'title', 'content', 'image', 'closable'];
  }

  #icon = null;
  #action = null;

  connectedCallback() {
    // Slots are captured on first connect: the action is a live element (its
    // listeners must survive re-renders), the icon is markup we own.
    if (this.#action === null) {
      this.#action = this.querySelector('[data-slot="action"]');
      const icon = this.querySelector('[data-slot="icon"]');
      this.#icon = icon ? icon.innerHTML : '';
    }
    this.render();
  }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    const type = this.getAttribute('type') === 'vertical' ? 'vertical' : 'horizontal';
    const title = this.getAttribute('title') ?? '';
    const content = this.getAttribute('content') ?? '';
    const image = this.getAttribute('image');
    const closable = this.hasAttribute('closable') && type === 'horizontal';

    const lead = image
      ? `<img class="lead" src="${escAttr(image)}" alt="" width="24" height="24">`
      : this.#icon ? `<span class="lead" aria-hidden="true">${this.#icon}</span>` : '';

    this.innerHTML = `
      <div class="banner is-${type}">
        <div class="main">
          <div class="head">
            ${lead}
            <div class="title">${escHtml(title)}</div>
          </div>
          <div class="content">${escHtml(content)}</div>
        </div>
        <div class="actions">
          <span class="action"></span>
          ${closable ? `<button type="button" class="close" aria-label="Close">${icons.x()}</button>` : ''}
        </div>
      </div>`;

    if (this.#action) this.querySelector('.action').appendChild(this.#action);
    unsizeIcons(this.querySelector('.head'));
    this.querySelector('.close')?.addEventListener('click', () => {
      const ev = new CustomEvent('banner-close', { bubbles: true, cancelable: true });
      if (this.dispatchEvent(ev)) this.remove();
    });
  }
}
customElements.define('app-banner', AppBanner);
