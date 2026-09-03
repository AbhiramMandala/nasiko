/**
 * Full-height side sheet that slides in over a dimmed backdrop.
 *
 * Ported from nasiko_ui `showNasikoSheet`. The same styling language as
 * `<app-modal>` — bg-base surface, border-primary hairline, r16 rounding on the
 * inner edge only — built on a native `<dialog>` so focus trapping, Escape,
 * `inert` behind it and top-layer painting come from the platform. Where a
 * modal is for a decision, a sheet is for a task that keeps the page in view:
 * filters, a detail inspector, a multi-field editor.
 *
 * Markup mirrors app-modal: body content in the default slot, actions in
 * `[data-slot="footer"]`. Imperative use: `el.show()` / `el.close(result)`;
 * the `sheet-close` event carries the result (`null` on backdrop / Escape / ×).
 *
 * @element app-sheet
 * @attr {string} heading - Title in the header.
 * @attr {string} side - `right` (default) | `left`
 * @attr {string} width - CSS width, e.g. `480px` (default `420px`). Capped at 100vw.
 * @attr {boolean} open - Whether the sheet is showing. Reflected.
 * @attr {boolean} no-backdrop-close - Ignore clicks on the backdrop.
 * @slot default - Body content.
 * @slot [data-slot="footer"] - Action row (Cancel / Save).
 * @fires sheet-close - `{ result }` after the sheet has closed. Bubbles.
 * @method show() / close(result?) — `open` is the reflected attribute/property, so the
 *   opener is `show()` (as on app-popover and app-menu), not `open()`.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-sheet.css', import.meta.url));
import { icons } from '../../utils/icons.js';
import { escStyleValue } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppSheet extends HTMLElement {
  static get observedAttributes() { return ['heading', 'side', 'width', 'open', 'no-backdrop-close']; }

  #dialog = null;
  #built = false;
  #result = null;
  #titleId = `app-sheet-title-${++uid}`;

  get open() { return this.hasAttribute('open'); }
  set open(v) { v ? this.setAttribute('open', '') : this.removeAttribute('open'); }

  connectedCallback() {
    this.#build();
    this.#sync();
  }

  attributeChangedCallback(name) {
    if (!this.#built) return;
    if (name === 'heading') this.#dialog.querySelector('.title').textContent = this.getAttribute('heading') ?? '';
    if (name === 'width') this.#applyWidth();
    if (name === 'open') this.#sync();
  }

  #build() {
    if (this.#built) return;
    this.#built = true;
    const footer = [...this.children].find((el) => el.dataset.slot === 'footer');
    const bodyNodes = [...this.childNodes].filter((n) => n !== footer);

    const dialog = document.createElement('dialog');
    dialog.className = 'app-sheet';
    dialog.setAttribute('aria-labelledby', this.#titleId);
    dialog.innerHTML = `
      <header>
        <h4 class="title" id="${this.#titleId}"></h4>
        <button type="button" class="close" aria-label="Close">${icons.x('', 14)}</button>
      </header>
      <div class="body"></div>
      ${footer ? '<footer></footer>' : ''}`;
    dialog.querySelector('.title').textContent = this.getAttribute('heading') ?? '';
    const body = dialog.querySelector('.body');
    for (const n of bodyNodes) body.appendChild(n);
    if (footer) dialog.querySelector('footer').appendChild(footer);

    dialog.querySelector('.close').addEventListener('click', () => this.close(null));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && !this.hasAttribute('no-backdrop-close')) this.close(null);
    });
    // Escape closes the native dialog; `cancel` is where we hear about it.
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close(null); });
    dialog.addEventListener('close', () => {
      this.removeAttribute('open');
      this.dispatchEvent(new CustomEvent('sheet-close', { bubbles: true, detail: { result: this.#result } }));
      this.#result = null;
    });

    this.appendChild(dialog);
    this.#dialog = dialog;
    this.#applyWidth();
  }

  #applyWidth() {
    const w = this.getAttribute('width');
    this.#dialog.style.setProperty('--sheet-w', w ? escStyleValue(w) : '');
  }

  #sync() {
    const d = this.#dialog;
    if (this.open && !d.open) d.showModal();
    else if (!this.open && d.open) this.close(null);
  }

  show() { this.setAttribute('open', ''); }

  /** Close with a result; `sheet-close` fires after the exit transition. */
  close(result = null) {
    const d = this.#dialog;
    if (!d?.open) return;
    this.#result = result;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { d.close(); return; }
    d.classList.add('is-leaving');
    // animationend is the normal path; the timer is the guarantee. A sheet whose
    // exit animation never runs (display toggled, sheet detached mid-flight) must
    // still close, or the page stays inert behind an invisible modal.
    const done = () => { d.classList.remove('is-leaving'); if (d.open) d.close(); };
    d.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400);
  }
}
customElements.define('app-sheet', AppSheet);
