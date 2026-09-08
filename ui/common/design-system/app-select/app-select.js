/**
 * Single-select dropdown: a styled native `<select>` with the input's label,
 * hint and state treatment.
 *
 * Matched to Figma "Design System V2" › ↳Select › Select (node 4581:45). The
 * trigger is a full match: same 32/28px box, padding, radius and border ramp as
 * app-input, plus a 16px chevron in fg/default/icon-secondary (#bb8f06).
 *
 * The design also specifies a custom listbox (4569:27) and per-option states
 * (4558:61: hover, focus, selected with a gold check, disabled). A native
 * `<select>` renders the OS popup, so those option states are not reachable
 * here — that is the trade for free keyboard, mobile and screen-reader
 * behaviour. If a page needs the designed listbox, that is a separate
 * popover-based component; the option tokens are already in place
 * (--bg-surface hover, --bg-secondary-brand selected, --fg-brand check).
 *
 * @element app-select
 * @attr {string} size - `md` (default, 32px) | `sm` (28px)
 * @attr {string} state - `error` | `success` | `hover` | `focus` (visual only)
 * @attr {string} label - Label above the trigger.
 * @attr {string} hint - Helper line below. Turns red in `state="error"`.
 * @attr {string} placeholder - Renders a selected-but-disabled first option.
 * @attr {string} options - JSON array of `"value"` or `{value, label, disabled}`.
 * @attr {boolean} required|disabled
 * @attr {string} name|aria-label - Forwarded to the inner `<select>`.
 * @attr {string} value - Initially selected value; matched against `options`.
 * @attr {boolean} fit-content - Shrinks/grows the trigger box to the width of
 *       whatever option is CURRENTLY shown (the placeholder, or the selected
 *       option), instead of the native-<select> default of sizing the box to
 *       the WIDEST option in the list. Native `<select>` has no CSS for this —
 *       the box width has to be measured in JS (offscreen canvas text
 *       measurement) and set as an explicit inline width, recomputed whenever
 *       the shown text changes. Opt-in per instance so the many existing
 *       app-select consumers that want a stable, content-independent width
 *       (e.g. a form field lined up in a grid) are unaffected.
 * @prop {string} value - Get/set the selected value.
 * @prop {HTMLSelectElement} select - The inner select.
 * @slot [data-slot="leading"] - A prefix glyph inside the trigger, before the
 *   text — same slot name, metrics and colour as app-input's, so a prefixed
 *   select and a prefixed field are the same markup. There is no `trailing`
 *   slot: that edge is the chevron's.
 * @fires change - Bubbles from the inner select.
 * @note Options can be slotted as plain `<option>` children instead of the
 *       `options` attribute; whichever is present wins, attribute first.
 * @note A `value` no option carries is ignored, not applied: a native <select>
 *       given an unknown value renders blank, which would wipe the visible
 *       selection (e.g. a leading "None"/"Not configured" option).
 * @note The leading glyph is sized by the component — 16px at md, 12px at sm —
 *       so pass a bare `icons.sortBoth()` and don't set a size at the call site.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-select.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

// Shared offscreen canvas for `fit-content` text measurement — one 2d context
// for every app-select instance rather than one per component/render.
let measureCtx = null;
function measureText(text, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

export class AppSelect extends HTMLElement {
  static get observedAttributes() {
    return ['size', 'state', 'label', 'hint', 'placeholder', 'options', 'required',
            'disabled', 'name', 'value', 'aria-label', 'fit-content'];
  }

  #id = `app-select-${++uid}`;
  /** Slotted <option> markup, captured once — render() replaces innerHTML. */
  #slotted = null;
  /** Same, for the leading glyph: re-querying after a render would find the
   *  copy this component wrote and, on the render after that, nothing. */
  #leading = null;

  get value() { return this.select?.value ?? this.getAttribute('value') ?? ''; }
  set value(v) { if (this.select) this.#applyValue(v); else this.setAttribute('value', v); }
  get select() { return this.querySelector('select'); }

  /** The host is not focusable — a `focus()` on it would silently do nothing,
   *  so hand it to the control inside. */
  focus(options) { this.select?.focus(options); }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  /** `options` JSON → <option> markup. Bad JSON renders nothing rather than throwing. */
  #optionsHtml() {
    const raw = this.getAttribute('options');
    if (!raw) return this.#slotted;
    let list;
    try { list = JSON.parse(raw); } catch { return this.#slotted; }
    if (!Array.isArray(list)) return this.#slotted;
    return list.map((o) => {
      const { value, label, disabled } = typeof o === 'object' && o !== null
        ? o : { value: o, label: o };
      // Both halves escaped: `options` is routinely bound from API data, so the
      // label is a sink for text nobody in this repo authored.
      return `<option value="${escAttr(value)}"${
        disabled ? ' disabled' : ''}>${escHtml(label ?? value)}</option>`;
    }).join('');
  }

  /** Select `v` only if an option carries it. A native <select> assigned a
   *  value no option has drops to selectedIndex -1 and renders *blank* — it
   *  does not no-op — so a caller binding an unrecognised server value (an
   *  IdP kind with no option, a role that was renamed) would erase the
   *  selection the user can see, including the first option's default. */
  #applyValue(v) {
    const sel = this.select;
    if ([...sel.options].some((o) => o.value === String(v))) sel.value = v;
    this.#applyFitWidth();
  }

  /**
   * `fit-content`: measures the text of whichever option is currently shown
   * (`selectedOptions[0]` — the placeholder header counts too) and sets that
   * plus the trigger's own fixed chrome as an explicit width on `.select-box`,
   * so the box tracks the shown option's width rather than the widest one the
   * native popup would otherwise reserve room for. `align-self: flex-start`
   * on `.select-box[fit-content-applied]` disables the parent's default
   * stretch so the inline width actually takes effect (see app-select.css).
   * No-ops (and leaves any width from a previous render) when `fit-content`
   * is absent, disabled, or the select isn't in the document yet — a hidden
   * <select> the browser hasn't laid out reports a font it can't guarantee.
   */
  #applyFitWidth() {
    if (!this.hasAttribute('fit-content')) return;
    const sel = this.select;
    const box = this.querySelector('.select-box');
    if (!sel || !box) return;
    const opt = sel.selectedOptions[0] ?? sel.options[0];
    const text = opt ? (opt.textContent || '') : '';
    const font = getComputedStyle(sel).font;
    const isSm = this.getAttribute('size') === 'sm';
    // Chrome outside the measured text: select-box border (1px × 2) plus the
    // select's own left/right padding — 12/36 at md, 8/30 at sm (see the
    // "Right padding leaves room for..." note in app-select.css).
    const chrome = 2 + (isSm ? 8 + 30 : 12 + 36);
    // +4px safety margin: canvas measureText() and the browser's own text
    // shaping for the <select> can differ by a pixel or two — better a hair
    // of breathing room than a clipped last character.
    box.style.width = `${Math.ceil(measureText(text, font)) + chrome + 4}px`;
  }

  render() {
    const prev = this.select;
    const value = prev ? prev.value : (this.getAttribute('value') ?? '');
    const refocus = prev && document.activeElement === prev;
    if (this.#slotted === null) {
      this.#slotted = [...this.querySelectorAll('option')].map((o) => o.outerHTML).join('');
    }
    if (this.#leading === null) {
      this.#leading = this.querySelector('[data-slot="leading"]')?.outerHTML ?? '';
    }

    const size        = this.getAttribute('size') === 'sm' ? 'sm' : 'md';
    const disabled    = this.hasAttribute('disabled');
    const state       = disabled ? 'disabled' : (this.getAttribute('state') || 'default');
    const label       = this.getAttribute('label');
    const hint        = this.getAttribute('hint');
    const placeholder = this.getAttribute('placeholder');
    const name        = this.getAttribute('name');
    // Named like app-input's: the inner <select> is what a screen reader reads,
    // and a label sitting in another grid column can't point at its generated id.
    const aria        = this.getAttribute('aria-label');

    this.innerHTML = `
      <div class="field is-${size} is-${state}">
        ${label === null ? '' : `<label class="label-row" for="${this.#id}">${
          this.hasAttribute('required') ? '<span class="req">*</span>' : ''}${escHtml(label)}</label>`}
        <div class="select-box">
          ${this.#leading}
          <select id="${this.#id}"${name ? ` name="${escAttr(name)}"` : ''}${
            aria ? ` aria-label="${escAttr(aria)}"` : ''}${
            disabled ? ' disabled' : ''}${this.hasAttribute('required') ? ' required' : ''}>
            ${placeholder === null ? ''
              : `<option value="" disabled selected>${escHtml(placeholder)}</option>`}
            ${this.#optionsHtml()}
          </select>
          <span class="chevron" aria-hidden="true">${icons.chevronDown()}</span>
        </div>
        ${hint === null ? '' : `<div class="hint-row"><span class="hint">${escHtml(hint)}</span></div>`}
      </div>`;

    // The chevron comes from icons.js with its size inline, which beats the
    // sheet — so app-select.css's 16/12 chevron rules only apply once dropped.
    unsizeIcons(this);

    if (value) this.#applyValue(value);
    else this.#applyFitWidth();
    if (refocus) this.select.focus();

    // Picking a new option fires 'change' on the inner <select> without going
    // through #applyValue — a fresh element each render, so re-attached here.
    if (this.hasAttribute('fit-content')) {
      this.select.addEventListener('change', () => this.#applyFitWidth());
    }
  }
}
customElements.define('app-select', AppSelect);
