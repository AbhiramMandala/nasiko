/**
 * Inline time editor: `HH : MM` segments, optional seconds, optional AM/PM.
 *
 * Ported from nasiko_ui `NasikoTimePicker`. One `<app-input>`-shaped box holds
 * two-digit segments that behave like the platform time control should:
 *
 * - Digits type a two-digit value, clamped to the segment's range, and
 *   auto-advance to the next segment when the segment is complete (typing `3`
 *   into hours completes it immediately, since no two-digit hour starts with 3).
 * - ArrowUp/ArrowDown step with wrap-around; from an empty segment they land on
 *   the minimum/maximum. ArrowLeft/ArrowRight move between segments;
 *   Backspace/Delete clear.
 * - AM/PM segment: `A` / `P` set the period; ArrowUp/Down/Space/Enter toggle.
 *
 * `change` fires whenever the segments form a complete time, after clamping
 * to `min`/`max`. The value is always 24-hour `HH:MM` (or `HH:MM:SS`) — the
 * AM/PM presentation is derived, exactly as `NasikoTimeOfDay` does it.
 *
 * @element app-time-field
 * @attr {string} value - `HH:MM` or `HH:MM:SS`, 24-hour. Reflected on change.
 * @attr {string} format - `24h` (default) | `12h` — adds the AM/PM segment.
 * @attr {string} mode - (deprecated: use format)
 * @attr {boolean} seconds - Adds the seconds segment.
 * @attr {string} min - Earliest time, `HH:MM[:SS]`. A complete value below it snaps up.
 * @attr {string} max - Latest time, `HH:MM[:SS]`.
 * @attr {string} label - Label above the box.
 * @attr {string} hint - Helper line below the box.
 * @attr {string} state - `error` — red border. Omit for default.
 * @attr {boolean} required - Red `*` before the label.
 * @attr {boolean} disabled
 * @attr {string} name - Forwarded to a hidden native input for form submit.
 * @prop {string|null} value - Get/set the 24-hour time.
 * @fires change - `{ value }` when the segments form a complete time. Bubbles.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-time-field.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import { readAttr } from '../../utils/deprecate.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

let uid = 0;
const pad = (n) => String(n).padStart(2, '0');

/** `HH:MM[:SS]` → { h, m, s } or null. */
function parseTime(str) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str || '');
  if (!m) return null;
  const t = { h: Number(m[1]), m: Number(m[2]), s: Number(m[3] ?? 0) };
  return t.h < 24 && t.m < 60 && t.s < 60 ? t : null;
}
const toSeconds = (t) => t.h * 3600 + t.m * 60 + t.s;
const fromSeconds = (n) => ({ h: Math.floor(n / 3600), m: Math.floor((n % 3600) / 60), s: n % 60 });

export class AppTimeField extends HTMLElement {
  static get observedAttributes() {
    return ['value', 'format', 'seconds', 'min', 'max', 'label', 'hint', 'state', 'required', 'disabled', 'name', 'mode'];
  }

  #id = `app-time-field-${++uid}`;
  /** Segment state: null = empty. `pm` is only meaningful in 12h mode. */
  #seg = { h: null, m: null, s: null, pm: false };
  #typing = ''; // digits typed into the focused segment so far

  get value() { return this.getAttribute('value') || null; }
  set value(v) { v ? this.setAttribute('value', v) : this.removeAttribute('value'); }

