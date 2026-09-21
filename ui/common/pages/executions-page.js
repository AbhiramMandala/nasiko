/**
 * All executions — workflow runs across every workflow (GET /api/maf/executions).
 *
 * Active tab shows in-flight runs with a live step timeline (the list rows
 * carry snapshotted step_results; the page re-polls the list every 1.5s
 * while anything is pending/running — there is no run SSE). History tab
 * lists finished runs, collapsed. Search, status and age filter either tab,
 * client-side — the list endpoint takes no query parameters.
 *
 * @element executions-page
 */
import { icons } from '/common/utils/icons.js';
import { timeAgo, formatDisplay } from '/common/utils/date-utils.js';
import { fmtDuration, fmtTokens } from '/common/utils/units.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-search/app-search.js';
import '/common/design-system/app-select/app-select.js';
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
/** Empty-screen illustration (Figma export, ui/common/images). */
const RUNS_ART = '/common/images/executions_empty.svg';
const ACTIVE = new Set(['pending', 'running']);
/** Toolbar status → the run statuses it admits. 'running' covers pending too:
 *  a queued run is one the user is waiting on, not a third thing to filter by. */
const STATUS_FILTERS = { running: ACTIVE, success: new Set(['success']), failed: new Set(['failed']) };
const STATUS_OPTIONS = JSON.stringify([
  { value: 'all', label: 'All statuses' },
  { value: 'running', label: 'Running' },
  { value: 'success', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
]);
/** Toolbar age → the window in days it admits. */
const TIME_WINDOWS = { '1d': 1, '7d': 7, '30d': 30 };
const TIME_OPTIONS = JSON.stringify([
  { value: 'any', label: 'Any time' },
  { value: '1d', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]);
/** Run status → <app-badge> variant. */
const STATUS_VARIANTS = { success: 'success', failed: 'error', running: 'warning', pending: 'neutral' };

class ExecutionsPage extends HTMLElement {
  #initialized = false;
  #executions = [];
  #tab = 'active';
  #query = '';
  #status = 'all';
  #time = 'any';
  #expanded = new Set();
  #pollTimer = null;
  #loaded = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <app-module-nav module="orchestrator"></app-module-nav>
      <h1 class="title-page page-title">Workflow runs</h1>
      <app-tabs strip class="tabs">
        <button type="button" class="tab" role="tab" data-key="active" aria-selected="true">Active</button>
        <button type="button" class="tab" role="tab" data-key="history" aria-selected="false">History</button>
      </app-tabs>
      <div class="toolbar">
        <app-search id="ex-search" size="sm" class="ex-search"
          placeholder="Search" aria-label="Search workflow runs"></app-search>
        <app-select id="ex-status" size="sm" fit-content aria-label="Filter by status"
          options='${STATUS_OPTIONS}' value="all"></app-select>
        <app-select id="ex-time" size="sm" fit-content aria-label="Filter by age"
          options='${TIME_OPTIONS}' value="any"></app-select>
      </div>
      <div class="list-area" id="list-area">${this.#skeleton()}</div>
    `;

    // <app-tabs strip> flips aria-selected and slides the indicator; the page
    // keeps owning the single list area both tabs render into.
    this.querySelector('.tabs').addEventListener('tabs-change', (e) => {
      this.#tab = e.detail.key;
      this.#renderList();
    });

    // `input` covers typing and <app-search>'s own clear button, which re-fires it.
    this.querySelector('#ex-search').addEventListener('input', (e) => {
      this.#query = e.target.value.trim().toLowerCase();
      this.#renderList();
    });
    this.querySelector('.toolbar').addEventListener('change', (e) => {
      if (e.target.id === 'ex-status') this.#status = e.target.value;
      if (e.target.id === 'ex-time') this.#time = e.target.value;
      this.#renderList();
    });

    this.querySelector('#list-area').addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-toggle]');
      if (!toggle) return;
      const id = toggle.dataset.toggle;
      this.#expanded.has(id) ? this.#expanded.delete(id) : this.#expanded.add(id);
      this.#renderList();
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
      // Was a bare line of text where the list should be. The raw message
      // moves into the description so the detail survives the restyle.
      const area = this.querySelector('#list-area');
      area.innerHTML = `
        <app-empty-state variant="error"
          heading="Couldn't load executions"
          description="${escAttr(err?.message || 'The request failed.')}">
          <app-button id="exec-retry" variant="tertiary">Retry</app-button>
        </app-empty-state>`;
      area.querySelector('#exec-retry')?.addEventListener('click', () => {
        area.innerHTML = this.#skeleton();
        this.#load();
      });
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
    // Filtered, like the render it is refreshing — otherwise every poll sees a
    // set that never matches what is on screen and rebuilds the whole list.
    const active = this.#executions.filter((e) => ACTIVE.has(e.status) && this.#matches(e));
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

    // Nothing has ever run: the page has no two states to tab between, so it is
    // the section's empty screen and the strip comes down with it.
    const noRuns = !this.#executions.length;
    this.querySelector('.tabs').hidden = noRuns;
    // Nothing to search or filter: the controls go inert rather than away, so
    // the toolbar does not appear and disappear as the first run lands.
    for (const el of this.querySelectorAll('.toolbar > *')) el.toggleAttribute('disabled', noRuns);
    if (noRuns) {
      area.innerHTML = `
        <app-empty-state plain heading="No workflow runs yet"
          description="Your workflow runs will appear here once you start executing a deployed workflow.">
          <img data-slot="icon" class="runs-art" src="${RUNS_ART}" alt="" width="286" height="164" />
          <app-button variant="secondary" size="md" href="/workflows">View workflows</app-button>
        </app-empty-state>`;
      return;
    }

    const active = this.#tab === 'active';
    const rows = this.#executions.filter((e) => ACTIVE.has(e.status) === active);
    if (!rows.length) {
      area.innerHTML = active
        ? this.#emptyState({
            icon: icons.play('', 40),
            title: 'Your active runs will appear here',
            sub: 'Monitor live workflow executions, track progress across each step, and inspect outputs as they are generated.',
            action: `<app-button variant="primary" href="/workflows">Browse workflows</app-button>`,
          })
        : this.#emptyState({
            icon: icons.workflow('', 40),
            title: 'No finished runs yet',
            sub: 'Completed and failed workflow runs land here with their full step timelines.',
            action: `<app-button variant="primary" href="/workflows">Browse workflows</app-button>`,
          });
      return;
    }
    const shown = rows.filter((e) => this.#matches(e));
    if (!shown.length) {
      area.innerHTML = '<p class="filter-empty">No runs match these filters.</p>';
      return;
    }
    // An active run is opened by default — its step timeline is the reason to
    // be on the tab at all; a finished one opens on request.
    area.innerHTML = `<div class="run-list">${shown
      .map((e) => this.#runCard(e, { open: active || this.#expanded.has(e.id) })).join('')}</div>`;
    this.#hydrateSteps(active ? shown : shown.filter((e) => this.#expanded.has(e.id)));
  }

  /** Search over the workflow name and the run number, plus the two selects. */
  #matches(exec) {
    const admitted = STATUS_FILTERS[this.#status];
    if (admitted && !admitted.has(exec.status)) return false;
    const days = TIME_WINDOWS[this.#time];
    if (days && Date.now() - new Date(exec.created_at).getTime() > days * 86_400_000) return false;
    if (!this.#query) return true;
    return `${exec.workflow_name || ''} #${exec.execution_number}`.toLowerCase().includes(this.#query);
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
      <app-empty-state heading="${title}" description="${sub}" icon='${icon}'>
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
