/**
 * Compact, keyboard-accessible page switcher: `‹ 1 … 5 [6] 7 … 20 ›`.
 *
 * Ported from nasiko_ui `NasikoPagination`. A previous/next pair around a
 * windowed list of numbered pages with ellipses for collapsed ranges. The
 * current page wears the primary-button fill and is not interactive; every
 * other control is a small tertiary button. Controlled: the component never
 * changes `page` itself — listen for `page-change` and set the attribute.
 *
 * `<app-table>` has its own built-in pager; this is the standalone one for a
 * card grid, a log, anything that is not a table.
 *
 * @element app-pagination
 * @attr {number} page - Current page, 1-based (default 1).
 * @attr {number} page-count - Total pages (default 1). Nothing renders for ≤ 1.
 * @attr {number} max-visible - Number slots to show including ellipses (default 7, min 5).
 * @attr {boolean} disabled
 * @attr {string} label - Accessible name of the `<nav>` (default: `Pagination`).
 * @prop {number} page - Get/set the current page.
 * @fires pagination-change - `{ page }` when the user picks a different page. Bubbles.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-pagination.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr } from '../../utils/escape.js';
import { emit } from '../../utils/deprecate.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppPagination extends HTMLElement {
  static get observedAttributes() { return ['page', 'page-count', 'max-visible', 'disabled', 'label']; }

  get page() { return Math.max(1, Number(this.getAttribute('page')) || 1); }
  set page(p) { this.setAttribute('page', String(p)); }
  get pageCount() { return Math.max(1, Number(this.getAttribute('page-count')) || 1); }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  /** Same windowing as pagination.dart: near start / near end / middle. `null` = ellipsis. */
  #visible() {
    const n = this.pageCount;
    const max = Math.max(5, Number(this.getAttribute('max-visible')) || 7);
    const p = this.page - 1; // zero-based, as in the Dart source
    if (n <= max) return Array.from({ length: n }, (_, i) => i);
    const last = n - 1;
    if (p < max - 3) return [...Array.from({ length: max - 2 }, (_, i) => i), null, last];
    if (p > n - max + 2) return [0, null, ...Array.from({ length: max - 2 }, (_, i) => n - max + 2 + i)];
    const inner = max - 4;
    const start = p - Math.floor((inner - 1) / 2);
    return [0, null, ...Array.from({ length: inner }, (_, i) => start + i), null, last];
  }

  #go(page) {
    if (page < 1 || page > this.pageCount || page === this.page) return;
    emit(this, 'pagination-change', { page }, { legacy: 'page-change' });
  }

  render() {
    const n = this.pageCount;
    const page = this.page;
    const disabled = this.hasAttribute('disabled');
    if (n <= 1) { this.innerHTML = ''; return; }

    const btn = (label, cls, extra, inner) =>
      `<button type="button" class="pg ${cls}" aria-label="${escAttr(label)}"${extra}>${inner}</button>`;

    const slots = this.#visible().map((i) => {
      if (i === null) return '<span class="ellipsis" aria-hidden="true">…</span>';
      const num = i + 1;
      const current = num === page;
      return btn(`Page ${num}`, current ? 'is-current' : 'is-page',
        ` data-page="${num}"${current ? ' aria-current="page"' : ''}${disabled || current ? ' disabled' : ''}`, String(num));
    }).join('');

    this.innerHTML = `
      <nav aria-label="${escAttr(this.getAttribute('label') || 'Pagination')}">
        ${btn('Previous page', 'is-page', ` data-page="${page - 1}"${disabled || page <= 1 ? ' disabled' : ''}`, icons.chevronLeft())}
        ${slots}
        ${btn('Next page', 'is-page', ` data-page="${page + 1}"${disabled || page >= n ? ' disabled' : ''}`, icons.chevronRight())}
      </nav>`;
    unsizeIcons(this);

    for (const b of this.querySelectorAll('button[data-page]')) {
      b.addEventListener('click', () => this.#go(Number(b.dataset.page)));
    }
  }
}
customElements.define('app-pagination', AppPagination);
