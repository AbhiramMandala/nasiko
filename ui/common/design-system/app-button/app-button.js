/**
 * Styled button with variants, sizes, loading spinner, and disabled state.
 *
 * @element app-button
 * @attr {string} variant - Visual style: `primary` (default) | `secondary` | `ghost` | `danger` | `dark`
 * @attr {string} size - Size modifier: `sm` (--control-h-sm) | (default) --control-h-lg
 * @attr {boolean} disabled - Disables the button
 * @attr {boolean} loading - Shows a spinner and disables the button
 * @attr {string} type - HTML button type: `button` (default) | `submit` | `reset`
 * @prop {boolean} disabled - Get/set disabled state
 * @note Content goes in the default slot.
 */
import styles from './app-button.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];


export class AppButton extends HTMLElement {
  static get observedAttributes() { return ['variant', 'size', 'disabled', 'loading', 'type']; }
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
    const variant  = this.getAttribute('variant') || 'primary';
    const size     = this.getAttribute('size') || '';
    const type     = this.getAttribute('type') || 'button';
    const loading  = this.hasAttribute('loading');
    const disabled = this.hasAttribute('disabled') || loading;
    const content  = this.querySelector('.content')?.innerHTML ?? this.innerHTML;
    const classes  = ['btn', `is-${variant}`, size ? `is-${size}` : ''].filter(Boolean).join(' ');

    this.innerHTML = `
      <button class="${classes}" type="${type}"${disabled ? ' disabled' : ''}>
        ${loading ? '<span class="spinner" aria-hidden="true"></span>' : ''}
        <span class="content">${content}</span>
      </button>`;
  }
}
customElements.define('app-button', AppButton);

