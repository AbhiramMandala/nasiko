/**
 * TokenOps dashboard — FinOps: headline spend KPIs, two plots (spend over time ·
 * spend concentration) and per-agent/per-workflow attribution.
 *
 * @element tokenops-page
 * @note Data sources (see `tokensopsapis.md`, the backend handoff this page is
 *       wired against — `/api/observability/finops/*`):
 *       `call('fetchTokenopsDashboard', { range?, startTime?, endTime?, agentId?, model?, provider?, orgUnit?, view? })`
 *         → GET .../finops/dashboard — `{ data: { kpis, summary, agents,
 *           attributions } }`. `kpis` (`total_spend`/`total_tokens`/
 *           `cost_per_operation`/`avg_latency_ms`, each `{ current, previous,
 *           change_pct }`) is the KPI strip — the backend computes the delta
 *           itself now, so there is no second "fetch the previous window"
 *           round trip any more. `attributions.rows` (view-aware) is the
 *           table; `agents` stays agent-view-only, for the agent filter and
 *           the concentration panel's day drill-down. A row's `is_capped`
 *           gets a "~approx" badge — a real, undercounted-by-design number for
 *           very high-volume agents, not a bug.
 *       `call('fetchSpendTimeseries', { range?, startTime?, endTime?, agentId?, model? })`
 *         → GET .../finops/spend-timeseries — `{ bucket, points: [{
 *           bucket_start, spend_usd, operations }] }`. Dollar-only: the old
 *           `%`/`$` toggle and the anomaly detector are both gone, because
 *           neither exists against this endpoint (no anomaly service on the
 *           backend at all yet — see the doc's point 7).
 *       `call('fetchSpendCalendarDay', { date, agentId?, model? })`
 *         → GET .../finops/spend-calendar/day — one CALENDAR DAY (not the
 *           filter window): `{ hours: 24 x { hour, spend_usd, top_agents,
 *           others_spend_usd }, avg_hourly_spend_usd, top_agents,
 *           others_spend_usd }`. Confirmed against a live capture: every hour
 *           carries its OWN top_agents/others_spend_usd, a real per-hour
 *           ranking — not only the day-wide one at the top level. This panel
 *           draws the "segmented" (stacked-by-agent) bar form (`<app-chart
 *           segmented average-line>`), one series per day-level top-4 agent
 *           plus "Others", each read off its own hour's top_agents; the
 *           dashed rule IS `avg_hourly_spend_usd`, and the legend is the
 *           day-level top-4/others ranking, which is exactly the "Operation
 *           agent / Operation agent / Others" shape the doc describes. A day
 *           picker next to the panel title drives it, independent of the KPI
 *           strip's month/range window.
 *
 *       `fetchSpendCalendar` (the month heatmap) and `fetchFinopsAttributions`
 *       (standalone, sortable/paginated table source) are registered in
 *       usage-service.js and ready to use, but no panel calls them yet: there
 *       is no month-heatmap UI in this screen, and the table still sorts
 *       in-memory over the one dashboard payload rather than round-tripping a
 *       sort click — see the header note on `fetchFinopsAttributions`.
 *
 *       Server has no dimension in the API at all and stays disabled — see
 *       `INERT_FILTERS`. Provider/Model/Org unit are real filters, confirmed
 *       against `oss/server/src/observability/handler.rs`: `model`/`provider`
 *       filter `trace_usage` on every finops endpoint; `org_unit` is EE-only
 *       (`ee/server/src/finops_scope.rs` resolves it to `user_id`s) and only
 *       `dashboard` reads it — the other four endpoints ignore it entirely,
 *       and OSS ignores it outright (no org hierarchy). Their options come
 *       from two catalogs that already exist for other pages, not a new
 *       backend endpoint:
 *       `call('fetchLlmProviders')` → GET `/llm-router/providers` (the same
 *         call `llm-router-page.js` makes) gives Provider and Model their
 *         dropdown contents. One wrinkle: this endpoint normalizes
 *         `model_pricing.provider` for display (today, only `google` →
 *         `gemini` — `providers.rs::normalize_provider`), but `trace_usage
 *         .provider` — what the finops filter actually matches — keeps the
 *         raw value. `PROVIDER_FILTER_VALUE` below maps the display value
 *         back before it is sent, so picking "gemini" does not silently
 *         return zero rows. Delete that shim the day the backend exposes the
 *         raw value (or normalizes `trace_usage.provider` to match).
 *       `call('fetchOrgUnits')` → GET `/org/units` (flat, `ee/server/src
 *         /org_units.rs`) needs `can_read_org` (manager-or-above or
 *         superuser) — same gate the org chart itself uses — so a lower-role
 *         caller, or an OSS build where the route is not even mounted, sees
 *         the filter stay disabled rather than an empty or broken dropdown.
 *         `org-unit-service.js` (where this call lives) is only registered
 *         on the SPA router path today, not on this standalone page, so this
 *         page dynamic-imports it itself before calling — see
 *         `#loadFilterOptions`.
 *
 *       A 400 from any of these (bad `range`, bad `view`, bad date, an
 *       unresolvable `agent_id`) carries a human-readable plain-text body,
 *       which `fetchApi` already turns into `err.message` — surfaced with
 *       `toast.error()` rather than swallowed.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./tokenops-page.css', import.meta.url));
import { escAttr, escHtml } from '/common/utils/escape.js';
import { icons } from '/common/utils/icons.js';
import { toast } from '/common/utils/toast.js';
import { ApiError } from '../core/errors.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-chart/app-chart.js';
import '/common/design-system/app-segmented-control/app-segmented-control.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-table/app-table.js';
import { call } from '../core/data-sources.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const DAY_MS = 86_400_000;

const fmtTokens = (n) => {
  if (n == null) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
};
const fmtCost = (n) => `$${(n ?? 0).toFixed(3)}`;
/** The headline figure is cents — three decimals is a table column's precision. */
const fmtCostShort = (n) => `$${(n ?? 0).toFixed(2)}`;
/** Headline money: whole dollars once the figure is big enough not to need cents. */
const fmtMoney = (n) => (Math.abs(n ?? 0) >= 100
  ? `$${Math.round(n).toLocaleString()}`
  : `$${(n ?? 0).toFixed(2)}`);
