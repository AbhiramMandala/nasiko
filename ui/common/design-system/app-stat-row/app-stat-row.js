/**
 * Row of headline metrics separated by hairlines — the one stat strip.
 *
 * Six pages had each hand-built the same `.kpi-strip` markup and re-declared its
 * CSS, and the six copies had already drifted: three font families, four value
 * sizes, two label weights, and a mobile two-column rule present in two of them.
 * This is that strip, once. A page supplies the data; it does not get a say in
 * how a metric looks.
 *
 * The host element IS the strip — hairlines, columns and the mobile fold live
 * here, so a page's own sheet must not re-declare them.
 *
 * @element app-stat-row
 * @attr {string} items - JSON array of metric objects: `{ label, value, sub, pct }`.
 *   `sub` is the caption under the value; `pct` (a number) draws a severity meter
 *   and is omitted for metrics that have no ceiling. There is deliberately no
 *   per-metric colour: a value is a value, and the one that was tinted gold was
 *   drift, not meaning.
 * @attr {number} loading - Number of skeleton cells to reserve while data loads
 *   (default: 4). The skeleton lives here so it cannot drift from the real
 *   geometry. Present-but-empty means the default.
 */
import styles from './app-stat-row.css' with { type: 'css' };
import { escHtml, escAttr } from '/common/utils/escape.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const DEFAULT_SKELETON_CELLS = 4;

/**
 * Severity meter for a percentage. Only the bar width is clamped: a summed CPU
 * figure can exceed 100 (per-container samples are taken at slightly different
 * instants) and cgroup memory accounting can report marginally over a limit —
 * announcing a capped 100 tells a screen-reader user the wrong number.
 */
function meterHtml(pct) {
  const width = Math.max(0, Math.min(100, pct));
  const sev = pct >= 90 ? 'is-crit' : pct >= 70 ? 'is-warn' : 'is-ok';
  const state = pct >= 90 ? 'critical' : pct >= 70 ? 'high' : 'normal';
  return `<div class="meter ${sev}" role="img" aria-label="${escAttr(`${pct.toFixed(0)} percent, ${state}`)}">
      <div class="meter-fill" style="width:${width.toFixed(1)}%"></div>
    </div>`;
}

export class AppStatRow extends HTMLElement {
  static get observedAttributes() { return ['items', 'loading']; }

  #initialized = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected && this.#initialized) this.render();
  }

  /**
   * Property form of `items`, so a page writes `strip.items = [...]` instead of
   * hand-stringifying JSON into an attribute. Clearing `loading` here is the
   * point: every call site did it as a separate step and one of them forgot.
   */
  set items(list) {
    this.removeAttribute('loading');
    this.setAttribute('items', JSON.stringify(Array.isArray(list) ? list : []));
  }

  get items() { return this.#items(); }

  /** @returns {Array<Record<string, any>>} */
  #items() {
    const raw = this.getAttribute('items');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((i) => i && typeof i === 'object');
    } catch {
      return [];
    }
  }

  #cell(item) {
    // `pct` is opt-in per metric: a container count has no ceiling, so a bar
    // under it would invent one. Only a real number draws a meter.
    const pct = typeof item.pct === 'number' && Number.isFinite(item.pct) ? item.pct : null;
    const value = item.value === null || item.value === undefined || item.value === ''
      ? '—' : String(item.value);
    return `
      <div class="stat">
        <div class="stat-label">${escHtml(String(item.label ?? ''))}</div>
        <div class="stat-value">${escHtml(value)}</div>
        ${item.sub ? `<div class="stat-sub">${escHtml(String(item.sub))}</div>` : ''}
        ${pct === null ? '' : meterHtml(pct)}
      </div>`;
  }

  render() {
    if (this.hasAttribute('loading')) {
      const n = Number(this.getAttribute('loading'));
      const cells = Number.isInteger(n) && n > 0 ? n : DEFAULT_SKELETON_CELLS;
      this.setAttribute('aria-busy', 'true');
      this.innerHTML = Array.from({ length: cells }, () => `
        <div class="stat">
          <div class="stat-skel stat-skel--label"></div>
          <div class="stat-skel stat-skel--value"></div>
        </div>`).join('');
      return;
    }
    this.removeAttribute('aria-busy');
    this.innerHTML = this.#items().map((i) => this.#cell(i)).join('');
  }
}

customElements.define('app-stat-row', AppStatRow);
