/**
 * Rule / separator — a line between two blocks of content, optionally labelled.
 *
 * Matched to Figma "Design System (Copy)" › Divider Horizontal (234:7298) and
 * Divider Vertical (459:21308). Figma ships those as two components; here it is
 * one element with `vertical`, because the three variant axes are identical:
 *   Type  — default `border-width/1` | `thick` `border-width/2`
 *   Style — solid | dashed (dash `[6, 4]`) | dotted (dash `[1, 4]`)
 *   Tone  — default `border/default/primary` | subtle
 * The `style` name is taken by HTML's own attribute, so the axis is `line` here.
 *
 * The label is Figma's `Show label` boolean + `Label` text folded into one
 * attribute: set it and you get a leading label with the line filling the rest,
 * absent and the element is the line. It composes with every other axis — a
 * dashed subtle labelled divider is just the three attributes together.
 * Horizontal only, and leading-aligned; Figma has no vertical or centred label.
 *
 * @element app-divider
 * @attr {boolean} vertical - Vertical rule. Stretches to the flex row's height.
 * @attr {boolean} thick - Type=Thick (2px instead of 1px).
 * @attr {string} line - `solid` (default) | `dashed` | `dotted`
 * @attr {string} tone - `subtle` for the lighter border token.
 * @attr {string} label - Leading label text. Horizontal only.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-divider.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppDivider extends HTMLElement {
  static get observedAttributes() { return ['label', 'vertical']; }

  connectedCallback() { this.#sync(); }
  attributeChangedCallback() { if (this.isConnected) this.#sync(); }

  /** Reconciles the label child and the a11y attributes. Idempotent. */
  #sync() {
    this.setAttribute('role', 'separator');
    // Horizontal is the implicit orientation of role=separator, so only the
    // vertical case needs stating.
    if (this.hasAttribute('vertical')) this.setAttribute('aria-orientation', 'vertical');
    else this.removeAttribute('aria-orientation');

    const label = this.getAttribute('label');
    let el = this.querySelector(':scope > .divider-label');
    if (label === null) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('span');
      el.className = 'divider-label';
      this.prepend(el);
    }
    if (el.textContent !== label) el.textContent = label;
  }
}
customElements.define('app-divider', AppDivider);
