/**
 * All executions — workflow runs across every workflow (GET /api/maf/executions).
 *
 * Active tab shows in-flight runs with a live step timeline (the list rows
 * carry snapshotted step_results; the page re-polls the list every 1.5s
 * while anything is pending/running — there is no run SSE). History tab
 * lists finished runs, collapsed, with a status filter.
 *
 * @element executions-page
 */
import { icons } from '/common/utils/icons.js';
import { timeAgo, formatDisplay } from '/common/utils/date-utils.js';
import { fmtDuration, fmtTokens } from '/common/utils/units.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-skeleton/app-skeleton.js';
import '/common/design-system/app-tabs/app-tabs.js';
import '/common/features/wf-run-steps.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./executions-page.css', import.meta.url));
import { escAttr, escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';
// The page mounts an <app-module-nav>, and page-layout.css reserves the desktop
// gutter it pins into. Nothing imported it, so under the client router the
// gutter was reserved and the nav never upgraded.
import '/common/features/app-module-nav.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const POLL_MS = 1500;
const ACTIVE = new Set(['pending', 'running']);
/** Run status → <app-badge> variant. */
const STATUS_VARIANTS = { success: 'success', failed: 'error', running: 'warning', pending: 'neutral' };

class ExecutionsPage extends HTMLElement {
  #initialized = false;
  #executions = [];
  #tab = 'active';
  #statusFilter = 'all';
  #expanded = new Set();
  #pollTimer = null;
  #loaded = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <app-module-nav module="orchestrator"></app-module-nav>
      <h1 class="title-page page-title">All executions</h1>
      <app-tabs strip class="tabs">
        <button type="button" class="tab" role="tab" data-key="active" aria-selected="true">Active</button>
        <button type="button" class="tab" role="tab" data-key="history" aria-selected="false">History</button>
      </app-tabs>
      <div class="list-area" id="list-area">${this.#skeleton()}</div>
    `;

    // <app-tabs strip> flips aria-selected and slides the indicator; the page
    // keeps owning the single list area both tabs render into.
    this.querySelector('.tabs').addEventListener('tab-change', (e) => {
      this.#tab = e.detail.key;
      this.#renderList();
    });

    const area = this.querySelector('#list-area');
    area.addEventListener('click', (e) => {
      const filterBtn = e.target.closest('[data-filter]');
      if (filterBtn) {
        this.#statusFilter = filterBtn.dataset.filter;
        this.#renderHistoryRuns(); // seg-ctrl stays mounted so its indicator slides
        return;
      }
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const id = toggle.dataset.toggle;
        this.#expanded.has(id) ? this.#expanded.delete(id) : this.#expanded.add(id);
        this.#tab === 'history' ? this.#renderHistoryRuns() : this.#renderList();
      }
    });

    this.#load();
  }

  disconnectedCallback() {
    clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

  async #load() {
    try {
      this.#executions = await call('fetchAllExecutions');
      this.#loaded = true;
      this.#renderList();
      this.#pollIfActive();
    } catch (err) {
      this.querySelector('#list-area').innerHTML =
        `<p class="load-error">Failed to load executions: ${escHtml(err.message)}</p>`;
    }
  }

  #pollIfActive() {
    if (!this.#executions.some((e) => ACTIVE.has(e.status))) return;
    this.#pollTimer = setTimeout(async () => {
      try {
        this.#executions = await call('fetchAllExecutions');
        if (this.#tab === 'active') this.#refreshActive();
      } catch { /* transient poll failure — keep trying */ }
      this.#pollIfActive();
    }, POLL_MS);
  }

  /** In-place update of open active cards; full re-render only when the
   *  active set changes (keeps per-step tab state stable while polling). */
  #refreshActive() {
    const active = this.#executions.filter((e) => ACTIVE.has(e.status));
    const rendered = [...this.querySelectorAll('.run-card[data-card]')].map((c) => c.dataset.card);
    const sameSet = active.length === rendered.length && active.every((e) => rendered.includes(e.id));
    if (!sameSet) {
      this.#renderList();
      return;
    }
    for (const exec of active) {
      const card = this.querySelector(`.run-card[data-card="${CSS.escape(exec.id)}"]`);
      const metaEl = card?.querySelector('.run-card-meta');
      if (metaEl) metaEl.innerHTML = this.#metaHtml(exec);
    }
    this.#hydrateSteps(active);
  }

  #renderList() {
    const area = this.querySelector('#list-area');
    if (!this.#loaded) return;

    if (this.#tab === 'active') {
      const active = this.#executions.filter((e) => ACTIVE.has(e.status));
      if (!this.#executions.length) {
        area.innerHTML = this.#emptyState({
          icon: icons.workflow('', 40),
          title: 'No workflow runs yet',
          sub: 'Create your first workflow by chaining agents together.',
          action: `<app-button variant="primary" href="/workflow-new">Create workflow ${icons.plus()}</app-button>`,
        });
        return;
      }
      if (!active.length) {
        area.innerHTML = this.#emptyState({
          icon: icons.play('', 40),
          title: 'Your active runs will appear here',
          sub: 'Monitor live workflow executions, track progress across each step, and inspect outputs as they are generated.',
          action: `<app-button variant="tertiary" href="/workflows">Browse workflows</app-button>`,
        });
        return;
      }
      area.innerHTML = `<div class="run-list">${active.map((e) => this.#runCard(e, { open: true })).join('')}</div>`;
      this.#hydrateSteps(active);
      return;
    }

    // History tab
    const finished = this.#executions.filter((e) => !ACTIVE.has(e.status));
    if (!finished.length) {
      area.innerHTML = this.#emptyState({
        icon: icons.workflow('', 40),
        title: 'No finished runs yet',
        sub: 'Completed and failed workflow runs land here with their full step timelines.',
        action: `<app-button variant="tertiary" href="/workflows">Browse workflows</app-button>`,
      });
      return;
    }
    area.innerHTML = `
      <fieldset class="seg-ctrl">
        <legend>Status</legend>
        ${[['all', 'All'], ['success', 'Completed'], ['failed', 'Failed']].map(([key, label]) => `
          <label><input type="radio" name="status-filter" data-filter="${key}"
            ${this.#statusFilter === key ? 'checked' : ''}>${label}</label>`).join('')}
      </fieldset>
      <div class="run-list"></div>`;
    attachSlidingIndicator(area.querySelector('.seg-ctrl'), 'label', ':has(input:checked)', { pill: true });
    this.#renderHistoryRuns();
  }

  /** Fills `.run-list` only — the history seg-ctrl stays mounted so filter
   *  switches animate its indicator instead of rebuilding the control. */
  #renderHistoryRuns() {
    const list = this.querySelector('.run-list');
    if (!list) return;
    const finished = this.#executions.filter((e) => !ACTIVE.has(e.status));
    const filtered = this.#statusFilter === 'all'
      ? finished
      : finished.filter((e) => e.status === this.#statusFilter);
    list.innerHTML = filtered.length
      ? filtered.map((e) => this.#runCard(e, { open: this.#expanded.has(e.id) })).join('')
      : '<p class="filter-empty">No runs match this filter.</p>';
    this.#hydrateSteps(filtered.filter((e) => this.#expanded.has(e.id)));
  }

  /** wf-run-steps takes data via property — assign after the HTML lands. */
  #hydrateSteps(rows) {
    for (const exec of rows) {
      const el = this.querySelector(`wf-run-steps[data-exec="${CSS.escape(exec.id)}"]`);
      if (el) el.steps = exec.step_results || [];
    }
  }

  #metaHtml(exec) {
    const stepCount = exec.step_results?.length;
    const meta = [
      stepCount ? (stepCount === 1 ? '1 step' : `${stepCount} steps`) : '',
      exec.created_at ? (ACTIVE.has(exec.status) ? `Started ${timeAgo(exec.created_at)}` : formatDisplay(new Date(exec.created_at))) : '',
      exec.duration_ms != null ? fmtDuration(exec.duration_ms) : '',
      fmtTokens(exec.tokens_used),
    ].filter(Boolean);
    const variant = STATUS_VARIANTS[exec.status] || 'neutral';
    return meta.map((m) => `<app-badge variant="neutral">${escHtml(m)}</app-badge>`).join('') +
      `<app-badge variant="${variant}" dot>${escHtml(exec.status)}</app-badge>`;
  }

  #runCard(exec, { open }) {
    const orphaned = !exec.workflow_name || exec.workflow_status === 'deleted';
    const title = `${exec.workflow_name || 'Deleted workflow'} #${exec.execution_number}`;
    return `
      <div class="run-card" data-card="${escHtml(exec.id)}">
        <div class="run-card-head">
          <span class="run-title">${escHtml(title)}</span>
          ${orphaned ? `<app-badge variant="error">${icons.info('', 12)} Workflow not found</app-badge>` : ''}
          <span class="head-spacer"></span>
          ${!orphaned && exec.maf_id ? `<a class="open-wf" href="/workflow?id=${encodeURIComponent(exec.maf_id)}&exec=${encodeURIComponent(exec.id)}">Open workflow</a>` : ''}
          <app-button variant="ghost" size="sm" icon-only data-toggle="${escAttr(exec.id)}"
            aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} run">
            ${open ? icons.chevronUp() : icons.chevronDown()}
          </app-button>
        </div>
        <div class="run-card-meta">${this.#metaHtml(exec)}</div>
        ${open ? `<wf-run-steps surface="sand" data-exec="${escHtml(exec.id)}"></wf-run-steps>` : ''}
        ${open && exec.error ? `<div class="run-error">${escHtml(exec.error)}</div>` : ''}
      </div>`;
  }

  #emptyState({ icon, title, sub, action }) {
    return `
      <app-empty-state title="${title}" description="${sub}" icon='${icon}'>
        ${action}
      </app-empty-state>`;
  }

  /** The shimmer is <app-skeleton>; the well around it is the run card's own
   *  box, so the loading list occupies the same space the loaded one will. */
  #skeleton() {
    const card = '<div class="run-card is-skeleton"><app-skeleton lines="3"></app-skeleton></div>';
    return `<div class="run-list">${card.repeat(2)}</div>`;
  }

}

customElements.define('executions-page', ExecutionsPage);
