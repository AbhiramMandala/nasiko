/**
 * Unified entity card — the web counterpart of nasiko_ui's `NasikoCard`
 * (Flutter): title/version/subtitle/description/tags/author, a left accent
 * bar keyed on `variant`, and header actions (a menu, or retry/delete in the
 * error state). This is the ONE card primitive for entity/list grids — pages
 * should render this instead of hand-rolling their own `.foo-card` markup
 * and CSS (AGENTS.md: "Compose, don't hand-roll").
 *
 * Differences from `NasikoCard`, by design:
 * - Tags overflow to a single "+N" chip past `max-visible-tags` (a fixed
 *   count) rather than NasikoCard's fit-by-measured-text-width — a
 *   reasonable web simplification; revisit if a `ResizeObserver`-driven fit
 *   is worth the complexity later.
 * - The error variant's "Know more" affordance uses the native `title`
 *   tooltip instead of NasikoCard's custom overlay popover — nasiko_ui's
 *   inverse-surface tooltip tokens (`foregroundConstantBlack/White`,
 *   `backgroundInformationOverlay`) don't exist on the web side yet, so
 *   there's nothing faithful to render it with. Add those tokens to
 *   `global.css` first if a real popover is wanted.
 * - Adds an optional `slot="footer"` (a bottom actions row with a hairline
 *   top border) that `NasikoCard` has no equivalent for — Flutter call
 *   sites compose a footer outside the card, but list-grid cards on the web
 *   (e.g. your-agents-page) need lifecycle buttons *inside* the card, so
 *   this is expressed as part of the unified component rather than
 *   page-local markup.
 *
 * @element app-card
 * @attr {string} card-title - The card's title (required)
 * @attr {string} version - Small text shown after the title, e.g. "v1.1.0"
 * @attr {string} subtitle - Supporting line shown below the title row
 * @attr {string} description - Body copy, clamped to 2 lines
 * @attr {string} author - Attribution line shown below the description
 * @attr {string} variant - `normal` (default) | `setting-up` | `active` | `error` — left accent bar + body
 * @attr {boolean} disabled - Muted appearance; suppresses hover/selection/menu
 * @attr {boolean} selected - Persistent selected elevation (ignored when disabled/error)
 * @attr {boolean} clickable - Renders the card as an interactive target; fires `card-click`
 * @attr {string} href - If set, the card body navigates here on click (implies `clickable`)
 * @attr {string} icon - Leading icon SVG markup (alternative to `slot="leading"`)
 * @attr {string} tags - JSON array of `{ label, icon? }` tag chips
 * @attr {number} max-visible-tags - Tags shown before the "+N" overflow chip (default 2)
 * @attr {string} menu-items - JSON array of `{ id, label }` — renders a header `app-action-menu`
 * @attr {boolean} show-more - Set to the string "false" to suppress the menu even when `menu-items` is set
 * @attr {string} error-title - Bold headline in the error body (variant="error")
 * @attr {string} error-body - Error description (variant="error")
 * @attr {string} error-details - Extra detail exposed via a "Know more" tooltip (variant="error")
 * @attr {boolean} retry - Shows a retry icon button in the error header; fires `card-retry`
 * @attr {boolean} delete - Shows a delete icon button in the error header; fires `card-delete`
 * @attr {string} setting-up-title - Bold headline in the setting-up body (variant="setting-up")
 * @attr {string} setting-up-body - Status line in the setting-up body (variant="setting-up")
 * @attr {number} setting-up-progress - 0-100; omit for an indeterminate bar (variant="setting-up")
 * @attr {string} max-width - CSS max-width applied to the host
 * @slot leading - Custom leading element (overrides `icon`)
 * @slot title-badge - Small inline element rendered right after the title
 * @slot trailing - Custom header-right element (overrides the menu / retry / delete controls)
 * @slot footer - Bottom actions row, separated by a hairline top border
 * @fires card-click - Card body activated (not disabled, not variant="error") — bubbles
 * @fires card-action-select - Menu item selected; `detail: { id }` — bubbles
 * @fires card-retry - Retry icon button clicked (variant="error") — bubbles
 * @fires card-delete - Delete icon button clicked (variant="error") — bubbles
 */
import { icons } from '../../utils/icons.js';
import '/common/design-system/app-action-menu/app-action-menu.js';
import { escHtml } from '/common/utils/escape.js';
import { navigate as routerNavigate } from '../../core/router.js';

