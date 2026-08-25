/**
 * Animated shimmer placeholder for content that is still loading.
 *
 * @element app-skeleton
 * @attr {number} lines - Number of skeleton lines to render (default: 3)
 * @attr {string} height - Height of each line (CSS value, e.g. `1rem`)
 * @attr {string} radius - Corner size: `sm` | `md` | `lg` | `full` (default: `sm`)
 * @note Used as a loading placeholder. Animates with a shimmer effect.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-skeleton.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/**
 * The `radius` attribute keeps a semantic name because it is a component API,
 * not a token. It resolves to the numeric radius scale here — the semantic
 * --radius-* token aliases were removed, so `var(--radius-${x})` no longer
 * resolves to anything.
 * @type {Record<string, string>}
 */
const RADIUS = {
  sm:   'var(--r-4)',
  md:   'var(--r-8)',
  lg:   'var(--r-12)',
  full: 'var(--r-full)',
};

export class AppSkeleton extends HTMLElement {
  constructor() { super(); }
  connectedCallback() { if (this._initialized) return; this._initialized = true; this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    const lines  = parseInt(this.getAttribute('lines') || '0', 10);
    const height = this.getAttribute('height') || '1rem';
    const radius = RADIUS[this.getAttribute('radius') || 'sm'] || RADIUS.sm;
    this.innerHTML = lines > 0
      ? Array.from({ length: lines }, () => `<div class="skel is-line"></div>`).join('')
      : `<div class="skel" style="height:${height};border-radius:${radius};width:100%"></div>`;
  }
}
customElements.define('app-skeleton', AppSkeleton);
