/**
 * Navigation trail: `Home › Agents › research-agent`.
 *
 * Ported from nasiko_ui `NasikoBreadcrumb`. Every item but the last is a link
 * (or a button, when it has no `href`); the last is the current page and is
 * rendered as plain text with `aria-current="page"`. Internal `href`s go
 * through the SPA router like every other anchor, so no click handling is
 * needed for navigation — `crumb-select` is for the rare item that acts
 * without navigating.
 *
 * @element app-breadcrumb
 * @attr {string} items - JSON array of `{ label, href?, id? }`, first to last.
 *   Items without `href` render as buttons and fire `crumb-select`.
 * @attr {boolean} leading-icon - Prefixes the trail with a home glyph.
 * @attr {string} label - Accessible name of the `<nav>` (default: `Breadcrumb`).
 * @fires crumb-select - `{ id, label, index }` when an `href`-less item is clicked.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-breadcrumb.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppBreadcrumb extends HTMLElement {
  static get observedAttributes() { return ['items', 'leading-icon', 'label']; }

  #items() {
    try {
      const parsed = JSON.parse(this.getAttribute('items') || '[]');
      return Array.isArray(parsed) ? parsed.filter((i) => i && typeof i === 'object') : [];
    } catch {
      console.warn('[app-breadcrumb] invalid `items` JSON — rendering nothing');
      return [];
    }
  }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    const items = this.#items();
    const last = items.length - 1;
    const sep = `<li class="sep" aria-hidden="true">${icons.chevronRight()}</li>`;

    const crumbs = items.map((item, i) => {
      const label = escHtml(item.label);
      if (i === last) return `<li class="crumb is-current" aria-current="page">${label}</li>`;
      // `items` is data, and `href` lands in attribute position — refuse any
      // scheme other than a relative path or http(s), so a bound value cannot
      // become `javascript:`.
      const href = typeof item.href === 'string' && /^(\/|https?:\/\/)/.test(item.href) ? item.href : null;
      const inner = href
        ? `<a class="link" href="${escAttr(href)}">${label}</a>`
        : `<button type="button" class="link" data-index="${i}">${label}</button>`;
      return `<li class="crumb">${inner}</li>`;
    });

    this.innerHTML = `
      <nav aria-label="${escAttr(this.getAttribute('label') || 'Breadcrumb')}">
        <ol>
          ${this.hasAttribute('leading-icon') ? `<li class="lead" aria-hidden="true">${icons.folder()}</li>` : ''}
          ${crumbs.join(sep)}
        </ol>
      </nav>`;
    unsizeIcons(this);

    for (const btn of this.querySelectorAll('button.link')) {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.index);
        const item = items[index];
        this.dispatchEvent(new CustomEvent('crumb-select', {
          bubbles: true,
          detail: { id: item.id ?? null, label: item.label, index },
        }));
      });
    }
  }
}
customElements.define('app-breadcrumb', AppBreadcrumb);
