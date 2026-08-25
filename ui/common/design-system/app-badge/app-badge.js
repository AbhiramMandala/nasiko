/**
 * Small inline label with color variants for status, category, or metadata.
 *
 * @element app-badge
 * @attr {string} variant - Visual style: `neutral` (default) | `success` | `warning` | `error` | `info`
 * @note CSS-only component — no JS logic. Content goes in the default slot.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-badge.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];


export class AppBadge extends HTMLElement {}
customElements.define('app-badge', AppBadge);
