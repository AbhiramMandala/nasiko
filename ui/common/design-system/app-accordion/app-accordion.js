/**
 * Collapsible disclosure section — a header row that opens to reveal its body.
 *
 * Built on native `<details>`/`<summary>`, so the keyboard behaviour, focus
 * ring and expanded/collapsed semantics are the platform's rather than a
 * hand-rolled `role="button"` + `aria-expanded` pair that every hand-rolled
 * copy in this repo has so far forgotten to add.
 *
 * Nest one inside another's body for a tree: the body's inline padding is the
 * indent, so depth needs no per-level `padding-left` arithmetic at the call
 * site. Nested instances take `variant="flat"` so only the outermost draws the
 * card.
 *
 * @element app-accordion
 * @attr {string} label - Header text (required)
 * @attr {boolean} open - Expanded. Reflected, so it tracks user toggles.
 * @attr {string} variant - `card` (default) draws its own surface | `flat` drops
 *   the border and radius, for stacking inside a bordered list or nesting.
 * @attr {boolean} disabled - Header is inert and the section cannot be toggled
 * @slot [data-slot="meta"] - Trailing header content (tags, badges, a count)
 * @slot default - Body content
 * @fires accordion-toggle - Opened or closed; `detail: { open: boolean }` — bubbles
 */
import { icons } from '../../utils/icons.js';
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-accordion.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppAccordion extends HTMLElement {
  #initialized = false;
  #details = null;

  static get observedAttributes() {
    return ['label', 'open', 'disabled'];
  }

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    // Captured before the <details> shell replaces them: the slotted nodes are
    // relocated into it, so a later attribute change has nothing to re-query.
    const children = [...this.childNodes];
    const meta = children.find((n) => n.dataset?.slot === 'meta');
    const body = children.filter((n) => n !== meta);

    const details = document.createElement('details');
    details.innerHTML = `
      <summary>
        ${icons.chevronDown('chev', 16)}
        <span class="acc-label"></span>
        <span class="acc-meta"></span>
      </summary>
      <div class="acc-body"></div>`;

    if (meta) details.querySelector('.acc-meta').appendChild(meta);
    body.forEach((n) => details.querySelector('.acc-body').appendChild(n));

    this.appendChild(details);
    this.#details = details;
    this.#sync();

    // `inert` already takes a disabled header out of the tab order and off the
    // hit-test, but a scripted or synthesised click still reaches it — and that
    // click would toggle the section. Cancelling the default is what actually
    // makes `disabled` mean disabled.
    details.querySelector('summary').addEventListener('click', (e) => {
      if (this.hasAttribute('disabled')) e.preventDefault();
    });

    details.addEventListener('toggle', () => {
      // Reflect first: a listener that reads `el.open` during the event must
      // not see the pre-toggle value.
      this.toggleAttribute('open', details.open);
      this.dispatchEvent(new CustomEvent('accordion-toggle', {
        detail: { open: details.open },
        bubbles: true,
      }));
    });
  }

  attributeChangedCallback() {
    this.#sync();
  }

  /** Expanded state, as a property. Setting it toggles the section. */
  get open() {
    return this.hasAttribute('open');
  }
  set open(next) {
    this.toggleAttribute('open', Boolean(next));
  }

  #sync() {
    const details = this.#details;
    if (!details) return;
    // Guarded: assigning `open` fires `toggle`, which reflects the attribute,
    // which lands back here. Without the equality check that is a loop.
    if (details.open !== this.hasAttribute('open')) details.open = this.hasAttribute('open');
    const summary = details.querySelector('summary');
    summary.querySelector('.acc-label').textContent = this.getAttribute('label') || '';
    // `inert` rather than pointer-events:none — it takes the summary out of the
    // tab order too, which a CSS-only "disabled" never does.
    summary.inert = this.hasAttribute('disabled');
  }
}

if (!customElements.get('app-accordion')) customElements.define('app-accordion', AppAccordion);
