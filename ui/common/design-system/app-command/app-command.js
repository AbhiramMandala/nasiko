/**
 * Command palette: a search input over grouped, filterable commands.
 *
 * Ported from nasiko_ui `showNasikoCommandPalette`. Top-aligned modal
 * `<dialog>`; filtering is live and case-insensitive with the same scoring as
 * the Flutter side — label prefix beats word-boundary prefix beats substring or
 * keyword match — and groups whose items are all filtered out disappear.
 * ArrowUp/Down move the highlight across every visible item (wrapping), Enter
 * runs it, Escape closes. The selected command's event fires *after* the
 * palette has closed, so a handler can navigate freely.
 *
 * `<app-nav-search>` (features/) is the product's global entity search — it
 * fetches agents, workflows and sessions from the control plane. This is the
 * design-system primitive underneath that kind of surface: static commands,
 * no data access, embeddable in any page. `<app-kbd>` renders the shortcuts.
 *
 * @element app-command
 * @attr {string} groups - JSON array of `{ label, items: [{ id, label, icon?, keywords?, shortcut? }] }`.
 *   `icon` is a key of `utils/icons.js`; `shortcut` is an `<app-kbd>` keys string.
 * @attr {string} placeholder - Search input placeholder (default: `Type a command…`).
 * @attr {string} empty-text - Shown when nothing matches (default: `No results`).
 * @attr {boolean} open - Whether the palette is showing. Reflected.
 * @attr {string} hotkey - Global shortcut that opens it, e.g. `mod+k` (`mod` is ⌘ on
 *   Mac, Ctrl elsewhere). Omit for none.
 * @prop {string} query - The current search text.
 * @fires command-select - `{ id }` after the palette has closed. Bubbles.
 * @fires command-toggle - `{ open }` after every open/close. Bubbles.
 * @method show() / hide()
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-command.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import '../app-kbd/app-kbd.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;

/** Score a query against one item: 3 label prefix, 2 word prefix, 1 substring/keyword, 0 none. */
export function scoreCommand(item, q) {
  if (!q) return 1;
  const label = String(item.label ?? '').toLowerCase();
  if (label.startsWith(q)) return 3;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  if (label.includes(q)) return 1;
  if ((item.keywords ?? []).some((k) => String(k).toLowerCase().includes(q))) return 1;
  return 0;
}

export class AppCommand extends HTMLElement {
  static get observedAttributes() { return ['groups', 'placeholder', 'empty-text', 'open', 'hotkey']; }

