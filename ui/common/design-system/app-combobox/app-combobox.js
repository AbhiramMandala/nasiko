/**
 * Typeahead: a search box that suggests options as you type and reports the pick.
 *
 * The former `<auto-complete>`, renamed to the name every design system uses
 * and rebuilt on two things this codebase already has: the box is a real
 * `<app-search>` (same 36/28px field, glyph, clear button and states), and the
 * suggestions come from a **registered data source** — `data-fn` names a key in
 * `core/data-sources.js` — never a `window.*` global. The listbox is a top-layer
 * popover placed by `utils/anchor.js`, so it escapes `overflow: hidden` and
 * paints above an open dialog.
 *
 * Three ways to supply options, in precedence order:
 *  1. `.filterFn = (query) => options | Promise<options>` — set from JS.
 *  2. `data-fn="name"` — a registered source with the same signature.
 *  3. `options='[…]'` — a static list, filtered client-side on label / value.
 * An option is a string or `{ label, value, description? }`.
 *
 * Free text is allowed: the box keeps whatever was typed. `value` is the text;
 * `combobox-select` carries the chosen option's `value`. WAI-ARIA combobox
 * pattern (`role="combobox"` on the input, `aria-activedescendant` tracking the
 * highlighted option, `aria-expanded`), ArrowUp/Down rove, Enter picks, Escape
 * closes, clicking outside closes.
 *
 * @element app-combobox
 * @attr {string} data-fn - Registered data-source name: `(query) => options`.
 * @attr {string} options - JSON array of `"value"` or `{ label, value, description }`,
 *   filtered client-side when there is no `data-fn` / `filterFn`.
 * @attr {string} placeholder - Input placeholder (default: `Search`).
 * @attr {string} aria-label - Accessible name of the input. Falls back to the placeholder.
 * @attr {string} size - `md` (default, 36px) | `sm` (28px) — app-search's sizes.
 * @attr {boolean} disabled
 * @attr {number} min-chars - Characters before suggestions are fetched (default 0).
 * @attr {string} empty-text - Shown when nothing matches (default: `No results`).
 * @attr {string} name - Forwarded to the inner input for form submit.
 * @attr {string} value - Initial text.
 * @attr {string} filter-function - (deprecated: use data-fn) Name of a `window[fn]`.
 * @prop {string} value - Get/set the text in the box.
 * @prop {function} filterFn - Set an options function from JS.
 * @prop {HTMLInputElement} input - The inner input.
 * @fires combobox-select - `{ value, option }` when an option is picked. Bubbles.
 * @fires input - Native, bubbles from the inner input.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-combobox.css', import.meta.url));
import { icons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import { positionAnchored, followAnchor, supportsPopover } from '../../utils/anchor.js';
import { readAttr, emit, warnOnce } from '../../utils/deprecate.js';
import { resolveOptional } from '../../core/data-sources.js';
import '../app-search/app-search.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;
const FORWARD = ['placeholder', 'aria-label', 'size', 'disabled', 'name', 'value'];

export class AppCombobox extends HTMLElement {
  static get observedAttributes() {
    return ['data-fn', 'options', 'min-chars', 'empty-text', 'filter-function', ...FORWARD];
  }

  #id = `app-combobox-${++uid}`;
  #built = false;
  #search = null;
  #list = null;
  #filterFn = null;
  #options = [];
  #active = -1;
  #open = false;
  #seq = 0;
  #unfollow = null;
  #onDocClick = (e) => { if (!this.contains(e.target)) this.#close(); };

  get input() { return this.#search?.input ?? null; }
  get value() { return this.#search?.value ?? this.getAttribute('value') ?? ''; }
  set value(v) { if (this.#search) this.#search.value = v ?? ''; else this.setAttribute('value', v ?? ''); }
  set filterFn(fn) { this.#filterFn = typeof fn === 'function' ? fn : null; }

  connectedCallback() { this.#build(); }
  disconnectedCallback() { this.#close(); }

  attributeChangedCallback(name, _o, v) {
    if (!this.#built) return;
    if (FORWARD.includes(name)) {
      v === null ? this.#search.removeAttribute(name) : this.#search.setAttribute(name, v);
      if (name === 'disabled' && v !== null) this.#close();
    }
    if (name === 'empty-text' && this.#open) this.#renderList();
  }

  /** Resolve the options function: JS property → registry (`data-fn`) → static list. */
  #source() {
    if (this.#filterFn) return this.#filterFn;
    // `filter-function` (deprecated) resolves through the same registry lookup:
    // resolveOptional accepts a legacy window global and warns about it itself.
    const key = readAttr(this, 'data-fn', 'filter-function');
    if (key) {
      const fn = resolveOptional(key);
      if (fn) return fn;
      warnOnce(`${this.#id}.data-fn`, `<app-combobox data-fn="${key}"> names a data source that is not registered.`);
    }
    if (this.hasAttribute('options')) {
      let list = [];
      try { list = JSON.parse(this.getAttribute('options') || '[]'); } catch { console.warn('[app-combobox] invalid `options` JSON'); }
      return (q) => {
        const needle = q.toLowerCase();
        return (Array.isArray(list) ? list : []).filter((o) => {
          const label = typeof o === 'string' ? o : `${o.label ?? ''} ${o.value ?? ''}`;
          return !needle || label.toLowerCase().includes(needle);
        });
      };
    }
    return null;
  }

  #build() {
    if (this.#built) return;
    this.#built = true;

    const search = document.createElement('app-search');
    for (const a of FORWARD) if (this.hasAttribute(a)) search.setAttribute(a, this.getAttribute(a));
    if (!this.hasAttribute('placeholder')) search.setAttribute('placeholder', 'Search');
    const list = document.createElement('ul');
    list.className = 'app-combobox-list';
    list.id = `${this.#id}-list`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    if (supportsPopover) list.popover = 'manual';
    this.replaceChildren(search, list);
    this.#search = search;
    this.#list = list;

    // The inner input gets the combobox role once app-search has rendered it.
    const wire = () => {
      const input = this.input;
      if (!input || input.dataset.combobox) return;
      input.dataset.combobox = '1';
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-haspopup', 'listbox');
      input.setAttribute('aria-controls', list.id);
      input.setAttribute('aria-expanded', String(this.#open));
      input.setAttribute('autocomplete', 'off');
    };
    wire();
    // app-search re-renders on attribute change; re-apply the role each time.
    new MutationObserver(wire).observe(search, { childList: true, subtree: true });

    this.addEventListener('input', (e) => { if (e.target === this.input) this.#query(); });
    this.addEventListener('focusin', (e) => { if (e.target === this.input) this.#query(); });
    this.addEventListener('keydown', (e) => {
      if (e.target !== this.input) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!this.#open) return this.#query();
        const n = this.#options.length;
        if (!n) return;
        this.#active = (this.#active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        this.#paintActive();
      } else if (e.key === 'Enter') {
        if (!this.#open) return;
        e.preventDefault();
        this.#pick(this.#active >= 0 ? this.#active : 0);
      } else if (e.key === 'Escape' && this.#open) {
        e.preventDefault();
        this.#close();
      }
    });
    list.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
    list.addEventListener('click', (e) => {
      const li = e.target.closest('[role="option"]');
      if (li) this.#pick(Number(li.dataset.index));
    });
  }

  async #query() {
    if (this.hasAttribute('disabled')) return;
    const fn = this.#source();
    if (!fn) return this.#close();
    const q = this.value.trim();
    if (q.length < (Number(this.getAttribute('min-chars')) || 0)) return this.#close();
    const seq = ++this.#seq;
    // The spinner only appears for a slow source. Flipping `loading` re-renders
    // app-search's input, so doing it on every keystroke would rebuild the box
    // under the caret twice per character.
    const slow = setTimeout(() => this.#search.setAttribute('loading', ''), 150);
    try {
      const res = await Promise.resolve(fn(q));
      if (seq !== this.#seq) return; // a newer query superseded this one
      this.#options = Array.isArray(res) ? res : [];
    } catch (err) {
      console.error('[app-combobox] options source threw:', err);
      this.#options = [];
    } finally {
      clearTimeout(slow);
      if (seq === this.#seq && this.#search.hasAttribute('loading')) this.#search.removeAttribute('loading');
    }
    this.#active = -1;
    this.#renderList();
    this.#openList();
  }

  #renderList() {
    const l = this.#list;
    if (!this.#options.length) {
      l.innerHTML = `<li class="empty" role="presentation">${escHtml(this.getAttribute('empty-text') || 'No results')}</li>`;
      return;
    }
    l.innerHTML = this.#options.map((o, i) => {
      const label = typeof o === 'string' ? o : (o.label ?? o.value ?? '');
      const desc = typeof o === 'object' ? (o.description ?? o.subtitle ?? null) : null;
      return `<li class="option" role="option" id="${this.#id}-opt-${i}" data-index="${i}" aria-selected="false">
        <span class="option-label">${escHtml(label)}</span>
        ${desc ? `<span class="option-desc">${escHtml(desc)}</span>` : ''}
      </li>`;
    }).join('');
  }

  #paintActive() {
    const input = this.input;
    this.#list.querySelectorAll('[role="option"]').forEach((li, i) => {
      const on = i === this.#active;
      li.classList.toggle('is-active', on);
      li.setAttribute('aria-selected', String(on));
      if (on) { li.scrollIntoView({ block: 'nearest' }); input?.setAttribute('aria-activedescendant', li.id); }
    });
    if (this.#active < 0) input?.removeAttribute('aria-activedescendant');
  }

  #place() {
    positionAnchored(this.#list, this.#search, { side: 'bottom', align: 'start', gap: 4 });
    this.#list.style.minWidth = `${this.#search.getBoundingClientRect().width}px`;
  }

  #openList() {
    if (!this.#open) {
      this.#open = true;
      this.#list.hidden = false;
      if (supportsPopover) this.#list.showPopover();
      this.#unfollow = followAnchor(() => this.#place());
      document.addEventListener('click', this.#onDocClick, true);
      this.input?.setAttribute('aria-expanded', 'true');
    }
    this.#place();
    this.#paintActive();
  }

  #close() {
    if (!this.#open) return;
    this.#open = false;
    this.#unfollow?.(); this.#unfollow = null;
    document.removeEventListener('click', this.#onDocClick, true);
    if (supportsPopover && this.#list.matches(':popover-open')) this.#list.hidePopover();
    this.#list.hidden = true;
    this.input?.setAttribute('aria-expanded', 'false');
    this.input?.removeAttribute('aria-activedescendant');
  }

  #pick(i) {
    const option = this.#options[i];
    if (option === undefined) return;
    const label = typeof option === 'string' ? option : (option.label ?? option.value ?? '');
    const value = typeof option === 'string' ? option : (option.value ?? option.label ?? '');
    this.value = label;
    this.#close();
    emit(this, 'combobox-select', { value, option }, { legacy: 'option-selected' });
  }
}
customElements.define('app-combobox', AppCombobox);

/** Deprecated alias: `<auto-complete>` is `<app-combobox>`. Logs once; removed next release. */
class AutoCompleteAlias extends AppCombobox {
  connectedCallback() {
    warnOnce('auto-complete', '<auto-complete> is deprecated — use <app-combobox>. `filter-function` (a window global) is now `data-fn` (a registered data source) or the `filterFn` property; `option-selected` is now `combobox-select`.');
    super.connectedCallback();
  }
}
if (!customElements.get('auto-complete')) customElements.define('auto-complete', AutoCompleteAlias);
