/**
 * Tag / chip — an interactive, content-bearing label.
 *
 * Matched to Figma "Design System V2" › ↳Tag › Tag (234:7316): State
 * {default, hover, focus, selected, disabled} × Size {md, sm}. Three usages,
 * all the same component: display (read-only label), filter (`selectable`), and
 * removable (`removable`, the input/attachment chip).
 *
 * Not a badge — `<app-badge>` is the read-only tonal status pill. Tags are
 * squared and take their radius from the shared `control/radius/*` ramp.
 *
 * The label is whatever you put in the element. A leading stroke icon is an
 * inline `<svg>` child (first child, like `<app-button>`); a leading full-colour
 * logo/avatar comes from `image` instead. Use one or the other, not both.
 *
 * @element app-tag
 * @attr {string} size - `md` (default) | `sm`
 * @attr {boolean} selected - Gold fill. The filter chip's on state.
 * @attr {boolean} selectable - Click / Enter / Space toggles `selected`.
 * @attr {boolean} removable - Appends the trailing × button.
 * @attr {string} image - src for the circular leading image (provider logo, avatar).
 * @attr {boolean} disabled
 * @attr {string} state - `hover` | `focus`, for rendering those states statically.
 * @cssprop --tag-bg - Resting fill. Default `transparent` (Figma is outlined).
 * @cssprop --tag-hover-bg - Hover fill. Default `--bg-surface` (sand/100).
 *   Set either on the *surface*, not the tag — the fill depends on the plane the
 *   tag sits on, and one declaration on a container covers every tag inside it.
 * @prop {boolean} selected - Get/set the selected state.
 * @fires tag-change - `{ selected }` after a `selectable` tag toggles.
 * @fires tag-remove - Cancelable; the tag removes itself unless prevented.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-tag.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppTag extends HTMLElement {
  static get observedAttributes() {
    return ['removable', 'image', 'selectable', 'selected', 'disabled'];
  }

  get selected() { return this.hasAttribute('selected'); }
  set selected(v) { v ? this.setAttribute('selected', '') : this.removeAttribute('selected'); }

  connectedCallback() {
    this.#sync();
    this.addEventListener('click', this.#onClick);
    this.addEventListener('keydown', this.#onKeydown);
  }

  attributeChangedCallback() { if (this.isConnected) this.#sync(); }

  /** Reconciles the two injected children and the a11y attributes against the
   *  current attributes. Idempotent — the label content is never touched. */
  #sync() {
    const disabled = this.hasAttribute('disabled');

    const src = this.getAttribute('image');
    let img = this.querySelector(':scope > .tag-image');
    if (src === null) {
      img?.remove();
    } else {
      if (!img) {
        img = document.createElement('img');
        img.className = 'tag-image';
        img.alt = '';
        this.prepend(img);
      }
      if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    }

    let close = this.querySelector(':scope > .tag-remove');
    if (!this.hasAttribute('removable')) {
      close?.remove();
    } else {
      if (!close) {
        close = document.createElement('button');
        close.type = 'button';
        close.className = 'tag-remove';
        close.setAttribute('aria-label', 'Remove');
        close.innerHTML = icons.x();
        this.append(close);
      }
      close.disabled = disabled;
    }

    if (this.hasAttribute('selectable')) {
      this.setAttribute('role', 'button');
      this.setAttribute('aria-pressed', String(this.selected));
      // Not tabindex=-1 when disabled: the tag stops being a tab stop entirely,
      // which is what a disabled control should do.
      if (disabled) this.removeAttribute('tabindex');
      else this.setAttribute('tabindex', '0');
    }
    if (disabled) this.setAttribute('aria-disabled', 'true');
    else this.removeAttribute('aria-disabled');

    // Both glyphs — the consumer's leading icon and the × injected above —
    // arrive from icons.js with their size inline, which beats the sheet. The
    // 16/12 rules in app-tag.css only apply once that is dropped, so the tag
    // owns its icon size and a call site passes a bare `icons.check()`.
    unsizeIcons(this);
  }

  #onClick = (e) => {
    if (this.hasAttribute('disabled')) {
      e.stopPropagation();
      return;
    }
    if (e.target.closest('.tag-remove')) {
      // Cancelable so a consumer that owns the list can drop its own state
      // instead; unprevented, the tag just goes away.
      if (this.dispatchEvent(new CustomEvent('tag-remove', { bubbles: true, cancelable: true }))) {
        this.remove();
      }
      return;
    }
    if (this.hasAttribute('selectable')) {
      this.selected = !this.selected;
      this.dispatchEvent(new CustomEvent('tag-change', {
        bubbles: true, detail: { selected: this.selected },
      }));
    }
  };

  #onKeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!this.hasAttribute('selectable') || e.target !== this) return;
    e.preventDefault(); // Space would scroll the page
    this.click();
  };
}
customElements.define('app-tag', AppTag);
