/**
 * Anchored, non-modal overlay surface attached to a trigger.
 *
 * Ported from nasiko_ui `NasikoPopover`. The first child is the trigger (any
 * element — usually an `<app-button>`); `[data-slot="content"]` is the surface.
 * Clicking the trigger toggles; Escape and clicks outside close, and Escape
 * hands focus back to the trigger. The surface flips to the other side when it
 * does not fit and clamps to the viewport (`utils/anchor.js`, the shared
 * engine), and it follows the anchor while open.
 *
 * The surface is a top-layer `popover="manual"`, so it renders above an open
 * `<app-modal>` and is never clipped by an `overflow: hidden` ancestor — the
 * two things `position: absolute` menus get wrong.
 *
 * Not a menu: it has no item semantics. For a list of actions use
 * `<app-menu>`; for something that opens on hover use `<app-hover-card>`.
 *
 * @element app-popover
 * @attr {boolean} open - Whether the surface is showing. Reflected.
 * @attr {string} side - `bottom` (default) | `top` | `left` | `right` — preferred
 *   side; flips when it does not fit.
 * @attr {string} align - `start` (default) | `center` | `end`
 * @attr {string} width - CSS width for the surface, e.g. `320px`. Default: content.
 * @attr {boolean} no-outside-dismiss - Keep open on outside clicks (Escape still closes).
 * @slot default - The trigger element (first child).
 * @slot [data-slot="content"] - The surface content.
 * @fires popover-toggle - `{ open }` after every open/close. Bubbles.
 * @method show() / hide() / toggle()
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-popover.css', import.meta.url));
import { positionAnchored, followAnchor, supportsPopover } from '../../utils/anchor.js';
import { escStyleValue } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppPopover extends HTMLElement {
  static get observedAttributes() { return ['open', 'side', 'align', 'width', 'no-outside-dismiss']; }

  #trigger = null;
  #surface = null;
  #built = false;
  #unfollow = null;
  #onDocClick = (e) => {
    if (this.hasAttribute('no-outside-dismiss')) return;
    if (this.contains(e.target) || this.#surface.contains(e.target)) return;
    this.hide();
  };
  #onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    this.hide();
    this.#trigger?.focus?.();
    this.#trigger?.querySelector?.('button, a, [tabindex]')?.focus?.();
  };

  get open() { return this.hasAttribute('open'); }
  set open(v) { v ? this.setAttribute('open', '') : this.removeAttribute('open'); }
  show() { this.open = true; }
  hide() { this.open = false; }
  toggle() { this.open = !this.open; }

  connectedCallback() {
    this.#build();
    this.#sync();
  }

  disconnectedCallback() {
    this.#teardown();
    this.#surface?.remove();
  }

  attributeChangedCallback(name) {
    if (!this.#built) return;
    if (name === 'open') return this.#sync();
    if (name === 'width') this.#applyWidth();
    if (this.open) this.#place();
  }

  #build() {
    if (this.#built) return;
    this.#built = true;
    const content = this.querySelector(':scope > [data-slot="content"]');
    this.#trigger = [...this.children].find((el) => el !== content) ?? null;

    // The surface lives on <body>, not inside the host: a top-layer popover
    // must not be inside an ancestor that is itself display:none or inert,
    // and keeping it out of the host keeps the host's layout to the trigger.
    const surface = document.createElement('div');
    surface.className = 'app-popover-surface';
    surface.setAttribute('role', 'dialog');
    surface.hidden = true;
    if (supportsPopover) surface.popover = 'manual';
    if (content) surface.append(...content.childNodes);
    document.body.append(surface);
    this.#surface = surface;
    content?.remove();
    this.#applyWidth();

    this.#trigger?.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    this.#trigger?.setAttribute('aria-haspopup', 'dialog');
    this.#trigger?.setAttribute('aria-expanded', 'false');
  }

  #applyWidth() {
    const w = this.getAttribute('width');
    this.#surface.style.width = w ? escStyleValue(w) : '';
  }

  #place() {
    const { side } = positionAnchored(this.#surface, this.#trigger ?? this, {
      side: this.getAttribute('side') || 'bottom',
      align: this.getAttribute('align') || 'start',
    });
    this.#surface.dataset.side = side;
  }

  #sync() {
    const open = this.open;
    const s = this.#surface;
    if (open === !s.hidden) return;
    if (open) {
      s.hidden = false;
      if (supportsPopover) s.showPopover();
      this.#place();
      this.#unfollow = followAnchor(() => this.#place());
      document.addEventListener('click', this.#onDocClick, true);
      document.addEventListener('keydown', this.#onKey);
      // Focus the first focusable thing inside, if any — otherwise the surface
      // itself so Escape is heard.
      const first = s.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (first) first.focus(); else { s.tabIndex = -1; s.focus(); }
    } else {
      this.#teardown();
      if (supportsPopover && s.matches(':popover-open')) s.hidePopover();
      s.hidden = true;
    }
    this.#trigger?.setAttribute('aria-expanded', String(open));
    this.dispatchEvent(new CustomEvent('popover-toggle', { bubbles: true, detail: { open } }));
  }

  #teardown() {
    this.#unfollow?.();
    this.#unfollow = null;
    document.removeEventListener('click', this.#onDocClick, true);
    document.removeEventListener('keydown', this.#onKey);
  }
}
customElements.define('app-popover', AppPopover);
