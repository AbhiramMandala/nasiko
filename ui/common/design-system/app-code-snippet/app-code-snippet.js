/**
 * Labeled command/code block with a copy-to-clipboard button.
 *
 * @element app-code-snippet
 * @attr {string} label - Optional label rendered above the code well.
 * @attr {string} code - The command text. Falls back to the element's initial
 *                       text content when the attribute is absent.
 * @note NightOwl: sand-50 well, r8, Chivo Mono command text, ghost copy button.
 */
import { icons } from '../../utils/icons.js';
import { showToast } from '../../utils/toast.js';

import styles from './app-code-snippet.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

class AppCodeSnippet extends HTMLElement {
  #initialized = false;
  #resetTimer = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    const code = this.getAttribute('code') ?? this.textContent.trim();
    const label = this.getAttribute('label');
    this.textContent = '';

    this.innerHTML = `
      ${label ? `<span class="snippet-label"></span>` : ''}
      <div class="snippet-well">
        <pre class="snippet-code"></pre>
        <button class="snippet-copy" type="button" aria-label="Copy to clipboard">${icons.copy('', 14)}</button>
      </div>
    `;
    if (label) this.querySelector('.snippet-label').textContent = label;
    this.querySelector('.snippet-code').textContent = code;

    this.querySelector('.snippet-copy').addEventListener('click', async () => {
      const btn = this.querySelector('.snippet-copy');
      try {
        await navigator.clipboard.writeText(code);
        showToast('Copied to clipboard');
        btn.classList.add('is-copied');
        btn.innerHTML = icons.check('', 14);
        clearTimeout(this.#resetTimer);
        this.#resetTimer = setTimeout(() => {
          btn.classList.remove('is-copied');
          btn.innerHTML = icons.copy('', 14);
        }, 1500);
      } catch {
        showToast('Copy failed — clipboard unavailable');
      }
    });
  }

  disconnectedCallback() {
    clearTimeout(this.#resetTimer);
  }
}

customElements.define('app-code-snippet', AppCodeSnippet);
