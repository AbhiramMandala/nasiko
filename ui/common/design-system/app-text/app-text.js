/**
 * Typography — a heading, a paragraph, a caption, an eyebrow label.
 *
 * The design system had no way to put a word on a page that was not already
 * inside something else. A generated surface could title a card, label a
 * divider, or name a stat — but it could not write a section heading above a
 * group of cards, or a sentence explaining what the numbers mean. Every
 * generated dashboard was therefore a wall of boxes with no voice: the thing
 * that most separates a designed page from a generated one is not its layout,
 * it is that somebody wrote on it.
 *
 * One element, one axis. `variant` picks a ramp that already exists in the
 * tokens rather than inventing a sixth size, and each ramp is a role — what
 * the text is doing on the page — not a size. A model choosing between
 * "section heading" and "supporting note" gets it right far more often than
 * one choosing between 20px and 13px, and a role survives a token change.
 *
 * Heading level is fixed, not offered. A surface renders inside a page that
 * already owns the `<h1>`, so `title` is level 2 and `subtitle` is level 3.
 * Letting a caller pick produces documents whose outline is wrong in a way
 * nothing visible ever shows, and there is no layout it would buy.
 *
 * No margins. Spacing between blocks belongs to the stack or grid that holds
 * them — a component that carries its own outer margin collides with the
 * container's `gap` and the result is spacing nobody chose.
 *
 * @element app-text
 * @attr {string} variant - Role on the page: `body` (default) | `title` | `subtitle` | `caption` | `label`
 * @note Content goes in the default slot (light DOM). CSS-only apart from the
 *   heading semantics, which cannot be expressed in a stylesheet.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-text.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** The two variants that are headings, and the level each one is. */
const HEADING_LEVEL = { title: '2', subtitle: '3' };

export class AppText extends HTMLElement {
  static get observedAttributes() { return ['variant']; }

  connectedCallback() { this.#sync(); }
  attributeChangedCallback() { if (this.isConnected) this.#sync(); }

  /**
   * Reconciles the heading semantics with `variant`. Idempotent, and it never
   * touches content — the text is the caller's child node, so a re-render here
   * cannot lose it and cannot fight the surface renderer's `textContent` write.
   */
  #sync() {
    const level = HEADING_LEVEL[this.getAttribute('variant')];
    if (level) {
      this.setAttribute('role', 'heading');
      this.setAttribute('aria-level', level);
    } else if (this.getAttribute('role') === 'heading') {
      // Only clears what this element set. An author who wrote their own role
      // on a body variant keeps it.
      this.removeAttribute('role');
      this.removeAttribute('aria-level');
    }
  }
}
customElements.define('app-text', AppText);
