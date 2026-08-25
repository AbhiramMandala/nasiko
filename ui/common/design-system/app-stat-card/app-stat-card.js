/**
 * Metric summary card showing a label, primary value, delta, and trend direction.
 *
 * @element app-stat-card
 * @attr {string} label - Metric label (e.g. "Total Revenue")
 * @attr {string} value - Primary value to display
 * @attr {string} delta - Change value shown below the main value (e.g. "+12%")
 * @attr {string} trend - Trend direction: `up` | `down` | `neutral`
 * @attr {boolean} loading - Show a skeleton placeholder instead of data
 * @note Every attribute is escaped on the way in. These values are routinely
 *   bound straight from an API field — an agent name, a cost, a model id — and
 *   a generated surface can bind any of them, so this element is a sink for
 *   data nobody in this repo authored.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-stat-card.css', import.meta.url));
import { escHtml, escAttr } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];


export class AppStatCard extends HTMLElement {
  static get observedAttributes() { return ['label', 'value', 'delta', 'trend', 'loading']; }
  #initialized = false;
  connectedCallback() { if (this.#initialized) return; this.#initialized = true; this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    if (this.hasAttribute('loading')) {
      this.innerHTML = '<div class="stat-card is-loading"></div>';
      return;
    }
    const label = this.getAttribute('label') || '';
    const value = this.getAttribute('value') || '—';
    const delta = this.getAttribute('delta') || '';
    const trend = this.getAttribute('trend') || 'neutral';
    this.innerHTML = `
      <div class="stat-card">
        <p class="label">${escHtml(label)}</p>
        <p class="value">${escHtml(value)}</p>
        ${delta ? `<p class="delta is-${escAttr(trend)}">${escHtml(delta)}</p>` : ''}
      </div>`;
  }
}
customElements.define('app-stat-card', AppStatCard);
