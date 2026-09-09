import { icons } from '/common/utils/icons.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-skeleton/app-skeleton.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./flow-detail-page.css', import.meta.url));
import { escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const STATUS_VARIANTS = { completed: 'success', running: 'info', failed: 'error', timeout: 'warning' };

class FlowDetailPage extends HTMLElement {
  #initialized = false;

  #toolbar(sub = '') {
    return `<header class="page-head">
      <div>
        <h1 class="title-page">Flow detail</h1>
        ${sub ? `<p class="page-sub">${sub}</p>` : ''}
      </div>
      <a class="back-link" href="/flows">${icons.chevronLeft('', 16)}Back to flows</a>
    </header>`;
  }

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    const flowId = new URLSearchParams(location.search).get('id');
    if (!flowId) {
      this.innerHTML = `${this.#toolbar()}
        <app-empty-state
          heading="No flow selected"
          description="Open a flow from the list to inspect its trace."
          icon='${icons.activity("", 40)}'></app-empty-state>`;
      return;
    }
    this.innerHTML = `${this.#toolbar()}${this.#loadingBodyHtml()}`;
    this.#load(flowId);
  }

  /**
   * Placeholder for the body while the flow trace loads. The real layout
   * below is a 5-tile KPI strip followed by a list of step rows, so the
   * loading state shimmers as those same shapes instead of one slab.
   */
  #loadingBodyHtml() {
    const kpi = (labelWidth) => `
        <div class="kpi">
          <div class="kpi-label"><app-skeleton height="10px" style="width:${labelWidth};"></app-skeleton></div>
          <div class="kpi-value"><app-skeleton height="14px" style="width:70%;"></app-skeleton></div>
        </div>`;
    const stepRow = () => '<app-skeleton height="48px" radius="md" style="margin-bottom:var(--s-8);"></app-skeleton>';
    return `
      <div class="kpi-strip">${['4ch', '7ch', '6ch', '6ch', '4ch'].map(kpi).join('')}</div>
      <div class="section-head">
        <h2 class="section-title">Steps</h2>
      </div>
      <div class="steps">${Array.from({ length: 3 }, stepRow).join('')}</div>`;
  }

  async #load(flowId) {
    const data = await call('fetchFlowDetail', flowId);
    if (!data) {
      this.innerHTML = `${this.#toolbar()}
        <app-empty-state
          heading="Flow not found"
          description="This flow may have expired or been removed."
          icon='${icons.faceFrown("", 40)}'></app-empty-state>`;
      return;
    }

    const flow = data.flow || data;
    const steps = data.steps || [];

    document.title = `Nasiko — Flow ${flow.flow_id.slice(0, 12)}`;
    const variant = STATUS_VARIANTS[flow.status] || 'neutral';
    const duration = flow.duration_ms != null
      ? (flow.duration_ms < 1000 ? `${flow.duration_ms}ms` : `${(flow.duration_ms / 1000).toFixed(1)}s`)
      : 'In progress';
    const started = flow.created_at
      ? new Date(flow.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '—';

    this.innerHTML = `${this.#toolbar(escHtml(flow.title || ''))}
      <div class="kpi-strip">
        <div class="kpi">
          <div class="kpi-label">Status</div>
          <div class="kpi-value"><app-badge variant="${variant}" dot>${escHtml(flow.status)}</app-badge></div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Root agent</div>
          <div class="kpi-value is-mono">${escHtml(flow.root_agent_name || 'orchestrator')}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Duration</div>
          <div class="kpi-value is-mono">${duration}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Started</div>
          <div class="kpi-value is-mono">${started}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Steps</div>
          <div class="kpi-value is-mono">${steps.length}</div>
        </div>
      </div>

      <div class="section-head">
        <h2 class="section-title">Steps</h2>
        <p class="section-sub">Each agent call in this flow, in execution order. Expand a step for its input and timing.</p>
      </div>
      <div class="steps" id="trace-container"></div>
    `;

    this.#renderTrace(steps, flow.duration_ms || 1);
  }

  #renderTrace(steps, totalDuration) {
    const container = this.querySelector('#trace-container');
    if (!steps.length) {
      container.innerHTML = `
        <app-empty-state
          heading="No steps recorded"
          description="No agent calls were recorded for this flow."
          icon='${icons.activity("", 40)}'></app-empty-state>`;
      return;
    }

    const flowStart = new Date(steps[0].created_at).getTime();

    container.innerHTML = steps.map((step, i) => {
      const stepStart = new Date(step.created_at).getTime();
      const stepEnd = step.completed_at ? new Date(step.completed_at).getTime() : stepStart + (totalDuration || 1000);
      const offsetPct = ((stepStart - flowStart) / totalDuration) * 100;
      const widthPct = Math.max(2, ((stepEnd - stepStart) / totalDuration) * 100);
      const latency = step.latency_ms != null ? `${step.latency_ms}ms` : (step.completed_at ? `${stepEnd - stepStart}ms` : '…');
      const status = step.status || 'running';
      const numClass = status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'active';
      const startedAt = new Date(step.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      return `
        <details class="step">
          <summary class="step-row">
            <span class="step-num ${numClass}">${i + 1}</span>
            <span class="step-agent">${escHtml(step.agent_name)}</span>
            ${step.input_summary ? `<span class="step-snippet">${escHtml(step.input_summary.slice(0, 60))}${step.input_summary.length > 60 ? '…' : ''}</span>` : '<span class="step-snippet"></span>'}
            <app-badge variant="${STATUS_VARIANTS[status] || 'neutral'}" dot>${escHtml(status)}</app-badge>
            <span class="step-latency">${latency}</span>
            <span class="step-caret">${icons.chevronDown('', 14)}</span>
          </summary>
          <div class="step-body">
            ${step.input_summary ? `
              <div class="step-well">
                <div class="well-label">Input</div>
                <div class="well-text">${escHtml(step.input_summary)}</div>
              </div>` : ''}
            <div class="step-meta">
              <span class="meta-item">Started <span class="is-mono">${startedAt}</span></span>
              <span class="meta-item">Latency <span class="is-mono">${latency}</span></span>
            </div>
            <div class="step-track">
              <div class="step-bar is-${numClass}" style="left:${offsetPct}%;width:${widthPct}%;"></div>
            </div>
          </div>
        </details>
      `;
    }).join('');
  }

}

customElements.define('flow-detail-page', FlowDetailPage);
