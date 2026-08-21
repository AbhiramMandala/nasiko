/**
 * Avatar — the circular identity mark, optionally with the label beside it.
 *
 * Matched to Figma "Design System V2" › Avatar and Avatar Label. Those are two
 * Figma components but one element here: Avatar Label *is* an Avatar with text,
 * so `label`/`description` switch the text block on and nothing else changes.
 *
 * Content falls back in one order — `image`, then `initials`, then the generic
 * user glyph — so a row of users renders without the call site branching on
 * which fields came back from the API.
 *
 * A single text line (description but no label, or the reverse) sits centred
 * against the circle; two lines centre as a stack. That is `align-items: center`
 * in the sheet, not a variant.
 *
 * @element app-avatar
 * @attr {string} size - `xs` 20 | `sm` 24 | `md` 32 (default) | `lg` 40 | `xl` 48 | `2xl` 64
 * @attr {string} image - src for the photo/logo. Wins over `initials`.
 * @attr {string} initials - Monogram, 1-2 characters. Used when there is no image.
 * @attr {string} label - Primary line (display name, org).
 * @attr {string} description - Secondary line (email, handle, role).
 * @attr {boolean} filled - Wraps the whole thing in the dark chip.
 * @attr {boolean} interactive - The chip is a control: pointer + live hover.
 * @attr {boolean} disabled
 * @attr {string} state - `hover`, for rendering that state statically.
 * @attr {string} alt - Accessible name. Defaults to `label`/`description`; the
 *   mark is decorative (aria-hidden) whenever text is already showing.
 */
import styles from './app-avatar.css' with { type: 'css' };
import { icons, unsizeIcons } from '../../utils/icons.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppAvatar extends HTMLElement {
  static get observedAttributes() {
    return ['image', 'initials', 'label', 'description', 'alt'];
  }

  connectedCallback() { this.#render(); }

  attributeChangedCallback() { if (this.isConnected) this.#render(); }

  /** Rebuilds both children from the attributes. Cheap enough to redo whole —
   *  an avatar has no state to preserve and no focus to lose. */
  #render() {
    const image = this.getAttribute('image');
    const initials = this.getAttribute('initials');
    const label = this.getAttribute('label');
    const description = this.getAttribute('description');
    const text = label ?? description;

    const shape = document.createElement('span');
    shape.className = 'avatar-shape';
    if (image) {
      const img = document.createElement('img');
      img.className = 'avatar-image';
      img.src = image;
      // The visible text already names the person; a repeated alt is noise. With
      // no text, the mark IS the identity, so it gets the name.
      img.alt = text ? '' : (this.getAttribute('alt') || '');
      shape.append(img);
    } else if (initials) {
      shape.textContent = initials.slice(0, 2).toUpperCase();
    } else {
      shape.innerHTML = icons.user();
    }
    if (text) shape.setAttribute('aria-hidden', 'true');

    this.replaceChildren(shape);

    if (label || description) {
      const stack = document.createElement('span');
      stack.className = 'avatar-text';
      for (const [cls, value] of [['avatar-label', label], ['avatar-desc', description]]) {
        if (!value) continue;
        const line = document.createElement('span');
        line.className = cls;
        line.textContent = value;
        line.title = value; // the lines ellipsis; the full value stays readable
        stack.append(line);
      }
      this.append(stack);
    }

    // Glyph size is a fraction of --avatar-size, which only lands once the
    // inline width/height icons.js writes is dropped. Same as app-tag.
    unsizeIcons(this);
  }
}
customElements.define('app-avatar', AppAvatar);
