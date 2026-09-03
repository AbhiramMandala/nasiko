/**
 * Multi-line text input with the same label / hint / count / state contract as `<app-input>`.
 *
 * The plain multi-line field the design system was missing: `<app-input>` is
 * single-line, and `<app-chatbox>` is the chat composer (attachments, send,
 * token estimate — nasiko_ui's `NasikoTextBox`). This is the one for a
 * description, a system prompt, a JSON blob: a box that grows with its
 * content between `rows` and `max-rows`, wearing the input's exact border,
 * radius, focus ring and error/success/read-only paint.
 *
 * @element app-textarea
 * @attr {string} state - `error` | `success` | `read-only` | `hover` | `focus`.
 *   Omit for the default state.
 * @attr {string} label - Label above the box.
 * @attr {string} hint - Helper line below the box. Turns red in `state="error"`.
 * @attr {string} count - Right-aligned counter in the hint row, e.g. `120/500`.
 *   With `maxlength` set and no `count`, the counter is derived live.
 * @attr {boolean} required - Red `*` before the label.
 * @attr {number} rows - Visible lines at rest (default 3).
 * @attr {number} max-rows - Growth ceiling; beyond it the box scrolls. Omit for
 *   no ceiling.
 * @attr {boolean} disabled
 * @attr {boolean} readonly - Same paint as `state="read-only"`.
 * @attr {boolean} resizable - Shows the native corner grip. Off by default —
 *   auto-grow covers the common case and a grip fights it.
 * @attr {string} name|placeholder|value|maxlength|spellcheck|aria-label - Forwarded
 *   to the inner `<textarea>`.
 * @prop {string} value - Get/set the text. Setting does not fire events.
 * @prop {HTMLTextAreaElement} input - The inner textarea.
 * @fires input - Bubbles from the inner textarea.
 * @fires change - Bubbles from the inner textarea.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-textarea.css', import.meta.url));
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const FORWARD = ['name', 'placeholder', 'maxlength', 'spellcheck', 'aria-label'];
let uid = 0;

export class AppTextarea extends HTMLElement {
  static get observedAttributes() {
    return ['state', 'label', 'hint', 'count', 'required', 'rows', 'max-rows', 'disabled',
            'readonly', 'resizable', 'value', ...FORWARD];
  }

  #id = `app-textarea-${++uid}`;
  #wired = false;

  get input() { return this.querySelector('textarea'); }
  get value() { return this.input ? this.input.value : (this.getAttribute('value') ?? ''); }
  set value(v) {
    if (this.input) { this.input.value = v ?? ''; this.#grow(); this.#count(); }
    else this.setAttribute('value', v ?? '');
  }

  connectedCallback() {
    this.render();
    if (this.#wired) return;
    this.#wired = true;
    this.addEventListener('input', () => { this.#grow(); this.#count(); });
  }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    // `value` set from outside mid-edit should not rebuild the box under the
    // caret; only the text moves.
    if (name === 'value' && this.input) { this.value = this.getAttribute('value') ?? ''; return; }
    this.render();
  }

  render() {
    const prev = this.input;
    const refocus = prev && document.activeElement === prev;
    const kept = prev ? prev.value : (this.getAttribute('value') ?? '');

    const disabled = this.hasAttribute('disabled');
    const readonly = this.hasAttribute('readonly');
    const state = disabled ? 'disabled' : readonly ? 'read-only' : (this.getAttribute('state') || 'default');
    const label = this.getAttribute('label');
    const hint = this.getAttribute('hint');
    const rows = Math.max(1, Number(this.getAttribute('rows')) || 3);
    const forwarded = FORWARD.filter((a) => this.hasAttribute(a))
      .map((a) => ` ${a}="${escAttr(this.getAttribute(a))}"`).join('');

    this.innerHTML = `
      <div class="field is-${state}${this.hasAttribute('resizable') ? ' is-resizable' : ''}">
        ${label === null ? '' : `<label class="label-row" for="${this.#id}">${escHtml(label)}${
          this.hasAttribute('required') ? '<span class="req"> *</span>' : ''}</label>`}
        <div class="box">
          <textarea id="${this.#id}" rows="${rows}"${forwarded}${disabled ? ' disabled' : ''}${
            readonly ? ' readonly' : ''}${state === 'error' ? ' aria-invalid="true"' : ''}></textarea>
        </div>
        <div class="hint-row"${hint === null && !this.#hasCount() ? ' hidden' : ''}>
          <span class="hint">${hint === null ? '' : escHtml(hint)}</span>
          <span class="count"></span>
        </div>
      </div>`;

    this.input.value = kept;
    this.#grow();
    this.#count();
    if (refocus) this.input.focus();
  }

  #hasCount() { return this.hasAttribute('count') || this.hasAttribute('maxlength'); }

  #count() {
    const out = this.querySelector('.count');
    if (!out) return;
    const fixed = this.getAttribute('count');
    if (fixed !== null) { out.textContent = fixed; return; }
    const max = this.getAttribute('maxlength');
    out.textContent = max ? `${this.input.value.length}/${max}` : '';
  }

  /** Auto-grow between `rows` and `max-rows` by measuring scrollHeight. */
  #grow() {
    const ta = this.input;
    if (!ta) return;
    const maxRows = Number(this.getAttribute('max-rows')) || 0;
    ta.style.height = 'auto';
    // border-box (global reset), so scrollHeight — content + padding — is the
    // height to set; the box's border lives on the wrapper, not the textarea.
    let h = ta.scrollHeight;
    if (maxRows) {
      const cs = getComputedStyle(ta);
      const cap = maxRows * (parseFloat(cs.lineHeight) || 18)
        + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      ta.style.overflowY = h > cap ? 'auto' : 'hidden';
      h = Math.min(h, cap);
    } else {
      ta.style.overflowY = 'hidden';
    }
    ta.style.height = `${h}px`;
  }
}
customElements.define('app-textarea', AppTextarea);
