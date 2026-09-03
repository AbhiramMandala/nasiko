/**
 * Segmented control — one exclusive choice from a set, shown as a joined strip.
 *
 * Native radios inside a `<fieldset>`, not buttons: the browser then owns
 * exclusivity, arrow-key movement between segments and the single tab stop, and
 * `:has(:checked)` carries the fill. It is also why the selection is announced
 * without a line of aria bookkeeping here. A button group would have needed all
 * four written by hand, and the four were the parts that got skipped.
 *
 * One shape: a bordered strip with hairline dividers and a brand-tinted
 * selection, which is the whole of the spec sheet. Any second look — strokeless
 * pills, a gapped chip row — is a different control and belongs in its own
 * component, not behind a `variant` here.
 *
 * Selection is the `value` attribute and it is reflected, so a user's click is
 * readable from markup and survives a re-render. Setting `value` syncs the
 * radios in place rather than re-rendering: a re-render replaces the focused
 * input, which loses the keyboard user mid-arrow-key.
 *
 * @element app-segmented-control
 * @attr {string} items - JSON array of `"value"` strings or
 *   `{value, label, disabled, title}` objects. Prefer the `items` property. The
 *   string form uses the label as the value, so `value` has to match it
 *   exactly, case included; pass objects when the two should differ.
 * @attr {string} value - Selected value. Reflected. A value matching no segment
 *   selects nothing, which is how "no choice yet" is expressed.
 * @attr {string} size - `md` (default, 32px) | `sm` (28px). The same step the
 *   other controls take: 28px box, 12px type, `--r-6` corners.
 * @attr {boolean} disabled - The whole control is inert. Individual segments
 *   carry their own `disabled` in `items`.
 * @attr {string} state - `hover` | `focus`, for rendering those states
 *   statically (spec review), same contract as `app-input`.
 * @attr {string} label|aria-label - Accessible name for the group, rendered as a
 *   visually-hidden `<legend>`. A segmented control is a question ("over what
 *   range?") whose answer is the only thing on screen, so the question has to be
 *   somewhere for a screen reader.
 * @prop {Array} items - Get/set the segments without hand-stringifying JSON.
 * @prop {string} value - Get/set the selection.
 * @fires change - Bubbles from the inner radio. Read `e.target.value`, or the
 *   host's `.value`, which is already updated.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-segmented-control.css', import.meta.url));
import { escAttr, escHtml } from '../../utils/escape.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export class AppSegmentedControl extends HTMLElement {
  static get observedAttributes() {
    return ['items', 'value', 'size', 'disabled', 'state', 'label', 'aria-label'];
  }

  /** Per-instance radio group name, so two controls on a page stay independent. */
  #name = `app-seg-${++uid}`;
  #initialized = false;
  #wired = false;

  get value() { return this.getAttribute('value') ?? ''; }
  set value(v) { this.setAttribute('value', v ?? ''); }

  set items(list) {
    this.setAttribute('items', JSON.stringify(Array.isArray(list) ? list : []));
  }

  get items() { return this.#items(); }

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.render();
    }
    // Wired once, on the host: the listener then survives every re-render of the
    // inner radios, which is what re-adding it per connect got wrong elsewhere.
    if (this.#wired) return;
    this.#wired = true;
    // Reflect the user's choice, so `value` is the single source of truth for
    // both a page reading it back and the next render.
    this.addEventListener('change', (e) => {
      if (e.target instanceof HTMLInputElement) this.setAttribute('value', e.target.value);
    });
  }

  attributeChangedCallback(name) {
    if (!this.isConnected || !this.#initialized) return;
    // `value` never re-renders — see the note in the header.
    if (name === 'value') this.#syncChecked();
    else this.render();
  }

  /** @returns {Array<{value: string, label: string, disabled?: boolean, title?: string}>} */
  #items() {
    const raw = this.getAttribute('items');
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Bad JSON renders an empty control rather than throwing out of the
      // upgrade and taking the rest of the page's module graph with it.
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((i) => (typeof i === 'string' || typeof i === 'number'
        ? { value: String(i), label: String(i) }
        : i && typeof i === 'object'
          ? { value: String(i.value ?? ''), label: String(i.label ?? i.value ?? ''),
              disabled: !!i.disabled, title: i.title }
          : null))
      .filter(Boolean);
  }

  #syncChecked() {
    const value = this.value;
    for (const input of this.querySelectorAll('input')) input.checked = input.value === value;
  }

  render() {
    const items = this.#items();
    const value = this.value;
    const label = this.getAttribute('label') || this.getAttribute('aria-label') || 'Options';
    // `disabled` on the fieldset disables every inner radio natively, so one
    // attribute covers the group and the CSS needs no separate group rule.
    this.innerHTML = `
      <fieldset${this.hasAttribute('disabled') ? ' disabled' : ''}>
        <legend class="sr-only">${escHtml(label)}</legend>
        ${items.map((item) => `
          <label class="seg"${item.title ? ` title="${escAttr(item.title)}"` : ''}>
            <input type="radio" name="${escAttr(this.#name)}" value="${escAttr(item.value)}"
              ${item.value === value ? 'checked' : ''}${item.disabled ? ' disabled' : ''}>
            <span>${escHtml(item.label)}</span>
          </label>`).join('')}
      </fieldset>`;
  }
}

customElements.define('app-segmented-control', AppSegmentedControl);
