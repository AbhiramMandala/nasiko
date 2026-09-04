/**
 * TokenOps dashboard — FinOps: headline spend KPIs, two plots (spend over time ·
 * spend concentration) and per-agent attribution.
 *
 * @element tokenops-page
 * @note Data sources (see /api/docs):
 *       `call('fetchTokenopsDashboard', start?, end?)`
 *         → GET /api/observability/finops/dashboard — `{ data: { summary,
 *           agents, token_usage } }`. Windowed and fleet-wide; the KPI strip and
 *           the attributions table come from here. Fetched twice per load: once
 *           for the window, once for the window immediately before it, which is
 *           what the delta chips compare against.
 *       `call('fetchUsageHistory', days)`
 *         → GET /api/usage/history — one row per day `{ date, request_count,
 *           total_tokens, total_cost_usd }`. The "Spend over time" series and
 *           the anomaly marks/caption. Caller-scoped (it reads `token_usage`,
 *           not Tempo), so it can be narrower than the fleet totals above.
 *       `call('fetchAgentHours', start, end, 'hour')`
 *         → GET /api/observability/finops/agent-hours — the hourly per-agent
 *           breakdown behind "Spend concentration". The response shape is
 *           normalised in `#hourlyRows()`; until the endpoint returns hourly
 *           buckets the panel draws an ILLUSTRATIVE distribution of the real
 *           per-agent totals and says so in its caption (see `#sampleHourly`).
 *
 *       The provider/model/server/org-unit filters are rendered disabled: no
 *       windowed dataset carries those dimensions (see `INERT_FILTERS`).
 *
 *       Both plots are `<app-chart>`: the anomaly line (`anomalies`, `axis: 'y2'`,
 *       `format-y2`) and the segmented columns (`segmented`, `average-line`) —
 *       the two TokenOps forms the component grew for this page. The `%` / `$`
 *       scale switches the spend series between share-of-window and currency.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./tokenops-page.css', import.meta.url));
import { escAttr, escHtml } from '/common/utils/escape.js';
import { icons } from '/common/utils/icons.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-chart/app-chart.js';
import '/common/design-system/app-checkbox/app-checkbox.js';
import '/common/design-system/app-segmented-control/app-segmented-control.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-table/app-table.js';
import { call } from '../core/data-sources.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const DAY_MS = 86_400_000;
/** Cap on the `/usage/history` look-back, so an old month can't ask for years. */
const MAX_HISTORY_DAYS = 400;
/** `--viz-1…5` are the chart's fixed colour slots; the 6th series is "Other". */
const CONCENTRATION_SLOTS = 4;

/** Budget burn has no data source — see the KPI it fills in `#renderSummary`. */
const DUMMY_BUDGET_BURN_PCT = 77;
const DUMMY_BUDGET_BURN_DELTA_PCT = 6.1;

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

/** `csv` is the export value for the column; the table renders `render`. */
const COLUMNS = [
  { key: 'agent_name', label: 'Agent',
    render: (v, r) => `<span class="agent-name">${escHtml(v || r.agent_id)}</span>`,
    csv: (r) => r.agent_name },
  { key: 'total_cost', label: 'Spend', render: fmtMoney },
  { key: 'total_tokens', label: 'Tokens', render: fmtTokens },
  { key: 'completion_tokens', label: 'Output', render: fmtTokens },
  { key: 'prompt_tokens', label: 'Input', render: fmtTokens },
  { key: 'operations', label: 'Operations', render: fmtCount },
  { key: 'avg_cost_per_operation', label: 'Avg cost/op', render: fmtCost },
  { key: 'container_hours', label: 'Agent hours', render: fmtNum },
  { key: 'avg_latency_ms', label: 'Avg latency', render: fmtLatency },
];

