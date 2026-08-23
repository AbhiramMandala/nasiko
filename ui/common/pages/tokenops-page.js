/**
 * TokenOps dashboard — token-first cost/usage analytics per agent.
 *
 * @element tokenops-page
 * @note Data source: `call('fetchTokenopsDashboard', startTime?, endTime?)` →
 *       GET /api/observability/finops/dashboard (see /api/docs), which returns
 *       `{ data: { summary, agents, token_usage }, status_code, message }`.
 */
import styles from './tokenops-page.css' with { type: 'css' };
import { escHtml } from '/common/utils/escape.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-search/app-search.js';
import '/common/design-system/app-table/app-table.js';
import '/common/design-system/app-stat-row/app-stat-row.js';
import { call } from '../core/data-sources.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const fmtTokens = (n) => {
  if (n == null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
};
const fmtCost = (n) => `$${(n ?? 0).toFixed(3)}`;
const fmtNum = (n) => (n ?? 0).toFixed(1);
const fmtLatency = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
const fmtCount = (n) => (n ?? 0).toLocaleString();

/** `csv` is the export value for the column; the table renders `render`. */
const COLUMNS = [
  { key: 'agent_name', label: 'Agent',
    render: (v, r) => `<span class="agent-name">${escHtml(v || r.agent_id)}</span>`,
    csv: (r) => r.agent_name },
  { key: 'total_tokens', label: 'Tokens', render: fmtTokens },
  { key: 'prompt_tokens', label: 'Input', render: fmtTokens },
  { key: 'completion_tokens', label: 'Output', render: fmtTokens },
  // Keyed on the read count so the header sort has a real number to sort on;
  // the cell shows read / written.
  { key: 'cache_read_tokens', label: 'Cache r/w',
    render: (v, r) => `${fmtTokens(v)} / ${fmtTokens(r.cache_creation_tokens)}`,
    csv: (r) => `${r.cache_read_tokens ?? 0} / ${r.cache_creation_tokens ?? 0}` },
  { key: 'operations', label: 'Operations', render: fmtCount },
  { key: 'total_cost', label: 'Total cost', render: fmtCost },
  { key: 'avg_cost_per_operation', label: 'Avg cost/op', render: fmtCost },
  { key: 'container_hours', label: 'Agent hours', render: (v) => `${fmtNum(v)} hrs` },
  { key: 'avg_latency_ms', label: 'Avg latency', render: fmtLatency },
  { key: 'version', label: 'Version', render: (v) => escHtml(v || '—') },
];

const SORTS = [
  { value: 'total_tokens', label: 'Most tokens' },
  { value: 'prompt_tokens', label: 'Most input tokens' },
  { value: 'completion_tokens', label: 'Most output tokens' },
  { value: 'total_cost', label: 'Highest cost' },
  { value: 'operations', label: 'Most operations' },
  { value: 'avg_latency_ms', label: 'Slowest' },
  { value: 'agent_name', label: 'Name' },
];

