/**
 * Vertical flex stack with configurable gap and alignment.
 *
 * @element app-stack
 * @attr {string} gap - Space between items: `xs` | `sm` | `md` (default) | `lg` | `xl`
 * @attr {string} align - Cross-axis alignment: `start` | `center` | `end` | `stretch` (default)
 * @attr {string} padding - Inner padding token: `xs` | `sm` | `md` | `lg` | `xl`
 * @note Vertical flex stack. For horizontal use `<app-row>`.
 * @slot default - Any children; the container only lays them out.
 * @children *
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-stack.css', import.meta.url));
import { BaseLayout } from '../../core/base-layout.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppStack extends BaseLayout {
  static get observedAttributes() { return ['gap', 'align', 'padding']; }
  constructor() { super('stack'); }
}
customElements.define('app-stack', AppStack);