const SORTS = [
  { value: 'total_tokens', label: 'Most tokens' },
  { value: 'total_cost', label: 'Highest spend' },
  { value: 'completion_tokens', label: 'Most output tokens' },
  { value: 'prompt_tokens', label: 'Most input tokens' },
  { value: 'operations', label: 'Most operations' },
  { value: 'avg_latency_ms', label: 'Slowest' },
  { value: 'agent_name', label: 'Name' },
];

/** Fixed windows, relative to now. No selection here means the month select owns
 *  the window instead — the two controls write the same start/end. */
const RANGES = [
  { value: '24h', label: '24h', days: 1 },
  { value: '7d', label: '7d', days: 7 },
  { value: '30d', label: '30d', days: 30 },
];

/** The value scale the plot's series were drawn in. Rendered (it is part of the
 *  panel head the design draws, and of the height the panel keeps) but disabled
 *  while there is no plot to scale — the same treatment as `INERT_FILTERS`. */
const UNITS = [{ value: '%', label: '%' }, { value: '$', label: '$' }];

const ATTR_MODES = [
  { value: 'agent', label: 'Agent' },
  { value: 'workflow', label: 'Workflow', disabled: true,
    title: 'No per-workflow cost data yet' },
];

/**
 * Filters with no windowed dataset behind them. They are rendered because the
 * screen is a fixed five-up filter bar, and disabled because the alternative is
 * a control that silently does nothing: `/usage/by-model` carries provider and
 * model but is all-time, so applying either to a month view would mix windows,
 * and neither "server" nor an org unit exists in the FinOps data at all.
 */
const INERT_FILTERS = [
  { id: 'server-select', label: 'Server',
    why: 'No server dimension in the FinOps data yet.' },
  { id: 'provider-select', label: 'Provider',
    why: 'Needs a windowed per-provider breakdown; /usage/by-model is all-time.' },
  { id: 'model-select', label: 'Model',
    why: 'Needs a windowed per-model breakdown; /usage/by-model is all-time.' },
  { id: 'org-select', label: 'Org unit',
    why: 'Org units are an enterprise concept; no OSS data source.' },
];

const sum = (ns) => ns.reduce((a, b) => a + b, 0);

/** Percent change, or `null` when there is no comparable baseline. */
function pctDelta(now, prev) {
  if (!Number.isFinite(now) || !Number.isFinite(prev) || prev === 0) return null;
  return ((now - prev) / prev) * 100;
}

/**
 * The movement chip for one KPI. `goodWhen` is the direction that is good news
 * — spend rising is bad, so it passes `'down'`. The arrow is the *direction*
 * and the tint is the *sentiment*, so a rising cost is an up arrow in an amber
 * chip. One glyph, rotated: `arrowUpRight` mirrored is the down-right arrow.
 */