  connectedCallback() { this.render(); }

  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === 'value' && this.querySelector('.seg')) { this.#fromValue(); this.#paint(); return; }
    this.render();
  }

  get #is12h() { return readAttr(this, 'format', 'mode') === '12h'; }
  get #hasSeconds() { return this.hasAttribute('seconds'); }

  /** Load the attribute into the segments (external value is the source of truth). */
  #fromValue() {
    const t = parseTime(this.value);
    if (!t) { this.#seg = { h: null, m: null, s: null, pm: false }; return; }
    this.#seg = { h: t.h, m: t.m, s: t.s, pm: t.h >= 12 };
  }

  /** Displayed hour for the current mode. */
  #displayHour(h) {
    if (!this.#is12h) return h;
    const x = h % 12;
    return x === 0 ? 12 : x;
  }

  #range(seg) {
    if (seg === 'h') return this.#is12h ? [1, 12] : [0, 23];
    return [0, 59];
  }

  /** Complete? Then clamp, reflect and fire. */
  #commit() {
    const { h, m, s, pm } = this.#seg;
    if (h === null || m === null || (this.#hasSeconds && s === null)) return;
    let hour24 = h;
    if (this.#is12h) hour24 = (h % 12) + (pm ? 12 : 0);
    let secs = toSeconds({ h: hour24, m, s: s ?? 0 });
    const min = parseTime(this.getAttribute('min'));
    const max = parseTime(this.getAttribute('max'));
    if (min) secs = Math.max(secs, toSeconds(min));
    if (max) secs = Math.min(secs, toSeconds(max));
    const t = fromSeconds(secs);
    const value = `${pad(t.h)}:${pad(t.m)}${this.#hasSeconds ? `:${pad(t.s)}` : ''}`;
    if (value !== this.value) {
      this.setAttribute('value', value); // attributeChangedCallback → #fromValue → #paint
      this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));
    } else {
      this.#paint();
    }
  }

  #paint() {
    const { h, m, s, pm } = this.#seg;
    const set = (name, v) => {
      const el = this.querySelector(`.seg[data-seg="${name}"]`);
      if (el) { el.value = v === null ? '' : pad(v); el.classList.toggle('is-empty', v === null); }
    };
    set('h', h === null ? null : (this.#is12h ? this.#displayHour(h) : h));
    set('m', m);
    set('s', s);
    const p = this.querySelector('.seg[data-seg="pm"]');
    if (p) p.value = h === null ? '--' : (pm ? 'PM' : 'AM');
    const native = this.querySelector('input[type="hidden"]');
    if (native) native.value = this.value ?? '';
  }

  #segments() { return [...this.querySelectorAll('.seg')]; }

  #moveTo(el, dir) {
    const segs = this.#segments();
    const next = segs[segs.indexOf(el) + dir];
    if (next) { next.focus(); next.select?.(); }
  }

  #onKey(e) {
    const el = e.currentTarget;
    const seg = el.dataset.seg;
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.#typing = ''; return this.#moveTo(el, -1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); this.#typing = ''; return this.#moveTo(el, 1); }

    if (seg === 'pm') {
      const k = e.key.toLowerCase();
      if (k === 'a' || k === 'p' || ['ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(e.key)) {
        e.preventDefault();
        this.#seg.pm = k === 'a' ? false : k === 'p' ? true : !this.#seg.pm;
        // `h` may hold a 24-hour value (loaded) or a display hour (typed);
        // #commit's `h % 12 + pm` derivation is correct for both.
        this.#commit();
      }
      return;
    }

    const [lo, hi] = this.#range(seg);
    const cur = this.#seg[seg];
    const curDisplay = cur === null ? null : (seg === 'h' ? this.#displayHour(cur) : cur);

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      this.#typing = '';
      let v;
      if (curDisplay === null) v = e.key === 'ArrowUp' ? lo : hi;
      else v = e.key === 'ArrowUp' ? (curDisplay >= hi ? lo : curDisplay + 1) : (curDisplay <= lo ? hi : curDisplay - 1);
      this.#seg[seg] = v;
      this.#commit();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      this.#typing = '';
      this.#seg[seg] = null;
      this.removeAttribute('value');
      this.#paint();
      return;
    }
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      this.#typing = (this.#typing + e.key).slice(-2);
      let v = Number(this.#typing);
      // Clamp as you type; a first digit that cannot start a valid two-digit
      // value completes the segment immediately (hours: 3–9; minutes: 6–9).
      const firstDigitCompletes = this.#typing.length === 1 && Number(this.#typing) * 10 > hi;
      if (v > hi) v = hi;
      if (v < lo && this.#typing.length === 2) v = lo;
      this.#seg[seg] = this.#typing.length === 1 && !firstDigitCompletes ? v : Math.max(lo, v);
      this.#paint();
      if (this.#typing.length === 2 || firstDigitCompletes) {
        this.#typing = '';
        this.#commit();
        this.#moveTo(el, 1);
      }
      return;
    }
    // Everything else that would type a character is swallowed; navigation keys pass.
    if (e.key.length === 1) e.preventDefault();
  }

  render() {
    this.#fromValue();
    const disabled = this.hasAttribute('disabled');
    const state = disabled ? 'disabled' : (this.getAttribute('state') === 'error' ? 'error' : 'default');
    const label = this.getAttribute('label');
    const hint = this.getAttribute('hint');
    const name = this.getAttribute('name');
    const seg = (key, aria) => `<input class="seg" data-seg="${key}" type="text" inputmode="numeric" maxlength="2"
      autocomplete="off" aria-label="${aria}" placeholder="--"${disabled ? ' disabled' : ''}>`;

    this.innerHTML = `
      <div class="field is-${state}">
        ${label === null ? '' : `<label class="label-row" for="${this.#id}">${escHtml(label)}${this.hasAttribute('required') ? '<span class="req"> *</span>' : ''}</label>`}
        <div class="box" role="group"${label ? ` aria-labelledby="${this.#id}-l"` : ''}>
          <span class="icon" aria-hidden="true">${icons.clock()}</span>
          ${seg('h', 'Hours').replace('class="seg"', `class="seg" id="${this.#id}"`)}<span class="colon">:</span>${seg('m', 'Minutes')}${
            this.#hasSeconds ? `<span class="colon">:</span>${seg('s', 'Seconds')}` : ''}${
            this.#is12h ? `<input class="seg is-period" data-seg="pm" type="text" maxlength="2" readonly aria-label="AM or PM"${disabled ? ' disabled' : ''}>` : ''}
        </div>
        ${name ? `<input type="hidden" name="${escAttr(name)}">` : ''}
        ${hint === null ? '' : `<div class="hint-row">${escHtml(hint)}</div>`}
      </div>`;
    unsizeIcons(this);
    this.querySelector('.label-row')?.setAttribute('id', `${this.#id}-l`);

    for (const el of this.#segments()) {
      el.addEventListener('keydown', (e) => this.#onKey(e));
      el.addEventListener('focus', () => { this.#typing = ''; el.select?.(); });
      el.addEventListener('blur', () => { this.#typing = ''; this.#paint(); });
      // Everything comes through keydown; `input` only fires for paste/IME —
      // take digits from it and re-run the same path.
      el.addEventListener('input', () => {
        if (el.dataset.seg === 'pm') return;
        const digits = el.value.replace(/\D/g, '').slice(0, 2);
        el.value = '';
        for (const d of digits) el.dispatchEvent(new KeyboardEvent('keydown', { key: d, cancelable: true }));
      });
    }
    this.#paint();
  }
}
customElements.define('app-time-field', AppTimeField);
