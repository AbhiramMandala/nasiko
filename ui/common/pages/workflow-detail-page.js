/**
 * Workflow detail — review/edit one MAF workflow, run it, and watch runs.
 *
 * Views (single 720px column, mirroring the mockup's review screen):
 * - review: editable name/description/steps (PUT /api/maf/workflow/{id}),
 *   output_generation display, run button, execution history. A draft holds the
 *   same steps a deployed workflow does and runs through the same endpoint, so
 *   it gets Test run as well as Deploy (POST /api/maf/workflow/{id}/promote,
 *   a status flip). A draft with no steps yet — the bare sentence
 *   POST /maf/workflow/draft saves — can do neither until Edit gives it one.
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
  // Whether the run view on screen was pushed onto history by this page. If it
  // was, leaving it is a step back — pushing a review entry there instead made
  // Back bounce into the run view forever (executions → run → review → Back →
  // run → review → Back → run …).
  #runPushed = false;
  #pollTimer = null;
  /** The description the steps in the editor came from — the saved one on
   *  entering edit mode, the regenerated one after a redraft. Null while there
   *  is no plan to compare against. See #syncGenerate(). */
  #generatedFrom = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    const params = new URLSearchParams(location.search);
    this.#workflowId = params.get('id');
    window.addEventListener('popstate', this.#onPopState);

    if (!this.#workflowId) {
      this.innerHTML = `
        <div class="col">
          <app-empty-state
            heading="No workflow selected"
            description="Open one from the workflows library to review its steps and runs."
            icon='${icons.workflow('', 40)}'>
            <app-button variant="tertiary" href="/workflows">Browse workflows</app-button>
          </app-empty-state>
        </div>`;
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
    this.innerHTML = `
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
      </div>`;
  }

  disconnectedCallback() {
    this.#stopPolling();
    window.removeEventListener('popstate', this.#onPopState);
  }

  #onPopState = () => {
    const exec = new URLSearchParams(location.search).get('exec');
    if (exec) this.#openRun(exec, { push: false });
    else this.#showReview();
  };

  async #load(execId) {
    try {
      const workflow = await call('fetchWorkflow', this.#workflowId);
      this.#workflow = workflow;
      document.title = `Nasiko — ${workflow.name}`;
    } catch {
      this.innerHTML = `
        <div class="col">
          <app-empty-state
            heading="Workflow not found"
            description="It may have been deleted."
            icon='${icons.faceFrown('', 40)}'>
            <app-button variant="tertiary" size="sm" href="/workflows">Back to workflows</app-button>
          </app-empty-state>
        </div>`;
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

  /** @param {{edit?: boolean}} [opts] Start in edit mode (the Edit button). */
  #showReview({ edit = false } = {}) {
    this.#stopPolling();
    this.#execution = null;
    const wf = this.#workflow;
    const steps = wf.maf_json?.steps || [];
    const description = wf.description || wf.maf_json?.description || '';

    this.innerHTML = `
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
            <app-button variant="tertiary" size="sm" id="discard-btn">Cancel</app-button>
            <app-button variant="primary" size="sm" id="save-btn">Save changes</app-button>
          </div>`
        : `
          <div class="page-actions">
            <app-button variant="tertiary" size="md" id="edit-btn">${icons.editThin('', 12)} Edit</app-button>
            ${isDeployed(wf) ? `
              <app-button variant="primary" size="md" id="run-btn">${icons.play('', 12)} Run</app-button>`
            : steps.length ? `
              <app-button variant="tertiary" size="md" id="run-btn">${icons.play('', 12)} Test run</app-button>
              <app-button variant="primary" size="md" id="deploy-btn">Deploy</app-button>`
            : ''}
          </div>

          <section class="danger-zone">
            <h3 class="danger-title">Danger zone</h3>
            <p class="danger-note">Remove this workflow from your deployed workflows.
              Existing workflow runs will not be affected.</p>
            <app-button variant="danger-secondary" size="md" id="delete-btn">Delete workflow</app-button>
          </section>`}
      </div>
    `;

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
      this.querySelector('#save-btn').addEventListener('click', () => this.#saveEdits());
      this.querySelector('#discard-btn').addEventListener('click', () => this.#showReview());
      return;
    }
    this.querySelector('#edit-btn').addEventListener('click', () => this.#showReview({ edit: true }));
    this.querySelector('#run-btn')?.addEventListener('click', () => this.#run());
    this.querySelector('#deploy-btn')?.addEventListener('click', () => this.#deploy());
    this.querySelector('#delete-btn').addEventListener('click', () => this.#delete());
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

  async #saveEdits() {
    const btn = this.querySelector('#save-btn');
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
    btn.setAttribute('loading', '');
    try {
      this.#workflow = await call('updateWorkflow', this.#workflowId, {
        name: this.querySelector('#wf-name').value.trim() || undefined,
        description: this.querySelector('#wf-desc').value.trim() || undefined,
        steps,
      });
      showToast('Workflow updated');
      this.#showReview();
      return true;
    } catch (err) {
      btn.removeAttribute('loading');
      showToast(`Save failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Draft → deployed. Promotion flips the status and touches nothing else: the
   * steps and their agents were resolved when the draft was created, so what
   * was reviewed here is exactly what runs. Same id, so the URL stays valid.
   */
  async #deploy() {
    const btn = this.querySelector('#deploy-btn');
    btn?.setAttribute('loading', '');
    try {
      this.#workflow = await call('promoteWorkflow', this.#workflowId);
      showToast('Workflow deployed');
      this.#showReview();
    } catch (err) {
      btn?.removeAttribute('loading');
      showToast(`Deploy failed: ${err.message}`);
    }
  }

  async #run() {
    const btn = this.querySelector('#run-btn');
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
      history.pushState({}, '', url);
      this.#runPushed = true;
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
    this.innerHTML = `
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
      </div>`;
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
      if (this.#runPushed) {
        this.#runPushed = false;
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
    // A paused run is answered here, in the step that paused — `fetchExecution`
    // returns the pending rows alongside the exec, so this page already had
    // them and was simply dropping them on the floor.
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
