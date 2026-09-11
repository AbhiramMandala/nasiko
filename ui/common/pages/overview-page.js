/**
 * Overview — the landing page. Fleet health in one screen: a KPI strip, a
 * latency ranking, operations over time, the day's spend concentration, and
 * per-agent attribution.
 *
 * @element overview-page
 *
 * @note Data sources. This page adds NO new endpoints, and makes TWO requests
 *       for its six panels — both calls TokenOps already makes:
 *
 *       `call('fetchTokenopsDashboard', { range?, startTime?, endTime?, orgUnit?, myAgent?, view })`
 *         → GET /api/observability/finops/dashboard. Supplies `summary`,
 *           `kpis` (`total_spend`, `total_tokens`, `cost_per_operation`,
 *           `avg_latency_ms`, `total_agents`, `active_agents`,
 *           `total_operations`, `total_tool_calls`, `latency_p95_ms`,
 *           `latency_p99_ms` — each `{ current, previous, change_pct }`),
 *           `agents` (the agent filter + the table's per-agent percentiles and
 *           tool-call counts) and `attributions.rows` (the table).
 *       `call('fetchSpendTimeseries', { … })`
 *         → GET /api/observability/finops/spend-timeseries. Each point carries
 *           `operations` and `tool_calls` (the two "Agent activity" series) plus
 *           the fleet-wide `p50/p95/p99_latency_ms` percentiles that the
 *           "Latency" panel plots over time.
 *           `points[]` also drives "Spend over time": `spend_usd` per bucket,
 *           split by `top_agent_spend_usd` into the bucket's heaviest agent
 *           and the remainder. THREE panels, one request.
 *
 *       `fetchLlmProviders` and `fetchOrgUnits` fill the Provider and Org unit
 *       dropdowns — same two catalogs `tokenops-page.js` uses, and the same
 *       failure handling: a filter whose options never arrive stays disabled
 *       with a `title` saying why, rather than offering an empty menu.
 *
 * @note Filter scope follows the chrome the control sits in — no exceptions,
 *       which is the rule a reader infers from the layout anyway:
 *
 *       • The **filter bar** (month, range, Myself/Org, Org unit) is
 *         page-level: each re-runs `#load()` and every figure on the screen
 *         moves. Org unit belongs here rather than in a panel because it
 *         scopes WHOSE traces count at all; it used to be two synced copies,
 *         one per panel, which made a page-wide filter look panel-local twice
 *         over.
 *       • **Spend over time's** Agent and Provider selects sit inside that
 *         panel's card, so they narrow that panel alone (`#loadSpendSeries`)
 *         and cost a request only while one of them is set. Agent activity and
 *         Performance have no filters in the design and stay fleet-wide, which
 *         is also what makes them comparable against the strip above them.
 *
 *       There is no Server filter: the observability API has no server
 *       dimension, so the control is absent rather than present-and-disabled —
 *       same rule as A2A and Success rate.
 *
 * @note What this screen's design asks for that the backend still cannot
 *       answer. Each renders as a visibly inert control or an em dash with an
 *       explanatory `title` — never as a plausible-looking wrong number. See
 *       `docs/OVERVIEW_API_GAPS.md` for the endpoint asks.
 *
 *       1. **Scope, partially.** `my_agent=true` narrows the *dashboard* to
 *          agents the caller owns, so the Myself/Org control is live — but
 *          `spend-timeseries` and `spend-calendar/day` declare the param and
 *          never read it (`oss/server/src/observability/handler.rs`), so the
 *          Latency, Agent activity and Spend concentration panels stay
 *          fleet-wide. `#scope-note` says so on screen whenever Myself is
 *          selected, rather than letting three panels quietly claim a scope
 *          they do not have. Also note the axis: `my_agent` is *agents you
 *          own*, not *traces you ran* — a caller who uses agents they do not
 *          own reads zero under Myself.
 *       2. **Activity by call kind, partially.** `points[].tool_calls` gives
 *          the panel a real second series (migration 0015), so All / Agent
 *          calls / Tool calls are three distinct readings. The design's other
 *          two kinds — A2A and "Other" — have no call-kind column behind them
 *          and are absent rather than shown-and-disabled: a control that
 *          cannot be used is chrome, and Success rate is gone from the KPI
 *          strip for the same reason.
 *       3. **Spend over time is a two-way split, not the design's five.**
 *          `spend-timeseries` names one agent per bucket
 *          (`top_agent_name`/`top_agent_spend_usd`), so the stack is that
 *          agent against the remainder. The design's Tokens right axis has no
 *          field at all on this endpoint — `spend-timeseries` carries no token
 *          count — so the panel is single-axis. Its `%` unit IS real: the
 *          share of the window total is arithmetic over points already on the
 *          page, not a parameter the endpoint has to grow.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./overview-page.css', import.meta.url));
import { escAttr, escHtml } from '/common/utils/escape.js';
import { icons } from '/common/utils/icons.js';
import { toast } from '/common/utils/toast.js';
import { ApiError } from '../core/errors.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-chart/app-chart.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-segmented-control/app-segmented-control.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-table/app-table.js';
import { attachTooltip } from '/common/design-system/app-tooltip/app-tooltip.js';
import { call } from '../core/data-sources.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const DAY_MS = 86_400_000;

const ARTIFACT_LIBRARY_URL = 'https://registry.nasiko.dev/';

const fmtTokens = (n) => {
  if (n == null) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
};
const fmtMoney = (n) => (Math.abs(n ?? 0) >= 100
  ? `$${Math.round(n).toLocaleString()}`
  : `$${(n ?? 0).toFixed(2)}`);
const fmtCost = (n) => `$${(n ?? 0).toFixed(3)}`;
const fmtCount = (n) => (n ?? 0).toLocaleString();
const fmtLatency = (ms) => (ms == null ? '—'
  : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

const sum = (ns) => ns.reduce((a, b) => a + b, 0);

const RANGES = [
  { value: '24h', label: '24h', days: 1 },
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
];

const SCOPES = [
  { value: 'self', label: 'Myself' },
  { value: 'org', label: 'Org' },
];

/**
 * The activity breakdown. Two real series now that `spend-timeseries` counts
 * tool-call spans per bucket (`points[].tool_calls`, migration 0015): "All"
 * draws both, the other two draw one each. No "A2A calls" segment — that kind
 * still has no dimension in the aggregation table, and a segment that cannot
 * be plotted has no business being on screen (gap 3 in the header note).
 *
 * `series` is the point field each mode plots, in legend/colour order.
 */
