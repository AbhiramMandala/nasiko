/**
 * Inline callout with an icon, title and optional description.
 *
 * Ported from nasiko_ui `NasikoAlert`. Not a banner: a banner is a page-level
 * announcement built around an action; an alert sits inline within content,
 * is status-coloured, carries no action and is non-dismissable by default. Not
 * a toast either — a toast leaves on its own, an alert stays until the state
 * it describes changes.
 *
 * The five variants use the same feedback tokens as `<app-badge>` and the toast
 * manager, so an "error" reads the same wherever it appears.
 *
 * @element app-alert
 * @attr {string} variant - `normal` (default) | `info` | `success` | `warning` | `destructive`
 * @attr {string} title - Bold first line. Required for an alert to mean anything.
 * @attr {string} description - Body text under the title.
 * @attr {boolean} dismissible - Appends a trailing × button. Clicking it collapses
 *   the alert in place and fires `alert-dismiss`; the element removes itself
 *   unless the event is cancelled.
 * @attr {string} dismiss-label - Accessible name of the × button (default: `Dismiss`).
 * @slot [data-slot="icon"] - Replaces the variant's default icon with your own
 *   inline `<svg>`.
 * @fires alert-dismiss - Cancelable. Fired after the collapse animation; the
 *   element removes itself unless `preventDefault()` is called.
 * @method dismiss() - Programmatic dismissal; same path as the × button.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-alert.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const VARIANTS = ['normal', 'info', 'success', 'warning', 'destructive'];

const DEFAULT_ICON = {
  normal: () => icons.info(),
  info: () => icons.info(),
  success: () => icons.checkCircle(),
  warning: () => icons.alertTriangle(),
  destructive: () => icons.alertTriangle(),
};

export class AppAlert extends HTMLElement {
  static get observedAttributes() {
    return ['variant', 'title', 'description', 'dismissible', 'dismiss-label'];
  }

  #icon = null;
  #dismissing = false;

  connectedCallback() {
    // The custom icon is captured once. A re-render replaces innerHTML, so the
    // slot has to be remembered rather than re-read.
    if (this.#icon === null) {
      const custom = this.querySelector('[data-slot="icon"]');
      this.#icon = custom ? custom.innerHTML : '';
    }
    this.render();
  }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  dismiss() {
    if (this.#dismissing) return;
    this.#dismissing = true;
    const finish = () => {
      const ev = new CustomEvent('alert-dismiss', { bubbles: true, cancelable: true });
      const keep = !this.dispatchEvent(ev);
      if (!keep) this.remove();
      else { this.classList.remove('is-leaving'); this.#dismissing = false; }
    };
    // Height + fade at motion base; reduced motion collapses instantly.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
    this.style.setProperty('--alert-h', `${this.offsetHeight}px`);
    this.classList.add('is-leaving');
    this.addEventListener('animationend', finish, { once: true });
  }

  render() {
    const raw = this.getAttribute('variant');
    const variant = VARIANTS.includes(raw) ? raw : 'normal';
    const title = this.getAttribute('title') ?? '';
    const description = this.getAttribute('description');
    const dismissible = this.hasAttribute('dismissible');
    const dismissLabel = this.getAttribute('dismiss-label') || 'Dismiss';
    // Prefer `role=alert` only for the urgent variants: a live-region on a
    // passive info callout announces every render to a screen reader.
    const role = variant === 'destructive' || variant === 'warning' ? 'alert' : 'status';

    this.innerHTML = `
      <div class="alert is-${variant}" role="${role}">
        <span class="icon" aria-hidden="true">${this.#icon || DEFAULT_ICON[variant]()}</span>
        <div class="body">
          <div class="title">${escHtml(title)}</div>
          ${description === null ? '' : `<div class="description">${escHtml(description)}</div>`}
        </div>
        ${dismissible ? `<button type="button" class="dismiss" aria-label="${escAttr(dismissLabel)}">${icons.x()}</button>` : ''}
      </div>`;
    unsizeIcons(this);
    this.querySelector('.dismiss')?.addEventListener('click', () => this.dismiss());
  }
}
customElements.define('app-alert', AppAlert);
