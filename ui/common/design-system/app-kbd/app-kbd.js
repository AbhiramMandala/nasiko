/**
 * Keyboard shortcut rendered as a row of key caps.
 *
 * Ported from nasiko_ui `NasikoKbd`. Purely a visual hint — in menus, tooltips
 * and the command palette — never an interactive control. Pass display glyphs,
 * not key names: `⌘ K`, `Ctrl Shift P`.
 *
 * @element app-kbd
 * @attr {string} keys - Space-separated caps, e.g. `⌘ K`. Each token becomes
 *   one `<kbd>`. Alternatively write the caps as text content; the attribute wins.
 * @attr {string} size - `md` (default) | `sm`
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-kbd.css', import.meta.url));
import { escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppKbd extends HTMLElement {
  static get observedAttributes() { return ['keys', 'size']; }

  #text = null;

  connectedCallback() { this.render(); }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    // Captured lazily from render(), not connectedCallback: during upgrade the
    // browser runs attributeChangedCallback (with isConnected already true)
    // BEFORE connectedCallback, so the first render can happen before a
    // connect-time capture — and would wipe the children it needed.
    if (this.#text === null) this.#text = this.textContent.trim();
    const src = this.getAttribute('keys') ?? this.#text ?? '';
    const caps = src.split(/\s+/).filter(Boolean);
    this.innerHTML = caps.map((k) => `<kbd>${escHtml(k)}</kbd>`).join('');
  }
}
customElements.define('app-kbd', AppKbd);