const ACTIVITY_MODES = [
  { value: 'all', label: 'All', series: ['operations', 'tool_calls'] },
  { value: 'agent', label: 'Agent calls', series: ['operations'] },
  { value: 'tool', label: 'Tool calls', series: ['tool_calls'] },
];

const ACTIVITY_SERIES = {
  operations: { label: 'Agent calls' },
  tool_calls: { label: 'Tool calls' },
};

/**
 * The Performance panel's three series, in colour order. All three come off the
 * same `points[]` the activity panel reads, so plotting them costs no request.
 */
const LATENCY_SERIES = [
  { key: 'p50_latency_ms', label: 'p50' },
  { key: 'p95_latency_ms', label: 'p95' },
  { key: 'p99_latency_ms', label: 'p99' },
];

/** The design's glossary tooltip on the "Latency tail" term in the footnote. */
const TAIL_GLOSSARY = 'Latency tail measures the slowest requests. p95 shows the '
  + 'latency exceeded by 5% of requests; p99 shows the latency exceeded by 1%.';

/**
 * Spend units. `$` is the endpoint's own `spend_usd`; `%` is each bucket's
 * share of the window total — arithmetic over the points already on the page,
 * not a figure the endpoint has to grow a parameter for.
 */
const SPEND_UNITS = [
  { value: 'pct', label: '%' },
  { value: 'usd', label: '$' },
];

const SORTS = [
  { value: 'operations', label: 'Most run', field: 'operations' },
  { value: 'cost', label: 'Highest spend', field: 'total_cost' },
  { value: 'tokens', label: 'Most tokens', field: 'total_tokens' },
  { value: 'avg_latency', label: 'Slowest (p50)', field: 'avg_latency_ms' },
  { value: 'p95_latency', label: 'Slowest (p95)', field: 'avg_latency_p95_ms' },
  { value: 'name', label: 'Name', field: 'agent_name' },
];

const COLUMNS = [
  { key: 'agent_name', label: 'Agent',
    render: (v, r) => `<span class="agent-name">${escHtml(v || r.agent_id || '')}</span>`,
    csv: (r) => r.agent_name },
  // Tool calls ride the Runs cell's `title` rather than a seventh column: the
  // design specifies six, and at six "Cost/operation" is already truncating —
  // a seventh pushed "Avg latency" out of the panel entirely.
  { key: 'operations', label: 'Runs', numeric: true,
    render: (v, r) => (r.tool_call_count
      ? `<span title="${escAttr(`${fmtCount(r.tool_call_count)} tool calls`)}">${escHtml(fmtCount(v))}</span>`
      : fmtCount(v)),
    csv: (r) => r.operations },
  { key: 'total_tokens', label: 'Tokens', numeric: true, render: fmtTokens },
  { key: 'total_cost', label: 'Spend', numeric: true, render: fmtMoney },
  { key: 'avg_cost_per_operation', label: 'Cost/Op', numeric: true,
    render: (v) => (v == null ? '—' : fmtCost(v)) },
  // p50 in the cell, p95/p99 on hover: the tail is what you chase when a
  // median looks fine, but three latency columns would crowd the panel out of
  // its half of the row. `title`, not two more columns.
  { key: 'avg_latency_ms', label: 'Avg latency', numeric: true,
    render: (v, r) => {
      const tail = [['p95', r.avg_latency_p95_ms], ['p99', r.avg_latency_p99_ms]]
        .filter(([, ms]) => ms != null)
        .map(([name, ms]) => `${name} ${fmtLatency(ms)}`);
      return tail.length
        ? `<span title="${escAttr(tail.join(' · '))}">${escHtml(fmtLatency(v))}</span>`
        : fmtLatency(v);
    },
    csv: (r) => r.avg_latency_ms ?? '' },
];

/**
 * The movement chip, from the backend's own `change_pct`. `null` ("no previous
 * window to compare with", and every KPI the API has no baseline for at all)
 * reads as 0.0% flat. `goodWhen` is the direction that is good news, so a
 * rising cost is an up arrow in a warning-tinted chip: the arrow is the direction, the tint is the
 * sentiment. Same contract as `tokenops-page.js`.
 *
 * Every tile carries a chip so the strip stays one shape: with no baseline it
 * reads 0.0% flat and neutral, the same as a genuinely unchanged metric.
 */
function deltaChip(changePct, goodWhen) {
  if (changePct == null || !Number.isFinite(changePct)) {
    return { delta: '0.0%', dir: 'flat', trend: 'neutral' };
  }
  const good = changePct > 0 ? goodWhen === 'up' : goodWhen === 'down';
  return {
    delta: `${Math.abs(changePct).toFixed(1)}%`,
    dir: changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat',
    trend: changePct === 0 ? 'neutral' : good ? 'up' : 'down',
  };
}

