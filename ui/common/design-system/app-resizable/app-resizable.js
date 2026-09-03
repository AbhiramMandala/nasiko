/**
 * Row or column of panels separated by draggable dividers.
 *
 * Ported from nasiko_ui `NasikoResizablePanelGroup`. Children are the panels;
 * each declares its share of the axis with `data-flex` (default 1) and
 * optional `data-min-flex` / `data-max-flex`, all in the same continuous unit
 * — `data-flex="340" data-min-flex="240"` next to `data-flex="660"` reads like
 * pixel widths of a 1000-unit layout. Dragging a divider resizes the two
 * neighbours; when one hits its bound the remainder cascades to the next
 * panel on that side. Double-click resets the pair to its defaults. Dividers
 * are focusable `role="separator"`s: arrows move the focused divider by 2% of
 * the group per press.
 *
 * `layout-change` reports the normalized fractions (sum ≈ 1) after every
 * applied change, so a page can persist and restore a layout via `sizes`.
 * Changing the panel count resets to the declared defaults — deterministic,
 * rather than guessing how freed space should be spread.
 *
 * @element app-resizable
 * @attr {string} orientation - `horizontal` (default, panels side by side) | `vertical`
 * @attr {string} direction - (deprecated: use orientation)
 * @attr {string} sizes - Space-separated fractions to apply, e.g. `0.3 0.7`. Reflected
 *   after every change, so it doubles as the persistence format.
 * @attr {boolean} no-reset - Disables the double-click reset.
 * @slot default - The panels, in order.
 * @children *
 * @childattr {number} data-flex - The panel's share of the axis, in any unit (default 1).
 * @childattr {number} data-min-flex - Smallest share the panel may shrink to, same unit.
 * @childattr {number} data-max-flex - Largest share the panel may grow to, same unit.
 * @fires resizable-change - `{ sizes: number[] }` after an applied change. Bubbles.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-resizable.css', import.meta.url));
import { readAttr, emit } from '../../utils/deprecate.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const STEP = 0.02;
const EPS = 1e-6;

export class AppResizable extends HTMLElement {
  static get observedAttributes() { return ['orientation', 'sizes', 'no-reset', 'direction']; }

  /** Current fractions, one per panel. */
  #frac = [];
  #built = false;
  #observer = null;
  #drag = null;

  get horizontal() { return readAttr(this, 'orientation', 'direction') !== 'vertical'; }
  get panels() { return [...this.children].filter((el) => !el.classList.contains('divider')); }

  connectedCallback() {
    if (!this.#built) {
      this.#built = true;
      // Panels added or removed later reset the layout, as on the Flutter side.
      this.#observer = new MutationObserver((muts) => {
        if (muts.some((m) => [...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1 && !n.classList.contains('divider')))) this.#rebuild();
      });
    }
    this.#observer.observe(this, { childList: true });
    this.#rebuild();
  }

  disconnectedCallback() {
    this.#observer?.disconnect();
    this.#endDrag();
  }

  attributeChangedCallback(name) {
    if (!this.#built || !this.isConnected) return;
    if (name === 'sizes') {
      const next = this.#parseSizes();
      if (next && !this.#same(next, this.#frac)) { this.#frac = next; this.#apply(false); }
      return;
    }
    if (name === 'orientation' || name === 'direction') this.#apply(false);
  }

  #same(a, b) { return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < EPS); }

  #parseSizes() {
    const n = this.panels.length;
    const parts = (this.getAttribute('sizes') ?? '').split(/\s+/).filter(Boolean).map(Number);
    if (parts.length !== n || parts.some((x) => !(x > 0))) return null;
    const total = parts.reduce((a, b) => a + b, 0);
    return parts.map((x) => x / total);
  }

  /** Declared flex, min and max per panel, normalized to fractions of the total default flex. */
  #declared() {
    const panels = this.panels;
    const flex = panels.map((p) => Math.max(0, Number(p.dataset.flex)) || 1);
    const total = flex.reduce((a, b) => a + b, 0) || 1;
    return {
      def: flex.map((f) => f / total),
      min: panels.map((p) => (Number(p.dataset.minFlex) || 0) / total),
      max: panels.map((p) => p.dataset.maxFlex ? Number(p.dataset.maxFlex) / total : 1),
    };
  }

  #rebuild() {
    // Strip old dividers, re-insert one between each pair.
    for (const d of this.querySelectorAll(':scope > .divider')) d.remove();
    const panels = this.panels;
    this.setAttribute('role', 'group');
    panels.forEach((p, i) => {
      p.classList.add('panel');
      if (i === 0) return;
      const div = document.createElement('div');
      div.className = 'divider';
      div.setAttribute('role', 'separator');
      div.setAttribute('tabindex', '0');
      div.setAttribute('aria-orientation', this.horizontal ? 'vertical' : 'horizontal');
      div.dataset.index = String(i - 1);
      div.innerHTML = '<span class="grip" aria-hidden="true"></span>';
      div.addEventListener('pointerdown', (e) => this.#startDrag(e, i - 1));
      div.addEventListener('dblclick', () => { if (!this.hasAttribute('no-reset')) this.#reset(i - 1); });
      div.addEventListener('keydown', (e) => this.#onKey(e, i - 1));
      p.before(div);
    });
    this.#frac = this.#parseSizes() ?? this.#declared().def;
    this.#apply(false);
  }

  /**
   * Move the divider at `i` by `delta` (fraction of the group). The near
   * neighbours absorb it first; when one hits its bound the remainder cascades
   * to the next panel on that side, so a drag never dead-stops early.
   */
  #move(i, delta) {
    const { min, max } = this.#declared();
    const f = [...this.#frac];
    const take = (indices, amount) => {
      // Shrink panels in `indices` order by `amount` total; return what was taken.
      let left = amount;
      for (const k of indices) {
        const room = f[k] - min[k];
        const d = Math.min(room, left);
        f[k] -= d; left -= d;
        if (left <= EPS) break;
      }
      return amount - left;
    };
    const give = (indices, amount) => {
      let left = amount;
      for (const k of indices) {
        const room = max[k] - f[k];
        const d = Math.min(room, left);
        f[k] += d; left -= d;
        if (left <= EPS) break;
      }
      return amount - left;
    };
    const before = [...Array(i + 1).keys()].reverse();          // i, i-1, … 0
    const after = [...Array(f.length).keys()].slice(i + 1);     // i+1 … n-1
    let moved;
    if (delta > 0) moved = give(before, take(after, delta));
    else moved = give(after, take(before, -delta));
    if (moved <= EPS) return false;
    // Whatever the receiving side could not absorb goes back where it came from.
    const sum = f.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > EPS) { const k = delta > 0 ? after[0] : before[0]; f[k] += 1 - sum; }
    this.#frac = f;
    return true;
  }

  #apply(notify = true) {
    const panels = this.panels;
    if (this.#frac.length !== panels.length) this.#frac = this.#declared().def;
    panels.forEach((p, i) => p.style.setProperty('--panel-frac', String(this.#frac[i])));
    this.querySelectorAll(':scope > .divider').forEach((d) => {
      const i = Number(d.dataset.index);
      d.setAttribute('aria-orientation', this.horizontal ? 'vertical' : 'horizontal');
      d.setAttribute('aria-valuenow', String(Math.round(this.#frac[i] * 100)));
      d.setAttribute('aria-valuemin', '0');
      d.setAttribute('aria-valuemax', '100');
    });
    const sizes = this.#frac.map((x) => Math.round(x * 1e4) / 1e4);
    this.setAttribute('sizes', sizes.join(' '));
    if (notify) emit(this, 'resizable-change', { sizes }, { legacy: 'layout-change' });
  }

  #reset(i) {
    const { def } = this.#declared();
    const pairTotal = this.#frac[i] + this.#frac[i + 1];
    const defTotal = def[i] + def[i + 1] || 1;
    this.#frac[i] = pairTotal * (def[i] / defTotal);
    this.#frac[i + 1] = pairTotal * (def[i + 1] / defTotal);
    this.#apply();
  }

  #onKey(e, i) {
    const h = this.horizontal;
    const dir = { [h ? 'ArrowLeft' : 'ArrowUp']: -1, [h ? 'ArrowRight' : 'ArrowDown']: 1 }[e.key];
    if (dir === undefined) {
      if (e.key === 'Enter' && !this.hasAttribute('no-reset')) { e.preventDefault(); this.#reset(i); }
      return;
    }
    e.preventDefault();
    if (this.#move(i, dir * STEP)) this.#apply();
  }

  #startDrag(e, i) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = this.getBoundingClientRect();
    const size = this.horizontal ? rect.width : rect.height;
    const divider = e.currentTarget;
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('is-dragging');
    this.classList.add('is-resizing');
    let last = this.horizontal ? e.clientX : e.clientY;
    const onMove = (ev) => {
      const now = this.horizontal ? ev.clientX : ev.clientY;
      const delta = (now - last) / size;
      if (this.#move(i, delta)) { last = now; this.#apply(false); }
      // `last` stays where it was when nothing moved, so a drag past a bound
      // does not accumulate phantom distance.
    };
    const onUp = () => { this.#endDrag(); this.#apply(); };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp, { once: true });
    divider.addEventListener('pointercancel', onUp, { once: true });
    this.#drag = () => {
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.removeEventListener('pointercancel', onUp);
      divider.classList.remove('is-dragging');
      this.classList.remove('is-resizing');
    };
  }

  #endDrag() { this.#drag?.(); this.#drag = null; }
}
customElements.define('app-resizable', AppResizable);
