/**
 * Workflow detail — review/edit one MAF workflow, run it, and watch runs.
 *
 * Views (single 720px column, mirroring the mockup's review screen):
 * - review: name/description/steps (PUT /api/maf/workflow/{id}),
 *   output_generation display, execution history. Which face it opens on is
 *   the workflow's status: a draft is a thing still being written, so it opens
 *   editable and never leaves edit mode; a deployed workflow opens read-only
 *   behind Edit, because its definition is live.
 *   Both run through the same endpoint, and that endpoint runs the *stored*
 *   row — so a test run saves first, which is why one button does both. A
 *   draft additionally gets Deploy (POST /api/maf/workflow/{id}/promote, a
 *   status flip), and a draft with no steps yet — the bare sentence
 *   POST /maf/workflow/draft saves — starts on the editor's empty step.
 * - run: live per-step timeline for one execution — polls
 *   GET /api/maf/execution/{id} every 1.5s while pending/running (no SSE).
 *
 * Deep link: /workflow?id=<workflow>&exec=<execution>.
 *
 * @element workflow-detail-page
 */
import { apiFetch } from '/common/services/api.js';
import { icons } from '/common/utils/icons.js';
import { showToast } from '/common/utils/toast.js';
import { confirmDialog } from '/common/design-system/app-modal/app-modal.js';
import { timeAgo } from '/common/utils/date-utils.js';
import { fmtDuration, fmtTokens } from '/common/utils/units.js';
import { renderMarkdown } from '/common/utils/markdown.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-chatbox/app-chatbox.js';
import '/common/design-system/app-button/app-button.js';
import '/common/utils/back-link.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/features/wf-step-editor.js';
import { EXEC_ACTIVE, EXEC_STATUS } from '/common/features/wf-run-steps.js';
// The page mounts an <app-module-nav>, and page-layout.css reserves the desktop
// gutter it pins into.
import '/common/features/app-module-nav.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./workflow-detail-page.css', import.meta.url));
import { escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';
import { generateErrorHtml, isDeployed } from '/common/services/workflows-service.js';
import { navigate } from '../core/router.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const POLL_MS = 1500;
/** Execution status → <app-badge> variant. */
// Status wording and colour are `EXEC_STATUS`, shared with the executions list:
// this page used to carry its own map, which had no `awaiting_human` in it, so a
// paused run printed the raw wire value under a heading that said nothing about
// what to do next.

class WorkflowDetailPage extends HTMLElement {
  #initialized = false;
  #workflowId = null;
  #workflow = null;
  #execution = null;
  #pollTimer = null;
  /** The description the steps in the editor came from — the saved one on
   *  entering edit mode, the regenerated one after a redraft. Null while there
   *  is no plan to compare against. See #syncGenerate(). */
  #generatedFrom = null;

  /**
   * Replace the page body, keeping the module nav.
   *
   * `/workflow` names no row in the tree, so the path match every other row
   * lives by finds nothing and the whole module goes unlit. The row a workflow
   * belongs under is its status — a draft is under Drafts, a live one under
   * Deployed — which only this page has fetched, so it tells the nav. Before
   * the fetch lands (the skeleton) there is nothing to claim yet, and the nav
   * simply lights nothing rather than guessing and then moving.
   */
  #paint(html) {
    const row = this.#workflow
      ? (isDeployed(this.#workflow) ? '/workflows' : '/workflow-drafts')
      : '';
    const nav = `<app-module-nav module="orchestrator"${row ? ` active-url="${row}"` : ''}></app-module-nav>`;
    this.innerHTML = nav + html;
  }

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    const params = new URLSearchParams(location.search);
    this.#workflowId = params.get('id');
    window.addEventListener('popstate', this.#onPopState);

    if (!this.#workflowId) {
      this.#paint(`
        <div class="col">
          <app-empty-state
            heading="No workflow selected"
            description="Open one from the workflows library to review its steps and runs."
            icon='${icons.workflow('', 40)}'>
            <app-button variant="tertiary" href="/workflows">Browse workflows</app-button>
          </app-empty-state>
        </div>`);
      return;
    }
    // Set by the create screen's "Save & run" when the save succeeded but the
    // run request didn't — otherwise the workflow just silently sits unrun.
    const runError = params.get('run_error');
    if (runError) showToast(`Saved, but the run didn't start: ${runError}`);

    // Paint the skeleton before the fetches, not after: under the SPA router
    // this element arrives empty (the pre-upgrade markup in workflow.html only
    // exists on a full document load), so every route in here — the library,
    // a deep link, the create screen's save — cross-faded to a blank card for
    // the length of two API calls and then popped the content in.
    this.#renderSkeleton();
    this.#load(params.get('exec'));
  }

  /** Same shape as workflow.html's pre-upgrade markup, so both paint alike. */
  #renderSkeleton() {
    this.#paint(`
      <div class="col">
        <div class="skel-head">
          <div class="skel-card__avatar"></div>
          <div class="skel-card__line skel-card__line--w50"></div>
        </div>
        <div class="skel-card__line skel-card__line--w80"></div>
        <div class="skel-card__tags">
          <div class="skel-card__tag"></div><div class="skel-card__tag"></div>
        </div>
        <div class="skel-card">
          <div class="skel-card__line skel-card__line--w40"></div>
          <div class="skel-card__line skel-card__line--w80"></div>
        </div>
        <div class="skel-card">
          <div class="skel-card__line skel-card__line--w40"></div>
          <div class="skel-card__line skel-card__line--w80"></div>
        </div>
      </div>`);
  }

  disconnectedCallback() {
    this.#stopPolling();
    window.removeEventListener('popstate', this.#onPopState);
  }

  /**
   * Back/forward *within* this page — review ⇄ run, which the page moves
   * between with its own history entries rather than a route change.
   *
   * The guard is the point: this listener is on `window`, so it also fired when
   * the user left the page altogether (Back out to /workflows). The router's
   * own popstate handler is async — it awaits the next page's module — so this
   * one ran first and repainted the whole workflow view from scratch, which is
   * the flicker Back showed before the list faded in. A pop that lands on any
   * other path, or on another workflow, belongs to the router.
   */
  #onPopState = () => {
    const params = new URLSearchParams(location.search);
    if (location.pathname.replace(/\.html$/, '') !== '/workflow') return;
    if (params.get('id') !== this.#workflowId) return;
    const exec = params.get('exec');
    if (exec) this.#openRun(exec, { push: false });
    else this.#showReview();
  };

  async #load(execId) {
    try {
      const workflow = await call('fetchWorkflow', this.#workflowId);
      this.#workflow = workflow;
      document.title = `Nasiko — ${workflow.name}`;
    } catch {
      this.#paint(`
        <div class="col">
          <app-empty-state
            heading="Workflow not found"
            description="It may have been deleted."
            icon='${icons.faceFrown('', 40)}'>
            <app-button variant="tertiary" size="sm" href="/workflows">Back to workflows</app-button>
          </app-empty-state>
        </div>`);
      return;
    }
    if (execId) this.#openRun(execId, { push: false });
    else this.#showReview();
  }

  // ── Review view ───────────────────────────────────────────────────────────

  #stepLabels() {
    const labels = {};
    for (const s of this.#workflow.maf_json?.steps || []) labels[s.step_id] = s.task_description;
    return labels;
  }

  /**
   * @param {{edit?: boolean}} [opts] Which face to render. Defaulted from the
   * workflow's status rather than passed by each caller, so every entry point
   * — first load, Back out of a run, discard — agrees on what a draft looks
   * like without having to remember to ask.
   */
  #showReview({ edit = !isDeployed(this.#workflow) } = {}) {
    this.#stopPolling();
    this.#execution = null;
    const wf = this.#workflow;
    const steps = wf.maf_json?.steps || [];
    const description = wf.description || wf.maf_json?.description || '';

    this.#paint(`
      <div class="col">
        <header class="page-head">
          <app-button variant="tertiary" size="sm" icon-only href="/workflows" data-back
            aria-label="Back">${icons.chevronLeft()}</app-button>
          <input class="name-input" id="wf-name" value="${escHtml(wf.name)}"
            aria-label="Workflow name" ${edit ? '' : 'readonly'} />
        </header>

        ${edit ? `
          <app-chatbox id="wf-desc" no-attachments submit-label="Regenerate plan"
            aria-label="Workflow description"
            placeholder="Describe what this workflow is for"></app-chatbox>
          <div class="gen-notice" id="gen-notice" hidden></div>
          <div class="generating" id="generating" hidden>Generating your workflow...</div>`
        : `<p class="desc-text">${escHtml(description)}</p>`}

        ${edit
          ? '<wf-step-editor id="editor"></wf-step-editor>'
          : WorkflowDetailPage.#stepList(steps)}

        ${wf.maf_json?.output_generation ? `
          <section class="sec">
            <h2 class="sec-title">Output guidelines</h2>
            <p class="output-gen">${escHtml(wf.maf_json.output_generation)}</p>
          </section>` : ''}

        ${edit ? `
          <div class="save-bar">
            ${isDeployed(wf) ? `
              <app-button variant="tertiary" size="sm" id="discard-btn">Cancel</app-button>` : ''}
            <app-button variant="${isDeployed(wf) ? 'primary' : 'tertiary'}" size="sm"
              id="test-run-btn">${icons.play('', 12)} Save & run</app-button>
            ${isDeployed(wf) ? '' : `
              <app-button variant="primary" size="sm" id="deploy-btn">Deploy</app-button>`}
          </div>`
        : `
          <div class="page-actions">
            <app-button variant="tertiary" size="md" id="edit-btn">${icons.editThin('', 12)} Edit</app-button>
            <app-button variant="primary" size="md" id="run-btn">${icons.play('', 12)} Run</app-button>
          </div>`}

        <section class="danger-zone">
          <h3 class="danger-title">Danger zone</h3>
          <p class="danger-note">Remove this workflow from your deployed workflows.
            Existing workflow runs will not be affected.</p>
          <app-button variant="danger-secondary" size="md" id="delete-btn">Delete workflow</app-button>
        </section>
      </div>
    `);

    // The danger zone renders on both faces, so its listener is bound before
    // the edit branch returns.
    this.querySelector('#delete-btn').addEventListener('click', () => this.#delete());

    if (edit) {
      const editor = this.querySelector('#editor');
      // A draft saved as a bare sentence has no steps yet. Seed the blank one
      // the create screen starts from, so editing a draft and editing a
      // deployed workflow are the same screen — otherwise this opened on the
      // editor's own empty state, whose only affordance is an unlabelled "+".
      editor.steps = steps.length
        ? steps.map((s) => ({
          taskDescription: s.task_description,
          agentId: s.agent_id,
          agentName: s.agent_name,
        }))
        : [{ taskDescription: '', agentId: '', agentName: '' }];
      this.#loadAgents();
      // The composer is the same one the create screen drafts from, so a
      // description can be rewritten and re-planned wherever it is editable —
      // on a draft or on a deployed workflow. The steps on screen came from the
      // saved description, so the button starts inert.
      const box = this.querySelector('#wf-desc');
      box.value = description;
      this.#generatedFrom = steps.length ? description : null;
      box.addEventListener('input', () => this.#syncGenerate());
      box.addEventListener('chatbox-submit', (e) => this.#regenerate(e.detail.value));
      this.#syncGenerate();
      this.querySelector('#test-run-btn').addEventListener('click', () => this.#saveAndRun());
      this.querySelector('#deploy-btn')?.addEventListener('click', () => this.#deploy());
      this.querySelector('#discard-btn')?.addEventListener('click', () => this.#showReview({ edit: false }));
      return;
    }
    this.querySelector('#edit-btn').addEventListener('click', () => this.#showReview({ edit: true }));
    this.querySelector('#run-btn').addEventListener('click', () => this.#run());
  }

  /**
   * The generate button keeps its place and its label says what it would do;
   * it goes inert while the description still matches the plan on screen,
   * because regenerating it would only return the same plan.
   */
  #syncGenerate() {
    const box = this.querySelector('#wf-desc');
    if (!box) return;
    box.setAttribute('submit-label', this.#generatedFrom === null ? 'Generate plan' : 'Regenerate plan');
    box.submitDisabled = this.#generatedFrom !== null && box.value.trim() === this.#generatedFrom;
  }

  /**
   * Redraft the steps from the description as it now reads. Replaces what is in
   * the editor — nothing is written until Save changes, so a regenerate that
   * turns out worse is undone by Cancel.
   */
  async #regenerate(description) {
    const desc = (description || '').trim();
    if (!desc) return;
    const box = this.querySelector('#wf-desc');
    const notice = this.querySelector('#gen-notice');
    notice.hidden = true;
    this.querySelector('#generating').hidden = false;
    this.querySelector('#editor').hidden = true;
    box.setLoading(true);
    try {
      const plan = await call('generateWorkflow', desc);
      this.querySelector('#editor').steps = (plan.steps || []).map((s) => ({
        taskDescription: s.task_description,
        agentId: s.agent_id,
        agentName: s.agent_name,
        suggested: true,
      }));
      this.#generatedFrom = desc;
    } catch (err) {
      notice.hidden = false;
      notice.innerHTML = generateErrorHtml(err);
    } finally {
      this.querySelector('#generating').hidden = true;
      this.querySelector('#editor').hidden = false;
      box.setLoading(false);
      // setLoading(false) re-enables the button from the composer's own rules;
      // re-apply ours on top of it.
      this.#syncGenerate();
    }
  }

  async #delete() {
    const confirmed = await confirmDialog({
      title: `Delete workflow?`,
      message: `"${this.#workflow.name}" will be permanently deleted. This action can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await call('deleteWorkflow', this.#workflowId);
      navigate('/workflows');
    } catch (err) {
      showToast(`Delete failed: ${err.message}`);
    }
  }

  /** Read-only face of the steps — the editor only mounts once Edit is hit. */
  static #stepList(steps) {
    if (!steps.length) {
      return `<app-empty-state heading="No steps yet"
        description="Hit Edit to add the first step."></app-empty-state>`;
    }
    return `<ol class="ro-steps">${steps.map((s, i) => `
      <li class="ro-step">
        <h3 class="ro-step-n">Step ${i + 1}</h3>
        <p class="ro-step-task">${escHtml(s.task_description || '')}</p>
        <p class="ro-step-agent">${escHtml(s.agent_name || 'Agent chosen at run time')}</p>
      </li>`).join('')}</ol>`;
  }

  async #loadAgents() {
    try {
      const res = await apiFetch('/agents?limit=100');
      if (!res.ok) return;
      const body = await res.json();
      const editor = this.querySelector('#editor');
      if (editor) {
        editor.agents = (Array.isArray(body) ? body : body.data || [])
          .map((a) => ({ id: a.id, name: a.display_name || a.name || a.id }));
      }
    } catch { /* picker falls back to the persisted agent names */ }
  }

  /**
   * Persist what is in the editor. Returns whether it saved, so the callers
   * that go on to act on the stored row — test run, deploy — can stop when it
   * didn't. It leaves the view alone: each caller replaces it differently.
   *
   * @param {Element} [btn] Button to show progress on.
   */
  async #saveEdits(btn) {
    const steps = this.querySelector('#editor').steps
      .map((s, i) => ({
        step_index: i,
        task_description: s.taskDescription.trim(),
        agent_id: s.agentId || undefined,
      }))
      .filter((s) => s.task_description);
    if (!steps.length) {
      showToast('A workflow needs at least one step with instructions.');
      return false;
    }
    btn?.setAttribute('loading', '');
    try {
      this.#workflow = await call('updateWorkflow', this.#workflowId, {
        name: this.querySelector('#wf-name').value.trim() || undefined,
        description: this.querySelector('#wf-desc').value.trim() || undefined,
        steps,
      });
      return true;
    } catch (err) {
      btn?.removeAttribute('loading');
      showToast(`Save failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Test run saves first, and has to: the run endpoint executes the stored
   * row, never what is in the editor. On a deployed workflow that means the
   * live definition is updated before the run and Cancel cannot take it back —
   * the note beside the button is the only warning the user gets, so it stays.
   */
  async #saveAndRun() {
    const btn = this.querySelector('#test-run-btn');
    if (await this.#saveEdits(btn)) this.#run(btn);
  }

  /**
   * Draft → deployed. Promotion flips the status and touches nothing else: the
   * steps and their agents were resolved when the draft was created, so what
   * was reviewed here is exactly what runs. Same id, so the URL stays valid.
   */
  async #deploy() {
    const btn = this.querySelector('#deploy-btn');
    // A draft is always on the editable face, so what is on screen can be
    // newer than the row promote would flip. Promotion copies no steps of its
    // own, so an unsaved edit would simply be lost at the moment it went live.
    if (!await this.#saveEdits(btn)) return;
    try {
      this.#workflow = await call('promoteWorkflow', this.#workflowId);
      showToast('Workflow deployed');
      this.#showReview();
    } catch (err) {
      btn?.removeAttribute('loading');
      showToast(`Deploy failed: ${err.message}`);
    }
  }

  /** @param {Element} [btn] Button to show progress on. */
  async #run(btn = this.querySelector('#run-btn')) {
    btn?.setAttribute('loading', '');
    try {
      const started = await call('runWorkflow', this.#workflowId);
      this.#openRun(started.execution_id, { push: true });
    } catch (err) {
      btn?.removeAttribute('loading');
      showToast(`Run failed: ${err.message}`);
    }
  }

  // ── Run view ──────────────────────────────────────────────────────────────

  async #openRun(execId, { push }) {
    this.#stopPolling();
    if (push) {
      const url = `/workflow?id=${encodeURIComponent(this.#workflowId)}&exec=${encodeURIComponent(execId)}`;
      // `wfRunPushed` marks THIS history entry as one this page pushed on top of
      // a review entry, so Back out of it is a real step back. It lives in the
      // entry's state rather than on the instance because an instance flag goes
      // stale the moment the user uses the browser's own Back/Forward: leaving
      // the run and then coming forward into it again left the flag false, and
      // the back button then replaced the entry instead of popping it — so the
      // next Back landed on a review that was already on screen and looked like
      // it had done nothing.
      history.pushState({ wfRunPushed: true }, '', url);
    }
    this.#renderRunShell();
    try {
      this.#execution = await call('fetchExecution', execId);
    } catch (err) {
      this.querySelector('#run-body').innerHTML =
        `<p class="load-error">Failed to load execution: ${escHtml(err.message)}</p>`;
      return;
    }
    this.#updateRunView();
    this.#pollIfActive();
  }

  #renderRunShell() {
    this.#paint(`
      <div class="col">
        <header class="page-head">
          <app-button variant="tertiary" size="sm" icon-only id="run-back"
            aria-label="Back to workflow">${icons.chevronLeft()}</app-button>
          <h1 class="title-page run-title" id="run-title">${escHtml(this.#workflow?.name || 'Execution')}</h1>
        </header>
        <div id="run-body">
          <div class="run-head-row">
            <span class="run-exec-num" id="run-num"></span>
            <span id="run-status"></span>
          </div>
          <div class="badges" id="run-badges"></div>
          <wf-run-steps id="run-steps"></wf-run-steps>
          <section class="sec" id="run-output" hidden>
            <h2 class="sec-title">Output</h2>
            <div class="run-output-body md-body" id="run-output-body"></div>
          </section>
          <div class="run-error" id="run-error" hidden></div>
        </div>
      </div>`);
    // A decision does not deliver itself: the MAF worker picks the resolved row
    // up and carries the run on server-side, so the only thing left to do here
    // is look again straight away rather than waiting out the poll interval.
    for (const type of ['hitl-resolved', 'hitl-canceled']) {
      this.querySelector('#run-body').addEventListener(type, () => {
        this.#stopPolling();
        this.#pollNow();
      });
    }

    this.querySelector('#run-back').addEventListener('click', async () => {
      // This page pushed the run view, so leaving it is a step back and the
      // popstate handler renders the review. Otherwise the run view IS the
      // entry (opened from /executions or a deep link) and there is no review
      // entry to return to — replace it, never push, or Back lands right back
      // on the run view.
      if (history.state?.wfRunPushed) {
        history.back();
        return;
      }
      history.replaceState({}, '', `/workflow?id=${encodeURIComponent(this.#workflowId)}`);
      this.#showReview();
    });
  }

  #updateRunView() {
    const exec = this.#execution;
    const { label, variant } = EXEC_STATUS[exec.status] || { label: exec.status, variant: 'neutral' };
    this.querySelector('#run-num').textContent = `Execution #${exec.execution_number}`;
    this.querySelector('#run-status').innerHTML =
      `<app-badge variant="${variant}" dot>${escHtml(label)}</app-badge>`;

    const stepCount = exec.step_results?.length || 0;
    const attempts = exec.attempt_count > 1 ? `attempt ${exec.attempt_count}/${exec.max_attempts}` : '';
    this.querySelector('#run-badges').innerHTML = [
      stepCount ? `${stepCount === 1 ? '1 step' : `${stepCount} steps`}` : '',
      exec.started_at ? `Started ${timeAgo(exec.started_at)}` : '',
      exec.duration_ms != null ? fmtDuration(exec.duration_ms) : '',
      fmtTokens(exec.tokens_used),
      attempts,
    ].filter(Boolean).map((label) => `<app-badge variant="neutral">${escHtml(label)}</app-badge>`).join('');

    const stepsEl = this.querySelector('#run-steps');
    stepsEl.labels = this.#stepLabels();
    stepsEl.steps = exec.step_results || [];
    // Lets the timeline account for planning/synthesis, which belong to the
    // run and appear in no step row.
    stepsEl.totalTokens = exec.tokens_used || 0;
    // A paused run is answered here, in the step that paused, and a run that has
    // moved on still shows what was answered — the exec carries every row,
    // decided ones included, and the timeline renders those as receipts.
    stepsEl.hitl = exec.hitl || [];

    const outputSec = this.querySelector('#run-output');
    if (exec.output) {
      outputSec.hidden = false;
      this.querySelector('#run-output-body').innerHTML = renderMarkdown(exec.output);
    } else {
      outputSec.hidden = true;
    }

    const errorEl = this.querySelector('#run-error');
    if (exec.status === 'failed' && exec.error) {
      errorEl.hidden = false;
      errorEl.textContent = exec.error;
    } else {
      errorEl.hidden = true;
    }
  }

  /** Re-read the run and repaint, then fall back into the ordinary cadence. */
  async #pollNow() {
    try {
      this.#execution = await call('fetchExecution', this.#execution.id);
      if (this.querySelector('#run-body')) this.#updateRunView();
    } catch { /* transient failure — the poll below tries again */ }
    this.#pollIfActive();
  }

  #pollIfActive() {
    // `awaiting_human` counts: the answer is delivered to the MAF worker
    // server-side, so a run that pauses here would otherwise sit frozen with a
    // resolved card and never show that it had carried on.
    if (!EXEC_ACTIVE.has(this.#execution?.status)) return;
    this.#pollTimer = setTimeout(() => this.#pollNow(), POLL_MS);
  }

  #stopPolling() {
    clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }

}

customElements.define('workflow-detail-page', WorkflowDetailPage);
