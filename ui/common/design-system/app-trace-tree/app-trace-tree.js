/**
 * Tree of timed spans: a nested run where every node carries a duration and an
 * outcome — a distributed trace, a call graph, a build's step tree.
 *
 * Fully controlled. The tree renders exactly the `spans` it is given, marks the
 * row named by `value`, and hides the children of every id in `collapsed`; it
 * mutates none of the three. Clicking a row fires `trace-tree-select` and
 * clicking a chevron fires `trace-tree-toggle` — the owner decides what those
 * mean and sets the attributes back (the same controlled rule as `app-list`).
 *
 * Nodes are generic on purpose: `icon` names a glyph from the shared icon set
 * and `status`/`duration` are already-formatted presentation values, so the
 * component needs no knowledge of spans, providers or OTel semconv. A node that
 * appears twice in one tree is drawn once — a cyclic `children` chain is data
 * this cannot render, not a reason to hang the page.
 *
 * @element app-trace-tree
 * @attr {string} spans - JSON array of root nodes, each
 *   `{ id, label, meta?, icon?, status?, duration?, children? }`: `id` is echoed
 *   in both events, `meta` is the mono line beside the label (an operation
 *   name), `icon` names a glyph from the shared set, `status` is `ok` (default)
 *   or `error`, `duration` is the formatted time on the trailing badge.
 * @attr {string} value - `id` of the selected row.
 * @attr {string} collapsed - JSON array of node ids whose children are hidden.
 * @attr {string} label - Accessible name for the `role="tree"`.
 * @fires trace-tree-select - `{ id }` when a row is clicked or activated.
 * @fires trace-tree-toggle - `{ id, expanded }` from the disclosure chevron.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-trace-tree.css', import.meta.url));
import { icons } from '../../utils/icons.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import '../app-badge/app-badge.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

export class AppTraceTree extends HTMLElement {
  static get observedAttributes() { return ['spans', 'value', 'collapsed', 'label']; }

  connectedCallback() { this.render(); }

  attributeChangedCallback() { if (this.isConnected) this.render(); }

  /** Lenient JSON attribute: bad data renders nothing rather than throwing. */
  #json(attr) {
    try {
      const parsed = JSON.parse(this.getAttribute(attr) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      console.warn(`[app-trace-tree] invalid \`${attr}\` JSON — rendering nothing`);
      return [];
    }
  }

  /** The visible rows, depth-first, with folded subtrees left out. */
  #rows() {
    const collapsed = new Set(this.#json('collapsed'));
    const seen = new Set();
    const out = [];
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || seen.has(node.id)) return;
      seen.add(node.id);
      const kids = Array.isArray(node.children) ? node.children : [];
      const folded = collapsed.has(node.id);
      out.push({ node, depth, kids: kids.length, folded });
      if (!folded) kids.forEach((c) => walk(c, depth + 1));
    };
    this.#json('spans').filter((n) => n && typeof n === 'object').forEach((n) => walk(n, 0));
    return out;
  }

  render() {
    const rows = this.#rows();
    const value = this.getAttribute('value');
    // Re-rendering replaces the focused button, so remember which row had it
    // and hand focus back to the same id once the new rows are in.
    const focusedId = this.contains(document.activeElement)
      ? this.querySelector('.row:focus')?.dataset.id ?? null
      : null;
    // One tab stop for the whole tree: the selected row, or the first one.
    const stop = rows.findIndex((r) => r.node.id === value);
    const tabIndex = stop < 0 ? 0 : stop;

    this.innerHTML = `
      <div class="tree" role="tree" aria-label="${escAttr(this.getAttribute('label') || 'Trace')}">
        ${rows.map(({ node, depth, kids, folded }, i) => `
        <div class="line" role="none" style="--depth:${depth}">
          ${kids
            ? `<span class="fold" aria-hidden="true" data-fold="${escAttr(node.id)}"
                 data-expanded="${!folded}"
               >${folded ? icons.chevronRight('', 14) : icons.chevronDown('', 14)}</span>`
            : '<span class="fold is-leaf" aria-hidden="true"></span>'}
          <button type="button" class="row${node.id === value ? ' is-selected' : ''}"
            role="treeitem" aria-level="${depth + 1}" aria-selected="${node.id === value}"
            ${kids ? `aria-expanded="${!folded}"` : ''}
            tabindex="${i === tabIndex ? '0' : '-1'}" data-id="${escAttr(node.id)}">
            <span class="icon" aria-hidden="true">${this.#glyph(node.icon)}</span>
            <span class="name">${escHtml(node.label ?? '')}</span>
            ${node.meta ? `<span class="op">${escHtml(node.meta)}</span>` : ''}
            <span class="dot${node.status === 'error' ? ' is-error' : ''}" aria-hidden="true"></span>
            ${node.duration == null ? ''
              : `<app-badge variant="neutral">${icons.clock('', 12)} ${escHtml(node.duration)}</app-badge>`}
          </button>
        </div>`).join('')}
      </div>`;

    this.#wire(rows);
    if (focusedId) this.querySelector(`.row[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  }

  /** An unknown (or absent) icon name falls back to the generic trace glyph. */
  #glyph(name) {
    const icon = typeof name === 'string' && typeof icons[name] === 'function' ? icons[name] : icons.trace;
    return icon('', 14);
  }

  #wire(rows) {
    // The chevron is a mouse affordance and nothing else. It was a
    // `<button tabindex="-1" aria-expanded aria-label>`, which put a second
    // exposed element inside `role="tree"` — and a tree may own only
    // `treeitem` and `group`, so axe's aria-required-children failed on every
    // page that renders one.
    //
    // Hiding it costs assistive tech nothing, because it never carried
    // anything unique: the row below already IS the treeitem, already carries
    // `aria-expanded`, and already folds on ArrowRight/ArrowLeft through the
    // same `trace-tree-toggle` event this click emits (see the keydown handler
    // below). It was never in the tab order either — `tabindex="-1"` from the
    // day it was written. So a keyboard or screen-reader user loses no
    // capability here; a pointer user keeps the click target.
    //
    // `data-expanded` rather than `aria-expanded` for the same reason: state
    // an aria-hidden element carries is state nothing can read, so keeping it
    // in ARIA would be decoration that looks like semantics.
    for (const fold of this.querySelectorAll('.fold[data-fold]')) {
      fold.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#emit('trace-tree-toggle', {
          id: fold.dataset.fold,
          expanded: fold.dataset.expanded === 'false',
        });
      });
    }

    const buttons = [...this.querySelectorAll('.row')];
    buttons.forEach((row, i) => {
      row.addEventListener('click', () => this.#emit('trace-tree-select', { id: row.dataset.id }));
      row.addEventListener('keydown', (e) => {
        const { kids, folded, node } = rows[i];
        // Arrows walk the flattened tree; left/right fold, exactly as a
        // treeview is expected to behave.
        if (e.key === 'ArrowRight' && kids && folded) return this.#fold(e, node.id, true);
        if (e.key === 'ArrowLeft' && kids && !folded) return this.#fold(e, node.id, false);
        const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        buttons[Math.min(Math.max(next, 0), buttons.length - 1)]?.focus();
      });
    });
  }

  #fold(e, id, expanded) {
    e.preventDefault();
    this.#emit('trace-tree-toggle', { id, expanded });
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
  }
}
customElements.define('app-trace-tree', AppTraceTree);
