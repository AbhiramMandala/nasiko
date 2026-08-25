/**
 * Horizontal toolbar with named start and end slots for grouping actions.
 *
 * @element app-toolbar
 * @attr {string} aria-label - Accessible label for the toolbar region
 * @slot [data-slot="start"] - Left-side content
 * @slot [data-slot="end"] - Right-side content
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-toolbar.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];


export class AppToolbar extends HTMLElement {
  #initialized = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    const start = [...this.children].find(el => el.dataset.slot === 'start');
    const end   = [...this.children].find(el => el.dataset.slot === 'end');

    const wrap     = document.createElement('div');
    const startDiv = Object.assign(document.createElement('div'), { className: 'start' });
    const endDiv   = Object.assign(document.createElement('div'), { className: 'end' });

    wrap.className = 'toolbar';
    wrap.setAttribute('role', 'toolbar');
    wrap.setAttribute('aria-label', this.getAttribute('aria-label') ?? 'Toolbar');
    if (start) startDiv.appendChild(start);
    if (end)   endDiv.appendChild(end);
    wrap.append(startDiv, endDiv);
    this.appendChild(wrap);

    // role="toolbar" promises arrow-key movement between its controls
    // (WAI-ARIA toolbar pattern) — without it the role is a claim the
    // keyboard cannot cash.
    wrap.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 0, End: 0 };
      if (!(e.key in keys)) return;
      const controls = [...wrap.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => !el.disabled);
      if (!controls.length) return;
      const i = controls.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? controls.length - 1
        : (i + keys[e.key] + controls.length) % controls.length;
      controls[next].focus();
    });
  }
}
customElements.define('app-toolbar', AppToolbar);
