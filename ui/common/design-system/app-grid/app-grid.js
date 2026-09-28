/**
 * CSS grid layout wrapper with configurable columns, gap, and padding.
 *
 * @element app-grid
 * @attr {string|number} columns - Column count or grid template. Fractional tracks shrink without overflowing and collapse below 600px of available width.
 * @attr {string} min-width - Minimum column width for auto-fit layouts (e.g. `280px`)
 * @attr {string} gap - Gap between cells: `xs` | `sm` | `md` (default) | `lg` | `xl`
 * @attr {string} padding - Inner padding token: `xs` | `sm` | `md` | `lg` | `xl`
 * @slot default - Any children; the container only lays them out.
 * @children *
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-grid.css', import.meta.url));
import { BaseLayout } from '../../core/base-layout.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppGrid extends BaseLayout {
  #resize = new ResizeObserver(([entry]) => {
    this.toggleAttribute('data-narrow', entry.contentRect.width < 600);
  });
  static get observedAttributes() { return ['columns', 'min-width', 'gap', 'padding']; }
  constructor() { super('grid'); }

  connectedCallback() {
    super.connectedCallback();
    this.#resize.observe(this);
  }

  disconnectedCallback() { this.#resize.disconnect(); }

  updateProperty(name, value) {
    if (name === 'columns') {
      const n = Number(value);
      const val = (Number.isInteger(n) && n > 0) ? `repeat(${n}, minmax(0, 1fr))`
        : /^\d+(?:\.\d+)?fr(?:\s+\d+(?:\.\d+)?fr)*$/.test(value)
          ? value.split(/\s+/).map(track => `minmax(0, ${track})`).join(' ') : value;
      this.style.setProperty('--grid-columns', val);
    } else {
      super.updateProperty(name, value);
    }
  }
}
customElements.define('app-grid', AppGrid);
