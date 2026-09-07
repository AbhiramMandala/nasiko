/**
 * `<generated-view-page>` — a screen Weave built, at its own URL.
 *
 * Generation opens a route rather than replacing the current screen: the user
 * asked for this from somewhere, and that somewhere is still where they were.
 * The view is addressable (`/view?id=…`), so it can be linked, reloaded and
 * re-opened from the dock's artifact card long after the conversation moved on.
 *
 * A generated view is ephemeral until saved. **Save view** is the only thing
 * that promotes it into the sidebar and onto `/custom-views`; everything else
 * here is the frame around whatever was generated.
 *
 * ponytail: the dashboard body is one canned TokenOps layout, the same for
 * every prompt. `#renderDashboard()` is where a real generated tree mounts —
 * `<weave-surface>` already renders one from a model spec (see weave-page), and
 * swapping it in is a one-function change that touches nothing else on the page.
 *
 * @element generated-view-page
 */

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./generated-view-page.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

import { escHtml } from '/common/utils/escape.js';
import { icons } from '/common/utils/icons.js';
import { toast } from '/common/utils/toast.js';
import { navigate } from '/common/core/router.js';
import { getView, saveView, touchView } from '/common/state/weave-views.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-menu/app-menu.js';
import '/common/design-system/app-chart/app-chart.js';
import '/common/design-system/app-table/app-table.js';
import '/common/design-system/app-toggle-group/app-toggle-group.js';
import '/common/design-system/app-empty-state/app-empty-state.js';

/** How long the generating state holds. Long enough to read, short enough to trust. */
const GENERATE_MS = 1400;

const COPY_ACTIONS = [
  { id: 'link', label: 'Copy link' },
  { id: 'json', label: 'Copy as JSON' },
  { id: 'image', label: 'Copy as image' },
];

/** Dummy fleet rows — the shape mirrors the TokenOps dashboard's agent rows. */
const ATTRIBUTIONS = [
  { agent: 'DevOps Engineer',         spend: 1247.83, tokens: '18.4M', output: '6.2M',  input: '12.2M', avgCost: 0.32, hours: 128.5, latency: '2.4s' },
  { agent: 'Documentation Assistant', spend: 892.14,  tokens: '14.1M', output: '8.7M',  input: '5.4M',  avgCost: 0.17, hours: 96.2,  latency: '1.8s' },
  { agent: 'Finance Analyst',         spend: 2034.56, tokens: '22.7M', output: '4.9M',  input: '17.8M', avgCost: 0.94, hours: 214.7, latency: '4.1s' },
  { agent: 'Support Triage',          spend: 618.40,  tokens: '9.8M',  output: '3.1M',  input: '6.7M',  avgCost: 0.21, hours: 74.9,  latency: '1.2s' },
  { agent: 'Research Agent',          spend: 1502.09, tokens: '16.3M', output: '7.4M',  input: '8.9M',  avgCost: 0.55, hours: 143.1, latency: '3.6s' },
];

const KPIS = [
  { value: '$46,210', label: 'Total AI spend',  delta: '8.4%', dir: 'up',   trend: 'bad' },
  { value: '1.23B',   label: 'Total tokens',    delta: '6.1%', dir: 'up',   trend: 'bad' },
  { value: '77%',     label: 'Budget burn',     delta: '6.1%', dir: 'down', trend: 'good' },
  { value: '$0.62',   label: 'Cost / operation',delta: '6.1%', dir: 'down', trend: 'good' },
  { value: '2.3s',    label: 'Avg latency',     delta: '6.1%', dir: 'down', trend: 'good' },
];

const SPEND_SERIES = [280, 215, 300, 340, 315, 360, 395, 350, 300, 330, 380, 420, 400, 445,
                      330, 345, 340, 335, 350, 360, 355, 350, 360, 358, 352, 348, 340, 330, 320, 300, 285];

const CONCENTRATION = [
  { label: 'Operation agent', value: 123 },
  { label: 'Operation agent', value: 123 },
  { label: 'Operation agent', value: 123 },
  { label: 'Others',          value: 123 },
];

