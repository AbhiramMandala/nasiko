/**
 * Placeholder shown when a list or view has no content yet.
 *
 * @element app-empty-state
 * @attr {string} heading - Bold heading text
 * @attr {string} title - (deprecated: use heading) The old name. Moved onto `heading`
 *   and removed from the DOM on first render, because `title` is the global
 *   tooltip attribute — the browser would show it on hover.
 * @attr {string} description - Supporting description text
 * @attr {boolean} plain - Drops the dashed well and its fill, for an empty
 *   state that is the whole page rather than a placeholder inside one.
 * @attr {string} icon - (markup) SVG markup string for the icon (alternative to
 *   slot). Deliberately NOT escaped: it is markup by contract. That makes it a sink,
 *   so a generated surface may not set it. The (markup) marker is what
 *   gen-catalog reads to emit `markup: true`, and gen-dsl-catalog withholds
 *   every marked attribute from the DSL vocabulary automatically. Use the
 *   `icon` slot instead — it does the same job safely.
 * @slot [data-slot="icon"] - Element to use as the icon
 * @slot default - Action elements (e.g. a button)
 *
 * (The two attributes below were added after the catalog first shipped and sit
 * last on purpose: the DSL passes attributes positionally in @attr order, so a
 * new one must append — see catalog-compat.mjs.)
 * @attr {string} variant - `default` (nothing here yet) | `error` (we could not
 *   load it). `error` tints the icon with the status red and defaults to the
 *   alert glyph; `default` defaults to the info glyph. The distinction is the
 *   whole point: "there is nothing" and "we don't know" look identical today
 *   across most of the product, and a user reading the first when it is really
 *   the second concludes their data does not exist.
 * @attr {boolean} inline - Drop the dashed frame and the surface fill, for use
 *   *inside* another component's box (a table body, a chart plot area, a stat
 *   strip) where the host already draws the container. Standalone page-level
 *   empty states leave it off and keep the frame.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-empty-state.css', import.meta.url));
import { escHtml } from '../../utils/escape.js';
import { readAttr, slotted } from '../../utils/deprecate.js';
import { icons } from '../../utils/icons.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** Default glyph per variant, so every "nothing" and every "broken" in the
 *  product reads the same without each call site remembering an icon. A
 *  caller-supplied icon (attribute or slot) still wins.
 *
 *  Sized at the call, not by the sheet: every `icons.*` builder writes its
 *  dimensions into an inline `style`, which outranks a rule in an adopted
 *  stylesheet — `.icon svg { width: 2.5rem }` cannot shrink one. */
const DEFAULT_ICON = { error: icons.alertTriangle, default: icons.info };


export class AppEmptyState extends HTMLElement {
  #initialized = false;
  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    const iconChild = slotted(this, 'icon');
    const actions = [...this.children].filter(n => n !== iconChild);
    const title    = readAttr(this, 'heading', 'title') || '';
    const desc     = this.getAttribute('description') || '';
    const variant  = this.getAttribute('variant') === 'error' ? 'error' : 'default';
    const iconAttr = this.getAttribute('icon') || '';
    const iconHtml = iconAttr
      || (iconChild ? '' : DEFAULT_ICON[variant]('', this.hasAttribute('inline') ? 28 : 40));
    const hasIcon  = iconHtml || iconChild;
    // `title` collides with the global HTML tooltip attribute — every
    // browser would show it as a native hover tooltip duplicating the
    // heading text below. Drop it from the DOM once consumed; it's only
    // ever read here (no observedAttributes reactivity to preserve it for).
    this.removeAttribute('title');
    // A failure that swaps itself in for a region the user was waiting on has
    // to be announced; a plain "nothing here yet" must not be.
    if (variant === 'error' && !this.hasAttribute('role')) this.setAttribute('role', 'alert');
    if (title && !this.hasAttribute('heading')) this.setAttribute('heading', title);
    this.innerHTML = `
      ${hasIcon ? `<div class="icon">${iconHtml}</div>` : ''}
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
