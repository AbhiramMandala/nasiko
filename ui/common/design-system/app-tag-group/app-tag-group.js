/**
 * A row of `<app-tag>`s that behaves as one filter control.
 *
 * Ported from nasiko_ui `NasikoChipGroup`, and given the selection semantics
 * the Flutter version left to the caller: in `single` mode picking one tag
 * releases the rest; in `multiple` mode each tag toggles freely. Tags inside
 * the group are made `selectable` automatically. The row wraps by default;
 * `scrollable` keeps one line and scrolls horizontally instead.
 *
 * ArrowLeft/ArrowRight move focus across enabled tags with wrap-around;
 * Home/End jump; Enter/Space toggle (the tag's own handler).
 *
 * @element app-tag-group
 * @attr {string} mode - `multiple` (default) | `single` | `none` — `none` is a
 *   plain layout row with no selection behaviour (the Flutter default).
 * @attr {string} value - Selected tag values, space-separated. Reflected as the
 *   user picks. Each tag's value is its `value` attribute, falling back to its text.
 * @attr {boolean} scrollable - One line, horizontal scroll, instead of wrapping.
 * @attr {string} size - `md` (default) | `sm` — applied to every tag.
 * @attr {string} label - Accessible name of the `role="group"`.
 * @slot default - `<app-tag>` children.
 * @prop {string[]} value - Selected values.
 * @fires group-change - `{ value: string[] }` after a selection change.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-tag-group.css', import.meta.url));
import '../app-tag/app-tag.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppTagGroup extends HTMLElement {
  static get observedAttributes() { return ['mode', 'value', 'scrollable', 'size', 'label']; }

  #wired = false;

  get mode() { const m = this.getAttribute('mode'); return m === 'single' || m === 'none' ? m : 'multiple'; }
  get tags() { return [...this.querySelectorAll(':scope > app-tag')]; }
  #valueOf(tag) { return tag.getAttribute('value') ?? tag.textContent.trim(); }

  get value() { return this.tags.filter((t) => t.hasAttribute('selected')).map((t) => this.#valueOf(t)); }
  set value(v) { this.setAttribute('value', (Array.isArray(v) ? v : [v]).filter(Boolean).join(' ')); }

  connectedCallback() {
    this.setAttribute('role', 'group');
    this.#sync();
    if (this.#wired) return;
    this.#wired = true;

    this.addEventListener('tag-change', (e) => {
      const tag = e.target.closest('app-tag');
      if (!tag || tag.parentElement !== this || this.mode === 'none') return;
      e.stopPropagation();
      if (this.mode === 'single') {
        // Single: the picked tag stays on and releases the rest; un-picking the
        // current one is allowed (a filter can be cleared).
        if (e.detail.selected) for (const t of this.tags) if (t !== tag) t.removeAttribute('selected');
      }
      this.setAttribute('value', this.value.join(' '));
      this.dispatchEvent(new CustomEvent('group-change', { bubbles: true, detail: { value: this.value } }));
    });

    this.addEventListener('keydown', (e) => {
      const tags = this.tags.filter((t) => !t.hasAttribute('disabled'));
      if (!tags.length) return;
      const i = tags.indexOf(document.activeElement?.closest('app-tag'));
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tags.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const t = tags[((next % tags.length) + tags.length) % tags.length];
      (t.querySelector('[tabindex], button') ?? t).focus();
    });
  }

  attributeChangedCallback() { if (this.isConnected) this.#sync(); }

  #sync() {
    const label = this.getAttribute('label');
    label ? this.setAttribute('aria-label', label) : this.removeAttribute('aria-label');
    const size = this.getAttribute('size');
    const selected = new Set((this.getAttribute('value') ?? '').split(/\s+/).filter(Boolean));
    const selecting = this.mode !== 'none';
    for (const t of this.tags) {
      size ? t.setAttribute('size', size) : t.removeAttribute('size');
      if (selecting) t.setAttribute('selectable', '');
      if (this.hasAttribute('value') && selecting) {
        selected.has(this.#valueOf(t)) ? t.setAttribute('selected', '') : t.removeAttribute('selected');
      }
    }
  }
}
customElements.define('app-tag-group', AppTagGroup);