  #id = `app-command-${++uid}`;
  #dialog = null;
  #built = false;
  #active = 0;
  #pending = null; // id to emit after close
  #onHotkey = (e) => {
    const hk = (this.getAttribute('hotkey') || '').toLowerCase();
    if (!hk) return;
    const parts = hk.split('+');
    const key = parts.pop();
    const isMac = /mac|iphone|ipad/i.test(navigator.platform);
    const want = {
      mod: parts.includes('mod'), ctrl: parts.includes('ctrl'), alt: parts.includes('alt'), shift: parts.includes('shift'),
    };
    const modHeld = isMac ? e.metaKey : e.ctrlKey;
    if (want.mod !== modHeld && !(want.mod && want.ctrl)) return;
    if (want.ctrl && !e.ctrlKey) return;
    if (want.alt !== e.altKey || want.shift !== e.shiftKey) return;
    if (e.key.toLowerCase() !== key) return;
    e.preventDefault();
    this.open ? this.hide() : this.show();
  };

  get open() { return this.hasAttribute('open'); }
  set open(v) { v ? this.setAttribute('open', '') : this.removeAttribute('open'); }
  get query() { return this.#dialog?.querySelector('input')?.value ?? ''; }
  show() { this.open = true; }
  hide() { this.open = false; }

  connectedCallback() {
    this.#build();
    this.#sync();
    document.addEventListener('keydown', this.#onHotkey);
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this.#onHotkey);
  }

  attributeChangedCallback(name) {
    if (!this.#built) return;
    if (name === 'open') return this.#sync();
    if (name === 'groups' || name === 'empty-text') this.#renderList();
    if (name === 'placeholder') this.#dialog.querySelector('input').placeholder = this.getAttribute('placeholder') || 'Type a command…';
  }

  #groups() {
    try {
      const parsed = JSON.parse(this.getAttribute('groups') || '[]');
      return Array.isArray(parsed) ? parsed.filter((g) => g && Array.isArray(g.items)) : [];
    } catch {
      console.warn('[app-command] invalid `groups` JSON — rendering nothing');
      return [];
    }
  }

  #build() {
    if (this.#built) return;
    this.#built = true;
    const dialog = document.createElement('dialog');
    dialog.className = 'app-command';
    dialog.setAttribute('aria-label', 'Command palette');
    dialog.innerHTML = `
      <div class="search">
        <span class="search-icon" aria-hidden="true">${icons.search()}</span>
        <input type="text" role="combobox" aria-expanded="true" aria-autocomplete="list"
          aria-controls="${this.#id}-list" autocomplete="off" spellcheck="false"
          placeholder="${escAttr(this.getAttribute('placeholder') || 'Type a command…')}">
        <app-kbd keys="Esc" size="sm"></app-kbd>
      </div>
      <div class="list" id="${this.#id}-list" role="listbox"></div>`;
    this.appendChild(dialog);
    this.#dialog = dialog;
    unsizeIcons(dialog.querySelector('.search'));

    const input = dialog.querySelector('input');
    input.addEventListener('input', () => { this.#active = 0; this.#renderList(); });
    input.addEventListener('keydown', (e) => {
      const items = this.#visibleItems();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        this.#active = (this.#active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        this.#paintActive();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const el = items[this.#active];
        if (el) this.#pick(el.dataset.id);
      }
    });
    dialog.querySelector('.list').addEventListener('click', (e) => {
      const el = e.target.closest('.cmd');
      if (el) this.#pick(el.dataset.id);
    });
    dialog.querySelector('.list').addEventListener('pointermove', (e) => {
      const el = e.target.closest('.cmd');
      if (!el) return;
      const i = this.#visibleItems().indexOf(el);
      if (i >= 0 && i !== this.#active) { this.#active = i; this.#paintActive(); }
    });
    dialog.addEventListener('click', (e) => { if (e.target === dialog) this.hide(); });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.hide(); });
    dialog.addEventListener('close', () => {
      this.removeAttribute('open');
      this.dispatchEvent(new CustomEvent('command-toggle', { bubbles: true, detail: { open: false } }));
      // After close, so the handler can navigate without fighting the dialog.
      if (this.#pending !== null) {
        const id = this.#pending; this.#pending = null;
        this.dispatchEvent(new CustomEvent('command-select', { bubbles: true, detail: { id } }));
      }
    });
    this.#renderList();
  }

  #pick(id) {
    this.#pending = id;
    this.hide();
  }

  #visibleItems() { return [...this.#dialog.querySelectorAll('.cmd')]; }

  #paintActive() {
    this.#visibleItems().forEach((el, i) => {
      el.classList.toggle('is-active', i === this.#active);
      el.setAttribute('aria-selected', String(i === this.#active));
      if (i === this.#active) {
        el.scrollIntoView({ block: 'nearest' });
        this.#dialog.querySelector('input').setAttribute('aria-activedescendant', el.id);
      }
    });
  }

  #renderList() {
    const q = this.query.trim().toLowerCase();
    let n = 0;
    const groups = this.#groups().map((g) => {
      const items = g.items
        .map((it) => ({ it, score: scoreCommand(it, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ it }) => {
          const icon = it.icon && typeof icons[it.icon] === 'function' ? icons[it.icon]('', 16) : '';
          return `<div class="cmd" role="option" id="${this.#id}-opt-${n++}" data-id="${escAttr(it.id)}" aria-selected="false">
            <span class="cmd-icon" aria-hidden="true">${icon}</span>
            <span class="cmd-label">${escHtml(it.label)}</span>
            ${it.shortcut ? `<app-kbd size="sm" keys="${escAttr(it.shortcut)}"></app-kbd>` : ''}
          </div>`;
        });
      return items.length ? `<div class="group" role="group" aria-label="${escAttr(g.label)}"><div class="group-label">${escHtml(g.label)}</div>${items.join('')}</div>` : '';
    }).join('');
    this.#dialog.querySelector('.list').innerHTML = n
      ? groups
      : `<div class="empty">${escHtml(this.getAttribute('empty-text') || 'No results')}</div>`;
    this.#active = Math.min(this.#active, Math.max(0, n - 1));
    this.#paintActive();
  }

  #sync() {
    const d = this.#dialog;
    if (this.open && !d.open) {
      const input = d.querySelector('input');
      input.value = '';
      this.#active = 0;
      this.#renderList();
      d.showModal();
      input.focus();
      this.dispatchEvent(new CustomEvent('command-toggle', { bubbles: true, detail: { open: true } }));
    } else if (!this.open && d.open) {
      d.close();
    }
  }
}
customElements.define('app-command', AppCommand);
