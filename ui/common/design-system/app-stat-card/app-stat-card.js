/**
 * Metric summary card showing a label, primary value, delta, and trend direction.
 *
 * @element app-stat-card
 * @attr {string} label - Metric label (e.g. "Total Revenue")
 * @attr {string} value - Primary value to display
 * @attr {string} delta - Change value shown below the main value (e.g. "+12%")
 * @attr {string} trend - Trend direction: `up` | `down` | `neutral`
 * @attr {boolean} loading - Show a skeleton placeholder instead of data
 *   (The two attributes below were added after the catalog first shipped and
 *   sit last on purpose: the DSL passes attributes positionally in @attr
 *   order, so a new one must append — see catalog-compat.mjs.)
 * @attr {string} format - Display unit: `number` | `currency` | `percent` |
 *   `compact` | `bytes` | `duration` | `tokens` | `date` | `time` |
 *   `datetime` | `text`. Applies to the value. Omit it and the card formats by
 *   shape — a fractional number is shown to two decimals, an ISO-8601 string
 *   as local time, everything else verbatim; `text` opts out entirely.
 * @attr {string} currency - ISO code for `format="currency"` (default `USD`)
 * @note Every attribute is escaped on the way in. These values are routinely
 *   bound straight from an API field — an agent name, a cost, a model id — and
 *   a generated surface can bind any of them, so this element is a sink for
 *   data nobody in this repo authored.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-stat-card.css', import.meta.url));
import { escHtml, escAttr } from '../../utils/escape.js';
import { applyFormat } from '../../utils/units.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];


export class AppStatCard extends HTMLElement {
  static get observedAttributes() {
    return ['label', 'value', 'delta', 'trend', 'loading', 'format', 'currency'];
  }
  #initialized = false;
  connectedCallback() { if (this.#initialized) return; this.#initialized = true; this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }
  render() {
    if (this.hasAttribute('loading')) {
      this.setAttribute('aria-busy', 'true');
      // Label + value + delta as three independent bars, matching the real
      // card's three lines, instead of the whole card becoming one flat
      // pulsing rectangle that hides which numbers are still loading.
      this.innerHTML = `
        <div class="stat-card is-loading">
          <div class="skel-line skel-line--label"></div>
          <div class="skel-line skel-line--value"></div>
          <div class="skel-line skel-line--delta"></div>
        </div>`;
      return;
    }
    this.removeAttribute('aria-busy');
    const label = this.getAttribute('label') || '';
    // Attributes are strings, always — a generated surface binding a cost
    // hands over "0.023456789012" and the type is gone by the time it lands
    // here. Formatting is therefore the card's job, not the caller's: the
    // caller cannot do it (the DSL has no formatter) and the raw digits are
    // what shipped on screen.
    const fmt = this.getAttribute('format') || undefined;
    const opts = { currency: this.getAttribute('currency') || 'USD' };
    const value = applyFormat(this.getAttribute('value'), fmt, opts) || '—';
    // The delta is a change in the same unit, except for a percentage delta on
    // an absolute metric — which is why it keeps its own sign and suffix and is
    // only ever auto-formatted, never forced through `format`.
    const delta = applyFormat(this.getAttribute('delta'), undefined) || '';
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
