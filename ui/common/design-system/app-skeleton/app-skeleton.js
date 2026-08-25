/**
 * Animated shimmer placeholder for content that is still loading.
 *
 * @element app-skeleton
 * @attr {number} lines - Number of skeleton text lines to render. Omit (or 0)
 *   for a single block sized by `height` — the form every current consumer of
 *   a block placeholder uses.
 * @attr {string} height - Height of the single block (CSS value, e.g. `1rem`).
 *   Ignored when `lines` is set.
 * @attr {string} radius - Corner size: `sm` (default) | `md` | `lg` | `full`
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
  // Declared so attributeChangedCallback actually fires — without this list the
  // callback below was dead code and a later `height`/`lines` change was
  // silently ignored.
  static get observedAttributes() { return ['lines', 'height', 'radius']; }

  #initialized = false;

  connectedCallback() { if (this.#initialized) return; this.#initialized = true; this.render(); }
  attributeChangedCallback() { if (this.isConnected && this.#initialized) this.render(); }

  render() {
    const lines  = parseInt(this.getAttribute('lines') || '0', 10);
    const radius = RADIUS[this.getAttribute('radius') || 'sm'] || RADIUS.sm;
    if (lines > 0) {
      this.innerHTML = Array.from({ length: lines }, () => `<div class="skel is-line"></div>`).join('');
      return;
    }
    // Built as DOM, not an interpolated style string: `height` is a free-string
    // attribute, and a style attribute is an injection sink like any other.
    const block = document.createElement('div');
    block.className = 'skel';
    block.style.height = this.getAttribute('height') || '1rem';
    block.style.borderRadius = radius;
    block.style.width = '100%';
    this.replaceChildren(block);
  }
}
customElements.define('app-skeleton', AppSkeleton);