/**
 * One KPI tile: movement chip beside the figure over its label. `title` carries
 * the caption — for the cells with no data at all it is the explanation.
 *
 * Every tile gets a chip — the geometry is the same across the strip, and a
 * missing one reads as a rendering bug rather than as "no baseline". A whole
 * metric the API cannot answer is still not a tile at all (Success rate used
 * to hold a slot here; it is gone until there is a figure for it).
 */
function kpiHtml({ label, value, sub, delta, dir, trend }) {
  return `
    <div class="kpi"${sub ? ` title="${escAttr(sub)}"` : ''}>
      <div class="kpi-chip is-${trend} dir-${dir ?? 'flat'}">
        ${icons.arrowUpRight('kpi-arrow', 14)}
        <span class="kpi-delta">${escHtml(delta)}</span>
      </div>
      <div class="kpi-text">
        <div class="kpi-value">${escHtml(value == null || value === '' ? '—' : String(value))}</div>
        <div class="kpi-label">${escHtml(label)}</div>
      </div>
    </div>`;
}

/** How many tiles `#renderKpis()` builds. Only here so the skeleton reserves
 *  the same geometry the data lands in — keep the two in step. */
const KPI_COUNT = 5;

/** The strip's real geometry, so it does not resize when the data lands. */
const KPI_SKELETON = Array.from({ length: KPI_COUNT }, () => `
  <div class="kpi">
    <div class="kpi-chip is-neutral"><span class="kpi-skel kpi-skel--chip"></span></div>
    <div class="kpi-text">
      <div class="kpi-skel kpi-skel--value"></div>
      <div class="kpi-skel kpi-skel--label"></div>
    </div>
  </div>`).join('');

class OverviewPage extends HTMLElement {
  #initialized = false;
  #agents = [];
  #summary = {};
  #kpis = null;
  #rows = [];
  #spend = { bucket: 'day', points: [] };
  /** Which activity series are on screen — see ACTIVITY_MODES. */
  #activity = 'all';
  /** `usd` | `pct` — the Spend panel's y unit. */
  #spendUnit = 'usd';
  /** `attachTooltip`'s cleanup for the latency-tail term, or null. */
  #detachTailTip = null;
  #start = null;
  #end = null;
  #range = '30d';
  #scope = 'org';
  /** Spend-over-time's own filters. They live inside that panel's card, so
   *  they narrow that panel and nothing else — the KPI strip, Agent activity,
   *  Performance and Attributions all stay fleet-wide. (They used to run
   *  through `#load()` and move the whole screen: inherited from the Spend
   *  concentration panel this one replaced, where the same two selects also
   *  drove a day drill-down.) */
  #spendAgent = '';
  #spendProvider = '';
  /** Page-level, unlike the two above: org unit scopes WHOSE traces count, so
   *  it moves the whole screen and belongs on `#load()`. */
  #orgUnitFilter = '';
  /** `spend-timeseries` filtered by the two above, or null when neither is set
   *  — in which case Spend reads the shared payload and costs no request. */
  #spendSeries = null;
  #sort = 'operations';
  /** No agents at all in the window → the first-run screen. */
  #empty = false;
  #pending = null;
  /** Bumped per load; every response checks it before writing, so a slow
   *  August answer cannot overwrite the September numbers. */
  #loadId = 0;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <div class="page-head">
        <h1 class="title-page">Overview</h1>
        <app-button variant="tertiary" size="md" id="export-btn">Export report</app-button>
      </div>