function deltaChip(change, goodWhen) {
  if (change === null) return { delta: null, trend: 'neutral' };
  const good = change > 0 ? goodWhen === 'up' : goodWhen === 'down';
  return {
    delta: `${Math.abs(change).toFixed(1)}%`,
    dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    trend: change === 0 ? 'neutral' : good ? 'up' : 'down',
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

/** Five cells of the real geometry, so the strip does not resize on data. */
const KPI_SKELETON = Array.from({ length: 5 }, () => `
  <div class="kpi">
    <div class="kpi-chip is-neutral"><span class="kpi-skel kpi-skel--chip"></span></div>
    <div class="kpi-text">
      <div class="kpi-skel kpi-skel--value"></div>
      <div class="kpi-skel kpi-skel--label"></div>
    </div>
  </div>`).join('');

/** Operations-weighted mean latency; plain mean would let an idle agent dominate. */
function weightedLatency(agents) {
  const rows = agents.filter((a) => a.avg_latency_ms != null && a.operations > 0);
  const ops = sum(rows.map((a) => a.operations));
  return ops === 0 ? null : sum(rows.map((a) => a.avg_latency_ms * a.operations)) / ops;
}

class TokenopsPage extends HTMLElement {
  #initialized = false;
  #agents = [];
  #summary = {};
  #prevSummary = null;
  #prevAgents = [];
  #tokenUsage = {};
  #prevTokenUsage = {};
  #history = [];
  /** Hourly per-agent rows for the window (normalised; see `#hourlyRows`). */
  #agentHours = [];
  /** True when the concentration plot is drawn from `#sampleHourly`, not data. */
  #hourlyIsSample = false;
  /** `$` (currency) or `%` (share of the window's spend) for the spend series. */
  #unit = '$';
  /** Window start/end as Dates — written by the month select and the range group. */
  #start = null;
  #end = null;
  #range = '30d';
  #anomalies = true;
  #agentFilter = '';
  #sort = 'total_tokens';
  /** The in-flight dashboard fetch — the table awaits it, so its own skeleton
   *  rows are the page's loading state. */
  #pending = null;
  /** Bumped per load. Four requests fan out per window and a second window can
   *  be picked mid-flight, so every one of them checks this before writing:
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
          <app-select id="agent-select" size="md" aria-label="Agent"></app-select>
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
            <app-segmented-control id="unit-seg" size="sm" label="Value scale"></app-segmented-control>
          </div>
          <div class="panel-tools">
            <app-checkbox id="anomaly-toggle" checked label="Anomalies"></app-checkbox>
          </div>
          <app-chart id="spend-plot" class="plot-slot" type="line" format="currency" format-y2="compact" height="300px"
            legend="on" label="Spend over time" empty-text="No usage in this window" loading></app-chart>
          <p class="anomaly-note" id="anomaly-note" hidden></p>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Spend concentration</h2>
          </div>
          <div class="conc-body">
            <app-chart id="conc-plot" class="plot-slot" type="bar" segmented average-line legend="off" height="220px"
              format="currency" label="Spend concentration by hour of day"
              empty-text="No agent activity in this window" loading></app-chart>
            <ul class="conc-legend" id="conc-legend"></ul>
          </div>
          <p class="anomaly-note" id="conc-note" hidden></p>
        </section>
      </div>

      <div class="section-head">
        <h2 class="section-title">Attributions</h2>
        <div class="section-tools">
          <app-segmented-control id="attr-seg"
            size="sm" label="Attribute by"></app-segmented-control>
          <app-select id="sort-select" size="md" aria-label="Sort"
            options='${JSON.stringify(SORTS)}'></app-select>
        </div>
      </div>
      <app-table id="cost-table" pagination="none" search
        search-placeholder="Search agents by name..."
        empty-message="No agent activity in this period"></app-table>
    `;

    // Segment sets are data, not markup: assigned as properties so no JSON has
    // to be escaped into an attribute at a call site.
    this.#segment('#range-seg', RANGES.map((r) => ({ value: r.value, label: r.label })), this.#range);
    this.#segment('#unit-seg', UNITS, this.#unit);
    this.#segment('#attr-seg', ATTR_MODES, 'agent');

    const table = this.querySelector('#cost-table');
    table.columns = COLUMNS;
    // Filtering and sorting are in-memory over the one dashboard payload, so
    // "fetching" a page is just awaiting the load that is already in flight.
    table.dataFn = async (query) => {
      await this.#pending;
      return this.#visibleAgents(query);
    };

    this.querySelector('#month-select').addEventListener('change', () => {
      // Clearing the range group's value deselects every segment: the month is
      // now the window, and two lit controls would each claim to own it.
      this.#range = '';
      this.querySelector('#range-seg').value = '';
      this.#load();
    });
    this.querySelector('#range-seg').addEventListener('change', (e) => {
      this.#range = e.target.value;
      this.#load();
    });
    this.querySelector('#anomaly-toggle').addEventListener('change', (e) => {
      this.#anomalies = e.target.checked;
      this.#renderSpend();
    });
    this.querySelector('#unit-seg').addEventListener('change', (e) => {
      this.#unit = e.target.value || '$';
      this.#renderSpend();
    });
    this.querySelector('#agent-select').addEventListener('change', (e) => {
      this.#agentFilter = e.target.value;
      table.refresh();
      this.#renderConcentration();
    });
    this.querySelector('#sort-select').addEventListener('change', (e) => {
      this.#sort = e.target.value;
      table.refresh();
    });
    this.querySelector('#export-btn').addEventListener('click', () => this.#exportCsv());

    this.#load();
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

  /** The range group wins when it holds a selection; otherwise the month does. */
  #resolveWindow() {
    const range = RANGES.find((r) => r.value === this.#range);
    if (range) {
      this.#end = new Date();
      this.#start = new Date(this.#end.getTime() - range.days * DAY_MS);
      return;
    }
    const select = this.querySelector('#month-select');
    this.#start = new Date(select.value);
    const end = select.select?.selectedOptions[0]?.dataset.end;
    this.#end = end ? new Date(end) : new Date();
  }

  async #load() {
    const id = ++this.#loadId;
    this.#resolveWindow();
    const start = this.#start.toISOString();
    const end = this.#end.toISOString();
    // Equal-length window ending where this one starts — the delta baseline.
    const span = this.#end.getTime() - this.#start.getTime();
    const prevStart = new Date(this.#start.getTime() - span).toISOString();

    // Assigned before the first await so the table's initial refresh — queued a
    // microtask after this element's markup was parsed — awaits this fetch
    // rather than seeing an empty agent list.
    this.#pending = call('fetchTokenopsDashboard', start, end);
    const table = this.querySelector('#cost-table');
    table.refresh();
    const strip = this.querySelector('#kpi-strip');
    strip.setAttribute('aria-busy', 'true');
    strip.innerHTML = KPI_SKELETON;
    this.querySelector('#spend-plot').setAttribute('loading', '');
    this.querySelector('#conc-plot').setAttribute('loading', '');

    let resp;
    try {
      resp = await this.#pending;
    } catch (e) {
      // The table surfaces the failure itself — its dataFn awaits the same
      // rejected promise.
      console.error('TokenOps dashboard fetch failed:', e);
      return;
    }
    if (id !== this.#loadId) return;
    const data = resp?.data ?? resp ?? {};
    this.#agents = data.agents || [];
    this.#summary = data.summary || {};
    this.#tokenUsage = data.token_usage || {};
    this.#renderAgentOptions();
    table.refresh();
    this.#renderSummary();
    this.#renderConcentration();

    // Everything below only sharpens the page: the baseline behind the delta
    // chips, the daily series, and the hourly breakdown. Each failure is
    // absorbed where it happens so one bad call can't blank the page.
    this.#loadBaseline(id, prevStart, start);
    this.#loadHistory(id);
    this.#loadAgentHours(id, start, end);
  }

  /**
   * Hourly per-agent spend for the concentration plot. Absorbs its own failure:
   * the panel then falls back to the illustrative distribution rather than a
   * blank, and says so.
   */
  async #loadAgentHours(id, start, end) {
    try {
      const resp = await call('fetchAgentHours', start, end, 'hour');
      if (id !== this.#loadId) return;
      this.#agentHours = this.#hourlyRows(resp);
    } catch (e) {
      console.error('TokenOps agent-hours fetch failed:', e);
      this.#agentHours = [];
    }
    this.#renderConcentration();
  }

  /**
   * Normalise the agent-hours response into `{ hour: 0–23, agent_id, cost }`.
   * The endpoint's bucketed shape is not final (API integration follows this
   * page), so this accepts the likely spellings and rejects anything without a
   * timestamp — a row it cannot place in an hour is not a row.
   */
  #hourlyRows(resp) {
    const rows = Array.isArray(resp) ? resp : Array.isArray(resp?.data) ? resp.data
      : Array.isArray(resp?.data?.buckets) ? resp.data.buckets : [];
    const out = [];
    for (const r of rows) {
      const stamp = r.bucket ?? r.hour ?? r.timestamp ?? r.time ?? r.start_time;
      const t = typeof stamp === 'number' && stamp < 24 ? stamp : new Date(stamp).getHours();
      if (!Number.isFinite(t)) continue;
      out.push({
        hour: t,
        agent_id: r.agent_id ?? r.agent ?? r.agent_name ?? 'unknown',
        cost: Number(r.total_cost ?? r.cost ?? r.cost_usd ?? r.total_cost_usd ?? 0) || 0,
      });
    }
    return out;
  }

  async #loadBaseline(id, start, end) {
    try {
      const resp = await call('fetchTokenopsDashboard', start, end);
      if (id !== this.#loadId) return;
      const data = resp?.data ?? resp ?? {};
      this.#prevSummary = data.summary || {};
      this.#prevAgents = data.agents || [];
      this.#prevTokenUsage = data.token_usage || {};
      this.#renderSummary();
    } catch (e) {
      console.error('TokenOps baseline fetch failed:', e);
    }
  }

  async #loadHistory(id) {
    const days = Math.min(MAX_HISTORY_DAYS,
      Math.ceil((Date.now() - this.#start.getTime()) / DAY_MS) + 1);
    try {
      const resp = await call('fetchUsageHistory', days);
      if (id !== this.#loadId) return;
      this.#history = Array.isArray(resp) ? resp : resp?.data ?? [];
    } catch (e) {
      console.error('TokenOps history fetch failed:', e);
      this.#history = [];
    }
    this.#renderSpend();
  }

  // ── KPI strip ─────────────────────────────────────────────────────────────

  #renderSummary() {
    const s = this.#summary;
    const prev = this.#prevSummary;
    // `average_cost` IS cost-per-operation server-side (grand_cost / total_ops).
    // Taken from the summary rather than divided here: agents deleted inside the
    // window count toward the fleet figures but have no row, so the two differ.
    const costPerOp = s.average_cost ?? 0;
    const prevCostPerOp = prev?.average_cost ?? 0;
    const latency = weightedLatency(this.#agents);
    const prevLatency = weightedLatency(this.#prevAgents);

    // A missing baseline (first load, or the previous window failed) yields no
    // chip at all rather than a 0% one — "unchanged" is a claim, not a default.
    const chip = (now, before, goodWhen) => (prev === null
      ? { delta: null, trend: 'neutral' }
      : deltaChip(pctDelta(now, before), goodWhen));

    const items = [
      { label: 'Total AI spend', value: fmtMoney(s.total_cost),
        sub: `${fmtCount(s.total_operations)} operations`,
        ...chip(s.total_cost, prev?.total_cost, 'down') },
      { label: 'Total tokens', value: fmtTokens(this.#tokenUsage.total_tokens),
        sub: 'Across all agents',
        ...chip(this.#tokenUsage.total_tokens, this.#prevTokenUsage?.total_tokens, 'down') },
      // ponytail: dummy. No budget exists anywhere in the platform, so there is
      // nothing to burn against — these are the design's placeholder figures,
      // held so the strip is the five-up the screen specifies. Swap both for the
      // real ratio (spend ÷ budget) once a budget is configurable; the `sub`
      // says out loud that the number is not measured.
      { label: 'Budget burn', value: `${DUMMY_BUDGET_BURN_PCT}%`,
        sub: 'Placeholder — no budget configured',
        ...deltaChip(-DUMMY_BUDGET_BURN_DELTA_PCT, 'down') },
      { label: 'Cost / operation', value: fmtCostShort(costPerOp),
        sub: `${fmtNum(s.total_container_hours)} agent hours`,
        ...chip(costPerOp, prevCostPerOp, 'down') },
      { label: 'Avg latency', value: fmtLatencyShort(latency),
        sub: `${s.active_agents ?? 0} of ${s.total_agents ?? 0} agents active`,
        ...chip(latency, prevLatency, 'down') },
    ];

    const strip = this.querySelector('#kpi-strip');
    strip.removeAttribute('aria-busy');
    strip.innerHTML = items.map(kpiHtml).join('');
  }

  // ── Spend over time ───────────────────────────────────────────────────────

  /** `/usage/history` is a look-back from today; the window trims it. */
  #historyInWindow() {
    const from = this.#start.getTime();
    const to = this.#end.getTime();
    return this.#history
      .filter((r) => {
        const t = new Date(r.date).getTime();
        return Number.isFinite(t) && t >= from && t < to;
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  /**
   * Anomalous day indices over the window: >2σ above the mean — the standard
   * first cut, and honest about being a threshold rather than a model. Returned
   * with the stats so the caption and the plot say the same thing.
   */
  #anomalyIndices(rows) {
    const costs = rows.map((r) => r.total_cost_usd ?? 0);
    if (costs.length < 3) return { flagged: [], costs };
    const mean = sum(costs) / costs.length;
    const sd = Math.sqrt(sum(costs.map((c) => (c - mean) ** 2)) / costs.length);
    const flagged = costs.map((c, i) => (sd > 0 && c > mean + 2 * sd ? i : -1)).filter((i) => i >= 0);
    return { flagged, costs };
  }

  /**
   * "Spend over time": one point per day of the window. Spend on the left axis
   * (currency, or share of the window's spend when the scale is `%`), token
   * volume on the right (`axis: 'y2'`, compact). Anomalies are the red marks
   * on the spend series and the caption under the plot — same indices.
   */
  #renderSpend() {
    const chart = this.querySelector('#spend-plot');
    const note = this.querySelector('#anomaly-note');
    const rows = this.#historyInWindow();
    const { flagged, costs } = this.#anomalyIndices(rows);
    const total = sum(costs);
    const percent = this.#unit === '%';
    const fmtDay = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

    chart.setAttribute('format', percent ? 'percent' : 'currency');
    chart.removeAttribute('loading');
    chart.data = rows.length ? {
      labels: rows.map((r) => fmtDay.format(new Date(r.date))),
      datasets: [
        {
          label: percent ? 'Share of spend' : 'Spend',
          data: costs.map((c) => (percent ? (total > 0 ? (c / total) * 100 : 0) : c)),
          anomalies: this.#anomalies
            ? flagged.map((i) => ({ index: i, note: `${fmtMoney(costs[i])} — above 2σ of the window mean` }))
            : [],
        },
        { label: 'Tokens', axis: 'y2', data: rows.map((r) => r.total_tokens ?? 0) },
      ],
    } : { labels: [], datasets: [] };

    if (!this.#anomalies) { note.hidden = true; return; }
    note.hidden = false;
    if (costs.length < 3) { note.textContent = ''; return; }
    note.textContent = flagged.length === 0
      ? 'No days above 2σ of this window’s mean spend.'
      : `${flagged.length} day${flagged.length > 1 ? 's' : ''} above 2σ: ${
        flagged.map((i) => `${fmtDay.format(new Date(rows[i].date))} (${fmtMoney(costs[i])})`).join(', ')}`;
  }

  // ── Spend concentration ───────────────────────────────────────────────────

  /**
   * Top spenders in the window: one colour slot each, the tail as "Others"
   * (past five the pastel scale collides). The legend lists them with their
   * window totals; the plot stacks their spend per hour of day.
   */
  #concentrationEntries() {
    const shown = this.#agentFilter
      ? this.#agents.filter((a) => a.agent_id === this.#agentFilter)
      : this.#agents;
    const ranked = [...shown].sort((a, b) => (b.total_cost ?? 0) - (a.total_cost ?? 0));
    const top = ranked.slice(0, CONCENTRATION_SLOTS);
    const rest = ranked.slice(CONCENTRATION_SLOTS);
    return [
      ...top.map((a, i) => ({ label: a.agent_name || a.agent_id, ids: [a.agent_id], cost: a.total_cost ?? 0, slot: `var(--viz-${i + 1})` })),
      ...(rest.length ? [{ label: `Others (${rest.length})`, ids: rest.map((a) => a.agent_id), cost: sum(rest.map((a) => a.total_cost ?? 0)), slot: 'var(--fg-secondary)' }] : []),
    ];
  }

  /**
   * Stand-in for the hourly breakdown while `/finops/agent-hours` does not yet
   * return hourly buckets: each agent's REAL window total spread over 24 hours
   * on a working-day curve, so the plot shows the shape the design intends
   * against true magnitudes. Deterministic — no randomness — and labelled as
   * illustrative in the panel caption. Delete when the endpoint lands.
   */
  #sampleHourly(entries) {
    const curve = [1, 1, 1, 1, 1, 2, 4, 8, 12, 14, 13, 11, 12, 13, 12, 10, 8, 7, 5, 3, 3, 3, 2, 2];
    const weight = sum(curve);
    return entries.map((e) => curve.map((w) => (e.cost * w) / weight));
  }

  #renderConcentration() {
    const legend = this.querySelector('#conc-legend');
    const chart = this.querySelector('#conc-plot');
    const note = this.querySelector('#conc-note');
    const entries = this.#concentrationEntries();

    legend.innerHTML = entries.map((e) => `
      <li><span class="dot" style="--dot:${e.slot}"></span>
        <span class="conc-name">${escHtml(e.label)}</span>
        <span class="conc-cost">${fmtMoney(e.cost)}</span></li>`).join('');

    // Real hourly rows when the endpoint supplies them; the illustrative curve
    // otherwise. Either way the series order matches the legend, so the colour
    // slots line up.
    let series;
    if (this.#agentHours.length) {
      this.#hourlyIsSample = false;
      series = entries.map((e) => {
        const byHour = new Array(24).fill(0);
        for (const r of this.#agentHours) if (e.ids.includes(r.agent_id)) byHour[r.hour] += r.cost;
        return byHour;
      });
    } else {
      this.#hourlyIsSample = true;
      series = this.#sampleHourly(entries);
    }

    const labels = Array.from({ length: 24 }, (_, h) => (h === 0 ? '12am' : h === 12 ? '12pm' : String(h % 12)));
    chart.removeAttribute('loading');
    chart.data = entries.length && sum(entries.map((e) => e.cost)) > 0
      ? { labels, datasets: entries.map((e, i) => ({ label: e.label, data: series[i] })) }
      : { labels: [], datasets: [] };

    note.hidden = !(this.#hourlyIsSample && entries.length);
    note.textContent = 'Hourly distribution is illustrative until agent-hours returns hourly buckets; totals are real.';
  }

  // ── Attributions ──────────────────────────────────────────────────────────

  /**
   * Agent options for the filter. `''` is every agent rather than a `placeholder`
   * prompt, because a placeholder option is disabled — there would be no way
   * back to the unfiltered view. <app-select> reads `options` from the
   * attribute, so this writes the attribute, not a property.
   */
  #renderAgentOptions() {
    const select = this.querySelector('#agent-select');
    select.setAttribute('options', JSON.stringify([
      { value: '', label: 'Agent' },
      ...this.#agents.map((a) => ({ value: a.agent_id, label: a.agent_name || a.agent_id })),
    ]));
    // Re-rendered options reset the native select; keep the caller's choice.
    if (this.#agentFilter) select.value = this.#agentFilter;
  }

  #visibleAgents(query) {
    const q = (query || '').trim().toLowerCase();
    const rows = this.#agents.filter((a) => {
      if (this.#agentFilter && a.agent_id !== this.#agentFilter) return false;
      return !q || (a.agent_name || '').toLowerCase().includes(q);
    });
    const key = this.#sort;
    rows.sort((a, b) => (key === 'agent_name'
      ? (a.agent_name || '').localeCompare(b.agent_name || '')
      : (b[key] ?? 0) - (a[key] ?? 0)));
    return rows;
  }

  #exportCsv() {
    const header = COLUMNS.map((c) => c.label).join(',');
    const lines = this.#visibleAgents('').map((a) => COLUMNS
      .map((c) => (c.csv ? c.csv(a) : a[c.key] ?? ''))
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
