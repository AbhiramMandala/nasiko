/**
 * Styled button with variants, sizes, loading spinner, and disabled state.
 *
 * Matched to Figma "Design System V2" › ↳Button › Button (node 11:4247). Figma
 * models Type × Tone as two axes; this component keeps one flat `variant`, so
 * Tone=destructive is spelled `danger` (Type=primary) and `danger-secondary`
 * (Type=secondary). See the header of app-button.css for the full mapping.
 *
 * @element app-button
 * @attr {string} variant - Visual style: `primary` (default, dark fill) | `secondary` (brand tint) |
 *   `tertiary` (white + hairline border; `outline` is an alias) | `ghost` | `danger` |
 *   `danger-secondary` | `ghost-danger` (red ink, no fill — the quiet destructive
 *   icon in a rail of icons) | `dark` (alias of `primary`, kept for existing call
 *   sites) | `icon`
 * @attr {string} size - Size modifier: `sm` (28px) | `md` (32px) | (default) 36px
 * @attr {boolean} icon-only - Squares the button to its size's control height with no
 *   padding, per Figma's Icon Button frame (4158:1100) — which is the same Type × Tone
 *   × Size matrix as the text button, so `variant` still supplies the colour.
 *   `variant="icon"` remains as the ghost-coloured shorthand used across mcp-page
 *   and the EE pages.
 * @attr {string} href - Renders an `<a class="btn">` instead of a `<button>`, so a
 *   navigation CTA is the same component as every other button. The SPA router
 *   intercepts internal anchor clicks, so no click handler is needed. A `disabled`
 *   (or `loading`) button keeps its `<button disabled>` — an anchor cannot be disabled.
 * @attr {boolean} disabled - Disables the button
 * @attr {boolean} loading - Shows a spinner and disables the button
 * @attr {string} type - HTML button type: `button` (default) | `submit` | `reset`
 * @attr {string} aria-label|title|aria-expanded - Forwarded to the inner `<button>`,
 *   which is the focusable element an AT actually names. Required on an `icon-only`
 *   button: the host is not focusable, so an aria-label left on it is never
 *   announced — and neither is a disclosure button's `aria-expanded`.
 * @prop {boolean} disabled - Get/set disabled state
 * @note Content goes in the default slot. The button sizes any icon in it —
 *       20px at the default size, 16 at `md`, 12 at `sm` — so pass a bare
 *       `icons.plus()` and let the size attribute pick the glyph size.
 */
import styles from './app-button.css' with { type: 'css' };
import { unsizeIcons } from '../../utils/icons.js';
import { escAttr } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];


export class AppButton extends HTMLElement {
  static get observedAttributes() {
    return ['variant', 'size', 'disabled', 'loading', 'type', 'icon-only',
            'href', 'aria-label', 'title', 'aria-expanded'];
  }
  constructor() { super(); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(val) { val ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); }
  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  /// Replace the button's text.
  ///
  /// Assigning to `element.textContent` directly would wipe the rendered
  /// `<button>` wrapper and leave a bare text node — the button keeps its box
  /// in the layout but loses all of its styling. Callers that relabel a button
  /// (e.g. a Create/Save-changes modal) should use this instead.
  set label(text) {
    const content = this.querySelector('.content');
    if (content) content.textContent = text;
    else this.textContent = text; // not rendered yet; render() picks this up
  }

  render() {
    // The inner control is replaced wholesale; if it held focus (a click just
    // flipped `loading`, say), carry focus across like app-input does.
    const refocus = this.querySelector('.btn') === document.activeElement
      && document.activeElement !== null;
    const variant  = this.getAttribute('variant') || 'primary';
    const size     = this.getAttribute('size') || '';
    // Closed set — `type` reaches attribute position, so an unknown value falls
    // back rather than being interpolated as written.
    const typeAttr = this.getAttribute('type');
    const type     = ['submit', 'reset'].includes(typeAttr) ? typeAttr : 'button';
    const loading  = this.hasAttribute('loading');
    const disabled = this.hasAttribute('disabled') || loading;
    const content  = this.querySelector('.content')?.innerHTML ?? this.innerHTML;
    // `variant="icon"` is the ghost-coloured square; `icon-only` squares any variant.
    const iconOnly = this.hasAttribute('icon-only') || variant === 'icon';
    const classes  = ['btn', `is-${variant}`, size ? `is-${size}` : '',
                      iconOnly ? 'is-icon-only' : ''].filter(Boolean).join(' ');
    // A CTA that navigates is still this component: same variants, same sizes,
    // one definition. `href` goes through the same forwarding (and therefore the
    // same escaping) as the other pass-through attributes.
    const linked = this.hasAttribute('href') && !disabled;
    const forwarded = ['aria-label', 'title', 'aria-expanded', ...(linked ? ['href'] : [])]
      .filter((a) => this.hasAttribute(a))
      .map((a) => ` ${a}="${escAttr(this.getAttribute(a))}"`)
      .join('');
    const tag = linked ? 'a' : 'button';

    this.innerHTML = `
      <${tag} class="${classes}"${linked ? '' : ` type="${type}"`}${forwarded}${!linked && disabled ? ' disabled' : ''}${
        loading ? ' aria-busy="true"' : ''}>
        ${loading ? '<span class="spinner" aria-hidden="true"></span>' : ''}
        <span class="content">${content}</span>
      </${tag}>`;

    // icons.js writes each glyph's size into the svg's `style` attribute, and an
    // inline style beats every stylesheet rule — so the icon ramp above (l 20,
    // m 16, s 12) had no effect and every button drew whatever px its call site
    // passed, 24 by default. Dropping the inline size hands the ramp back to the
    // sheet, so a call site passes a bare `icons.plus()` and the size attribute
    // decides the glyph.
    unsizeIcons(this);

    // A control that became disabled cannot take focus back — focus() is then a
    // silent no-op and focus falls to <body>, same as not trying. So this only
    // restores focus where restoring is possible.
    if (refocus) this.querySelector('.btn')?.focus();
  }
}
customElements.define('app-button', AppButton);

