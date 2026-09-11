/**
 * Horizontal flex row with configurable gap, alignment, and optional wrapping.
 *
 * @element app-row
 * @attr {string} gap - Space between items: `xs` | `sm` | `md` (default) | `lg` | `xl`
 * @attr {string} align - Cross-axis alignment: `start` | `center` | `end` | `stretch` (default)
 * @attr {string} justify - Main-axis alignment: `start` (default) | `center` | `end` | `between`
 * @attr {string} padding - Inner padding token: `xs` | `sm` | `md` | `lg` | `xl`
 * @attr {boolean} wrap - Allow items to wrap to next line
 * @note Horizontal flex row. For vertical use `<app-stack>`.
 * @slot default - Any children; the container only lays them out.
 * @children *
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-row.css', import.meta.url));
import { BaseLayout } from '../../core/base-layout.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppRow extends BaseLayout {
  static get observedAttributes() { return ['gap', 'align', 'justify', 'padding', 'wrap']; }
  constructor() { super('row'); }
}
customElements.define('app-row', AppRow);
