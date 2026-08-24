/**
 * Paginated data table — search, sortable auto-detected columns, an optional
 * row-detail panel, and numbered page navigation.
 *
 * The design-system successor to `features/smart-table.js`. Same data contract,
 * same column API, same events — the difference is the pager: page numbers with
 * prev/next instead of prev/next alone, so page 12 of 40 is one click away
 * rather than eleven. Pagination is also optional now (`pagination="none"`).
 *
 * @element app-table
 * @attr {number} limit - Rows per page (default: 10). Ignored for
 *   `pagination="none"`, which renders whatever the data function returns.
 * @attr {string} pagination - `pages` (default) — prev / windowed page numbers /
 *   next — or `none` for no pager at all. Optional: omit it and you get pages.
 * @attr {string} data-fn - Name of a registered data source (see
 *   core/data-sources.js), called as `(query, page, limit)` and returning
 *   `{ data, total }` or a bare array. `page` is 1-based. Alternatively assign
 *   the `dataFn` property directly and call `refresh()` yourself.
 * @attr {boolean} search - Show the search input.
 * @attr {string} search-placeholder - Placeholder for the search input.
 * @attr {string} detail - Present: clicking a row opens a detail modal.
 * @attr {string} empty-message - Body text when there are no rows and no query.
 * @prop {Array} columns - Optional column definitions; see below.
 * @prop {Function} dataFn - The fetcher, if not named via `data-fn`.
 * @fires loading-start - Before each fetch — bubbles.
 * @fires loading-end - After each fetch — bubbles.
 * @note Columns are inferred from the first row's keys when `columns` is unset.
 *       Sorting is client-side over the current page and cycles
 *       unsorted → ascending → descending → unsorted, so the server's own
 *       ordering is reachable again after a sort.
 */
import { icons } from '../../utils/icons.js';
import { createEventTracker, debounce } from '../../utils/data-component-utils.js';
import { resolveOptional as resolveDataSource } from '../../core/data-sources.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import '../app-button/app-button.js';
import '../app-input/app-input.js';
import '../app-modal/app-modal.js';
import styles from './app-table.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const IC_SORT_BOTH = icons.sortBoth('sort-icon');
const IC_SORT_ASC  = icons.sortAsc('sort-icon is-active');
const IC_SORT_DESC = icons.sortDesc('sort-icon is-active');
const IC_PREV      = icons.pagePrev();
const IC_NEXT      = icons.pageNext();
const IC_SEARCH    = icons.search('', 16);

/**
 * The page numbers to show: first, last, the current page and one neighbour
 * either side, with `null` standing in for each elided run. Exported because it
 * is the only non-obvious arithmetic in this file and app-table.test.mjs checks
 * it directly.
 *
 * @param {number} current 1-based current page
 * @param {number} total total page count
 * @param {number} [span] neighbours to keep either side of `current`
 * @returns {Array<number|null>}
 */
