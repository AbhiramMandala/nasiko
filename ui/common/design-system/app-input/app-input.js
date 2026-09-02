/**
 * Text input with label, hint, character count and leading/trailing icon slots.
 *
 * Matched to Figma "Design System V2" › ↳Input › Input (node 4190:129). Figma
 * models State × Size, where State is one axis of seven: default, hover, focus,
 * disabled, error, success, read-only. Hover and focus are real pseudo-classes
 * here; the `state` attribute also accepts them so the design-system page and
 * the parity test can render them statically.
 *
 * @element app-input
 * @attr {string} size - `md` (default, 32px) | `sm` (28px)
 * @attr {string} state - `error` | `success` | `read-only` | `hover` | `focus`.
 *   Omit for the default state. `disabled`/`readonly` below are the real
 *   attributes; `state` is for the two visual-only statuses plus the overrides.
 * @attr {string} label - Label above the box. Omit for no label.
 * @attr {string} hint - Helper line below the box. Turns red in `state="error"`.
 * @attr {string} count - Right-aligned counter in the hint row, e.g. `12/100`.
 * @attr {boolean} required - Renders the red `*` before the label.
 * @attr {boolean} reveal - On `type="password"`, adds a trailing show/hide button
 *   that flips the inner input between `password` and `text`. Opt-in rather than
 *   automatic: a field holding a *stored* secret (an API key already on the
 *   server) is not always one the viewer should be able to unmask, so the call
 *   site decides. Ignored on every other type.
 * @attr {boolean} disabled
 * @attr {boolean} readonly - Same paint as `state="read-only"`.
 * @attr {string} type - `text` (default) | `password` | `email` | `number` |
 *   `search` | `url` | `tel` | `date`. Forwarded verbatim to the inner `<input>`.
 * @attr {string} name|placeholder|value|autocomplete|maxlength|inputmode|min|max|step|pattern|list|spellcheck|aria-label
 * @cssprop --input-bg - Resting fill. Default `--bg-base` (white). Set it on the
 *   *surface*, not the field: the fill depends on the plane the field sits on, and
 *   one declaration on a container covers every field inside it. read-only and
 *   disabled keep their own fills — those are state signals, not surface fit.
 *   Forwarded verbatim to the inner `<input>`.
 * @prop {string} value - Get/set the current value.
 * @prop {HTMLInputElement} input - The inner input, for focus() and validation.
 * @fires input|change - Native events bubble from the inner input.
 * @slot [data-slot="leading"] - Glyph or control before the input.
 * @slot [data-slot="trailing"] - Glyph or control after the input.
 * @note Icons go in `<span data-slot="leading">` / `data-slot="trailing"`
 *       children; the component sizes them — 16px at size md, 12px at sm — so
 *       pass a bare `icons.search()` and don't set a size at the call site.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-input.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** Attributes handed straight to the inner <input>, not styling.
 *  `aria-label` is in here because the inner input is the thing a screen reader
 *  names, and a two-column form (label left, field right) can't reach it with
 *  `<label for>` — the id belongs to the input this component generates. */
const NATIVE = ['type', 'name', 'placeholder', 'value', 'autocomplete', 'maxlength',
                'inputmode', 'min', 'max', 'step', 'pattern', 'list', 'spellcheck',
                'aria-label'];

let uid = 0;

export class AppInput extends HTMLElement {
  static get observedAttributes() {
    return ['size', 'state', 'label', 'hint', 'count', 'required', 'disabled', 'readonly',
            'reveal', ...NATIVE];
  }

  #id = `app-input-${++uid}`;
  /** Slotted icon markup, captured once — render() replaces innerHTML. */
  #slots = null;
  /** Whether the reveal toggle is currently unmasking the value. Lives on the
   *  element, not in the DOM, so a re-render (a `hint`/`state` flip from a
   *  field error) doesn't silently re-mask a field the user asked to see. */
  #revealed = false;

  get value() { return this.input?.value ?? this.getAttribute('value') ?? ''; }
  set value(v) { if (this.input) this.input.value = v; else this.setAttribute('value', v); }
  get input() { return this.querySelector('input'); }

