/**
 * All executions — workflow runs across every workflow (GET /api/maf/executions).
 *
 * One list, newest first: in-flight runs open on their live step timeline, and
 * finished ones sit collapsed under it. The list rows carry snapshotted
 * step_results and the page re-polls every 1.5s while anything is unfinished —
 * there is no run SSE. Search, status, workflow and age filter client-side; the
 * list endpoint takes no query parameters.
 *
 * **HITL.** A run pauses at `awaiting_human` exactly the way a chat turn does,
 * and is answered by the same `<hitl-card>` the orchestrator and agent chat
 * mount — one component for every kind of pause, because
 * `POST /api/hitl/{id}/resolve` depends only on `kind`. Only the plumbing
 * differs: there is no stream to reconnect to, so the rows ride on the list
 * itself (`GET /api/maf/executions` carries `hitl` per run) and resolving just
 * re-polls — the MAF worker resumes the run server-side.
 *
 * The rows are handed on whatever their status, so a run that has moved on
 * still shows what the human answered: the answer lives only on the HITL row,
 * and a finished run that hid it read as the workflow acting on an answer
 * nobody could see.
 *
 * @element executions-page
 */
import { icons } from '/common/utils/icons.js';
import { showToast } from '/common/utils/toast.js';
import { userMessage } from '/common/core/errors.js';
import { timeAgo, formatDisplay } from '/common/utils/date-utils.js';
import { fmtDuration, fmtTokens } from '/common/utils/units.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-accordion/app-accordion.js';
import '/common/design-system/app-search/app-search.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-skeleton/app-skeleton.js';
import { EXEC_ACTIVE, EXEC_STATUS } from '/common/features/wf-run-steps.js';

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
/** A run still going somewhere — it opens expanded and keeps the poll alive.
 *  `awaiting_human` is unfinished too: it is waiting on the person reading this
 *  page, which is the most active a run can be. */
const ACTIVE = EXEC_ACTIVE;
/** Toolbar status → the run statuses it admits. 'running' covers pending too:
 *  a queued run is one the user is waiting on, not a third thing to filter by. */
