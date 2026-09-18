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
 * @attr {boolean} detail - Present: clicking a row opens a detail modal.
 *   A boolean, not a string: `#showDetail` is `hasAttribute('detail')` and the
 *   value is never read. It was typed `{string}` here, which made it a string
 *   in the catalog, which made `detail="false"` *enable* the modal — and a
 *   generated surface writing `false` into that position (which it does, to
 *   reach `empty-message` after it) therefore turned on a row-click modal
 *   nobody asked for, on every table, silently.
 * @attr {string} empty-message - Body text when there are no rows and no query.
 * @attr {boolean} loading - Hold the skeleton: the owner has not got rows yet
 *   and will hand them over later. Present suppresses the fetch entirely, so a
 *   table waiting on data upstream never flashes its empty state first;
 *   removing it fetches. Every other data component in the design system has
 *   this, and a caller who reasonably assumed this one did too was writing an
 *   argument that landed in the next slot along.
 * @prop {Array} columns - Optional column definitions; see below. A column
 *   may set `numeric: true` — right-aligns its header and cells and, while
 *   loading, draws a short right-aligned skeleton bar instead of a wide
 *   left-aligned one, so the loading state previews the real column shape.
 * @prop {Function} dataFn - The fetcher, if not named via `data-fn`.
 * @attr {string} error - The fetch failed. Present (bare, or with a message
 *   overriding the default copy) draws the shared failure block in the table
 *   body — icon, one line, Retry — under a live header row, in place of the
 *   rows. Set automatically when this table's own `dataFn` throws; settable by
 *   an owner that feeds the table itself. `loading` wins over it.
 * @fires loading-start - Before each fetch — bubbles.
 * @fires loading-end - After each fetch — bubbles.
 * @fires table-retry - Retry pressed on the failure state — bubbles. The table
 *   also refetches through its own `dataFn` first, where it has one; the event
 *   is for an owner that supplies rows itself.
 * @note Columns are inferred from the data when `columns` is unset — keys become
 *       humanised labels and all-numeric columns right-align. Cells with no
 *       `render` are displayed through `autoFormat` (utils/units.js): a
 *       fractional number is shown to two decimals and an ISO-8601 string as
 *       local time, with the exact value kept in the cell's tooltip. This is
 *       the only formatting a generated surface can get, since `columns` is a
 *       property and the DSL reaches attributes only.
 *       Sorting is client-side over the current page and cycles
 *       unsorted → ascending → descending → unsorted, so the server's own
 *       ordering is reachable again after a sort.
 */
import { icons } from '../../utils/icons.js';
import { createEventTracker, debounce, errorStateHtml } from '../../utils/data-component-utils.js';
import '../app-empty-state/app-empty-state.js';
import { resolveOptional as resolveDataSource } from '../../core/data-sources.js';
import { escAttr, escHtml } from '../../utils/escape.js';
import { autoFormat } from '../../utils/units.js';
import '../app-button/app-button.js';
import '../app-input/app-input.js';
import '../app-modal/app-modal.js';
import '../app-skeleton/app-skeleton.js';
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./app-table.css', import.meta.url));
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

/**
 * Column definitions for data nobody described.
 *
 * Exported for the same reason `pageWindow` is: app-table.test.mjs checks it
 * directly, and it is the whole of what a generated surface gets — a Weave
 * dashboard writes `AppTable(rowsQ, 20, ...)` and can never set `columns`,
 * because that is a property and the DSL only reaches attributes.
 *
 * - `numeric`, from the values: a column is right-aligned when every non-null
 *   value in it is a number, which is what the alignment actually claims.
 *   Sampling the whole page rather than the first row matters — `avg_latency_ms`
 *   is null on the first row of most of these responses.
 * - `label`, from the key. `avg_cost_per_operation` is a header nobody would
 *   write by hand. An all-caps run is left alone, so `agent_id` reads
 *   "Agent id" but `p95_ms` keeps its p95.
 */
export function inferColumns(rows) {
  const first = rows?.[0];
  if (!first || typeof first !== 'object') return null;
  return Object.keys(first).map((key) => {
    let sawNumber = false;
    let numeric = true;
    for (const row of rows) {
      const v = row?.[key];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number' && Number.isFinite(v)) sawNumber = true;
      else { numeric = false; break; }
    }
    return { key, label: humanize(key), numeric: numeric && sawNumber };
  });
}