  /** The host is not focusable — a `focus()` on it would silently do nothing,
   *  so hand it to the control inside. */
  focus(options) { this.input?.focus(options); }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  render() {
    // A re-render replaces the <input>, which would drop what the user typed and
    // any focus with it. Carry both across.
    const prev = this.input;
    const value = prev ? prev.value : (this.getAttribute('value') ?? '');
    const refocus = prev && document.activeElement === prev;
    // Caret too — a re-render mid-edit (a `hint`/`state` flip from a field error
    // clearing, say) would otherwise dump the cursor at the end of the value.
    // `selectionStart` is null on types that don't support it (number, email).
    const caret = refocus ? [prev.selectionStart, prev.selectionEnd] : null;
    if (this.#slots === null) {
      this.#slots = {
        leading: this.querySelector('[data-slot="leading"]')?.outerHTML ?? '',
        trailing: this.querySelector('[data-slot="trailing"]')?.outerHTML ?? '',
      };
    }

    const size     = this.getAttribute('size') === 'sm' ? 'sm' : 'md';
    const readonly = this.hasAttribute('readonly') || this.getAttribute('state') === 'read-only';
    const disabled = this.hasAttribute('disabled');
    const state    = disabled ? 'disabled' : readonly ? 'read-only'
                   : (this.getAttribute('state') || 'default');
    const label    = this.getAttribute('label');
    const hint     = this.getAttribute('hint');
    const count    = this.getAttribute('count');

    // `type` is emitted separately because the reveal toggle overrides it: the
    // attribute still reads `password` while the input is showing `text`, so
    // the call site's own markup never has to change for a state the component
    // owns. Everything else is forwarded verbatim.
    const revealable = this.hasAttribute('reveal')
      && this.getAttribute('type') === 'password' && !disabled && !readonly;
    if (!revealable) this.#revealed = false;
    const type = revealable && this.#revealed ? 'text' : this.getAttribute('type');

    const native = NATIVE
      .filter((a) => a !== 'value' && a !== 'type' && this.hasAttribute(a))
      .map((a) => `${a}="${escAttr(this.getAttribute(a))}"`)
      .join(' ');

    this.innerHTML = `
      <div class="field is-${size} is-${state}">
        ${label === null ? '' : `<label class="label-row" for="${this.#id}">${
          this.hasAttribute('required') ? '<span class="req">*</span>' : ''}${escHtml(label)}</label>`}
        <div class="input-box">
          ${this.#slots.leading}
          <input id="${this.#id}"${type === null ? '' : ` type="${escAttr(type)}"`} ${
            native}${disabled ? ' disabled' : ''}${
            readonly ? ' readonly' : ''}${this.hasAttribute('required') ? ' required' : ''}>
          ${this.#slots.trailing}
          ${revealable ? this.#revealButton() : ''}
        </div>
        ${hint === null && count === null ? '' : `<div class="hint-row">
          <span class="hint">${escHtml(hint)}</span>
          ${count === null ? '' : `<span class="count">${escHtml(count)}</span>`}
        </div>`}
      </div>`;

    // Slotted glyphs arrive from icons.js with their size inline, which beats
    // the sheet — so the 16/12 rules in app-input.css only apply once this has
    // dropped it. Call sites pass a bare `icons.search()` and shouldn't have to
    // know the field's size.
    unsizeIcons(this);

    this.#wireReveal();

    this.input.value = value;
    if (refocus) {
      this.input.focus();
      if (caret?.[0] != null) this.input.setSelectionRange(caret[0], caret[1]);
    }
  }

  /** `type="button"`: app-input is used inside real <form>s (the registry admin
   *  login, the MCP connector forms), where a bare <button> defaults to submit
   *  and unmasking the password would post the form. */
  #revealButton() {
    return `<button type="button" class="reveal" data-reveal
      aria-pressed="${this.#revealed}"
      aria-label="${this.#revealed ? 'Hide password' : 'Show password'}">${this.#revealed ? icons.eyeOff() : icons.eye()}</button>`;
  }

  /** Flips the mask in place instead of re-rendering. A re-render would replace
   *  the button mid-click and drop focus to the body, which is exactly the
   *  keyboard user this control exists for. */
  #wireReveal() {
    const toggle = this.querySelector('[data-reveal]');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      this.#revealed = !this.#revealed;
      this.input.type = this.#revealed ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(this.#revealed));
      toggle.setAttribute('aria-label', this.#revealed ? 'Hide password' : 'Show password');
      toggle.innerHTML = this.#revealed ? icons.eyeOff() : icons.eye();
      unsizeIcons(toggle);
      // Focus goes back to the field with the caret at the end — the point of
      // the toggle is to check what you just typed and carry on typing.
      const end = this.input.value.length;
      this.input.focus();
      this.input.setSelectionRange(end, end);
    });
  }
}
customElements.define('app-input', AppInput);