const STATUS_FILTERS = {
  attention: new Set(['awaiting_human']),
  running: new Set(['pending', 'running']),
  success: new Set(['success']),
  failed: new Set(['failed']),
  stopped: new Set(['stopped']),
};
const STATUS_OPTIONS = JSON.stringify([
  { value: 'all', label: 'All statuses' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'running', label: 'Running' },
  { value: 'success', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'stopped', label: 'Stopped' },
]);
/** Toolbar age → the window in days it admits. */
const TIME_WINDOWS = { '1d': 1, '7d': 7, '30d': 30 };
const TIME_OPTIONS = JSON.stringify([
  { value: 'any', label: 'Any time' },
  { value: '1d', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]);
class ExecutionsPage extends HTMLElement {
  #initialized = false;
  #executions = [];
  #query = '';
  #status = 'all';
  #workflow = 'all';
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
      <div class="toolbar">
        <app-search id="ex-search" size="sm" class="ex-search"
          placeholder="Search" aria-label="Search workflow runs"></app-search>
        <app-select id="ex-status" size="sm" fit-content aria-label="Filter by status"
          options='${STATUS_OPTIONS}' value="all"></app-select>
        <app-select id="ex-workflow" size="sm" fit-content aria-label="Filter by workflow"
          options='[{"value":"all","label":"All workflows"}]' value="all"></app-select>
        <app-select id="ex-time" size="sm" fit-content aria-label="Filter by age"
          options='${TIME_OPTIONS}' value="any"></app-select>
      </div>
      <div class="list-area" id="list-area">${this.#skeleton()}</div>
    `;

    // `input` covers typing and <app-search>'s own clear button, which re-fires it.
    this.querySelector('#ex-search').addEventListener('input', (e) => {
      this.#query = e.target.value.trim().toLowerCase();
      this.#renderList();
    });
    this.querySelector('.toolbar').addEventListener('change', (e) => {
      if (e.target.id === 'ex-status') this.#status = e.target.value;
      if (e.target.id === 'ex-workflow') this.#workflow = e.target.value;
      if (e.target.id === 'ex-time') this.#time = e.target.value;
      this.#renderList();
    });

    const area = this.querySelector('#list-area');
    area.addEventListener('click', (e) => {
      const rerun = e.target.closest('[data-rerun]');
      if (rerun) this.#rerun(rerun.dataset.rerun, rerun);
    });

    // <app-accordion> owns the disclosure — the chevron, the keyboard handling
    // and the open/close itself. The page only records what the user left open,
    // so a re-render (a filter change, a poll that changed the set) puts every
    // card back the way they had it. Deliberately no re-render here: the section
    // has already opened, and rebuilding it would throw that away and take any
    // live <hitl-card> with it.
    area.addEventListener('accordion-toggle', (e) => {
      const id = e.target.dataset.card;
      if (!id) return;
      e.detail.open ? this.#expanded.add(id) : this.#expanded.delete(id);
      if (e.detail.open) this.#hydrateSteps(this.#executions.filter((x) => x.id === id));
    });

    // A decision does not deliver itself: the MAF worker picks the resolved row
    // up and carries the run on server-side, so the only thing left to do here
    // is drop the stale pending rows and look again straight away rather than
    // waiting out the poll interval.
    for (const type of ['hitl-resolved', 'hitl-canceled']) {
      area.addEventListener(type, (e) => {
        clearTimeout(this.#pollTimer);
        this.#refresh();
      });
    }

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
    this.#pollTimer = setTimeout(() => this.#refresh(), POLL_MS);
  }

  /** One poll pass: re-read the list (HITL rows and all), patch what is on
   *  screen, and schedule the next one. */
  async #refresh() {
    try {
      this.#executions = await call('fetchAllExecutions');
      this.#refreshActive();
    } catch { /* transient poll failure — keep trying */ }
    this.#pollIfActive();
  }

  /** In-place update of open active cards; full re-render only when the
   *  active set changes (keeps per-step tab state stable while polling). */
  #refreshActive() {
    // Filtered, like the render it is refreshing — otherwise every poll sees a
    // set that never matches what is on screen and rebuilds the whole list.
    const shown = this.#executions.filter((e) => this.#matches(e));
    const rendered = [...this.querySelectorAll('.run-card[data-card]')].map((c) => c.dataset.card);
    const sameSet = shown.length === rendered.length && shown.every((e) => rendered.includes(e.id));
    if (!sameSet) {
      this.#renderList();
      return;
    }
    for (const exec of shown) {
      const card = this.querySelector(`.run-card[data-card="${CSS.escape(exec.id)}"]`);
      if (!card) continue;
      card.classList.toggle('needs-action', exec.status === 'awaiting_human');
      const metaEl = card.querySelector('.run-card-meta');
      if (metaEl) metaEl.innerHTML = this.#metaHtml(exec);
      const actionsEl = card.querySelector('.run-card-actions');
      if (actionsEl) actionsEl.innerHTML = this.#actionsHtml(exec);
    }
    this.#hydrateSteps(shown);
  }

  #renderList() {
    const area = this.querySelector('#list-area');
    if (!this.#loaded) return;

    // Nothing has ever run: the section's empty screen, with nothing to search
    // or filter, so the controls go inert rather than away — the toolbar does
    // not appear and disappear as the first run lands.
    const noRuns = !this.#executions.length;
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
    this.#syncWorkflowOptions();

    const shown = this.#executions.filter((e) => this.#matches(e));
    if (!shown.length) {
      area.innerHTML = '<p class="filter-empty">No runs match these filters.</p>';
      return;
    }
    area.innerHTML = `<div class="run-list">${shown
      .map((e) => this.#runCard(e, { open: this.#isOpen(e) })).join('')}</div>`;
    this.#hydrateSteps(shown);
  }

  /** A run still going opens on its timeline — that is the reason to be on this
   *  page at all; a finished one opens on request. */
  #isOpen(exec) {
    return ACTIVE.has(exec.status) || this.#expanded.has(exec.id);
  }

  /** The workflow filter's options are whatever has actually run — there is no
   *  point offering a workflow with no runs on a page that only lists runs. */
  #syncWorkflowOptions() {
    const names = [...new Set(this.#executions.map((e) => e.workflow_name).filter(Boolean))].sort();
    const options = JSON.stringify([
      { value: 'all', label: 'All workflows' },
      ...names.map((n) => ({ value: n, label: n })),
    ]);
    const select = this.querySelector('#ex-workflow');
    if (!select || select.getAttribute('options') === options) return;
    select.setAttribute('options', options);
    // The workflow this was filtered to may have dropped out of the list.
    if (!names.includes(this.#workflow)) this.#workflow = 'all';
    select.value = this.#workflow;
  }

  /** Start the same workflow again. The run lands at the top of the list on the
   *  refresh, so there is nothing to navigate to. */
  async #rerun(mafId, button) {
    button.setAttribute('loading', '');
    try {
      await call('runWorkflow', mafId);
      clearTimeout(this.#pollTimer);
      await this.#refresh();
    } catch (err) {
      button.removeAttribute('loading');
      showToast(userMessage(err, 'Could not start the run.'));
    }
  }

  /** Search over the workflow name and the run number, plus the three selects. */
  #matches(exec) {
    const admitted = STATUS_FILTERS[this.#status];
    if (admitted && !admitted.has(exec.status)) return false;
    if (this.#workflow !== 'all' && exec.workflow_name !== this.#workflow) return false;
    const days = TIME_WINDOWS[this.#time];
    if (days && Date.now() - new Date(exec.created_at).getTime() > days * 86_400_000) return false;
    if (!this.#query) return true;
    return `${exec.workflow_name || ''} #${exec.execution_number}`.toLowerCase().includes(this.#query);
  }

  /** wf-run-steps takes data via property — assign after the HTML lands. */
  #hydrateSteps(rows) {
    for (const exec of rows) {
      const el = this.querySelector(`wf-run-steps[data-exec="${CSS.escape(exec.id)}"]`);
      if (!el) continue;
      el.steps = exec.step_results || [];
      // Lets the timeline account for planning/synthesis, which belong to
      // the run and appear in no step row.
      el.totalTokens = exec.tokens_used || 0;
      // Pending and decided alike: a decided row is how a finished run shows
      // what the human answered, which is the only record of their part in it.
      el.hitl = exec.hitl || [];
    }
  }

  #metaHtml(exec) {
    const steps = exec.step_results || [];
    const done = steps.filter((st) => st.status === 'success').length;
    const meta = [
      steps.length ? (ACTIVE.has(exec.status) ? `Step ${done + 1}/${steps.length}`
        : steps.length === 1 ? '1 step' : `${steps.length} steps`) : '',
      exec.created_at ? (ACTIVE.has(exec.status) ? `Started ${timeAgo(exec.created_at)}` : formatDisplay(new Date(exec.created_at))) : '',
      exec.duration_ms != null ? fmtDuration(exec.duration_ms) : '',
      fmtTokens(exec.tokens_used),
    ].filter(Boolean);
    const { label, variant } = EXEC_STATUS[exec.status] || { label: exec.status, variant: 'neutral' };
    return meta.map((m) => `<app-badge variant="neutral">${escHtml(m)}</app-badge>`).join('') +
      `<app-badge variant="${variant}" dot>${escHtml(label)}</app-badge>`;
  }

  /**
   * What can be done with this run. A run whose workflow is gone can only be
   * looked at, so it keeps the trace link and loses everything that would need
   * the workflow to still exist.
   */
  #actionsHtml(exec) {
    const orphaned = !exec.workflow_name || exec.workflow_status === 'deleted';
    const out = [];
    if (!orphaned && exec.maf_id) {
      const href = `/workflow?id=${encodeURIComponent(exec.maf_id)}&exec=${encodeURIComponent(exec.id)}`;
      // A draft opens in the editor, a deployed workflow on its own page — same
      // route, but the label has to say which one the click leads to.
      out.push(`<app-button variant="secondary" size="sm" href="${escAttr(href)}"
        >${exec.workflow_status === 'draft' ? 'Open draft' : 'Open workflow'}</app-button>`);
      if (exec.status === 'failed' || exec.status === 'stopped') {
        out.push(`<app-button variant="secondary" size="sm" data-rerun="${escAttr(exec.maf_id)}"
          >Rerun</app-button>`);
      }
    }
    // Every hop of the run shares one trace, so the first step that recorded one
    // is the whole run's trace.
    const traceId = exec?.id;
    if (traceId) {
      out.push(`<a class="view-trace" href="/observability-session?session_id=${encodeURIComponent(traceId)}"
        >View trace</a>`);
    }
    return out.join('');
  }

  /**
   * One run, as `<app-accordion>`: the disclosure, its chevron, the keyboard
   * behaviour and the open/close transition are the design system's. This page
   * used to hand-roll all four around a ghost button.
   *
   * The header is slotted rather than passed as `label` because it is two rows —
   * the title with its actions, then the meta pills — and both have to stay
   * visible while the section is shut.
   */
  #runCard(exec, { open }) {
    const orphaned = !exec.workflow_name || exec.workflow_status === 'deleted';
    const title = `${exec.workflow_name || 'Deleted workflow'} #${exec.execution_number}`;
    return `
      <app-accordion variant="panel" class="run-card${exec.status === 'awaiting_human' ? ' needs-action' : ''}"
        data-card="${escAttr(exec.id)}" ${open ? 'open' : ''}>
        <div data-slot="label" class="run-head">
          <div class="run-head-top">
            <span class="run-title">${escHtml(title)}</span>
            ${orphaned ? `<app-badge variant="error">${icons.info('', 12)} Workflow not found</app-badge>` : ''}
            <span class="run-card-actions">${this.#actionsHtml(exec)}</span>
          </div>
          <div class="run-card-meta">${this.#metaHtml(exec)}</div>
        </div>
        <wf-run-steps surface="sand" data-exec="${escAttr(exec.id)}"></wf-run-steps>
        ${exec.error ? `<div class="run-error">${escHtml(exec.error)}</div>` : ''}
      </app-accordion>`;
  }

  /** The shimmer is <app-skeleton>; the well around it matches the run card's
   *  box, so the loading list occupies the same space the loaded one will. It
   *  is a plain div, not an <app-accordion> — there is nothing to disclose. */
  #skeleton() {
    const card = '<div class="run-card-shell is-skeleton"><app-skeleton lines="3"></app-skeleton></div>';
    return `<div class="run-list">${card.repeat(2)}</div>`;
  }

}

customElements.define('executions-page', ExecutionsPage);