      <div class="filter-bar">
        <app-select id="month-select" size="md" aria-label="Period"
          >${this.#monthOptions()}</app-select>
        <div class="filter-group">
          <app-segmented-control id="range-seg" size="sm" label="Time range"></app-segmented-control>
          <app-segmented-control id="scope-seg" size="sm" label="Scope"
            title="Myself narrows the KPI strip and the attributions table to agents you own."></app-segmented-control>
          <span id="org-slot"></span>
        </div>
      </div>
      <p class="scope-note" id="scope-note" hidden></p>

      <section class="hero" id="hero" hidden>
        <h2 class="hero-title">Build your agent fleet</h2>
        <p class="hero-desc">Bring your first agent into Nasiko and start seeing how your
          agents perform, interact, and scale.</p>
        <div class="hero-actions">
          <app-button variant="secondary" size="md" href="/add-agent">Import an agent</app-button>
          <app-button variant="primary" size="md" id="library-btn">Explore Artifact Library</app-button>
        </div>
      </section>

      <div class="kpi-strip" id="kpi-strip" aria-busy="true">${KPI_SKELETON}</div>

      <div class="panels">
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Agent activity</h2>
            <app-segmented-control id="activity-seg" size="sm" label="Break down by"
              title="Agent calls counts traces; Tool calls counts tool-call spans within them."></app-segmented-control>
          </div>
          <app-chart id="activity-plot" class="plot-slot" type="line" format="compact" height="240px"
            label="Requests over time" empty-text="No activity in this window" loading></app-chart>
          <app-empty-state id="activity-empty" hidden
            title="See your agents in action"
            description="Request volume, tool calls, A2A interactions and activity trends will appear here as your agents run."></app-empty-state>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Performance</h2>
          </div>
          <app-chart id="latency-plot" class="plot-slot" type="line" format="duration" height="240px"
            label="Latency percentiles over time"
            empty-text="No latency recorded" loading></app-chart>
          <app-empty-state id="latency-empty" hidden
            title="See how your agents perform"
            description="Track response times across your fleet and spot changes in latency as your agents handle real work."></app-empty-state>
          <p class="tail-note" id="tail-note" hidden></p>
        </section>
      </div>

      <div class="panels panels-b">
        <section class="panel">
        <div class="chart-header">
          <div class="panel-head">
            <h2 class="panel-title">Spend over time</h2>
          </div>
          <div class="panel-tools">
            <div class="filter-group">
              <app-segmented-control id="spend-unit-seg" size="sm" label="Spend unit"
                title="% is each bucket's share of the window's total spend."></app-segmented-control>
              <app-select id="agent-select" size="md" fit-content
                placeholder="All agents" aria-label="Agent"></app-select>
              <app-select id="provider-select" size="md" disabled fit-content
                placeholder="Provider" aria-label="Provider"
                title="Loading provider options…"></app-select>
            </div>
          </div>
          </div>
          <app-chart id="spend-plot" class="plot-slot" type="bar" segmented average-line
            height="240px" format="currency" label="Spend over time"
            empty-text="No spend in this window" loading></app-chart>
          <app-empty-state id="spend-empty" hidden
            title="Understand your agent economics"
            description="Track tokens, usage and platform spend as your fleet grows."></app-empty-state>
        </section>

        <section class="panel" id="attr-table-panel">
          <div class="panel-head">
            <h2 class="panel-title">Attributions</h2>
            <app-select id="sort-select" size="md" aria-label="Sort"
              options='${JSON.stringify(SORTS)}'></app-select>
          </div>
          <app-table id="attr-table" pagination="none"
            empty-message="No activity in this period"></app-table>
          <app-empty-state id="attr-empty" hidden
            title="See what&#39;s driving activity"
            description="Your agents will appear here once they&#39;re connected and running."></app-empty-state>
        </section>
      </div>
    `;

    this.#segment('#range-seg', RANGES.map((r) => ({ value: r.value, label: r.label })), this.#range);
    this.#segment('#scope-seg', SCOPES, this.#scope);
    this.#segment('#activity-seg', ACTIVITY_MODES, this.#activity);
    this.#segment('#spend-unit-seg', SPEND_UNITS, this.#spendUnit);

    const table = this.querySelector('#attr-table');
    table.columns = COLUMNS;
    // Sorting is in-memory over the one dashboard payload, so "fetching" a page
    // is just awaiting the load already in flight.
    table.dataFn = async () => {
      await this.#pending;
      return this.#sortedRows();
    };

    this.querySelector('#month-select').addEventListener('change', () => this.#load());
    this.querySelector('#range-seg').addEventListener('change', (e) => {
      this.#range = e.target.value;
      this.#load();
    });
    // Panel-local: refetch the Spend series alone. Calling `#load()` here
    // refetched the dashboard too, which moved every figure on the page.
    this.querySelector('#agent-select').addEventListener('change', (e) => {
      this.#spendAgent = e.target.value;
      this.#loadSpendSeries(this.#loadId);
    });
    this.querySelector('#provider-select').addEventListener('change', (e) => {
      this.#spendProvider = e.target.value;
      this.#loadSpendSeries(this.#loadId);
    });
    this.querySelector('#sort-select').addEventListener('change', (e) => {
      this.#sort = e.target.value;
      table.refresh();
    });
    this.querySelector('#scope-seg').addEventListener('change', (e) => {
      this.#scope = e.target.value || 'org';
      this.#renderScopeNote();
      this.#load();
    });
    this.querySelector('#activity-seg').addEventListener('change', (e) => {
      this.#activity = e.target.value || 'all';
      // No refetch: the series are already on the page — this only picks which.
      this.#renderActivity();
    });
    this.querySelector('#spend-unit-seg').addEventListener('change', (e) => {
      this.#spendUnit = e.target.value || 'usd';
      // Also no refetch: a percentage is the same points over their own total.
      this.#renderSpend();
    });
    this.querySelector('#export-btn').addEventListener('click', () => this.#exportCsv());
    this.querySelector('#library-btn').addEventListener('click', () => {
      window.open(ARTIFACT_LIBRARY_URL, '_blank', 'noopener');
    });

    this.#renderScopeNote();
    this.#load();
    this.#renderOrgControls();
    this.#loadProviders();
  }

  #segment(selector, items, value) {
    const control = this.querySelector(selector);
    control.items = items;
    control.value = value;
  }