export function pageWindow(current, total, span = 1) {
  const wanted = new Set([1, total, current]);
  for (let i = 1; i <= span; i++) {
    wanted.add(current - i);
    wanted.add(current + i);
  }
  const shown = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of shown) {
    // A gap of exactly one page is spelled as that page, not as an ellipsis
    // hiding a single number — "1 … 3" is strictly worse than "1 2 3".
    if (prev && p - prev === 2) out.push(prev + 1);
    else if (prev && p - prev > 2) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

export class AppTable extends HTMLElement {
  #data = [];
  #sortedData = [];
  #currentPage = 1;
  #sortField = null;
  #sortDirection = 'asc';
  #totalItems = 0;
  #searchQuery = '';
  #events = createEventTracker();
  #dataFnName = null;
  #debouncedSearch = null;
  #showDetail = false;
  #paginate = true;

  /**
   * Optional column definitions. If set, controls which columns are shown,
   * their labels, and how cells are rendered.
   *
   * Each entry: { key, label?, width?, wrap?, render?(value, row) => string }
   *
   * - `key`    — the property name on each data row
   * - `label`  — column header text (defaults to key); blank means a
   *              non-sortable action column, pinned to the right edge
   * - `width`  — CSS width string applied via <colgroup> (e.g. '30%')
   * - `wrap`   — if true, cell content wraps instead of truncating
   * - `render` — returns an HTML string for the cell; raw value used if omitted
   */
  columns = null;

  constructor() {
    super();
    this.limit = 10;
    this.dataFn = null;
    this.searchPlaceholder = 'Search...';
    this.showSearch = false;
  }

  static get observedAttributes() {
    return ['limit', 'data-fn', 'search-placeholder', 'search', 'detail',
            'empty-message', 'pagination'];
  }

  connectedCallback() {
    this.#readAttributes();

    this.#render();
    this.#setupEventListeners();
    // Deferred by a microtask: pages assign `columns` on the statement after
    // the element is created, which is after this callback has run. Waiting
    // lets the skeleton pass draw the real header and column widths, so rows
    // never move between the loading state and loaded data.
    queueMicrotask(() => this.refresh());
  }

  disconnectedCallback() {
    if (this.#debouncedSearch) this.#debouncedSearch.cancel();
    this.#events.cleanup();
  }

  #readAttributes() {
    this.limit = parseInt(this.getAttribute('limit')) || 10;
    this.searchPlaceholder = this.getAttribute('search-placeholder') || 'Search...';
    this.showSearch = this.hasAttribute('search');
    this.#showDetail = this.hasAttribute('detail');
    // Anything other than the opt-out keeps the default pager, so a typo in the
    // attribute leaves the table navigable instead of silently stranding rows.
    this.#paginate = this.getAttribute('pagination') !== 'none';
    const fnName = this.getAttribute('data-fn');
    if (fnName) {
      this.#dataFnName = fnName;
      this.dataFn = resolveDataSource(fnName) || null;
    }
  }

  #render() {
    this.innerHTML = `
      <div class="table-wrap">
        ${this.showSearch ? `
          <app-input
            class="search-field"
            type="search"
            placeholder="${escAttr(this.searchPlaceholder)}"
            value="${escAttr(this.#searchQuery)}"
            aria-label="Search table data"
          ><span data-slot="leading">${IC_SEARCH}</span></app-input>
        ` : ''}

        <div class="scroll">
          <table class="table">
            <thead class="thead"></thead>
            <tbody class="tbody"></tbody>
          </table>
        </div>

        ${this.#paginate ? `
          <nav class="pagination" role="navigation" aria-label="Table pagination" hidden>
            <app-button variant="tertiary" size="sm" icon-only
              data-page="prev" aria-label="Previous page">${IC_PREV}</app-button>
            <span class="pages"></span>
            <app-button variant="tertiary" size="sm" icon-only
              data-page="next" aria-label="Next page">${IC_NEXT}</app-button>
          </nav>
        ` : ''}

        <div class="error" role="alert" hidden></div>
      </div>

      ${this.#showDetail ? `
        <app-modal class="detail-modal" heading="Row Detail">
          <dl class="detail-list"></dl>
        </app-modal>
      ` : ''}
    `;
  }

  #setupEventListeners() {
    if (this.showSearch) {
      const searchField = this.querySelector('.search-field');
      if (searchField) {
        this.#debouncedSearch = debounce(() => {
          this.#searchQuery = searchField.value;
          this.#currentPage = 1;
          this.refresh();
        }, 300);
        // Delegated on the host <app-input>: it re-renders its inner <input> on
        // any attribute change, so a listener bound to that input would be
        // dropped on the floor. The event bubbles out of the host either way.
        this.#events.add(searchField, 'input', this.#debouncedSearch);
      }
    }

    // One delegated handler for prev / next / every page number, because the
    // number strip is rebuilt on each fetch.
    const nav = this.querySelector('.pagination');
    if (nav) {
      this.#events.add(nav, 'click', (e) => {
        const btn = e.target.closest('[data-page]');
        if (!btn || btn.hasAttribute('disabled')) return;
        const target = btn.dataset.page;
        if (target === 'prev') this.#goToPage(this.#currentPage - 1);
        else if (target === 'next') this.#goToPage(this.#currentPage + 1);
        else this.#goToPage(parseInt(target, 10));
      });
    }

    if (this.#showDetail) {
      const tbody = this.querySelector('.tbody');
      if (tbody) {
        this.#events.add(tbody, 'click', (e) => {
          if (e.target.closest('a, button, [data-action]')) return;
          const tr = e.target.closest('tr[data-row-index]');
          if (!tr) return;
          const idx = parseInt(tr.dataset.rowIndex, 10);
          const row = this.#getSortedData()[idx];
          if (row) this.#openDetail(row);
        });
      }
    }
  }

  /**
   * Re-fetch the current page.
   *
   * @param {{ resetPage?: boolean }} [opts] `resetPage` jumps back to page 1 —
   *   what a filter change needs, since filtering to fewer pages while parked
   *   on page 3 otherwise leaves an empty body under a hidden pager.
   */
  async refresh({ resetPage = false } = {}) {
    if (resetPage) this.#currentPage = 1;
    // Re-resolved on *every* refresh, not cached from connectedCallback: a
    // page-scoped `override()` swaps the registry entry without touching this
    // element, and a cached `dataFn` kept fetching the unfiltered original —
    // which is exactly how the Users page's role/department/status selects came
    // to do nothing. Tables that assign `.dataFn` directly carry no data-fn
    // name and are untouched by this.
    if (this.#dataFnName) {
      this.dataFn = resolveDataSource(this.#dataFnName) || null;
    }
    // Resolution is deliberately lazy and retried on every refresh — that is
    // what lets a late-loading service module recover, and what makes a
    // page-scoped override take effect. A declared data-fn that will not
    // resolve is a real bug, so it says so on screen; no declared name means
    // the owner sets `.dataFn` directly and calls refresh() itself, so an early
    // refresh there is expected and must stay silent.
    if (!this.dataFn) {
      if (this.#dataFnName) {
        this.#showError(`No data source named "${this.#dataFnName}".`);
        console.error(
          `[app-table] unresolved data-fn "${this.#dataFnName}" — register it with ` +
            `dataSources.registerAll({ ${this.#dataFnName}: … }) in the page's service module. ` +
            `Check the <script> order too: data functions must be defined before the page component.`,
        );
      }
      return;
    }

    this.#hideError();
    this.#showSkeletons();

    const scroll = this.querySelector('.scroll');
    if (scroll) scroll.classList.add('is-loading');

    this.dispatchEvent(new CustomEvent('loading-start', { bubbles: true, detail: { message: 'Loading data...' } }));

    try {
      const response = await this.dataFn(this.#searchQuery, this.#currentPage, this.limit);
      // A fetcher may answer a bare array or a {data, total} envelope. Anything
      // else is a contract mismatch (e.g. an endpoint returning a differently
      // named key): degrade to an empty table with a pointed warning rather
      // than assigning a non-iterable and throwing deep in the sort.
      const rows = Array.isArray(response) ? response : response?.data;
      if (!Array.isArray(rows)) {
        console.warn(
          `app-table: "${this.#dataFnName}" returned no row array (expected an array or {data:[…]}); got`,
          response,
        );
      }
      this.#data = Array.isArray(rows) ? rows : [];
      this.#totalItems = response?.total ?? this.#data.length;
      this.#invalidateSortCache();
      this.#renderTable();
      this.#updatePagination();
    } catch (error) {
      console.error('app-table: Error fetching data:', error);
      this.#showError('Failed to load data. Please try again.');
    } finally {
      if (scroll) scroll.classList.remove('is-loading');
      this.dispatchEvent(new CustomEvent('loading-end', { bubbles: true, detail: { message: 'Data loaded' } }));
    }
  }

  /** Show skeleton rows while data loads — gives the table a stable size hint. */
  #showSkeletons() {
    const thead = this.querySelector('.thead');
    const tbody = this.querySelector('.tbody');
    if (!thead || !tbody) return;
    if (!this.#data.length) {
      this.#renderColgroup(this.columns);
      this.#renderHead(this.columns);
    }
    const colCount = this.columns ? this.columns.length : 4;
    const widthSets = [
      ['60%','80%','40%','70%'],
      ['75%','55%','65%','50%'],
      ['50%','90%','45%','80%'],
      ['70%','60%','80%','55%'],
      ['65%','75%','50%','70%'],
    ];
    const skeletonRow = (i) => {
      const ws = widthSets[i % widthSets.length];
      const cells = Array.from({ length: colCount }, (_, j) =>
        `<td class="td"><div class="skel-bar" style="width:${ws[j % ws.length]}"></div></td>`
      ).join('');
      return `<tr>${cells}</tr>`;
    };
    const rowCount = this.#paginate ? this.limit : Math.min(this.limit, 10);
    tbody.innerHTML = Array.from({ length: rowCount }, (_, i) => skeletonRow(i)).join('');
  }

  #renderTable() {
    const thead = this.querySelector('.thead');
    const tbody = this.querySelector('.tbody');
    if (!thead || !tbody) return;

    if (!this.#data || this.#data.length === 0) {
      // Keep the header row. Blanking it left a <colgroup> sizing columns that
      // had no headers above them, so an empty table read as a broken one.
      this.#renderColgroup(this.columns);
      this.#renderHead(this.columns);
      // "No results found" is only true when something was actually searched
      // for — on a table with no active query it told the user their own filter
      // came up empty on a filter they never set.
      const message = this.#searchQuery
        ? `No results for “${escHtml(this.#searchQuery)}”`
        : (this.getAttribute('empty-message') || 'Nothing here yet');
      tbody.innerHTML = `<tr><td class="empty" colspan="100%">${message}</td></tr>`;
      return;
    }

    const cols = this.columns
      ? this.columns
      : Object.keys(this.#data[0]).map(k => ({ key: k, label: k }));

    // Rebuild colgroup on every render to stay consistent across sort/re-renders
    this.#renderColgroup(cols);
    this.#renderHead(cols);

    // Rebind sort events on headers
    this.#events.removeTagged('_header');
    thead.querySelectorAll('.th[data-field]').forEach(th => {
      const field = th.dataset.field;
      const clickHandler = () => this.#sort(field);
      const keyHandler = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.#sort(field);
        }
      };
      this.#events.add(th, 'click', clickHandler, { _header: true });
      this.#events.add(th, 'keydown', keyHandler, { _header: true });
    });

    const displayData = this.#getSortedData();
    tbody.innerHTML = displayData.map((row, i) => `
      <tr${this.#showDetail ? ` class="is-clickable" data-row-index="${i}"` : ''}>${cols.map(col => {
        const raw = row[col.key];
        const cell = col.render
          ? col.render(raw, row)
          : `<span title="${escAttr(raw)}">${escHtml(raw)}</span>`;
        // `is-plain` mirrors the header marker for label-less (row-action)
        // columns, so CSS can pin the action cell and its header together.
        const plain = !String(col.label ?? col.key).trim() ? ' is-plain' : '';
        return `<td class="td${col.wrap ? ' is-wrap' : ''}${plain}">${cell}</td>`;
      }).join('')}</tr>
    `).join('');
  }

  #renderColgroup(cols) {
    const table = this.querySelector('.table');
    if (!table) return;
    table.querySelector('colgroup')?.remove();
    if (!cols || !cols.some(c => c.width)) return;
    const cg = document.createElement('colgroup');
    cg.innerHTML = cols.map(c => `<col${c.width ? ` style="width:${c.width}"` : ''}>`).join('');
    table.prepend(cg);
  }

  /** Header row — shared by the skeleton pass and the data render, so the
   *  first body row sits at the same y in both. */
  #renderHead(cols) {
    const thead = this.querySelector('.thead');
    if (!thead) return;
    if (!cols) {
      thead.innerHTML = '';
      return;
    }
    thead.innerHTML = `<tr>${cols.map(col => {
      const field = col.key;
      const label = col.label ?? field;
      // Label-less columns (row actions) get a plain, non-sortable header —
      // a focusable empty "Sort by" control is noise for everyone.
      if (!String(label).trim()) {
        return `<th class="th is-plain" role="columnheader"></th>`;
      }
      let icon = IC_SORT_BOTH;
      let ariaSort = 'none';
      let action = `Sort by ${label}`;
      if (this.#sortField === field) {
        const asc = this.#sortDirection === 'asc';
        icon = asc ? IC_SORT_ASC : IC_SORT_DESC;
        ariaSort = asc ? 'ascending' : 'descending';
        action = asc ? `Sort by ${label} descending` : `Remove sorting on ${label}`;
      }
      return `
        <th class="th"
            data-field="${escAttr(field)}"
            tabindex="0"
            role="columnheader"
            aria-sort="${ariaSort}"
            aria-label="${escAttr(action)}">
          <div class="th-content">
            <span>${escHtml(label)}</span>
            ${icon}
          </div>
        </th>`;
    }).join('')}</tr>`;
  }

  get #totalPages() {
    return Math.max(1, Math.ceil(this.#totalItems / this.limit));
  }

  #updatePagination() {
    const nav = this.querySelector('.pagination');
    if (!nav) return;

    const totalPages = this.#totalPages;
    if (totalPages <= 1) {
      nav.hidden = true;
      return;
    }
    nav.hidden = false;

    const prevBtn = nav.querySelector('[data-page="prev"]');
    const nextBtn = nav.querySelector('[data-page="next"]');
    prevBtn.disabled = this.#currentPage === 1;
    nextBtn.disabled = this.#currentPage >= totalPages;

    nav.querySelector('.pages').innerHTML =
      pageWindow(this.#currentPage, totalPages).map((p) => {
        if (p === null) return `<span class="page-gap" aria-hidden="true">…</span>`;
        const current = p === this.#currentPage;
        return `<app-button
          variant="${current ? 'secondary' : 'ghost'}" size="sm"
          data-page="${p}"
          aria-label="Page ${p}"
          ${current ? 'aria-current="page"' : ''}>${p}</app-button>`;
      }).join('');
  }

  /**
   * Cycles the clicked column: unsorted → ascending → descending → unsorted.
   *
   * The third click is the point. With a two-state toggle there is no way back
   * to the order the server sent, which for a list that is already ranked (most
   * recent first, highest cost first) is the one ordering that matters — you
   * could leave it but never return to it.
   */
  #sort(field) {
    if (this.#sortField !== field) {
      this.#sortField = field;
      this.#sortDirection = 'asc';
    } else if (this.#sortDirection === 'asc') {
      this.#sortDirection = 'desc';
    } else {
      this.#sortField = null;
      this.#sortDirection = 'asc';
    }
    this.#invalidateSortCache();
    this.#renderTable();
  }

  /** Jump straight to a page. 1-based; out-of-range and no-op jumps are ignored. */
  #goToPage(page) {
    if (!Number.isInteger(page)) return;
    if (page < 1 || page > this.#totalPages || page === this.#currentPage) return;
    this.#currentPage = page;
    this.refresh();
  }

  #getSortedData() {
    if (!this.#sortField || !this.#data.length) return [...this.#data];
    if (this.#sortedData.length > 0) return this.#sortedData;

    this.#sortedData = [...this.#data].sort((a, b) => {
      const aVal = a[this.#sortField];
      const bVal = b[this.#sortField];
      const dir = this.#sortDirection === 'asc' ? 1 : -1;

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return (aVal - bVal) * dir;
      }
      return String(aVal).localeCompare(String(bVal)) * dir;
    });
    return this.#sortedData;
  }

  #invalidateSortCache() {
    this.#sortedData = [];
  }

  #openDetail(row) {
    const modal = this.querySelector('.detail-modal');
    if (!modal) return;
    const dl = modal.querySelector('.detail-list');
    if (!dl) return;
    const cols = this.columns
      ? this.columns
      : Object.keys(row).map(k => ({ key: k, label: k }));
    dl.innerHTML = cols.map(col => {
      const raw = row[col.key];
      const val = raw == null ? '' : String(raw);
      return `
        <div class="detail-item">
          <dt class="detail-key">${escHtml(col.label ?? col.key)}</dt>
          <dd class="detail-val">${escHtml(val)}</dd>
        </div>`;
    }).join('');
    modal.open();
  }

  #showError(message) {
    const el = this.querySelector('.error');
    if (el) {
      el.textContent = message;
      el.hidden = false;
    }
  }

  #hideError() {
    const el = this.querySelector('.error');
    if (el) el.hidden = true;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;

    switch (name) {
      case 'limit':
        this.limit = parseInt(newValue) || 10;
        this.#currentPage = 1;
        this.refresh();
        break;
      case 'data-fn':
        this.#dataFnName = newValue;
        this.dataFn = resolveDataSource(newValue) || null;
        this.#currentPage = 1;
        this.refresh();
        break;
      case 'search-placeholder':
        this.searchPlaceholder = newValue;
        this.querySelector('.search-field')?.setAttribute('placeholder', newValue);
        break;
      // These three change the rendered chrome, so the whole element is rebuilt
      // and its listeners rebound. #events.cleanup() first, or every rebuild
      // leaks another set of handlers onto nodes that no longer exist.
      case 'search':
      case 'detail':
      case 'pagination':
        this.#events.cleanup();
        this.#readAttributes();
        this.#currentPage = 1;
        this.#render();
        this.#setupEventListeners();
        this.refresh();
        break;
    }
  }
}

customElements.define('app-table', AppTable);