const COLUMNS = [
  { key: 'agent',   label: 'Agent' },
  { key: 'spend',   label: 'Spend',       render: (v) => `$${v.toFixed(2)}` },
  { key: 'tokens',  label: 'Tokens' },
  { key: 'output',  label: 'Output' },
  { key: 'input',   label: 'Input' },
  { key: 'avgCost', label: 'Avg cost/op',  render: (v) => `$${v.toFixed(2)}` },
  { key: 'hours',   label: 'Agent hours' },
  { key: 'latency', label: 'Avg latency' },
];

class GeneratedViewPage extends HTMLElement {
  #initialized = false;
  #view = null;
  #timer = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    // Asking Weave for a second screen while looking at the first is `/view?id=A`
    // → `?id=B`: the same route pattern, which the router serves by updating the
    // mounted page instead of remounting it. Without this the second view would
    // never draw — the URL would change and the first dashboard would stay put.
    this.addEventListener('route-update', () => this.#load());
    this.#load();
  }

  disconnectedCallback() {
    clearTimeout(this.#timer);
  }

  #load() {
    clearTimeout(this.#timer);
    this.classList.remove('is-expanded');
    this.#view = getView(new URLSearchParams(location.search).get('id') || '');
    if (!this.#view) {
      this.#renderMissing();
      return;
    }
    touchView(this.#view.id);
    document.title = `Nasiko — ${this.#view.title}`;
    this.#render();
    this.#timer = setTimeout(() => this.#renderDashboard(), GENERATE_MS);
  }

  #renderMissing() {
    this.innerHTML = `
      <app-empty-state heading="That view is gone"
        description="Generated views live in this browser. Ask Weave for it again, or open one from Custom views."
      ></app-empty-state>`;
  }

  #render() {
    const saved = this.#view.saved;
    this.innerHTML = `
      <header class="view-bar">
        <h1 class="title-page">${escHtml(this.#view.title)}</h1>
        <div class="view-bar__actions">
          <app-button id="save" variant="primary" size="sm" ${saved ? 'disabled' : ''}
            >${saved ? 'Saved' : 'Save view'}</app-button>
          <app-menu id="copy" label="Copy view" align="end"
            items='${JSON.stringify(COPY_ACTIONS)}'>
            <app-button variant="ghost" size="sm">Copy ${icons.chevronDownSmall('', 14, 1.25)}</app-button>
          </app-menu>
          <button class="icon-btn" id="expand" type="button" aria-label="Expand"
            >${icons.externalLink('', 16, 1.25)}</button>
          <button class="icon-btn" id="close" type="button" aria-label="Close view"
            >${icons.x('', 16, 1.25)}</button>
        </div>
      </header>

      <div class="canvas" id="canvas">
        <div class="generating">
          <p class="generating__head">Generating your dashboard…</p>
          <p>Analyzing your request and assembling the best sequence of steps.</p>
          <ul class="generating__steps">
            <li>Understanding your goal</li>
            <li>Selecting relevant steps</li>
            <li>Structuring the workflow</li>
            <li>Defining triggers and outputs</li>
          </ul>
          <p>This usually takes a few seconds.</p>
        </div>
      </div>`;

    this.querySelector('#save').addEventListener('click', () => this.#save());
    this.querySelector('#close').addEventListener('click', () => this.#close());
    this.querySelector('#expand').addEventListener('click',
      () => this.classList.toggle('is-expanded'));
    this.querySelector('#copy').addEventListener('menu-select', (e) => {
      if (e.detail.id === 'link') navigator.clipboard?.writeText(location.href);
      toast.success('Copied');
    });
  }

  #save() {
    saveView(this.#view.id);
    const button = this.querySelector('#save');
    button.textContent = 'Saved';
    button.setAttribute('disabled', '');
    // The rail caches its items per tab, so it has to be told. `nav-refresh`
    // is app-header's own hook — the alternative was reaching into its cache
    // from here, which is not this page's business.
    document.dispatchEvent(new CustomEvent('nav-refresh'));
    toast.success('Saved to Custom views');
  }

  /** Back to wherever this was generated from; the app root if there is no history. */
  #close() {
    if (history.length > 1) history.back();
    else navigate('/');
  }

  #renderDashboard() {
    const canvas = this.querySelector('#canvas');
    canvas.classList.add('is-ready');
    canvas.innerHTML = `
      <div class="filters">
        <app-select id="month" size="sm" aria-label="Month"
          options='["August","July","June"]' value="August"></app-select>
        <app-toggle-group attached size="sm" value="30d" label="Period">
          ${['24h', '7d', '30d'].map((p) => `<app-toggle value="${p}">${p}</app-toggle>`).join('')}
        </app-toggle-group>
        <app-select size="sm" aria-label="Server" options='["Server"]'></app-select>
        <app-select size="sm" aria-label="Agent" options='["Agent"]'></app-select>
        <app-select size="sm" aria-label="Provider" options='["Provider"]'></app-select>
      </div>

      <div class="kpis">
        ${KPIS.map((k) => `
          <div class="kpi">
            <span class="kpi__delta is-${k.trend}">
              ${k.dir === 'up' ? icons.arrowUpRight('', 14, 1.5) : icons.arrowDown('', 14, 1.5)}
              <span>${escHtml(k.delta)}</span>
            </span>
            <span class="kpi__body">
              <span class="kpi__value">${escHtml(k.value)}</span>
              <span class="kpi__label">${escHtml(k.label)}</span>
            </span>
          </div>`).join('')}
      </div>

      <div class="panels">
        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">Spend over time</h2>
            <app-toggle-group attached size="sm" value="usd" label="Units">
              <app-toggle value="pct">%</app-toggle>
              <app-toggle value="usd">$</app-toggle>
            </app-toggle-group>
          </div>
          <app-chart id="spend" type="line" height="220px" format="currency"
            label="Spend over time"></app-chart>
        </section>

        <section class="panel">
          <div class="panel__head">
            <h2 class="panel__title">Spend concentration</h2>
          </div>
          <div class="concentration">
            <div class="calendar" role="img" aria-label="Spend by day of month, 21 August is the peak">
              ${Array.from({ length: 30 }, (_, i) => `
                <span class="calendar__day${i < 23 ? ' is-on' : ''}${i === 20 ? ' is-peak' : ''}">${i + 1}</span>`).join('')}
            </div>
            <ul class="legend">
              ${CONCENTRATION.map((c, i) => `
                <li><span class="legend__dot" style="background:var(--viz-${i + 1})"></span>
                  <span class="legend__text">${escHtml(c.label)}<b>$${c.value}</b></span></li>`).join('')}
            </ul>
          </div>
          <app-chart id="hours" type="bar" stacked height="160px" format="currency"
            label="Spend by hour"></app-chart>
        </section>
      </div>

      <section class="panel panel--wide">
        <div class="panel__head">
          <h2 class="panel__title">Attributions</h2>
          <app-toggle-group attached size="sm" value="agent" label="Group by">
            <app-toggle value="agent">Agent</app-toggle>
            <app-toggle value="workflow">Workflow</app-toggle>
          </app-toggle-group>
          <app-select size="sm" aria-label="Sort"
            options='["Most tokens","Highest spend","Slowest"]'></app-select>
        </div>
        <app-table id="attributions" pagination="none"></app-table>
      </section>`;

    canvas.querySelector('#spend').data = {
      labels: SPEND_SERIES.map((_, i) => String(i + 1)),
      datasets: [{ label: 'Cost', data: SPEND_SERIES }],
    };
    canvas.querySelector('#hours').data = {
      labels: ['12am', '4', '8', '12', '4', '8', '12am'],
      datasets: [
        { label: 'Operations', data: [120, 180, 260, 300, 240, 280, 140] },
        { label: 'Research',   data: [60, 90, 140, 180, 120, 150, 70] },
      ],
    };
    const table = canvas.querySelector('#attributions');
    table.columns = COLUMNS;
    table.dataFn = async () => ATTRIBUTIONS;
  }
}

customElements.define('generated-view-page', GeneratedViewPage);