  /** Current + previous 5 months, most recent first. Each option carries both
   *  bounds — sending only a start made every past month mean "that month
   *  through today" instead of that month. */
  #monthOptions() {
    const fmt = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' });
    const now = new Date();
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      return `<option value="${d.toISOString()}" data-end="${end.toISOString()}">${fmt.format(d)}</option>`;
    }).join('');
  }

  /** The month picks the anchor, the range group picks how far back from it —
   *  so changing month keeps the 24h/7d/30d pick instead of dropping it. With
   *  no range selected the window is the whole month. */
  #resolveWindow() {
    const select = this.querySelector('#month-select');
    const monthStart = new Date(select.value);
    const monthEnd = select.select?.selectedOptions[0]?.dataset.end;
    const now = Date.now();
    // Never past now: that also makes a range on the current month resolve to
    // the same now-anchored window it always did.
    this.#end = new Date(Math.min(monthEnd ? new Date(monthEnd).getTime() : now, now));
    const range = RANGES.find((r) => r.value === this.#range);
    this.#start = range
      ? new Date(this.#end.getTime() - range.days * DAY_MS)
      : monthStart;
  }

  #reportError(err, what) {
    console.error(`Overview ${what} fetch failed:`, err);
    if (err instanceof ApiError && err.isClientError) {
      toast.error(err.message || `${what} request was rejected`);
    }
  }

  /**
   * What "Myself" actually covers, said on screen. `my_agent` is read by the
   * dashboard handler alone — `spend-timeseries` and `spend-calendar/day`
   * deserialize the param and ignore it — so three of this page's five panels
   * stay fleet-wide under Myself. A scoped strip beside three unscoped panels
   * with nothing to distinguish them is exactly the quietly-wrong number this
   * screen's design forbids; one line of copy is the honest version until the
   * other two endpoints honour the param (gap 2 in the header note).
   */
  #renderScopeNote() {
    const note = this.querySelector('#scope-note');
    note.hidden = this.#scope !== 'self';
    note.textContent = '';
  }

  /**
   * Org unit is a real filter, but only on the dashboard endpoint and only on
   * EE (`ee/server/src/finops_scope.rs` resolves it to `user_id`s; OSS has no
   * org hierarchy and ignores it). One select, in the page filter bar beside
   * Myself/Org — the two page-level scopes sit together, and neither is
   * mistakable for one of Spend's panel-local filters. `org-unit-service.js` only
   * self-registers on the EE route path, so import it before calling.
   *
   * No client-side role gate: `/org/units` already requires `can_read_org`
   * (manager-or-above — `ee/server/src/org_units.rs::list_units`), and that is
   * the whole rule. Any failure (absent module, unmounted route, a 403) leaves
   * the select disabled and says so in its title — the same way
   * `tokenops-page.js` handles the same filter.
   */
  async #renderOrgControls() {
    const slot = this.querySelector('#org-slot');
    slot.innerHTML = `<app-select id="org-select" size="md" disabled fit-content
      placeholder="Org unit" aria-label="Org unit"
      title="Loading org units…"></app-select>`;
    const select = this.querySelector('#org-select');

    let units = [];
    try {
      await import('/services/org-unit-service.js');
      const resp = await call('fetchOrgUnits');
      units = resp?.data ?? resp ?? [];
    } catch {
      units = [];
    }
    if (!Array.isArray(units) || !units.length) {
      select.title = 'Org unit filter unavailable — no organization hierarchy configured, or you do not have access to view it.';
      return;
    }
    // Rows arrive in `path` order (a parent before its children), so the
    // `depth` indent is enough to keep the hierarchy readable in a flat menu.
    select.setAttribute('options', JSON.stringify([
      { value: '', label: 'All' },
      ...units.map((u) => ({
        value: u.id,
        label: `${'—'.repeat(Math.max((u.depth ?? 1) - 1, 0))} ${u.name}`.trim(),
      })),
    ]));
    select.removeAttribute('title');
    if (!this.#empty) select.removeAttribute('disabled'); // same race as #loadProviders
    select.addEventListener('change', (e) => {
      this.#orgUnitFilter = e.target.value;
      this.#load();
    });
  }

  /** Provider options come from the LLM-router catalog — the same call
   *  `llm-router-page.js` makes, so this costs no new endpoint. */
  async #loadProviders() {
    let catalog = [];
    try {
      const resp = await call('fetchLlmProviders');
      catalog = resp?.data ?? resp ?? [];
    } catch (e) {
      console.error('Overview provider catalog fetch failed:', e);
      return;
    }
    const select = this.querySelector('#provider-select');
    const options = catalog.map((p) => ({ value: p.provider, label: p.provider }));
    if (!options.length) return; // leave disabled — nothing real to offer
    select.setAttribute('options', JSON.stringify([{ value: '', label: 'All' }, ...options]));
    select.removeAttribute('title');
    // This races `#load()`. Enabling unconditionally re-armed the filter on the
    // first-run screen whenever the catalog landed second — a live control over
    // a page with nothing to filter.
    if (!this.#empty) select.removeAttribute('disabled');
  }

  // ── Load ──────────────────────────────────────────────────────────────────

  async #load() {
    const id = ++this.#loadId;
    this.#resolveWindow();
    const params = {
      range: this.#range || undefined,
      startTime: this.#start.toISOString(),
      endTime: this.#end.toISOString(),
      orgUnit: this.#orgUnitFilter || undefined,
      view: 'agent',
    };
    // Dashboard-only: `usage-service.js` documents why this is not spread into
    // the timeseries call.
    const dashParams = { ...params, myAgent: this.#scope === 'self' };

    // Assigned before the first await so the table's initial refresh — queued
    // a microtask after this element's markup was parsed — awaits this fetch
    // rather than seeing an empty row list.
    this.#pending = call('fetchTokenopsDashboard', dashParams);
    const table = this.querySelector('#attr-table');
    table.refresh();
    const strip = this.querySelector('#kpi-strip');
    strip.setAttribute('aria-busy', 'true');
    strip.innerHTML = KPI_SKELETON;
    for (const sel of ['#latency-plot', '#activity-plot', '#spend-plot']) {
      this.querySelector(sel).setAttribute('loading', '');
    }

    let resp;
    try {
      resp = await this.#pending;
    } catch (e) {
      // The table surfaces the failure itself — its dataFn awaits the same
      // rejected promise.
      this.#reportError(e, 'dashboard');
      return;
    }
    if (id !== this.#loadId) return;

    const data = resp?.data ?? resp ?? {};
    this.#agents = data.agents || [];
    this.#summary = data.summary || {};
    this.#kpis = data.kpis || null;
    this.#rows = (data.attributions?.rows ?? data.agents ?? []).map((r) => this.#normalizeRow(r));
    // "Nothing deployed yet" is the first-run screen; "deployed but idle" is
    // still the real dashboard, with zeroes in it. `total_agents` is the only
    // field that tells the two apart.
    this.#empty = (this.#summary.total_agents ?? 0) === 0;

    this.#renderEmptyState();
    this.#renderAgentOptions();
    this.#renderKpis();
    table.refresh();

    // Absorbs its own failure — one bad call must not blank the KPI strip and
    // the table alongside it. One call, three panels: Agent activity,
    // Performance and Spend over time all read the same `points[]` — unless
    // Spend carries a filter of its own, in which case it fetches its own.
    this.#loadTimeseries(id, params);
    if (this.#spendFiltered()) this.#loadSpendSeries(id);
  }

  /** True when Spend-over-time is narrowed past what the shared payload says. */
  #spendFiltered() {
    return !!(this.#spendAgent || this.#spendProvider);
  }

  /**
   * Spend-over-time's own series. Only fetched while that panel carries a
   * filter — with neither set the shared `spend-timeseries` payload is already
   * the right answer, so the common case still costs two requests for the
   * whole page.
   */
  async #loadSpendSeries(id) {
    if (!this.#spendFiltered()) {
      this.#spendSeries = null;
      this.#renderSpend();
      return;
    }
    const chart = this.querySelector('#spend-plot');
    chart.setAttribute('loading', '');
    try {
      const resp = await call('fetchSpendTimeseries', {
        range: this.#range || undefined,
        startTime: this.#start.toISOString(),
        endTime: this.#end.toISOString(),
        agentId: this.#spendAgent || undefined,
        provider: this.#spendProvider || undefined,
      });
      if (id !== this.#loadId) return;
      const data = resp?.data ?? resp ?? {};
      this.#spendSeries = {
        bucket: data.bucket || 'day',
        points: Array.isArray(data.points) ? data.points : [],
      };
    } catch (e) {
      this.#reportError(e, 'spend-timeseries');
      if (id !== this.#loadId) return;
      this.#spendSeries = { bucket: 'day', points: [] };
    }
    this.#renderSpend();
  }

  async #loadTimeseries(id, params) {
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
    this.#renderActivity();
    this.#renderLatency();
    // Spend is `#loadSpendSeries`'s to draw while it carries a filter —
    // rendering the unfiltered payload here first would flash the wrong bars.
    if (!this.#spendFiltered()) this.#renderSpend();
  }

  // ── First-run screen ──────────────────────────────────────────────────────

  /**
   * The empty screen is the same page with its instruments greyed out, not a
   * different page: the hero appears, the filters go inert (there is nothing
   * to narrow), and the two upper panels swap their plot for the copy that
   * says what will appear there. The KPI strip and the table keep their own
   * zero/empty renderings — both already read correctly at zero.
   */
  #renderEmptyState() {
    this.querySelector('#hero').hidden = !this.#empty;
    // The org-unit select is injected by `#renderOrgControls()`, which races
    // this — hence the optional chaining on every lookup below.
    // NOT '#scope-seg': `#empty` is `total_agents === 0`, and under Myself that
    // is "you own no agents", not "the workspace has none". Greying the scope
    // control out on the first-run screen would strand a caller in Myself with
    // no way back to the fleet. Every other control here narrows a window that
    // cannot itself produce the empty state.
    for (const sel of ['#month-select', '#range-seg', '#spend-unit-seg',
      '#agent-select', '#sort-select', '#activity-seg', '#export-btn']) {
      this.querySelector(sel)?.toggleAttribute('disabled', this.#empty);
    }
    // Org unit and Provider are not simply the inverse: a catalog that never
    // arrived leaves nothing to offer, so those two stay disabled on both
    // screens — the same reason their loaders check `#empty` before enabling.
    for (const sel of ['#org-select', '#provider-select']) {
      const select = this.querySelector(sel);
      select?.toggleAttribute('disabled', this.#empty || !select.hasAttribute('options'));
    }
    for (const [plot, empty] of [
      ['#latency-plot', '#latency-empty'],
      ['#activity-plot', '#activity-empty'],
      ['#spend-plot', '#spend-empty'],
    ]) {
      this.querySelector(plot).hidden = this.#empty;
      this.querySelector(empty).hidden = !this.#empty;
    }
    // Attributions swaps its table for the copy the same way the plots do: a
    // header band over nothing is chrome, and "Deployed but idle" — which is a
    // real reading — still gets the table and its own one-line message.
    this.querySelector('#attr-table').hidden = this.#empty;
    this.querySelector('#attr-empty').hidden = !this.#empty;
  }

  // ── KPI strip ─────────────────────────────────────────────────────────────

  #renderKpis() {
    const s = this.#summary;
    const k = this.#kpis || {};
    const kpi = (name) => k[name] ?? { current: null, change_pct: null };
    const spend = kpi('total_spend');
    const tokens = kpi('total_tokens');
    const latency = kpi('avg_latency_ms');
    const p95 = kpi('latency_p95_ms');
    const p99 = kpi('latency_p99_ms');
    const dash = deltaChip(null);
    // `kpis` carries prior-window baselines for the fleet counts now, so these
    // three get real movement chips. `summary` stays the fallback: it is the
    // only place these figures lived before, and an older server still answers
    // with it. `total_agents` deliberately has no baseline server-side
    // (headcount, not a window measure), so it keeps the dash chip either way.
    const count = (name, fallback) => {
      const v = k[name];
      return v ? { value: fmtCount(v.current), ...deltaChip(v.change_pct, 'up') }
        : { value: fmtCount(fallback), ...dash };
    };
    const toolCalls = kpi('total_tool_calls');

    const items = [
      { label: 'Agents', value: fmtCount(k.total_agents?.current ?? s.total_agents), ...dash,
        sub: 'Agents deployed in this workspace' },
      { label: 'Active', ...count('active_agents', s.active_agents),
        sub: `${fmtCount(k.active_agents?.current ?? s.active_agents)} of `
          + `${fmtCount(k.total_agents?.current ?? s.total_agents)} agents ran in this window` },
      { label: 'Runs', ...count('total_operations', s.total_operations),
        sub: `${fmtCount(s.operations_last_24h)} in the last 24 hours`
          + (toolCalls.current == null ? '' : ` · ${fmtCount(toolCalls.current)} tool calls`) },
      { label: 'Spend',
        value: `${fmtMoney(spend.current)}/${fmtTokens(tokens.current)}`,
        sub: 'Spend and tokens across every agent in this window',
        ...deltaChip(spend.change_pct, 'down') },
      // p50 leads (it is the typical request); the tail rides the caption
      // rather than taking two more of the strip's slots. Labelled as the
      // design labels it — `avg_latency_ms` IS the p50 server-side, and the
      // caption says so.
      { label: 'Avg latency', value: fmtLatency(latency.current),
        sub: `p50 (median) across every recorded operation · p95 ${fmtLatency(p95.current)}`
          + ` · p99 ${fmtLatency(p99.current)}`,
        ...deltaChip(latency.change_pct, 'down') },
    ];

    const strip = this.querySelector('#kpi-strip');
    strip.removeAttribute('aria-busy');
    // First run: every figure is a dash, not a mix of true zeroes ("0 agents")
    // and figures that are only zero because there is nothing to measure
    // ("$0.00/0", "0ms"). One reading for the whole strip — there is no data —
    // is what the empty screen is for.
    strip.innerHTML = items
      .map((it) => (this.#empty ? { ...it, value: '—' } : it))
      .map(kpiHtml).join('');
  }

  // ── Latency ───────────────────────────────────────────────────────────────

  /**
   * Fleet latency over the window: p50, p95 and p99 per bucket, straight off
   * `spend-timeseries`'s `points[]`. Three series rather than a percentile
   * picker — the whole point of a tail percentile is reading it against the
   * median, and a control that hides two thirds of that costs a click to say
   * nothing new.
   *
   * A bucket with no measured trace carries `null` for all three; passed
   * through as `null` (not coerced to 0) so the line breaks over the gap
   * instead of diving to the floor and inventing an instant fleet.
   *
   * Per-agent percentiles are not lost with the old ranking — they moved to
   * the attributions table, where the p50 cell carries p95/p99 on hover and
   * the sort list offers both.
   */
  #renderLatency() {
    const chart = this.querySelector('#latency-plot');
    const points = this.#spend.points;
    const measured = LATENCY_SERIES.some((sr) => points.some((pt) => pt[sr.key] != null));

    chart.removeAttribute('loading');
    chart.data = measured ? {
      labels: points.map((pt) => this.#bucketLabel(pt.bucket_start)),
      datasets: LATENCY_SERIES.map((sr) => ({
        label: sr.label,
        data: points.map((pt) => pt[sr.key] ?? null),
      })),
    } : { labels: [], datasets: [] };

    this.#renderTailNote();
  }

  /**
   * "Latency tail widened 74% since Wednesday" — the design's footnote,
   * derived rather than authored. The tail is `p99 - p95` (how far the slowest
   * 1% sits past the slowest 5%); the comparison is the latest measured bucket
   * against the previous one, and the bucket's own weekday is what "since" is
   * named after, so the sentence cannot claim a day the data does not cover.
   *
   * Both buckets must be measured, and the earlier tail must be non-zero — a
   * percentage change from zero is undefined, and "widened ∞%" is not a
   * reading. Anything short of that hides the line rather than softening it
   * into a sentence with no number in it.
   */
  #renderTailNote() {
    const note = this.querySelector('#tail-note');
    // First run: the slot says what will appear in it, the same job the copy in
    // the plot's box does. Owned here rather than in `#renderEmptyState()`
    // because this method runs after it (the timeseries lands second) and would
    // otherwise hide the line it had just written.
    if (this.#empty) {
      this.#detachTailTip?.();
      this.#detachTailTip = null;
      note.textContent = 'Latency data will appear as your agents start handling requests.';
      note.hidden = false;
      return;
    }
    const tails = this.#spend.points
      .filter((pt) => pt.p95_latency_ms != null && pt.p99_latency_ms != null)
      .map((pt) => ({ at: pt.bucket_start, tail: pt.p99_latency_ms - pt.p95_latency_ms }));
    const now = tails.at(-1);
    const before = tails.at(-2);
    if (!now || !before || before.tail <= 0) {
      note.hidden = true;
      note.replaceChildren();
      this.#detachTailTip?.();
      this.#detachTailTip = null;
      return;
    }

    const changePct = ((now.tail - before.tail) / before.tail) * 100;
    const verb = changePct >= 0 ? 'widened' : 'narrowed';
    const since = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
      .format(new Date(before.at));

    // The glossary term is a real element, not a styled span inside a sentence
    // built by string concatenation: the weekday and the percentage are data.
    //
    // `attachTooltip`, not a native `title`: the design shows a tooltip card,
    // and `title` takes about a second of stillness to appear, has no styling,
    // and does not show on keyboard focus — which is why hovering the term
    // looked like nothing was there. `data-tooltip-wrap` because the
    // definition is a sentence, and app-tooltip is single-line by default.
    // `tabIndex` makes it reachable, and app-tooltip shows on focus too.
    const term = document.createElement('span');
    term.className = 'tail-term';
    term.tabIndex = 0;
    term.dataset.tooltipWrap = '';
    term.textContent = 'Latency tail';
    // The note is rebuilt on every load, so the old term's listeners go with
    // the element it is replaced by; keep the detach for the reader.
    this.#detachTailTip?.();
    this.#detachTailTip = attachTooltip(term, TAIL_GLOSSARY);
    const rest = document.createTextNode(
      ` ${verb} ${Math.abs(changePct).toFixed(0)}% since ${since}.`);
    note.replaceChildren(term, rest);
    note.hidden = false;
  }

  // ── Agent activity ────────────────────────────────────────────────────────

  /**
   * Calls per bucket, off `spend-timeseries`. Two real series — `operations`
   * (one per trace) and `tool_calls` (tool-call spans within them) — so the
   * segmented control picks one or draws both, and every segment plots
   * something true. The design's fourth kind, A2A calls, has no dimension in
   * the aggregation table and is absent rather than flat at zero (gap 3).
   *
   * The legend sits in the panel's tools row rather than inside the plot card,
   * mirroring the dataset order, which is what fixes the series' colour slot.
   */
  #renderActivity() {
    const chart = this.querySelector('#activity-plot');
    const points = this.#spend.points;
    const mode = ACTIVITY_MODES.find((m) => m.value === this.#activity) ?? ACTIVITY_MODES[0];

    chart.removeAttribute('loading');
    chart.data = points.length ? {
      labels: points.map((pt) => this.#bucketLabel(pt.bucket_start)),
      datasets: mode.series.map((key) => ({
        label: ACTIVITY_SERIES[key].label,
        data: points.map((pt) => pt[key] ?? 0),
      })),
    } : { labels: [], datasets: [] };
  }

  // ── Spend over time ───────────────────────────────────────────────────────

  /**
   * Spend per bucket, split between the bucket's heaviest agent and everything
   * else. `spend-timeseries` names one agent per bucket — `top_agent_name` and
   * `top_agent_spend_usd` — so a two-segment stack is the whole per-agent
   * breakdown the endpoint carries. Every segment of it is a real number; a
   * five-way split by agent is not available per bucket (the day drill-down is
   * the endpoint that ranks agents, and only within one calendar day).
   *
   * `segmented` — the same gapped-pill form TokenOps' Spend concentration
   * draws, so the two spend panels read as one presentation across the two
   * screens. It costs the value axis: `app-chart`'s `#scales` hides the y-axis
   * for this form deliberately (the shape and the position against the `avg`
   * rule are the reading, and per-column dollars stay one hover — or the
   * screen-reader table — away), which is why `average-line` comes with it.
   * `flush-top` does NOT: nothing sits directly above this chart, so all four
   * corners stay rounded, unlike the concentration panel with its day grid.
   *
   * `Others` carries `other: true` so it takes the grey slot rather than a
   * series colour — it is a remainder, not an agent.
   *
   * `%` is each bucket over the window's own total, computed here: the
   * endpoint has no percent mode, but every bucket of the window is already
   * on the page, so the share is arithmetic rather than a missing parameter.
   */
  #renderSpend() {
    const chart = this.querySelector('#spend-plot');
    // Its own filtered series when the panel carries a filter, otherwise the
    // payload the other two panels share.
    const src = this.#spendSeries ?? this.#spend;
    const points = src.points;
    const total = sum(points.map((pt) => pt.spend_usd ?? 0));
    const pct = this.#spendUnit === 'pct';

    chart.setAttribute('format', pct ? 'percent' : 'currency');
    // A percentage of a zero total is undefined, not 0% — fall back to dollars
    // rather than draw a flat row of "0%" columns.
    const scale = (v) => (pct ? (total > 0 ? (v / total) * 100 : 0) : v);

    chart.removeAttribute('loading');
    chart.data = total > 0 ? {
      labels: points.map((pt) => this.#bucketLabel(pt.bucket_start, src.bucket)),
      datasets: [
        { label: 'Top agent',
          data: points.map((pt) => scale(pt.top_agent_spend_usd ?? 0)) },
        { label: 'Others',
          other: true,
          data: points.map((pt) => scale(Math.max(
            (pt.spend_usd ?? 0) - (pt.top_agent_spend_usd ?? 0), 0))) },
      ],
    } : { labels: [], datasets: [] };
  }

  /** `spend-timeseries` picks hour vs day buckets for the window's length, so
   *  the tick label has to follow it rather than assume one. */
  #bucketLabel(iso, bucket = this.#spend.bucket) {
    const fmt = bucket === 'hour'
      ? new Intl.DateTimeFormat('en', { hour: 'numeric' })
      : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
    return fmt.format(new Date(iso));
  }

  // ── Attributions ──────────────────────────────────────────────────────────

  #renderAgentOptions() {
    const select = this.querySelector('#agent-select');
    select.setAttribute('options', JSON.stringify([
      { value: '', label: 'All agents' },
      ...this.#agents.map((a) => ({ value: a.agent_id, label: a.agent_name || a.agent_id })),
    ]));
    // Re-rendered options reset the native select; keep the caller's choice.
    if (this.#spendAgent) select.value = this.#spendAgent;
  }

  /** One fixed row shape, so the columns, the sort list, the CSV export and
   *  <app-table>'s own click-to-sort headers all read the same property names. */
  #normalizeRow(r) {
    return {
      agent_id: r.agent_id ?? r.id,
      agent_name: r.agent_name ?? r.name,
      operations: r.operations ?? 0,
      total_tokens: r.total_tokens ?? r.tokens ?? 0,
      total_cost: r.total_cost ?? r.cost ?? 0,
      avg_cost_per_operation: r.avg_cost_per_operation,
      avg_latency_ms: r.avg_latency_ms ?? r.avg_latency ?? null,
      avg_latency_p95_ms: r.avg_latency_p95_ms ?? null,
      avg_latency_p99_ms: r.avg_latency_p99_ms ?? null,
      tool_call_count: r.tool_call_count ?? 0,
    };
  }

  #sortedRows() {
    const spec = SORTS.find((s) => s.value === this.#sort) ?? SORTS[0];
    return [...this.#rows].sort((a, b) => (spec.field === 'agent_name'
      ? (a.agent_name || '').localeCompare(b.agent_name || '')
      : (b[spec.field] ?? 0) - (a[spec.field] ?? 0)));
  }

  #exportCsv() {
    const header = COLUMNS.map((c) => c.label).join(',');
    const lines = this.#sortedRows().map((r) => COLUMNS
      .map((c) => (c.csv ? c.csv(r) : r[c.key] ?? ''))
      .map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'overview.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

customElements.define('overview-page', OverviewPage);
