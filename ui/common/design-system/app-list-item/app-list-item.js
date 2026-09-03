/**
 * One row of an `<app-list>`. See the list's header for the attribute set.
 *
 * @element app-list-item
 * @attr {string} heading - Primary text. Truncates with an ellipsis.
 * @attr {string} description - Secondary line under the heading.
 * @attr {string} value - Identifier echoed in `list-item-select` (`id` itself is
 *   the DOM id and stays free for the page).
 * @attr {string} title - (deprecated: use heading) Moved onto `heading` and removed
 *   from the DOM so the browser shows no tooltip.
 * @attr {string} subtitle - (deprecated: use description)
 * @attr {string} id-value - (deprecated: use value)
 * @attr {string} image - Avatar image src (32px). Renders an `<app-avatar>`.
 * @attr {number} indent - Nesting level; each level indents by s24 (default 0).
 * @attr {boolean} selected - Brand-tinted row with the secondary border.
 * @attr {boolean} disabled
 * @attr {boolean} expandable - Shows the disclosure chevron; clicking it fires
 *   `item-toggle` instead of selecting.
 * @attr {boolean} expanded - Chevron points down (open) rather than right.
 * @attr {boolean} status-dot - 8px success dot after the title.
 * @attr {string} badge - Small outlined label on the trailing edge.
 * @fires list-item-select - `{ id }` on click / Enter / Space. Bubbles; the list
 *   re-emits it as `list-select` with the row index.
 * @fires list-item-toggle - `{ expanded }` from the disclosure chevron. Bubbles.
 * @method focusRow() - Moves focus onto the row's button.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-list-item.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import { readAttr, emit } from '../../utils/deprecate.js';
import '../app-avatar/app-avatar.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppListItem extends HTMLElement {
  static get observedAttributes() {
    return ['heading', 'description', 'value', 'image', 'indent', 'selected', 'disabled',
            'expandable', 'expanded', 'status-dot', 'badge', 'title', 'subtitle', 'id-value'];
  }

  #icon = null;

  connectedCallback() {
    this.setAttribute('role', 'option');
    this.render();
  }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  focusRow() { this.querySelector('.row')?.focus(); }

  render() {
    // Captured lazily from render(), not connectedCallback: during upgrade the
    // browser runs attributeChangedCallback (with isConnected already true)
    // BEFORE connectedCallback, so the first render can happen before a
    // connect-time capture — and would wipe the children it needed.
    if (this.#icon === null) {
      const svg = this.querySelector(':scope > svg');
      this.#icon = svg ? svg.outerHTML : '';
    }
    const refocus = this.contains(document.activeElement);
    const title = readAttr(this, 'heading', 'title') ?? '';
    if (this.hasAttribute('title')) { this.removeAttribute('title'); if (!this.hasAttribute('heading')) this.setAttribute('heading', title); }
    const subtitle = readAttr(this, 'description', 'subtitle');
    const image = this.getAttribute('image');
    const indent = Math.max(0, Number(this.getAttribute('indent')) || 0);
    const selected = this.hasAttribute('selected');
    const disabled = this.hasAttribute('disabled');
    const expandable = this.hasAttribute('expandable');
    const expanded = this.hasAttribute('expanded');
    const badge = this.getAttribute('badge');

    this.setAttribute('aria-selected', String(selected));
    this.style.setProperty('--indent', String(indent));

    this.innerHTML = `
      <div class="row${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}"
           tabindex="${disabled ? '-1' : '0'}" aria-disabled="${disabled}">
        ${expandable
          ? `<button type="button" class="toggle" tabindex="-1" aria-label="${expanded ? 'Collapse' : 'Expand'}"
               aria-expanded="${expanded}">${icons.chevronDown()}</button>`
          : '<span class="toggle-gap"></span>'}
        ${image ? `<app-avatar size="md" image="${escAttr(image)}"></app-avatar>` : ''}
        ${this.#icon ? `<span class="icon" aria-hidden="true">${this.#icon}</span>` : ''}
        <span class="text">
          <span class="title">${escHtml(title)}</span>
          ${subtitle === null ? '' : `<span class="subtitle">${escHtml(subtitle)}</span>`}
        </span>
        ${this.hasAttribute('status-dot') ? '<span class="dot" aria-hidden="true"></span>' : ''}
        ${badge === null ? '' : `<span class="badge">${escHtml(badge)}</span>`}
      </div>`;
    unsizeIcons(this);

    const row = this.querySelector('.row');
    const select = () => {
      if (disabled) return;
      emit(this, 'list-item-select', { id: readAttr(this, 'value', 'id-value') }, { legacy: 'item-select' });
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
      if (expandable && (e.key === 'ArrowRight' && !expanded || e.key === 'ArrowLeft' && expanded)) {
        e.preventDefault(); this.#toggle();
      }
    });
    this.querySelector('.toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!disabled) this.#toggle();
    });

    if (refocus) row.focus();
  }

  #toggle() {
    const expanded = !this.hasAttribute('expanded');
    emit(this, 'list-item-toggle', { expanded }, { legacy: 'item-toggle' });
  }
}
customElements.define('app-list-item', AppListItem);