const fmtNum = (n) => (n ?? 0).toFixed(1);
const fmtLatency = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
/** Sub-second latencies read better in ms — the KPI figure, not the table cell. */
const fmtLatencyShort = (ms) => (ms == null ? '—'
  : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtCount = (n) => (n ?? 0).toLocaleString();

/**
 * Read the first present key off a row. The exact field spelling an
 * attribution row uses is not pinned down by the handoff doc (it gives
 * `sort_by` value names — `cost`, `tokens`, `avg_latency` — not a JSON
 * example), so `#normalizeRow` below checks the short `sort_by`-style name
 * first and falls back to the longer name `data.agents` has always used, once,
 * at load time — everything downstream (columns, sort, CSV, the table's own
 * click-to-sort headers) then reads one fixed, real property name, the same
 * way `data.agents` rows have always worked.
 */
const pick = (r, ...keys) => {
  for (const k of keys) if (r[k] != null) return r[k];
  return undefined;
};

/** `csv` is the export value for the column; the table renders `render`. Keys
 *  match `#normalizeRow`'s output exactly, so <app-table>'s own click-to-sort
 *  headers (which read `row[col.key]` directly) work without going through
 *  `pick()` a second time. */
const AGENT_COLUMNS = [
  { key: 'agent_name', label: 'Agent',
    render: (v, r) => `<span class="agent-name">${escHtml(v || r.agent_id)
    }${r.is_capped ? ' <app-badge variant="warning" title="High-volume agent — this number is a real but undercounted approximation">~approx</app-badge>' : ''}</span>`,
    csv: (r) => r.agent_name },
  { key: 'total_cost', label: 'Spend', numeric: true, render: fmtMoney },
  { key: 'total_tokens', label: 'Tokens', numeric: true, render: fmtTokens },
  { key: 'completion_tokens', label: 'Output', numeric: true, render: (v) => (v == null ? '—' : fmtTokens(v)) },
  { key: 'prompt_tokens', label: 'Input', numeric: true, render: (v) => (v == null ? '—' : fmtTokens(v)) },
  { key: 'operations', label: 'Operations', numeric: true, render: fmtCount },
  { key: 'avg_cost_per_operation', label: 'Avg cost/op', numeric: true, render: (v) => (v == null ? '—' : fmtCost(v)) },
  { key: 'container_hours', label: 'Agent hours', numeric: true, render: (v) => (v == null ? '—' : fmtNum(v)) },
  { key: 'avg_latency_ms', label: 'Avg latency', numeric: true, render: fmtLatency },
];

/** Workflow rows carry no replica-hours or token-split columns — those are
 *  agent-execution concepts `sort_by`'s workflow-view value list has no
 *  equivalent for (`container_hours` only appears in the agent list). */
const WORKFLOW_COLUMNS = [
  { key: 'workflow_name', label: 'Workflow',
    render: (v, r) => `<span class="agent-name">${escHtml(v || r.workflow_id)}</span>`,
    csv: (r) => r.workflow_name },
  { key: 'total_cost', label: 'Spend', numeric: true, render: fmtMoney },
  { key: 'total_tokens', label: 'Tokens', numeric: true, render: fmtTokens },
  { key: 'operations', label: 'Operations', numeric: true, render: fmtCount },
  { key: 'avg_latency_ms', label: 'Avg latency', numeric: true, render: fmtLatency },
];

/** `sort_by` value lists from the handoff doc, one label per value — there is
 *  no predefined label list on the backend, so this mapping is ours to own.
 *  `field` matches the normalized row property, not the raw `sort_by` value. */
const AGENT_SORTS = [
  { value: 'cost', label: 'Highest spend', field: 'total_cost' },
  { value: 'tokens', label: 'Most tokens', field: 'total_tokens' },
  { value: 'operations', label: 'Most operations', field: 'operations' },
  { value: 'avg_latency', label: 'Slowest', field: 'avg_latency_ms' },
  { value: 'container_hours', label: 'Most agent hours', field: 'container_hours' },
  { value: 'name', label: 'Name', field: 'agent_name' },
];
const WORKFLOW_SORTS = [
  { value: 'cost', label: 'Highest spend', field: 'total_cost' },
  { value: 'tokens', label: 'Most tokens', field: 'total_tokens' },
  { value: 'operations', label: 'Most operations', field: 'operations' },
  { value: 'avg_latency', label: 'Slowest', field: 'avg_latency_ms' },
  { value: 'name', label: 'Name', field: 'workflow_name' },
];

/** Fixed windows, relative to now. No selection here means the month select owns
 *  the window instead — the two controls write the same start/end. */
const RANGES = [
  { value: '24h', label: '24h', days: 1 },
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
];

const ATTR_MODES = [
  { value: 'agent', label: 'Agent' },
  { value: 'workflow', label: 'Workflow' },
];

/**
 * The one filter with no dimension in the API at all — permanently disabled,
 * unlike Provider/Model/Org unit below, which start disabled only until
 * their options load (or, for Org unit, stay disabled if it turns out this
 * caller/build cannot use it — see `#loadFilterOptions`).
 */
const INERT_FILTERS = [
  { id: 'server-select', label: 'Server',
    why: 'No server dimension in the FinOps API.' },
];

/** Real filters whose options load asynchronously — see `#loadFilterOptions`. */
const ASYNC_FILTERS = [
  { id: 'provider-select', label: 'Provider' },
  { id: 'model-select', label: 'Model' },
  { id: 'org-select', label: 'Org unit' },
];

/**
 * `GET /llm-router/providers` normalizes some `model_pricing.provider` values
 * for display — today, only `google` → `gemini` (`oss/server/src/llm_router
 * /providers.rs::normalize_provider`) — but `trace_usage.provider` (what the
 * finops `provider` filter actually matches) keeps the raw value the trace
 * materializer copied straight out of `model_pricing`. Sending the display
 * label as the filter would silently match zero rows for real Gemini spend.
 * Only this one case is known to differ today; delete this the day the
 * backend exposes the raw value (or normalizes `trace_usage.provider` too).
 */
const PROVIDER_FILTER_VALUE = { gemini: 'google' };

const sum = (ns) => ns.reduce((a, b) => a + b, 0);

/**
 * The movement chip for one KPI, from the backend's own `change_pct` — no
 * client-side current/previous division any more. `null` ("no previous data
 * to compare") renders as a dash, never "0%": that was the doc's explicit
 * requirement (§1), and it is also just honest — a dash and "unchanged" are
 * different claims. `goodWhen` is the direction that is good news — spend
 * rising is bad, so it passes `'down'`. The arrow is the *direction* and the
 * tint is the *sentiment*, so a rising cost is an up arrow in an amber chip.
 */
function deltaChip(changePct, goodWhen) {
  if (changePct === null || changePct === undefined || !Number.isFinite(changePct)) {
    return { delta: null, trend: 'neutral' };
  }
  const good = changePct > 0 ? goodWhen === 'up' : goodWhen === 'down';
  return {
    delta: `${Math.abs(changePct).toFixed(1)}%`,
    dir: changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat',
    trend: changePct === 0 ? 'neutral' : good ? 'up' : 'down',
  };
}

/**
 * One KPI: movement chip on the left, value over label on the right. Plain divs
 * — the strip is this screen's own shape (no hairlines, a chip per metric), not
 * the shared `app-stat-row` one.
 *
 * `sub` is the `title`: the design gives the cell two lines, and the caption is
 * context for the figure rather than a number of its own.
 *
 * One arrow glyph for all three directions — `arrowUpRight` rotated by CSS, so
 * there is no second icon that can drift from the first.
 */
function kpiHtml({ label, value, sub, delta, dir, trend }) {
  return `
    <div class="kpi"${sub ? ` title="${escAttr(sub)}"` : ''}>
      <div class="kpi-chip is-${trend} dir-${dir ?? 'none'}">
        ${delta === null
          ? '<span class="kpi-none" aria-hidden="true">—</span>'
          : icons.arrowUpRight('kpi-arrow', 14)}
        <span class="kpi-delta">${escHtml(delta ?? '')}</span>
      </div>
      <div class="kpi-text">
        <div class="kpi-value">${escHtml(value == null || value === '' ? '—' : String(value))}</div>
        <div class="kpi-label">${escHtml(label)}</div>
      </div>
    </div>`;
}

/** Four cells of the real geometry, so the strip does not resize on data. */
const KPI_SKELETON = Array.from({ length: 4 }, () => `
  <div class="kpi">
    <div class="kpi-chip is-neutral"><span class="kpi-skel kpi-skel--chip"></span></div>
    <div class="kpi-text">
      <div class="kpi-skel kpi-skel--value"></div>
      <div class="kpi-skel kpi-skel--label"></div>
    </div>
  </div>`).join('');

/** `YYYY-MM-DD` in local time — `toISOString()` would drift a day near
 *  midnight in timezones ahead of UTC, which is exactly the case this feeds
 *  (the day picker's default value). */
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class TokenopsPage extends HTMLElement {
  #initialized = false;
  #agents = [];
  #summary = {};
  #kpis = null;
  #attributions = [];
  /** `agent` | `workflow` — which shape `#attributions` and the sort list are in. */
  #attrView = 'agent';
  /** `{ bucket: 'hour'|'day', points: [...] }` from `/finops/spend-timeseries`. */
  #spend = { bucket: 'day', points: [] };
  /** `/finops/spend-calendar/day` response for the selected `#day`, or `null`
   *  while it has not loaded yet. */
  #dayDrill = null;
  /** The concentration panel's own selection — independent of the KPI strip's
   *  month/range window (the endpoint takes a single `date`, not a range). */
  #day = localDateStr(new Date());
  /** Window start/end as Dates — written by the month select and the range group. */
  #start = null;
  #end = null;
  #range = '30d';
  /**
   * Which control actually drives the window. The two are independently
   * displayed now — the range strip keeps whatever preset was last picked lit
   * (30d by default) instead of going blank the moment a month is chosen —
   * but only one of them can be authoritative for `#resolveWindow()` and the
   * `range` param sent to the backend: `range` (24h|7d|30d) wins over
   * `start_time`/`end_time` server-side whenever both are sent (see
   * usage-service.js's fetchTokenopsDashboard note), so sending it while a
   * month is selected would silently make the month a no-op — the backend
   * would just re-derive "last 30 days from now" and ignore the picked month
   * entirely. `#load()` omits `range` whenever this is `'month'`.
   */
  #windowSource = 'range';
  #agentFilter = '';
  #providerFilter = '';
  #modelFilter = '';
  #orgUnitFilter = '';
  #sort = 'cost';
  /** The in-flight dashboard fetch — the table awaits it, so its own skeleton
   *  rows are the page's loading state. */
  #pending = null;
  /** Bumped per load. Requests fan out per window and a second window can be
   *  picked mid-flight, so every one of them checks this before writing:
   *  otherwise a slow August response overwrites the September numbers. */
  #loadId = 0;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <div class="page-head">
        <h1 class="title-page">TokenOps</h1>
        <app-button variant="tertiary" size="md" id="export-btn">Export report</app-button>
      </div>

      <div class="filter-bar">
        <app-select id="month-select" size="md" aria-label="Period"
          >${this.#monthOptions()}</app-select>
        <div class="filter-group">
          <app-segmented-control id="range-seg" size="sm" label="Time range"></app-segmented-control>
          <app-select id="agent-select" size="md" fit-content
            placeholder="Agent" aria-label="Agent"></app-select>
          ${ASYNC_FILTERS.map((f) => `
            <app-select id="${f.id}" size="md" disabled fit-content
              placeholder="${escAttr(f.label)}" aria-label="${escAttr(f.label)}"
              title="${escAttr(`Loading ${f.label.toLowerCase()} options…`)}"></app-select>`).join('')}
          ${INERT_FILTERS.map((f) => `
            <app-select id="${f.id}" size="md" disabled
              placeholder="${escAttr(f.label)}" aria-label="${escAttr(f.label)}"
              title="${escAttr(`${f.label} filter unavailable — ${f.why}`)}"></app-select>`).join('')}
        </div>
      </div>

      <div class="kpi-strip" id="kpi-strip" aria-busy="true">${KPI_SKELETON}</div>

      <div class="panels">
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Spend over time</h2>
          </div>
          <div class="chart-card">
            <div class="panel-tools">
              <ul class="series-legend" id="spend-legend" aria-label="Series"></ul>
            </div>
            <app-chart id="spend-plot" class="plot-slot" type="line" format="currency" format-y2="compact" height="300px"
              flush-top legend="off" label="Spend over time" empty-text="No usage in this window" loading></app-chart>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Spend concentration</h2>
          </div>
          <div class="conc-body">
            <div class="chart-card conc-plot-col">
              <div class="day-grid" id="day-grid" role="group" aria-label="Day"></div>
              <app-chart id="conc-plot" class="plot-slot" type="bar" segmented average-line flush-top legend="off" height="220px"
                format="currency" label="Spend by hour of day"
                empty-text="No spend on this day" loading></app-chart>
            </div>
            <ul class="conc-legend" id="conc-legend"></ul>
          </div>
          <p class="anomaly-note" id="conc-note"></p>
        </section>
      </div>

      <div class="section-head">
        <h2 class="section-title">Attributions</h2>
        <div class="section-tools">
          <app-segmented-control id="attr-seg"
            size="sm" label="Attribute by"></app-segmented-control>
          <app-select id="sort-select" size="md" aria-label="Sort"
            options='${JSON.stringify(AGENT_SORTS)}'></app-select>
        </div>
      </div>
      <app-table id="cost-table" pagination="none" search
        search-placeholder="Search by name..."
        empty-message="No activity in this period"></app-table>
    `;

    // Segment sets are data, not markup: assigned as properties so no JSON has
    // to be escaped into an attribute at a call site.
    this.#segment('#range-seg', RANGES.map((r) => ({ value: r.value, label: r.label })), this.#range);
    this.#segment('#attr-seg', ATTR_MODES, this.#attrView);
    this.#renderDayGrid();

    const table = this.querySelector('#cost-table');
    table.columns = AGENT_COLUMNS;
    // Filtering and sorting are in-memory over the one dashboard payload, so
    // "fetching" a page is just awaiting the load that is already in flight.
    table.dataFn = async (query) => {
      await this.#pending;
      return this.#visibleRows(query);
    };

    this.querySelector('#month-select').addEventListener('change', () => {
      // The range strip is left exactly as it was (30d, by default) — it is
      // no longer the source of truth once a month is picked, just a label
      // that keeps reading as "not broken". #resolveWindow() and #load()'s
      // `range` param both key off #windowSource, not off whether #range-seg
      // happens to show something.
      this.#windowSource = 'month';
      // The day picker is keyed to a single date, not a window, so a month
      // jump has to move it too or it keeps showing the OLD month's days
      // (see the comment on #syncDayToSelectedMonth).
      this.#syncDayToSelectedMonth();
      this.#renderDayGrid();
      this.#load();
    });
    this.querySelector('#range-seg').addEventListener('change', (e) => {
      this.#range = e.target.value;
      this.#windowSource = 'range';
      this.#load();
    });
    this.querySelector('#agent-select').addEventListener('change', (e) => {
      // `agent_id` is a real server-side param on every finops endpoint now,
      // not just an in-memory row filter — so this reloads everything the
      // window drives, same as a range change.
      this.#agentFilter = e.target.value;
      this.#load();
    });
    this.querySelector('#attr-seg').addEventListener('change', (e) => {
      this.#attrView = e.target.value || 'agent';
      const isAgent = this.#attrView === 'agent';
      table.columns = isAgent ? AGENT_COLUMNS : WORKFLOW_COLUMNS;
      const sorts = isAgent ? AGENT_SORTS : WORKFLOW_SORTS;
      const sortSelect = this.querySelector('#sort-select');
      sortSelect.setAttribute('options', JSON.stringify(sorts));
      this.#sort = 'cost';
      sortSelect.value = this.#sort;
      // The rows themselves are view-shaped server-side (`data.attributions`
      // respects `view`), so this needs the dashboard re-fetched, not just a
      // local re-render.
      this.#load();
    });
    this.querySelector('#sort-select').addEventListener('change', (e) => {
      this.#sort = e.target.value;
      table.refresh();
    });
    // The grid is redrawn (not just re-flagged) on every pick: the selected
    // cell moves and, at a month boundary, the whole day count could change.
    this.querySelector('#day-grid').addEventListener('click', (e) => {
      const cell = e.target.closest('.day-cell');
      if (!cell || cell.disabled) return;
      this.#day = cell.dataset.date;
      this.#renderDayGrid();
      this.#loadDay(this.#loadId);
    });
    this.querySelector('#provider-select').addEventListener('change', (e) => {
      this.#providerFilter = e.target.value;
      this.#load();
    });
    this.querySelector('#model-select').addEventListener('change', (e) => {
      this.#modelFilter = e.target.value;
      this.#load();
    });
    this.querySelector('#org-select').addEventListener('change', (e) => {
      this.#orgUnitFilter = e.target.value;
      this.#load();
    });
    this.querySelector('#export-btn').addEventListener('click', () => this.#exportCsv());

    this.#load();
    this.#loadFilterOptions();
  }

  #segment(selector, items, value) {
    const control = this.querySelector(selector);
    control.items = items;
    control.value = value;
  }

  /**
   * Current + previous 5 months, most recent first. Each option carries both
   * bounds: sending only a start made every past month mean "that month
   * through today" instead of that month.
   */
  #monthOptions() {
    const fmt = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' });
    const now = new Date();
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      return `<option value="${d.toISOString()}" data-end="${end.toISOString()}">${fmt.format(d)}</option>`;
    }).join('');
  }

  /** `#windowSource` (not whichever control looks selected) decides the
   *  window — see the field's own comment for why they had to be split. */
  #resolveWindow() {
    if (this.#windowSource === 'range') {
      const range = RANGES.find((r) => r.value === this.#range) || RANGES[RANGES.length - 1];
      this.#end = new Date();
      this.#start = new Date(this.#end.getTime() - range.days * DAY_MS);
      return;
    }
    const select = this.querySelector('#month-select');
    this.#start = new Date(select.value);
    const end = select.select?.selectedOptions[0]?.dataset.end;
    this.#end = end ? new Date(end) : new Date();
  }

  /** Surface a 400's human-readable body (bad range/view/date/agent_id — the
   *  doc's own wording, already in `err.message`) rather than swallow it. */
  #reportError(err, what) {
    console.error(`TokenOps ${what} fetch failed:`, err);
    if (err instanceof ApiError && err.isClientError) {
      toast.error(err.message || `${what} request was rejected`);
    }
  }

  /**
   * The dashboard call feeds the KPI strip and both chart panels, and none of
   * the three has a failure path of its own — they only ever leave their
   * loading state inside `#renderSummary`/`#renderSpend`/`#renderConcentration`,
   * which `#load()` only reaches once the dashboard call has actually
   * succeeded. Called from that call's `catch` so a failed dashboard fetch
   * shows a real "couldn't load" state instead of an indefinite skeleton.
   * The attributions table needs none of this — its own `dataFn` awaits the
   * same rejected `#pending` and surfaces the failure itself (see app-table's
   * `refresh()`).
   */
  #renderLoadFailure() {
    const strip = this.querySelector('#kpi-strip');
    strip.removeAttribute('aria-busy');
    strip.innerHTML = `
      <div class="kpi-error" role="alert">
        <span>Couldn't load usage data.</span>
        <app-button id="kpi-retry" variant="tertiary" size="sm">Retry</app-button>
      </div>`;
    strip.querySelector('#kpi-retry')?.addEventListener('click', () => this.#load());

    // Both charts already know how to show an empty state (`empty-text`) —
    // reused here for the failure case too, just overridden with a message
    // that says "couldn't load" instead of "no data". #renderSpend and
    // #renderConcentration each restore their own default text on the next
    // successful load, so a later genuine empty window doesn't inherit this.
    const spendChart = this.querySelector('#spend-plot');
    spendChart.removeAttribute('loading');
    spendChart.setAttribute('empty-text', "Couldn't load this chart");
    spendChart.data = { labels: [], datasets: [] };

    this.#dayDrill = null;
    // #renderConcentration() resets empty-text to its own default on every
    // call (see the comment there), so the override has to come after it
    // runs, not before.
    this.#renderConcentration();
    this.querySelector('#conc-plot').setAttribute('empty-text', "Couldn't load this chart");
  }

  /**
   * The display value a user picks from Provider can differ from the raw
   * value the finops API needs to match — see `PROVIDER_FILTER_VALUE`.
   */
  #providerFilterValue() {
    if (!this.#providerFilter) return undefined;
    return PROVIDER_FILTER_VALUE[this.#providerFilter] || this.#providerFilter;
  }

  /**
   * Populates Provider/Model/Org unit once, in parallel with the first
   * `#load()` — none of the three block the page's real data from showing.
   *
   * Provider/Model share one call: `fetchLlmProviders` (already registered
   * by `llm-service.js`, which every page's barrel import loads) groups
   * currently-effective models by provider. Org unit needs its own service
   * module dynamic-imported first: `org-unit-service.js` only self-registers
   * on the SPA router path (`ee/web/services/data-functions.js`), and this
   * page is a standalone document outside that path, same as the other
   * standalone EE documents that import their own service script directly.
   * On an OSS build the import 404s; either way, `call('fetchOrgUnits')`
   * throwing (import failed, route absent, or a non-manager's 403) is
   * treated as "not available", same reasoning `mcp-detail-page.js`'s
   * `#routeExists` uses for this exact route.
   */
  async #loadFilterOptions() {
    try {
      const resp = await call('fetchLlmProviders');
      const catalog = resp?.data ?? resp ?? [];
      this.#renderProviderOptions(catalog);
      this.#renderModelOptions(catalog);
    } catch (e) {
      console.error('TokenOps provider/model catalog fetch failed:', e);
    }

    try {
      await import('/services/org-unit-service.js');
      const resp = await call('fetchOrgUnits');
      this.#renderOrgUnitOptions(resp?.data ?? resp ?? []);
    } catch {
      const select = this.querySelector('#org-select');
      select.title = 'Org unit filter unavailable — no organization hierarchy configured, or you do not have access to view it.';
    }
  }

  #renderProviderOptions(catalog) {
    const select = this.querySelector('#provider-select');
    const options = catalog.map((p) => ({ value: p.provider, label: p.provider }));
    if (!options.length) return; // leave disabled — nothing real to offer
    select.setAttribute('options', JSON.stringify([{ value: '', label: 'All' }, ...options]));
    select.removeAttribute('disabled');
    select.removeAttribute('title');
  }

  #renderModelOptions(catalog) {
    const select = this.querySelector('#model-select');
    const models = [...new Set(catalog.flatMap((p) => (p.models ?? []).map((m) => m.model)))].sort();
    if (!models.length) return;
    select.setAttribute('options', JSON.stringify([
      { value: '', label: 'All' },
      ...models.map((m) => ({ value: m, label: m })),
    ]));
    select.removeAttribute('disabled');
    select.removeAttribute('title');
  }

  /**
   * `depth` (1 = a root unit) indents the label so the hierarchy still reads
   * in a flat dropdown. Rows already arrive in `path` order (a parent before
   * its children — `org_units.rs::list_units`), so no client-side sort.
   */
  #renderOrgUnitOptions(units) {
    if (!Array.isArray(units) || !units.length) return; // stays disabled — see #loadFilterOptions
    const select = this.querySelector('#org-select');
    select.setAttribute('options', JSON.stringify([
      { value: '', label: 'All' },
      ...units.map((u) => ({ value: u.id, label: `${'—'.repeat(Math.max((u.depth ?? 1) - 1, 0))} ${u.name}`.trim() })),
    ]));
    select.removeAttribute('disabled');
    select.removeAttribute('title');
  }

  async #load() {
    const id = ++this.#loadId;
    this.#resolveWindow();
    const start = this.#start.toISOString();
    const end = this.#end.toISOString();
    const params = {
      // Sent only when the range strip actually owns the window: the backend
      // takes `range` over `start_time`/`end_time` whenever both arrive, so
      // sending it while a month is selected would overrule the month with
      // "last 30 days from now" despite start/end correctly bounding that
      // month (see #windowSource's comment).
      range: this.#windowSource === 'range' ? (this.#range || undefined) : undefined,
      startTime: start,
      endTime: end,
      agentId: this.#agentFilter || undefined,
      model: this.#modelFilter || undefined,
      provider: this.#providerFilterValue(),
      orgUnit: this.#orgUnitFilter || undefined,
      view: this.#attrView,
    };

    // Assigned before the first await so the table's initial refresh — queued a
    // microtask after this element's markup was parsed — awaits this fetch
    // rather than seeing an empty agent list.
    this.#pending = call('fetchTokenopsDashboard', params);
    const table = this.querySelector('#cost-table');
    table.refresh();
    const strip = this.querySelector('#kpi-strip');
    strip.setAttribute('aria-busy', 'true');
    strip.innerHTML = KPI_SKELETON;
    this.querySelector('#spend-plot').setAttribute('loading', '');

    let resp;
    try {
      resp = await this.#pending;
    } catch (e) {
      // The table surfaces the failure itself — its dataFn awaits the same
      // rejected promise. The KPI strip and both charts have no such path of
      // their own, though: #loadSpend/#loadDay are only reached below, on the
      // success side of this try, and each of those clears the loading flag
      // it set above (`aria-busy` / `loading`) as part of its own render, so
      // skipping them here — via this early `return` — left all three stuck
      // on their loading skeleton forever instead of showing a real failure.
      this.#reportError(e, 'dashboard');
      if (id !== this.#loadId) return;
      this.#renderLoadFailure();
      return;
    }
    if (id !== this.#loadId) return;
    const data = resp?.data ?? resp ?? {};
    this.#agents = data.agents || [];
    this.#summary = data.summary || {};
    this.#kpis = data.kpis || null;
    const rawRows = data.attributions?.rows ?? data.agents ?? [];
    this.#attributions = rawRows.map((r) => this.#normalizeRow(r));
    this.#renderAgentOptions();
    table.refresh();
    this.#renderSummary();

    // "Spend over time" and the concentration day-drill each absorb their own
    // failure — one bad call must not blank the whole page.
    this.#loadSpend(id, params);
    // The day picker is independent of the window, but the agent filter still
    // applies to it — re-pull it on every load, not only when the day changes.
    this.#loadDay(id);
  }

  async #loadSpend(id, params) {
    try {
      const resp = await call('fetchSpendTimeseries', params);
      if (id !== this.#loadId) return;
      const data = resp?.data ?? resp ?? {};
      this.#spend = { bucket: data.bucket || 'day', points: Array.isArray(data.points) ? data.points : [] };
    } catch (e) {
      this.#reportError(e, 'spend-timeseries');
      if (id !== this.#loadId) return;
      this.#spend = { bucket: 'day', points: [] };
    }
    this.#renderSpend();
  }

  async #loadDay(id) {
    const chart = this.querySelector('#conc-plot');
    chart.setAttribute('loading', '');
    try {
      const resp = await call('fetchSpendCalendarDay', {
        date: this.#day,
        agentId: this.#agentFilter || undefined,
        model: this.#modelFilter || undefined,
        provider: this.#providerFilterValue(),
      });
      if (id !== this.#loadId) return;
      this.#dayDrill = resp?.data ?? resp ?? null;
    } catch (e) {
      this.#reportError(e, 'spend-calendar/day');
      if (id !== this.#loadId) return;
      this.#dayDrill = null;
    }
    this.#renderConcentration();
  }

  // ── KPI strip ─────────────────────────────────────────────────────────────

  #renderSummary() {
    const s = this.#summary;
    const k = this.#kpis || {};
    // `average_cost` IS cost-per-operation server-side (grand_cost / total_ops)
    // — the fallback for a `kpis`-less (old-shape) response.
    const kpi = (name, fallbackCurrent) => k[name] ?? { current: fallbackCurrent, previous: null, change_pct: null };
    const spend = kpi('total_spend', s.total_cost);
    const tokens = kpi('total_tokens', undefined);
    const costPerOp = kpi('cost_per_operation', s.average_cost ?? 0);
    const latency = kpi('avg_latency_ms', undefined);

    const items = [
      { label: 'Total AI spend', value: fmtMoney(spend.current),
        sub: `${fmtCount(s.total_operations)} operations`,
        ...deltaChip(spend.change_pct, 'down') },
      { label: 'Total tokens', value: fmtTokens(tokens.current),
        sub: 'Across all agents',
        ...deltaChip(tokens.change_pct, 'down') },
      { label: 'Cost / operation', value: fmtCostShort(costPerOp.current),
        sub: `${fmtNum(s.total_container_hours)} agent hours`,
        ...deltaChip(costPerOp.change_pct, 'down') },
      { label: 'Avg latency', value: fmtLatencyShort(latency.current),
        sub: `${s.active_agents ?? 0} of ${s.total_agents ?? 0} agents active`,
        ...deltaChip(latency.change_pct, 'down') },
    ];

    const strip = this.querySelector('#kpi-strip');
    strip.removeAttribute('aria-busy');
    strip.innerHTML = items.map(kpiHtml).join('');
  }

  // ── Spend over time ───────────────────────────────────────────────────────

  /**
   * "Spend over time": one point per bucket (`spend-timeseries` picks hour vs
   * day for the window's length — see `#spend.bucket`). Spend on the left axis
   * (currency), operation count on the right (`axis: 'y2'`, compact) — this
   * endpoint has no token count, so Operations replaces the old Tokens series.
   * Dollar-only: no `%` scale exists against it.
   */
  #renderSpend() {
    const chart = this.querySelector('#spend-plot');
    // Restores the real empty-text after a previous load failed and
    // #renderLoadFailure overrode it with a "couldn't load" message.
    chart.setAttribute('empty-text', 'No usage in this window');
    const points = this.#spend.points;
    const fmtLabel = this.#spend.bucket === 'hour'
      ? new Intl.DateTimeFormat('en', { hour: 'numeric' })
      : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

    // The legend lives in the panel's tools row (design), not inside the plot
    // card — so app-chart's own legend is off and this row mirrors the dataset
    // order, which is what fixes each series' colour slot.
    const legend = this.querySelector('#spend-legend');
    legend.innerHTML = ['Spend', 'Operations'].map((name, i) => `
      <li><span class="dot" style="--dot:var(--viz-${i + 1})"></span>${escHtml(name)}</li>`).join('');

    chart.removeAttribute('loading');
    chart.data = points.length ? {
      labels: points.map((p) => fmtLabel.format(new Date(p.bucket_start))),
      datasets: [
        { label: 'Spend', data: points.map((p) => p.spend_usd ?? 0) },
        { label: 'Operations', axis: 'y2', data: points.map((p) => p.operations ?? 0) },
      ],
    } : { labels: [], datasets: [] };
  }

  // ── Spend concentration ───────────────────────────────────────────────────

  /**
   * A grid of every day in `#day`'s month, one button each — the design's
   * replacement for a native `<input type="date">`. A day past today is
   * disabled (never a future date to drill into) rather than hidden, so the
   * grid's shape stays constant through the month instead of growing daily.
   * Redrawn on every pick, not just re-flagged, because moving into a new
   * month can also change how many cells there are.
   */
  /**
   * Moves `#day` inside whatever month the KPI strip's month select just
   * jumped to. `#day` drives the concentration panel's calendar independently
   * of the KPI/chart window (its endpoint takes one date, not a range) — but
   * "independent" only meant the range group shouldn't also own it, not that
   * a month jump should leave it behind. Without this the grid kept showing
   * last month's days after the window had already moved on.
   * Lands on today when the newly picked month IS the current month (there is
   * still a "today" to default to); the 1st otherwise, since a past month has
   * no "today" of its own to land on.
   */
  #syncDayToSelectedMonth() {
    const start = new Date(this.querySelector('#month-select').value);
    const now = new Date();
    const isCurrentMonth = start.getFullYear() === now.getFullYear()
      && start.getMonth() === now.getMonth();
    this.#day = isCurrentMonth ? localDateStr(now) : localDateStr(start);
  }

  #renderDayGrid() {
    const grid = this.querySelector('#day-grid');
    if (!grid) return;
    const [y, m] = this.#day.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const todayStr = localDateStr(new Date());
    grid.innerHTML = Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isFuture = dateStr > todayStr;
      const isSelected = dateStr === this.#day;
      return `<button type="button" class="day-cell${isSelected ? ' is-selected' : ''}"
        data-date="${escAttr(dateStr)}" ${isFuture ? 'disabled' : ''}
        aria-pressed="${isSelected}" aria-label="${escAttr(dateStr)}">${day}</button>`;
    }).join('');
  }

  /**
   * A single calendar day's hourly spend curve, segmented by agent — straight
   * off `/finops/spend-calendar/day`, no client-side aggregation beyond
   * matching each hour's own `top_agents` entries against the day's top-4
   * identities. `average-line` draws its dashed rule from the same 24 column
   * totals this chart plots, which is exactly `avg_hourly_spend_usd`.
   *
   * The backend gives every hour its OWN `top_agents`/`others_spend_usd`
   * (a real per-hour ranking, not just a day-wide one) — this used to draw a
   * single flat bar because an earlier version of this method assumed the
   * endpoint could only produce a day total. It can't produce more than a
   * day-wide top-4 identity list, though, so the segments are fixed to those
   * 4 agents (plus "Others") for all 24 hours; an hour where a fifth agent
   * briefly outspent the day's #4 still folds into that hour's "Others" pill,
   * same as it would in the day-level ranking.
   */
  #renderConcentration() {
    const legend = this.querySelector('#conc-legend');
    const chart = this.querySelector('#conc-plot');
    // Restores the real empty-text after a previous load failed and
    // #renderLoadFailure overrode it with a "couldn't load" message.
    chart.setAttribute('empty-text', 'No spend on this day');
    const note = this.querySelector('#conc-note');
    const day = this.#dayDrill;
    const hours = day?.hours ?? [];
    const topAgents = (day?.top_agents ?? []).slice(0, 4);

    const entries = [
      ...topAgents.map((a, i) => ({ label: a.agent_name, cost: a.spend_usd ?? 0, slot: `var(--viz-${i + 1})` })),
      ...(day?.others_spend_usd ? [{ label: 'Others', cost: day.others_spend_usd, slot: 'var(--fg-secondary)' }] : []),
    ];
    // A zero-spend day (or the loading gap before `#dayDrill` resolves) has no
    // real entries — four still rows, not an empty column, so the legend's
    // width holds and the chart beside it never visibly widens/narrows as the
    // day picker lands on and off empty days (see `.conc-body` in the CSS).
    legend.innerHTML = entries.length
      ? entries.map((e) => `
        <li><span class="dot" style="--dot:${e.slot}"></span>
          <span class="conc-name">${escHtml(e.label)}</span>
          <span class="conc-cost">${fmtMoney(e.cost)}</span></li>`).join('')
      : Array.from({ length: 4 }, () => `
        <li><span class="conc-legend-skel"></span>
          <span class="conc-name-skel"></span>
          <span class="conc-cost-skel"></span></li>`).join('');

    const labels = hours.map((h) => (h.hour === 0 ? '12am' : h.hour === 12 ? '12pm' : String(h.hour % 12)));
    chart.removeAttribute('loading');
    // Each of the day's top-4 agents becomes its own stacked series, read off
    // that hour's own `top_agents` (0 when this hour's payload doesn't list
    // them — they simply spent nothing that hour). "Others" is whatever is
    // left of the hour's total after those four are subtracted, not the
    // hour's own `others_spend_usd` verbatim — the two can disagree when an
    // hour's top_agents membership differs from the day's fixed top-4, and
    // the stack must sum to the bar's real height regardless.
    const agentSeries = (a, i) => ({
      label: a.agent_name,
      other: false,
      data: hours.map((h) => h.top_agents?.find((x) => x.agent_name === a.agent_name)?.spend_usd ?? 0),
    });
    const othersSeries = {
      label: 'Others',
      other: true,
      data: hours.map((h) => {
        const hourTotal = h.spend_usd ?? 0;
        const matched = sum(topAgents.map((a) => h.top_agents?.find((x) => x.agent_name === a.agent_name)?.spend_usd ?? 0));
        return Math.max(hourTotal - matched, 0);
      }),
    };
    chart.data = hours.length && sum(hours.map((h) => h.spend_usd ?? 0)) > 0
      ? { labels, datasets: [...topAgents.map(agentSeries), othersSeries] }
      : { labels: [], datasets: [] };

    note.textContent = day?.avg_hourly_spend_usd != null
      ? `Averaging ${fmtMoney(day.avg_hourly_spend_usd)}/hour on ${this.#day}.`
      : '';
  }

  // ── Attributions ──────────────────────────────────────────────────────────

  /**
   * Agent options for the filter. The markup carries `placeholder="Agent"`
   * (a disabled, unselectable header — the button's own label), so the real
   * `''` option below is the way back to the unfiltered view and reads "All",
   * matching Provider/Model/Org unit. <app-select> reads `options` from the
   * attribute, so this writes the attribute, not a property. Always built from
   * `data.agents` (agent-view, backward-compat) — the filter names an agent
   * regardless of which attribution view the table is showing.
   */
  #renderAgentOptions() {
    const select = this.querySelector('#agent-select');
    select.setAttribute('options', JSON.stringify([
      { value: '', label: 'All' },
      ...this.#agents.map((a) => ({ value: a.agent_id, label: a.agent_name || a.agent_id })),
    ]));
    // Re-rendered options reset the native select; keep the caller's choice.
    if (this.#agentFilter) select.value = this.#agentFilter;
  }

  /**
   * One row from `data.attributions.rows` (or the `data.agents` fallback),
   * mapped to a fixed shape so every column, the sort list, CSV export and
   * <app-table>'s own click-to-sort headers can all read one real property
   * name instead of guessing at the wire spelling — see the note on `pick()`.
   */
  #normalizeRow(r) {
    if (this.#attrView === 'workflow') {
      return {
        workflow_id: pick(r, 'workflow_id', 'id'),
        workflow_name: pick(r, 'workflow_name', 'name'),
        total_cost: pick(r, 'total_cost', 'cost'),
        total_tokens: pick(r, 'total_tokens', 'tokens'),
        operations: pick(r, 'operations'),
        avg_latency_ms: pick(r, 'avg_latency_ms', 'avg_latency'),
      };
    }
    return {
      agent_id: pick(r, 'agent_id', 'id'),
      agent_name: pick(r, 'agent_name', 'name'),
      total_cost: pick(r, 'total_cost', 'cost'),
      total_tokens: pick(r, 'total_tokens', 'tokens'),
      completion_tokens: pick(r, 'completion_tokens'),
      prompt_tokens: pick(r, 'prompt_tokens'),
      operations: pick(r, 'operations'),
      avg_cost_per_operation: pick(r, 'avg_cost_per_operation'),
      container_hours: pick(r, 'container_hours'),
      avg_latency_ms: pick(r, 'avg_latency_ms', 'avg_latency'),
      is_capped: !!r.is_capped,
    };
  }

  #visibleRows(query) {
    const q = (query || '').trim().toLowerCase();
    const sorts = this.#attrView === 'agent' ? AGENT_SORTS : WORKFLOW_SORTS;
    const nameField = this.#attrView === 'agent' ? 'agent_name' : 'workflow_name';
    const rows = this.#attributions.filter((r) => {
      const name = r[nameField] || '';
      return !q || name.toLowerCase().includes(q);
    });
    const spec = sorts.find((s) => s.value === this.#sort) ?? sorts[0];
    rows.sort((a, b) => {
      if (spec.field === nameField) return (a[nameField] || '').localeCompare(b[nameField] || '');
      return (b[spec.field] ?? 0) - (a[spec.field] ?? 0);
    });
    return rows;
  }

  #exportCsv() {
    const columns = this.#attrView === 'agent' ? AGENT_COLUMNS : WORKFLOW_COLUMNS;
    const header = columns.map((c) => c.label).join(',');
    const lines = this.#visibleRows('').map((r) => columns
      .map((c) => (c.csv ? c.csv(r) : r[c.key] ?? ''))
      .map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tokenops.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

customElements.define('tokenops-page', TokenopsPage);
