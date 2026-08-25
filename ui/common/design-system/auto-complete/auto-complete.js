/**
 * Typeahead text input that calls a window function for suggestions and fires on selection.
 *
 * @element auto-complete
 * @attr {string} placeholder - Input placeholder text
 * @attr {string} aria-label - Accessible label for the input
 * @attr {string} filter-function - Name of `window[fn](query)` returning `[{ label, value }]`
 * @fires option-selected - Option chosen; `detail: { value, option }` — bubbles
 */
import { icons } from '../../utils/icons.js';
import styles from './auto-complete.css' with { type: 'css' };
import { DropdownController } from '../../core/dropdown-controller.js';
import { escAttr, escHtml } from '../../utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

export default class AutoComplete extends HTMLElement {
  #initialized = false;
  #listboxId = `auto-complete-listbox-${++uid}`;
  #inputEl = null;
  #dropdownEl = null;
  #dd = null;              // DropdownController
  #filteredOptions = [];
  #filterFn = null;
  #onDocumentClick = (e) => {
    if (!this.contains(e.target)) this.#close();
  };

  /** Close plus the combobox bookkeeping the controller doesn't know about. */
  #close() {
    this.#dd?.close();
    this.#inputEl?.removeAttribute('aria-activedescendant');
  }

  /** Point aria-activedescendant at the highlighted option, so a screen reader
   *  tracks arrow-key movement through a listbox the DOM focus never enters. */
  #syncActiveDescendant() {
    const idx = this.#dd?.selIdx ?? -1;
    if (idx >= 0) this.#inputEl.setAttribute('aria-activedescendant', `${this.#listboxId}-opt-${idx}`);
    else this.#inputEl.removeAttribute('aria-activedescendant');
  }

  static get observedAttributes() {
    return ['placeholder', 'aria-label', 'filter-function'];
  }

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#render();
      this.#setupEvents();
      this.#resolveFilterFn();
    }
    // Re-registered on every connect because disconnect removes it — inside the
    // one-time block above, the first re-parenting would lose outside-click
    // close permanently (the firstConnected/connected asymmetry AGENTS.md names).
    document.addEventListener('click', this.#onDocumentClick);
  }

  disconnectedCallback() {
    document.removeEventListener('click', this.#onDocumentClick);
  }

  attributeChangedCallback(name, _old, val) {
    if (!this.#initialized) return;
    if (name === 'placeholder')      this.#inputEl.placeholder = val || 'Search...';
    if (name === 'aria-label')       this.#inputEl.setAttribute('aria-label', val || 'Search');
    if (name === 'filter-function')  this.#resolveFilterFn();
  }

  #render() {
    this.innerHTML = `
      <div class="ac-container">
        <div class="ac-input-wrapper">
          <input type="text"
                 class="ac-input"
                 placeholder="${escAttr(this.getAttribute('placeholder') || 'Search...')}"
                 aria-label="${escAttr(this.getAttribute('aria-label') || 'Search')}"
                 aria-expanded="false"
                 aria-haspopup="listbox"
                 aria-autocomplete="list"
                 aria-controls="${this.#listboxId}"
                 role="combobox" />
          <div class="ac-icon">
            ${icons.search('', 16)}
          </div>
        </div>
        <ul class="ac-dropdown hidden" id="${this.#listboxId}" role="listbox" aria-hidden="true"></ul>
      </div>
    `;

    this.#inputEl    = this.querySelector('.ac-input');
    this.#dropdownEl = this.querySelector('.ac-dropdown');
    this.#dd         = new DropdownController(this.#dropdownEl, this.#inputEl, '.ac-option');
  }

  set filterFn(fn) { this.#filterFn = fn; }

  #resolveFilterFn() {
    const name = this.getAttribute('filter-function');
    if (!name) {
      this.#filterFn = null;
      return;
    }
    if (typeof globalThis[name] === 'function') {
      this.#filterFn = globalThis[name];
    } else {
      this.#filterFn = null;
      // Module scripts execute in order; retry after current queue drains
      setTimeout(() => {
        if (typeof globalThis[name] === 'function') this.#filterFn = globalThis[name];
        else console.error('AutoComplete: filter function not found:', name);
      }, 0);
    }
  }

  #setupEvents() {
    this.#inputEl.addEventListener('input', () => this.#filterOptions());

    this.#inputEl.addEventListener('focus', async () => {
      if (!this.#filterFn) this.#resolveFilterFn();
      if (!this.#filterFn) return;
      try {
        this.#filteredOptions = await Promise.resolve(this.#filterFn(this.#inputEl.value.trim())) || [];
        this.#renderDropdown();
        if (this.#filteredOptions.length > 0) this.#dd.open();
      } catch (err) {
        console.error('AutoComplete: error on focus:', err);
      }
    });

    // Named, stored handler. An inline closure here was not merely un-removed,
    // it was un-removable: nothing held a reference to it, so every auto-complete
    // ever attached stayed subscribed to document clicks for the life of the
    // page, retaining the element and its option list.
    document.addEventListener('click', this.#onDocumentClick);

    this.#inputEl.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); this.#navigate(1);  break;
        case 'ArrowUp':   e.preventDefault(); this.#navigate(-1); break;
        case 'Enter':     e.preventDefault(); this.#selectOption(); break;
        case 'Escape':
          if (this.#dd.isOpen) { e.preventDefault(); this.#close(); }
          break;
      }
    });
  }

  async #filterOptions() {
    if (!this.#filterFn) this.#resolveFilterFn();
    if (!this.#filterFn) { this.#filteredOptions = []; this.#close(); return; }
    try {
      this.#filteredOptions = await Promise.resolve(this.#filterFn(this.#inputEl.value.trim())) || [];
      this.#renderDropdown();
      if (this.#filteredOptions.length > 0) this.#dd.open(); else this.#close();
    } catch (err) {
      console.error('AutoComplete: error filtering:', err);
    }
  }

  #renderDropdown() {
    if (this.#filteredOptions.length === 0) {
      this.#dropdownEl.innerHTML = `
        <div class="ac-empty">
          ${icons.faceFrown('ac-empty-icon')}
          <span class="ac-empty-text">No results found</span>
        </div>
      `;
    } else {
      this.#dropdownEl.innerHTML = this.#filteredOptions
        .map((option, index) => {
          const label    = typeof option === 'string' ? option : option.label || option;
          const subtitle = typeof option === 'object' ? option.subtitle : null;
          return `
            <li class="ac-option" id="${this.#listboxId}-opt-${index}" data-index="${index}" role="option" aria-selected="false">
              <div class="ac-option-body">
                <div class="ac-option-text">${escHtml(label)}</div>
                ${subtitle ? `<div class="ac-option-subtitle">${escHtml(subtitle)}</div>` : ''}
              </div>
            </li>
          `;
        })
        .join('');
    }
    this.#dd.bindItems(this.#filteredOptions.length, () => this.#selectOption());
  }

  async #navigate(dir) {
    if (!this.#filterFn) this.#resolveFilterFn();
    if (!this.#dd.isOpen) {
      if (!this.#filterFn) return;
      try {
        this.#filteredOptions = await Promise.resolve(this.#filterFn(this.#inputEl.value.trim())) || [];
        this.#renderDropdown();
        if (this.#filteredOptions.length > 0) this.#dd.open(); else return;
      } catch (err) {
        console.error('AutoComplete: error navigating:', err);
        return;
      }
    }
    this.#dd.navigate(dir);
    this.#syncActiveDescendant();
  }

  #selectOption() {
    let idx = this.#dd.selIdx;
    if (idx === -1 && this.#filteredOptions.length > 0) idx = 0;
    if (idx < 0 || idx >= this.#filteredOptions.length) return;

    const option  = this.#filteredOptions[idx];
    const display = typeof option === 'string' ? option : option.label || option;
    const value   = typeof option === 'string' ? option : option.value || option;

    this.#inputEl.value = display;
    this.dispatchEvent(new CustomEvent('option-selected', { bubbles: true, detail: { value, option } }));
    this.#close();
  }

  set value(v) { this.#inputEl.value = v; }
  get value()  { return this.#inputEl.value; }

}

customElements.define('auto-complete', AutoComplete);