/** `avg_cost_per_operation` -> "Avg cost per operation". */
export function humanize(key) {
  const words = String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return String(key);
  // Sentence case, from either spelling. `bucket_start` splits to
  // ['bucket', 'start'] and `bucketStart` to ['bucket', 'Start'] — so the tail
  // has to be lowercased, or the two spellings of the same field produce two
  // different headers. An all-caps run is a word in its own right (ID, USD,
  // TTL) and is left alone in both positions.
  const shout = (w) => w.length > 1 && w === w.toUpperCase();
  const [head, ...rest] = words;
  const first = shout(head) ? head : head[0].toUpperCase() + head.slice(1).toLowerCase();
  return [first, ...rest.map((w) => (shout(w) ? w : w.toLowerCase()))].join(' ');
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
            'empty-message', 'pagination', 'loading', 'error'];
  }

  connectedCallback() {
    this.#readAttributes();

    this.#render();
    this.#setupEventListeners();
    // Deferred by a microtask: pages assign `columns` on the statement after
    // the element is created, which is after this callback has run. Waiting
    // lets the skeleton pass draw the real header and column widths, so rows
    // never move between the loading state and loaded data.
    // `loading` held on the element means the owner is still fetching and will
    // hand rows over later; fetching now would race that and paint an empty
    // table first. Draw the skeleton and wait for the attribute to come off.
    if (this.hasAttribute('loading')) queueMicrotask(() => this.#showSkeletons());
    else queueMicrotask(() => this.refresh());
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
      </div>

      ${this.#showDetail ? `
        <app-modal class="detail-modal" heading="Row Detail">
          <dl class="detail-list"></dl>
        </app-modal>
      ` : ''}
    `;
  }

  #setupEventListeners() {
    // Delegated from the host, through the tracker rather than `bindRetry`:
    // this method re-runs after every chrome rebuild, and a raw
    // addEventListener would stack one more Retry handler each time.
    this.#events.add(this, 'click', (e) => {
      if (!e.target.closest('[data-retry]')) return;
      this.dispatchEvent(new CustomEvent('table-retry', { bubbles: true }));
      // A table with its own `dataFn` can act on Retry itself; one fed by its
      // owner cannot, and the event above is that owner's cue.
      if (this.dataFn) this.refresh();
      else this.removeAttribute('error');
    });
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
    // The owner is still fetching. Anything that calls refresh() in the
    // meantime — a sort, a page change, a re-entrant attribute write — must
    // not paint an empty table over the skeleton.
    if (this.hasAttribute('loading')) { this.#showSkeletons(); return; }
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
      // An owner-fed table (no `data-fn`, `.dataFn` assigned later) normally
      // paints nothing here — an empty body before the owner has handed rows
      // over would flash the empty state. A declared `error` is the one thing
      // that must still be drawn: the owner already knows the fetch failed,
      // and staying blank is the frozen-skeleton bug this state exists to end.
      if (this.hasAttribute('error')) this.#renderTable();
      return;
    }

    this.#hideError();
    this.#showSkeletons();

    const scroll = this.querySelector('.scroll');
    // A retry that succeeds must not leave the previous failure latched.
    this.removeAttribute('error');
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
      this.#showError("Couldn't load this table");
    } finally {
      if (scroll) scroll.classList.remove('is-loading');
      this.removeAttribute('aria-busy');
      this.dispatchEvent(new CustomEvent('loading-end', { bubbles: true, detail: { message: 'Data loaded' } }));
    }
  }

  /**
   * Show skeleton rows while data loads — gives the table a stable size hint,
   * with each cell's placeholder shaped like the column it stands in rather
   * than a generic bar repeated across the row: a label-less action column
   * stays empty (there is nothing there to preview), a `numeric` column draws
   * a short bar pinned to the same edge its real value will sit at, and every
   * other column draws a wider, more text-like bar with natural row-to-row
   * variation — so the skeleton reads as "this table, loading" rather than as
   * unrelated grey noise. Built from `<app-skeleton>` (the shared shimmer
   * primitive) instead of a bare unanimated div.
   */
  #showSkeletons() {
    const thead = this.querySelector('.thead');
    const tbody = this.querySelector('.tbody');
    if (!thead || !tbody) return;
    this.setAttribute('aria-busy', 'true');
    // The placeholder columns carry an explicit flag rather than being bare
    // `{}`. A bare object reads as a column whose label is blank, which is the
    // marker for a row-action column — and an action column draws no bar. So
    // every skeleton cell on a table with no declared `columns` was empty:
    // ten rows of nothing, which is exactly the table a generated surface has,
    // since `columns` is a property the DSL cannot reach.
    const cols = this.columns || Array.from({ length: 4 }, () => ({ placeholder: true }));
    if (!this.#data.length) {
      this.#renderColgroup(this.columns);
      this.#renderHead(this.columns);
    }
    // Two separate pools rather than one shared set of widths: a number is
    // short regardless of which row it is in, while a name/label column's
    // width is where the row-to-row variation belongs — mirroring how real
    // data actually varies per column, not per row. Fixed pixel widths, not
    // percentages: these columns have no declared `width` (no <colgroup>),
    // so the table is auto-laid-out — a percentage on a skeleton bar would be
    // resolving against a column width the browser has not settled on yet.
    const TEXT_WIDTHS = ['150px', '96px', '128px', '80px', '168px', '112px', '92px', '140px'];
    const NUMERIC_WIDTHS = ['42px', '58px', '48px', '66px', '38px', '52px', '60px', '46px'];
    const skeletonRow = (i) => {
      const cells = cols.map((col, j) => {
        // Only a *declared* column can be an action column. "No columns yet"
        // is not the same statement as "this column is deliberately blank".
        const plain = !col.placeholder && !String(col.label ?? col.key ?? '').trim();
        if (plain) return '<td class="td is-plain"></td>';
        const width = col.numeric
          ? NUMERIC_WIDTHS[(i + j) % NUMERIC_WIDTHS.length]
          : TEXT_WIDTHS[(i * 3 + j) % TEXT_WIDTHS.length];
        const style = `display:block;width:${width}${col.numeric ? ';margin-inline-start:auto' : ''}`;
        return `<td class="td${col.numeric ? ' is-numeric' : ''}">`
          + `<app-skeleton height="0.85em" radius="sm" style="${style}"></app-skeleton></td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    };
    const rowCount = this.#paginate ? this.limit : Math.min(this.limit, 10);
    tbody.innerHTML = Array.from({ length: rowCount }, (_, i) => skeletonRow(i)).join('');
  }

  #renderTable() {
    const thead = this.querySelector('.thead');
    const tbody = this.querySelector('.tbody');
    if (!thead || !tbody) return;

    const failed = this.hasAttribute('error');
    if (failed || !this.#data || this.#data.length === 0) {
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
      // colspan takes an integer — "100%" is invalid HTML that browsers happen
      // to clamp. Span the real column count (1 when none is known yet).
      const span = this.columns?.length
        || this.querySelector('.thead tr')?.children.length || 1;
      // A failure and an empty result are different answers and no longer
      // share a cell: the failure is checked first, because a throw leaves
      // `#data` empty too and would otherwise read as "nothing here yet".
      const body = failed
        ? errorStateHtml(this.getAttribute('error') || "Couldn't load this table")
        : `<app-empty-state inline description="${escAttr(message)}"></app-empty-state>`;
      tbody.innerHTML = `<tr><td class="empty" colspan="${span}">${body}</td></tr>`;
      return;
    }

    const cols = this.columns ? this.columns : inferColumns(this.#data);

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
        // A column with its own `render` owns its formatting completely. Every
        // other column is displayed through autoFormat, which is the only
        // formatting a generated surface can reach: `columns` is a property,
        // so nothing in the Weave DSL can set a renderer, and without this a
        // cost renders as 0.023456789012 and a bucket as 2026-09-09T14:00:00Z.
        const shown = col.render ? null : autoFormat(raw);
        // The tooltip holds the unshortened value, but only where there is one
        // — `title="null"` on every gap in the data is worse than no tooltip.
        const exact = raw === null || raw === undefined || String(raw) === shown
          ? '' : ` title="${escAttr(raw)}"`;
        const cell = col.render
          ? col.render(raw, row)
          : `<span${exact}>${escHtml(shown)}</span>`;
        // `is-plain` mirrors the header marker for label-less (row-action)
        // columns, so CSS can pin the action cell and its header together.
        const plain = !String(col.label ?? col.key).trim() ? ' is-plain' : '';
        const numeric = col.numeric ? ' is-numeric' : '';
        return `<td class="td${col.wrap ? ' is-wrap' : ''}${plain}${numeric}">${cell}</td>`;
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
        <th class="th${col.numeric ? ' is-numeric' : ''}"
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

  /**
   * Failure is an attribute now, not a hidden banner below the table.
   *
   * The banner said "Failed to load data" in a strip under an otherwise
   * normal-looking empty table — two contradictory answers on screen at once,
   * and the one the eye lands on first was the wrong one. The state belongs
   * where the rows would have been.
   */
  #showError(message) {
    this.setAttribute('error', message);
    this.#renderTable();
  }

  #hideError() {
    this.removeAttribute('error');
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
      case 'error':
        // Owner-set (it feeds the rows itself) or self-set from a throw; both
        // land here and repaint the body. Skip while `loading` holds — the
        // skeleton is the more recent truth.
        if (!this.hasAttribute('loading')) this.#renderTable();
        break;
      case 'loading':
        // Held: draw the skeleton the element already owns. Released: fetch.
        // The skeleton is the same one #fetch draws, so the two states cannot
        // drift apart.
        if (newValue === null) this.refresh();
        else this.#showSkeletons();
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