import styles from './app-card.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppCard extends HTMLElement {
  static get observedAttributes() {
    return [
      'card-title', 'version', 'subtitle', 'description', 'author',
      'variant', 'disabled', 'selected', 'clickable', 'href',
      'icon', 'tags', 'max-visible-tags', 'menu-items', 'show-more',
      'error-title', 'error-body', 'error-details', 'retry', 'delete',
      'setting-up-title', 'setting-up-body', 'setting-up-progress',
      'max-width',
    ];
  }

  #initialized = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.render();
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === 'max-width') { this.#syncMaxWidth(); return; }
    this.render();
  }

  #syncMaxWidth() {
    this.style.maxWidth = this.getAttribute('max-width') || '';
  }

  #tags() {
    const raw = this.getAttribute('tags');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  render() {
    this.#syncMaxWidth();

    const title = this.getAttribute('card-title') || '';
    const version = this.getAttribute('version') || '';
    const subtitle = this.getAttribute('subtitle') || '';
    const description = this.getAttribute('description') || '';
    const author = this.getAttribute('author') || '';
    const variant = this.getAttribute('variant') || 'normal';
    const disabled = this.hasAttribute('disabled');
    const selected = this.hasAttribute('selected');
    const href = this.getAttribute('href') || '';
    const clickable = this.hasAttribute('clickable') || !!href;
    const iconAttr = this.getAttribute('icon') || '';
    const tags = this.#tags();
    const maxVisible = parseInt(this.getAttribute('max-visible-tags') || '2', 10);
    const menuItemsAttr = this.getAttribute('menu-items');
    const showMore = this.getAttribute('show-more') !== 'false';
    const errorTitle = this.getAttribute('error-title') || '';
    const errorBody = this.getAttribute('error-body') || "We couldn't start this due to a configuration issue.";
    const errorDetails = this.getAttribute('error-details') || '';
    const showRetry = this.hasAttribute('retry');
    const showDelete = this.hasAttribute('delete');
    const suTitle = this.getAttribute('setting-up-title') || '';
    const suBody = this.getAttribute('setting-up-body') || '';
    const suProgressAttr = this.getAttribute('setting-up-progress');

    const isError = variant === 'error';
    const isActive = variant === 'active';
    const isSettingUp = variant === 'setting-up';
    const hasSettingUpBody = isSettingUp && (suTitle || suBody || suProgressAttr != null);
    const canInteract = clickable && !disabled && !isError;
    const isMuted = disabled;

    // Light-DOM slotted overrides — captured before innerHTML wipes them.
    const leadingSlot = this.querySelector(':scope > [slot="leading"]');
    const badgeSlot = this.querySelector(':scope > [slot="title-badge"]');
    const trailingSlot = this.querySelector(':scope > [slot="trailing"]');
    const footerSlot = [...this.querySelectorAll(':scope > [slot="footer"]')];

    const cardClasses = [
      'ac-card',
      // The gradient resting fill is a "setting-up progress" affordance in
      // nasiko_ui — it only applies when there's setting-up body content to
      // show, not for every card whose variant happens to be "setting-up"
      // (mirrors NasikoCard's `_hasSettingUpBody` gate on `settingUpGradient`).
      hasSettingUpBody ? 'is-setting-up' : '',
      disabled ? 'is-disabled' : '',
      isError ? 'is-error' : '',
      selected && !disabled && !isError ? 'is-selected' : '',
      canInteract ? 'is-clickable' : '',
    ].filter(Boolean).join(' ');

    const accentClass = disabled ? null
      : isSettingUp ? 'is-setting-up'
      : isActive ? 'is-active'
      : isError ? 'is-error'
      : null;

    const leadingHtml = leadingSlot ? `<span class="ac-leading-slot"></span>` : iconAttr
      ? `<span class="ac-leading${isError ? ' is-error' : ''}${isSettingUp ? ' is-setting-up' : ''}${disabled ? ' is-disabled' : ''}">${iconAttr}</span>`
      : '';

    const tagsToShow = tags.slice(0, maxVisible);
    const overflow = tags.length - tagsToShow.length;
    const tagsHtml = tags.length ? `
      <div class="ac-tags">
        ${tagsToShow.map((t) => `<span class="ac-tag${isMuted ? ' is-muted' : ''}">${t.icon || ''}${escHtml(t.label)}</span>`).join('')}
        ${overflow > 0 ? `<span class="ac-tag${isMuted ? ' is-muted' : ''}" title="${escHtml(tags.slice(maxVisible).map((t) => t.label).join(', '))}">+${overflow}</span>` : ''}
      </div>` : '';

    let actionsHtml = '';
    if (trailingSlot) {
      actionsHtml = `<span class="ac-trailing-slot"></span>`;
    } else if (isError) {
      actionsHtml = `
        ${showRetry ? `<button type="button" class="ac-icon-btn" data-action="retry" aria-label="Retry">${icons.refresh('', 14)}</button>` : ''}
        ${showDelete ? `<button type="button" class="ac-icon-btn is-danger" data-action="delete" aria-label="Delete">${icons.trash('', 14)}</button>` : ''}`;
    } else if (showMore && menuItemsAttr && !hasSettingUpBody) {
      actionsHtml = isMuted
        ? `<span class="ac-more-disabled">${icons.moreVertical('', 20)}</span>`
        : `<app-action-menu trigger-title="More actions" items='${menuItemsAttr.replace(/'/g, '&#39;')}'>${icons.moreVertical('', 20)}</app-action-menu>`;
    }

    let bodyHtml = '';
    if (isError) {
      bodyHtml = `
        ${errorTitle ? `<p class="ac-error-title">${escHtml(errorTitle)}</p>` : ''}
        <p class="ac-error-body">${escHtml(errorBody)}</p>
        ${errorDetails ? `<span class="ac-know-more" title="${escHtml(errorDetails)}">Know more</span>` : ''}`;
    } else if (hasSettingUpBody) {
      const pct = suProgressAttr != null ? Math.max(0, Math.min(100, Number(suProgressAttr))) : null;
      bodyHtml = `
        ${suTitle ? `<p class="ac-su-title">${escHtml(suTitle)}</p>` : ''}
        ${suBody ? `<p class="ac-su-body">${escHtml(suBody)}</p>` : ''}
        <div class="ac-progress${pct == null ? ' is-indeterminate' : ''}">
          <i${pct == null ? '' : ` style="width:${pct}%"`}></i>
        </div>`;
    } else {
      bodyHtml = `
        ${subtitle ? `<p class="ac-subtitle${isMuted ? ' is-muted' : ''}">${escHtml(subtitle)}</p>` : ''}
        ${tagsHtml}
        ${description ? `<p class="ac-description${isMuted ? ' is-muted' : ''}">${escHtml(description)}</p>` : ''}
        ${author ? `<p class="ac-author${isMuted ? ' is-muted' : ''}">Author: <b>${escHtml(author)}</b></p>` : ''}`;
    }

    this.innerHTML = `
      <div class="${cardClasses}">
        ${accentClass ? `<span class="ac-accent ${accentClass}"></span>` : ''}
        <div class="ac-header">
          ${leadingHtml}
          <div class="ac-title-wrap">
            <span class="ac-title${isMuted || isError ? ' is-muted' : ''}">${escHtml(title)}</span>
            <span class="ac-badge-slot"></span>
            ${version ? `<span class="ac-version${isMuted ? ' is-muted' : ''}">${escHtml(version)}</span>` : ''}
          </div>
          <div class="ac-actions">${actionsHtml}</div>
        </div>
        ${bodyHtml}
        <div class="ac-footer"></div>
      </div>`;

    if (leadingSlot) this.querySelector('.ac-leading-slot')?.replaceWith(leadingSlot);
    if (badgeSlot) this.querySelector('.ac-badge-slot')?.replaceWith(badgeSlot);
    else this.querySelector('.ac-badge-slot')?.remove();
    if (trailingSlot) this.querySelector('.ac-trailing-slot')?.replaceWith(trailingSlot);
    if (footerSlot.length) {
      const footer = this.querySelector('.ac-footer');
      footerSlot.forEach((n) => footer.appendChild(n));
    }

    this.#bindEvents(canInteract, href);
  }

  #bindEvents(canInteract, href) {
    const card = this.querySelector('.ac-card');

    if (canInteract) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action], app-action-menu')) return;
        if (href) { routerNavigate(href); return; }
        this.dispatchEvent(new CustomEvent('card-click', { bubbles: true }));
      });
    }

    this.querySelector('[data-action="retry"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('card-retry', { bubbles: true }));
    });
    this.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('card-delete', { bubbles: true }));
    });
    this.querySelector('app-action-menu')?.addEventListener('action-select', (e) => {
      this.dispatchEvent(new CustomEvent('card-action-select', { bubbles: true, detail: e.detail }));
    });
  }
}
customElements.define('app-card', AppCard);