class TokenopsPage extends HTMLElement {
  #initialized = false;
  #agents = [];
  #tokenUsage = {};
  #query = '';
  #sort = 'total_tokens';
  /** The in-flight dashboard fetch — the table awaits it, so its own skeleton
   *  rows are the page's loading state. */
  #pending = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="title-page">TokenOps</h1>
          <p class="page-sub">Token spend, usage, and agent activity across the cluster.</p>
        </div>
        <div class="head-actions">
          <app-select id="month-select" size="md" aria-label="Period"
            >${this.#monthOptions()}</app-select>
          <app-button variant="dark" size="md" id="export-btn">Export</app-button>
        </div>
      </div>

      <app-stat-row id="kpi-strip" loading="4"></app-stat-row>

      <h2 class="section-title">Agent cost</h2>
      <div class="toolbar">
        <app-search id="agent-search" size="md"
          placeholder="Search agents by name, skill, or capability..."
          aria-label="Search agents"></app-search>
        <app-select id="sort-select" size="md" aria-label="Sort"
          options='${JSON.stringify(SORTS)}'></app-select>
      </div>
      <app-table id="cost-table" pagination="none"
        empty-message="No agent activity in this period"></app-table>

      <h2 class="section-title">Token usage</h2>
      <app-stat-row id="token-strip" loading="4"></app-stat-row>
    `;

    const table = this.querySelector('#cost-table');
    table.columns = COLUMNS;
    // Filtering and sorting are in-memory over the one dashboard payload, so
    // "fetching" a page is just awaiting the load that is already in flight.
    table.dataFn = async () => {
      await this.#pending;
      return this.#visibleAgents();
    };

    this.querySelector('#agent-search').addEventListener('input', (e) => {
      this.#query = e.target.value.trim().toLowerCase();
      table.refresh();
    });
    this.querySelector('#sort-select').addEventListener('change', (e) => {
      this.#sort = e.target.value;
      table.refresh();
    });
    this.querySelector('#month-select').addEventListener('change', () => this.#load());
    this.querySelector('#export-btn').addEventListener('click', () => this.#exportCsv());

    this.#load();
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

  async #load() {
    const select = this.querySelector('#month-select');
    const startTime = select.value;
    const endTime = select.select?.selectedOptions[0]?.dataset.end;
    // Assigned before the first await so the table's initial refresh — queued a
    // microtask after this element's markup was parsed — awaits this fetch
    // rather than seeing an empty agent list.
    this.#pending = call('fetchTokenopsDashboard', startTime, endTime);
    const table = this.querySelector('#cost-table');
    table.refresh();
    let resp;
    try {
      resp = await this.#pending;
    } catch (e) {
      // The table surfaces the failure itself — its dataFn awaits the same
      // rejected promise.
      console.error('TokenOps dashboard fetch failed:', e);
      return;
    }
    const data = resp?.data ?? resp ?? {};
    this.#agents = data.agents || [];
    this.#tokenUsage = data.token_usage || {};
    this.#renderSummary(data.summary || {});
    this.#renderTokenUsage(this.#tokenUsage);
    table.refresh();
  }

  #renderSummary(s) {
    this.querySelector('#kpi-strip').items = [
      { label: 'Total cost', value: fmtCost(s.total_cost),
        sub: `Based on ${fmtCount(s.total_operations)} operations` },
      { label: 'Total tokens', value: fmtTokens(this.#tokenTotal), sub: 'Across all agents' },
      { label: 'Total operations', value: fmtCount(s.total_operations),
        sub: `${fmtCount(s.operations_last_24h)} in the last 24 hours` },
      { label: 'Active agents', value: `${s.active_agents ?? 0}`,
        sub: `${s.total_agents ?? 0} configured · ${fmtNum(s.total_container_hours)} agent hrs` },
    ];
  }

  #renderTokenUsage(t) {
    const avg = t.avg_tokens_per_operation ?? 0;
    this.querySelector('#token-strip').items = [
      { label: 'Input tokens', value: fmtTokens(t.prompt_tokens), sub: 'Sent to models as prompts' },
      { label: 'Output tokens', value: fmtTokens(t.completion_tokens), sub: 'Generated by models' },
      { label: 'Cache tokens',
        value: fmtTokens((t.cache_read_tokens ?? 0) + (t.cache_creation_tokens ?? 0)),
        sub: `${fmtTokens(t.cache_read_tokens)} read · ${fmtTokens(t.cache_creation_tokens)} written` },
      { label: 'Total tokens', value: fmtTokens(t.total_tokens),
        sub: `${fmtTokens(avg)} avg per operation` },
    ];
  }

  #visibleAgents() {
    const rows = this.#query
      ? this.#agents.filter((a) => (a.agent_name || '').toLowerCase().includes(this.#query))
      : [...this.#agents];
    const key = this.#sort;
    rows.sort((a, b) => key === 'agent_name'
      ? (a.agent_name || '').localeCompare(b.agent_name || '')
      : (b[key] ?? 0) - (a[key] ?? 0));
    return rows;
  }

  #exportCsv() {
    const header = COLUMNS.map((c) => c.label).join(',');
    const lines = this.#visibleAgents().map((a) => COLUMNS
      .map((c) => (c.csv ? c.csv(a) : a[c.key] ?? ''))
      .map((v) => `"${String(v).replaceAll('"', '""')}"`).join(','));
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tokenops.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // The server's own fleet total, not a client-side sum of the agent rows:
  // its comment notes that agents deleted inside the window count toward the
  // fleet figures but can't appear as rows, so summing here would quietly
  // under-report exactly when the two should differ.
  get #tokenTotal() {
    return this.#tokenUsage.total_tokens ?? 0;
  }
}

customElements.define('tokenops-page', TokenopsPage);
