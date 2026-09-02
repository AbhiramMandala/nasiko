/**
 * Search field — the box only, not a results surface.
 *
 * Matched to Figma "Design System V2" › ↳Search › Search (node 4258:104):
 * State {default, hover, focus, disabled, loading} × Size {md, sm}. Leaner than
 * `<app-input>` on purpose — no label, hint or counter, and 36px tall at md
 * (`control/height/lg`) rather than 32.
 *
 * "Has value" is a boolean, not a state: it co-occurs with hover and focus, so
 * the trailing clear is driven by the current value, not by `state`. It is
 * hidden in `loading` and `disabled` so it never collides with the spinner.
 *
 * @element app-search
 * @attr {string} size - `md` (default, 36px) | `sm` (28px)
 * @attr {string} state - `hover` | `focus`, so the design-system page and the
 *   parity test can render those pseudo-classes statically. `disabled` and
 *   `loading` below are real attributes, not `state` values.
 * @attr {boolean} loading - Swaps the trailing slot for a spinner.
 * @attr {boolean} disabled
 * @attr {string} placeholder - Defaults to "Search".
 * @attr {string} value - Initial value.
 * @attr {string} name|autocomplete|maxlength|inputmode - Forwarded to the inner
 *   `<input>`.
 * @attr {string} aria-label - Accessible name for the field. The box has no
 *   visible label of its own, so one is always emitted: this if you set it,
 *   otherwise the placeholder. Set it whenever the page holds more than one
 *   search box, or the placeholder does not say what is being searched.
 * @cssprop --search-bg - Resting fill. Default `--bg-base` (white). Set it on the
 *   *surface*, not the field: the fill depends on the plane the field sits on.
 * @prop {string} value - Get/set the current value.
 * @prop {HTMLInputElement} input - The inner input, for focus() and selection.
 * @fires input|change - Native events bubble from the inner input, including
 *   after the clear button empties it.
 * @fires search-clear - After the clear button runs, for call sites that want the
 *   clear itself rather than "value became empty".
 * @slot [data-slot="leading"] - Replaces the default search glyph.
 * @slot [data-slot="trailing"] - Replaces the default clear control.
 * @note Glyphs are 16px at md, 12px at sm, sized by the component — pass a bare
 *   `icons.x()`. Swap either by passing a `<span data-slot="leading">` /
 *   `"trailing"` child; trailing is the clear button's glyph, and it still clears.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-search.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** Attributes handed straight to the inner <input>, not styling. */
// `aria-label` is deliberately not in here — it is emitted separately below,
// because it has a fallback and these do not.
const NATIVE = ['name', 'autocomplete', 'maxlength', 'inputmode'];

export class AppSearch extends HTMLElement {
  static get observedAttributes() {
    // `aria-label` listed explicitly: it left NATIVE but still has to trigger
    // a re-render when it changes.
    return ['size', 'state', 'loading', 'disabled', 'placeholder', 'aria-label', ...NATIVE];
  }

  /** Slotted icon markup, captured once — render() replaces innerHTML. */
  #slots = null;
  #wired = false;

  get value() { return this.input?.value ?? this.getAttribute('value') ?? ''; }
  set value(v) {
    if (this.input) { this.input.value = v; this.#syncHasValue(); }
    else this.setAttribute('value', v);
  }

  get input() { return this.querySelector('input'); }

  /** The host is not focusable — a `focus()` on it would silently do nothing,
   *  so hand it to the control inside. */
  focus(options) { this.input?.focus(options); }

  connectedCallback() {
    this.render();
    if (this.#wired) return;
    // Both listeners sit on the host and rely on bubbling, so a re-render that
    // replaces the input does not need them re-attached — and nothing outside
    // this element's own DOM is listened to, so there is nothing to tear down.
    this.addEventListener('input', () => this.#syncHasValue());
    this.addEventListener('click', (e) => {
      if (e.target.closest('.clear')) this.#clear();
    });
    this.#wired = true;
  }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    // A re-render replaces the <input>, which would drop what the user typed and
    // any focus with it. Carry both across.
    const prev = this.input;
    const value = prev ? prev.value : (this.getAttribute('value') ?? '');
    const refocus = prev && document.activeElement === prev;
    if (this.#slots === null) {
      this.#slots = {
        leading: this.querySelector('[data-slot="leading"]')?.innerHTML ?? null,
        trailing: this.querySelector('[data-slot="trailing"]')?.innerHTML ?? null,
      };
    }

    const size     = this.getAttribute('size') === 'sm' ? 'sm' : 'md';
    const loading  = this.hasAttribute('loading');
    const disabled = this.hasAttribute('disabled');
    const state    = disabled ? 'disabled' : loading ? 'loading'
                   : (this.getAttribute('state') || 'default');

    const native = NATIVE
      .filter((a) => this.hasAttribute(a))
      .map((a) => `${a}="${escAttr(this.getAttribute(a))}"`)
      .join(' ');

    // The field has no visible label, so it must carry one — an unnamed search
    // input is announced as "search, edit text" and nothing else. A caller who
    // set aria-label wins; otherwise the placeholder is the only description
    // of this box that exists, and naming it "Search agents" beats naming it
    // nothing. Placeholder-as-label is a poor pattern when it is a *choice* —
    // it disappears the moment someone types. As the floor under a missing
    // aria-label it is strictly better than the alternative.
    const placeholder = this.getAttribute('placeholder') ?? 'Search';
    const label = this.getAttribute('aria-label') || placeholder;

    this.innerHTML = `
      <div class="search-box is-${size} is-${state}" role="search">
        <span data-slot="leading">${this.#slots.leading ?? icons.search()}</span>
        <input type="search" ${native} aria-label="${escAttr(label)}" placeholder="${
          escAttr(placeholder)}"${disabled ? ' disabled' : ''}>
        ${loading ? '<span class="spinner" aria-hidden="true"></span>' : `
        <button type="button" class="clear" aria-label="Clear search"
          ${disabled ? 'disabled' : ''}>${this.#slots.trailing ?? icons.x()}</button>`}
      </div>`;

    // icons.js writes each glyph's size inline, which beats the sheet — the
    // 16/12 rules in app-search.css only apply once that is dropped.
    unsizeIcons(this);

    this.input.value = value;
    this.#syncHasValue();
    if (refocus) this.input.focus();
  }

  /** The clear's visibility is the `Has value` boolean — a class, so typing does
   *  not re-render. Loading and disabled hide it via their own rules. */
  #syncHasValue() {
    this.querySelector('.search-box')?.classList.toggle('has-value', this.value !== '');
  }

  #clear() {
    this.input.value = '';
    this.#syncHasValue();
    // Call sites listen to the native events, so a clear has to look like typing.
    for (const type of ['input', 'change']) {
      this.input.dispatchEvent(new Event(type, { bubbles: true }));
    }
    this.dispatchEvent(new CustomEvent('search-clear', { bubbles: true }));
    this.input.focus();
  }
}
customElements.define('app-search', AppSearch);
