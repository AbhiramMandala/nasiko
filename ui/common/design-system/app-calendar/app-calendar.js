/**
 * Month-grid calendar for picking a single date.
 *
 * Ported from nasiko_ui `NasikoCalendar`. Weeks start on Monday; the grid
 * always renders six rows, so the control never changes height between
 * months. Days from the neighbouring months are dimmed and inert; today gets
 * a hairline marker; the selected day gets the primary-action fill; days
 * outside `min`/`max` are disabled.
 *
 * Keyboard (WAI-ARIA grid, one tab stop): arrows move the focused day
 * (±1 / ±7), Home/End jump to the start/end of the week, PageUp/PageDown move
 * a month, Enter/Space select. The month navigation buttons are the only
 * other tab stops.
 *
 * Dates are ISO `YYYY-MM-DD` strings in local time everywhere in the API —
 * the same shape `<input type="date">` and `utils/date-utils.js` use.
 *
 * @element app-calendar
 * @attr {string} value - Selected date, `YYYY-MM-DD`. Reflected on pick.
 * @attr {string} min - Earliest selectable date, `YYYY-MM-DD`.
 * @attr {string} max - Latest selectable date, `YYYY-MM-DD`.
 * @attr {string} month - Month to display, `YYYY-MM`. Defaults to the selected
 *   date's month, else today's. Reflected as the user navigates.
 * @attr {string} label - Accessible name of the grid (default: `Calendar`).
 * @prop {string|null} value - Get/set the selected date.
 * @fires change - `{ value }` after the user picks a day. Bubbles.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-calendar.css', import.meta.url));
import { icons, unsizeIcons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import { MONTH_NAMES, DAY_NAMES, toDateStr, parseDate, sameDay, startOfDay, addDays } from '../../utils/date-utils.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const LONG_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** `YYYY-MM` → first-of-month Date, or null. */
function parseMonth(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(s || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : null;
}
const monthStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const addMonths = (first, n) => new Date(first.getFullYear(), first.getMonth() + n, 1);

export class AppCalendar extends HTMLElement {
  static get observedAttributes() { return ['value', 'min', 'max', 'month', 'label']; }

  /** The day the roving focus sits on (a Date), independent of the selection. */
  #focus = null;

  get value() { return this.getAttribute('value') || null; }
  set value(v) { v ? this.setAttribute('value', v) : this.removeAttribute('value'); }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  #month() {
    return parseMonth(this.getAttribute('month'))
      ?? (parseDate(this.value) && new Date(parseDate(this.value).getFullYear(), parseDate(this.value).getMonth(), 1))
      ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  }

  #disabled(d) {
    const min = parseDate(this.getAttribute('min'));
    const max = parseDate(this.getAttribute('max'));
    return (min && d < min) || (max && d > max);
  }

  #select(d) {
    if (this.#disabled(d)) return;
    const value = toDateStr(d);
    this.#focus = d;
    this.setAttribute('month', monthStr(d));
    this.setAttribute('value', value);
    this.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));
  }

  #moveFocus(d) {
    this.#focus = d;
    const m = monthStr(d);
    if (m !== monthStr(this.#month())) this.setAttribute('month', m); // re-renders
    else this.render();
    this.querySelector('.day[tabindex="0"]')?.focus();
  }

  render() {
    const first = this.#month();
    const today = startOfDay(new Date());
    const selected = parseDate(this.value);
    const focus = this.#focus && monthStr(this.#focus) === monthStr(first) ? this.#focus
      : selected && monthStr(selected) === monthStr(first) ? selected
      : sameDay(today, first) || monthStr(today) === monthStr(first) ? today : first;
    this.#focus = focus;
    const keepFocus = this.contains(document.activeElement) && document.activeElement.classList.contains('day');

    // Monday-first offset of the 1st; six rows of seven, always.
    const lead = (first.getDay() + 6) % 7;
    const start = addDays(first, -lead);
    const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));

    const rows = [];
    for (let r = 0; r < 6; r++) {
      rows.push(`<tr>${cells.slice(r * 7, r * 7 + 7).map((d) => {
        const inMonth = d.getMonth() === first.getMonth();
        const disabled = !inMonth || this.#disabled(d);
        const isSel = sameDay(d, selected);
        const isToday = sameDay(d, today);
        const isFocus = sameDay(d, focus);
        const cls = ['day', inMonth ? '' : 'is-outside', disabled ? 'is-disabled' : '', isSel ? 'is-selected' : '', isToday ? 'is-today' : ''].filter(Boolean).join(' ');
        const label = `${LONG_DAYS[(d.getDay() + 6) % 7]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
        return `<td role="gridcell"${isSel ? ' aria-selected="true"' : ''}>
          <button type="button" class="${cls}" data-date="${toDateStr(d)}" tabindex="${isFocus && !disabled ? 0 : -1}"
            aria-label="${escAttr(label)}"${disabled ? ' disabled' : ''}${isToday ? ' aria-current="date"' : ''}>${d.getDate()}</button>
        </td>`;
      }).join('')}</tr>`);
    }

    this.innerHTML = `
      <div class="cal">
        <div class="head">
          <button type="button" class="nav" data-nav="-1" aria-label="Previous month">${icons.chevronLeft()}</button>
          <div class="month" aria-live="polite">${MONTH_NAMES[first.getMonth()]} ${first.getFullYear()}</div>
          <button type="button" class="nav" data-nav="1" aria-label="Next month">${icons.chevronRight()}</button>
        </div>
        <table role="grid" aria-label="${escAttr(this.getAttribute('label') || 'Calendar')}">
          <thead><tr>${DAY_NAMES.map((d, i) => `<th scope="col" abbr="${LONG_DAYS[i]}">${escHtml(d)}</th>`).join('')}</tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
    unsizeIcons(this);

    for (const b of this.querySelectorAll('.nav')) {
      b.addEventListener('click', () => {
        this.#focus = null;
        this.setAttribute('month', monthStr(addMonths(this.#month(), Number(b.dataset.nav))));
      });
    }
    const grid = this.querySelector('tbody');
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.day');
      if (btn && !btn.disabled) this.#select(parseDate(btn.dataset.date));
    });
    grid.addEventListener('keydown', (e) => {
      const btn = e.target.closest('.day');
      if (!btn) return;
      const d = parseDate(btn.dataset.date);
      const dow = (d.getDay() + 6) % 7;
      const next = {
        ArrowLeft: addDays(d, -1), ArrowRight: addDays(d, 1), ArrowUp: addDays(d, -7), ArrowDown: addDays(d, 7),
        Home: addDays(d, -dow), End: addDays(d, 6 - dow),
        PageUp: new Date(d.getFullYear(), d.getMonth() - 1, d.getDate()),
        PageDown: new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()),
      }[e.key];
      if (next) { e.preventDefault(); this.#moveFocus(next); return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.#select(d); }
    });

    if (keepFocus) this.querySelector('.day[tabindex="0"]')?.focus();
  }
}
customElements.define('app-calendar', AppCalendar);
