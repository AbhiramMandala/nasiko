/**
 * Create workflow — name it, describe the outcome, let the planner draft the
 * steps (POST /api/maf/generate), edit them, then save.
 *
 * Two saves, two endpoints:
 * - "Save as draft and test" → POST /api/maf/workflow/draft (status 'draft'),
 *   then PUT /api/maf/workflow/{id} for the name and the steps, which the draft
 *   endpoint does not store. Re-saving reuses that id rather than creating a
 *   new draft per click. A draft holds the same steps a deployed workflow does,
 *   so it can be run and edited straight away; Deploy is a status flip later.
 * - "Deploy" → POST /api/maf/workflows, which creates it 'active' straight away.
 *
 * The generate call has three designed failure modes: 503 (no OPENAI_API_KEY
 * on the server), 400 (the user has no agents), 422 (planner failure) — each
 * gets a friendly inline notice; manual authoring always stays available.
 *
 * @element workflow-new-page
 */
import { apiFetch } from '/common/services/api.js';
import { icons } from '/common/utils/icons.js';
import { showToast } from '/common/utils/toast.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-chatbox/app-chatbox.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-modal/app-modal.js';
import '/common/features/wf-step-editor.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./workflow-new-page.css', import.meta.url));
import { call } from '../core/data-sources.js';
import { generateErrorHtml } from '/common/services/workflows-service.js';
import { navigate as routerNavigate } from '../core/router.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const SUBTITLE = 'Connect multiple AI agents into a structured workflow to automate complex tasks.';

class WorkflowNewPage extends HTMLElement {
  #initialized = false;
  #drafting = false;
  #saved = null;
  /** Set by the first draft save, so later ones overwrite that row. */
  #draftId = null;
  /** The description the steps on screen were generated from, or null if no
   *  plan has been generated yet. Regenerating the same sentence would return
   *  the same plan, so the button stays put and goes inert until it changes. */
  #generatedFrom = null;
  /** Snapshot of the form as last saved (or as first rendered) — see #dirty(). */
  #clean = '';
  /** Where the intercepted click was headed. */
  #leaveTo = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <div class="col">
        <header class="page-head">
          <app-button variant="tertiary" size="sm" icon-only href="/workflows"
            aria-label="Back to workflows">${icons.chevronLeft()}</app-button>
          <div class="head-text">
            <h1 class="title">Create workflow</h1>
            <p class="subtitle">${SUBTITLE}</p>
          </div>
        </header>

        <app-input id="wf-name" label="Enter workflow name" required
          placeholder="Name this workflow"></app-input>

        <app-chatbox id="wf-desc" no-attachments submit-label="Generate plan"
          aria-label="Workflow description"
          placeholder="Describe workflow..."></app-chatbox>

        <div class="gen-notice" id="gen-notice" hidden></div>

        <div class="generating" id="generating" hidden>Generating your workflow...</div>

        <wf-step-editor id="editor"></wf-step-editor>

        <footer class="foot-actions">
          <app-button variant="secondary" size="sm" id="save-btn" disabled
            >Save as draft and test</app-button>
          <app-button variant="primary" size="sm" id="deploy-btn" disabled>Deploy</app-button>
        </footer>
      </div>

      <app-modal id="leave-modal" heading="Leave without saving?">
        <p>Your changes haven't been saved. If you leave now, you'll lose the changes
          made since your last save.</p>
        <div data-slot="footer">
          <app-button variant="secondary" size="sm" id="discard-btn">Discard workflow</app-button>
          <app-button variant="primary" size="sm" id="save-draft-btn">Save draft</app-button>
        </div>
      </app-modal>

      <app-modal id="deployed-modal" heading="Workflow deployed">
        <p>Your workflow has been saved and is ready for the next step.</p>
        <div data-slot="footer">
          <app-button variant="secondary" size="sm" id="library-btn">Find in library</app-button>
          <app-button variant="primary" size="sm" id="run-btn">Run workflow</app-button>
        </div>
      </app-modal>
    `;

    const editor = this.querySelector('#editor');
    editor.steps = [{ taskDescription: '', agentId: '', agentName: '' }];
    editor.addEventListener('wf-steps-change', () => this.#syncActions());
    this.#loadAgents();

    this.querySelector('#wf-name').addEventListener('input', () => this.#syncHeader());
    // The composer's textarea bubbles `input`, which is the only signal that
    // the description has drifted from the plan on screen.
    this.querySelector('#wf-desc').addEventListener('input', () => this.#syncGenerate());
    this.querySelector('#wf-desc').addEventListener('chatbox-submit', (e) => this.#draft(e.detail.value));
    this.querySelector('#save-btn').addEventListener('click', () => this.#save({ deploy: false }));
    this.querySelector('#deploy-btn').addEventListener('click', () => this.#save({ deploy: true }));
    this.querySelector('#library-btn').addEventListener('click', () => routerNavigate('/workflows'));
    this.querySelector('#run-btn').addEventListener('click', () => this.#run());
    this.querySelector('#discard-btn').addEventListener('click', () => this.#leave());
    this.querySelector('#save-draft-btn').addEventListener('click', () => this.#saveDraftAndLeave());
    // The warning glyph from the mockup — app-modal has no icon slot, and one
    // call site doesn't earn one.
    this.querySelector('#leave-modal header')
      .insertAdjacentHTML('afterbegin', `<span class="warn-icon">${icons.alertTriangle('', 16)}</span>`);

    document.addEventListener('click', this.#onLeaveClick, true);
    window.addEventListener('beforeunload', this.#onBeforeUnload);
    this.#syncActions();
    this.#clean = this.#snapshot();
  }

  disconnectedCallback() {
    document.removeEventListener('click', this.#onLeaveClick, true);
    window.removeEventListener('beforeunload', this.#onBeforeUnload);
  }

  async #loadAgents() {
    try {
      const res = await apiFetch('/agents?limit=100');
      if (!res.ok) return;
      const body = await res.json();
      const agents = (Array.isArray(body) ? body : body.data || [])
        .map((a) => ({ id: a.id, name: a.display_name || a.name || a.id }));
      this.querySelector('#editor').agents = agents;
    } catch { /* picker keeps free text — save still works */ }
  }

  get #name() {
    return this.querySelector('#wf-name').value.trim();
  }

  /** The heading stays "Create workflow" — only the field's own label reacts. */
  #syncHeader() {
    const name = this.#name;
    // Only on the empty→named edge: <app-input> re-renders on every attribute
    // write, and rebuilding the field under the caret on each keystroke is a
    // good way to lose an IME composition.
    const input = this.querySelector('#wf-name');
    const label = name ? 'Workflow name' : 'Enter workflow name';
    if (input.getAttribute('label') !== label) {
      input.setAttribute('label', label);
      input.toggleAttribute('required', !name);
    }
    this.#syncActions();
  }

  /**
   * Both saves need a name — it is how a workflow is found again, and a draft
   * with no name is a row nobody can identify in the library. Deploying
   * additionally needs at least one step with instructions; a draft may be as
   * half-filled as it likes beyond the name.
   */
  #syncActions() {
    const named = !!this.#name && !this.#drafting;
    const ready = named
      && this.querySelector('#editor').steps.some((s) => s.taskDescription.trim());
    this.querySelector('#deploy-btn').toggleAttribute('disabled', !ready);
    this.querySelector('#save-btn').toggleAttribute('disabled', !named);
    this.querySelector('#save-draft-btn').toggleAttribute('disabled', !named);
  }

  /**
   * The generate button, once a plan exists: it keeps its place and its label
   * says what it would do now, but it is inert until the description is edited.
   * Before the first plan there is nothing to compare against, so any non-empty
   * description can be generated from — which is what the composer already does
   * on its own.
   */
  #syncGenerate() {
    const box = this.querySelector('#wf-desc');
    if (!box) return;
    box.setAttribute('submit-label', this.#generatedFrom === null ? 'Generate plan' : 'Regenerate plan');
    box.submitDisabled = this.#generatedFrom !== null && box.value.trim() === this.#generatedFrom;
  }

  #notice(html) {
    const el = this.querySelector('#gen-notice');
    el.hidden = !html;
    el.innerHTML = html || '';
  }

  #setDrafting(on) {
    this.#drafting = on;
    this.querySelector('#generating').hidden = !on;
    this.querySelector('#editor').hidden = on;
    this.querySelector('#wf-desc').setLoading(on);
    this.#syncActions();
    // setLoading(false) re-enables the button from the composer's own rules;
    // re-apply ours on top of it.
    if (!on) this.#syncGenerate();
  }

  async #draft(description) {
    if (this.#drafting) return;
    const desc = (description || '').trim();
    if (!desc) return;
    this.#notice('');
    this.#setDrafting(true);
    try {
      const plan = await call('generateWorkflow', desc);
      const nameInput = this.querySelector('#wf-name');
      if (!nameInput.value.trim() && plan.name) nameInput.value = plan.name;
      this.querySelector('#editor').steps = (plan.steps || []).map((s) => ({
        taskDescription: s.task_description,
        agentId: s.agent_id,
        agentName: s.agent_name,
        suggested: true,
      }));
      // A plan exists now, so the same button re-runs it rather than making one
      // — and only once the sentence it came from has been edited.
      this.#generatedFrom = desc;
      this.#syncHeader();
    } catch (err) {
      this.#notice(generateErrorHtml(err));
    } finally {
      this.#setDrafting(false);
    }
  }

  /**
   * `deploy` picks the endpoint: a draft stores the sentence (plus the steps on
   * screen — the server ignores fields it doesn't know, so this is forwards-
   * compatible with draft steps landing), a deploy creates the live workflow.
   */
  async #save({ deploy, navigate = true }) {
    const btn = this.querySelector(deploy ? '#deploy-btn' : '#save-btn');
    const steps = this.querySelector('#editor').steps
      .map((s, i) => ({
        step_index: i,
        task_description: s.taskDescription.trim(),
        agent_id: s.agentId || undefined,
      }))
      .filter((s) => s.task_description);
    if (!this.#name) {
      this.#notice('Name this workflow before saving it.');
      return null;
    }
    if (deploy && !steps.length) {
      this.#notice('Add at least one step with instructions before deploying.');
      return null;
    }
    this.#notice('');
    btn.setAttribute('loading', '');
    try {
      const workflow = deploy
        ? await call('createWorkflow', {
          name: this.#name,
          description: this.querySelector('#wf-desc').value.trim() || undefined,
          steps,
        })
        : await this.#saveDraft(steps);
      this.#saved = workflow;
      this.#clean = this.#snapshot();
      btn.removeAttribute('loading');
      if (deploy) this.querySelector('#deployed-modal').show();
      else if (navigate) routerNavigate(`/workflow?id=${encodeURIComponent(workflow.id)}`);
      return workflow;
    } catch (err) {
      btn.removeAttribute('loading');
      showToast(`Save failed: ${err.message}`);
      return null;
    }
  }

  /**
   * A 404 means the draft was deleted or promoted elsewhere; drop the stale id
   * and save again as a new draft rather than losing what is on screen.
   */
  async #saveDraft(steps) {
    try {
      return await this.#writeDraft(steps);
    } catch (err) {
      if (!this.#draftId || err.status !== 404) throw err;
      this.#draftId = null;
      return this.#writeDraft(steps);
    }
  }

  /**
   * Two writes, because the draft endpoint stores the sentence and nothing
   * else: it creates (or refreshes) the row, and the PUT gives it the name and
   * the steps — which is also what makes a draft runnable, since the server
   * gates a run on having steps rather than on the status.
   *
   * PUT rejects an empty step list, so a draft with nothing in the editor yet
   * stays the bare sentence the POST saved.
   *
   * The instruction must be non-empty and the description box is optional here,
   * so the name stands in for it — it is the one field this screen requires.
   */
  async #writeDraft(steps) {
    const instruction = this.querySelector('#wf-desc').value.trim() || this.#name;
    let draft = null;
    if (!this.#draftId || !steps.length) {
      draft = await call('saveDraft',
        this.#draftId ? { instruction, draft_id: this.#draftId } : { instruction });
      this.#draftId = draft.id;
    }
    if (!steps.length) return draft;
    return call('updateWorkflow', this.#draftId, {
      name: this.#name,
      description: instruction,
      steps,
    });
  }

  /** What's on screen, as a comparable string. Dirty = differs from the last save. */
  #snapshot() {
    return JSON.stringify([
      this.#name,
      this.querySelector('#wf-desc').value.trim(),
      this.querySelector('#editor').steps.map((s) => [s.taskDescription.trim(), s.agentId || '']),
    ]);
  }

  #dirty() {
    return this.#snapshot() !== this.#clean;
  }

  /**
   * Leaving with unsaved work opens the modal instead. Capture phase so this
   * runs before the router's own document-level click handler — and covers
   * the rail, the header and the back arrow alike, since they are all <a>.
   */
  #onLeaveClick = (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href]');
    if (!a || a.target === '_blank' || a.origin !== location.origin) return;
    const to = a.pathname + a.search;
    if (to === location.pathname + location.search) return;
    if (!this.#dirty()) return;
    e.preventDefault();
    e.stopPropagation();
    this.#leaveTo = to;
    this.querySelector('#leave-modal').show();
  };

  // ponytail: browser back/forward isn't guarded — popstate fires after the
  // navigation, so blocking it needs a history sentinel. Add one if it bites.
  #onBeforeUnload = (e) => {
    if (this.#dirty()) e.preventDefault();
  };

  #leave() {
    this.querySelector('#leave-modal').hide();
    this.#clean = this.#snapshot(); // discarded — stop guarding the way out
    routerNavigate(this.#leaveTo || '/workflows');
  }

  async #saveDraftAndLeave() {
    const btn = this.querySelector('#save-draft-btn');
    btn.setAttribute('loading', '');
    const saved = await this.#save({ deploy: false, navigate: false });
    btn.removeAttribute('loading');
    if (saved) this.#leave();
  }

  async #run() {
    if (!this.#saved) return;
    const id = this.#saved.id;
    let target = `/workflow?id=${encodeURIComponent(id)}`;
    try {
      const started = await call('runWorkflow', id);
      target += `&exec=${encodeURIComponent(started.execution_id)}`;
    } catch (err) {
      // The workflow IS saved, so still land on the review screen — but say why
      // it didn't start. Swallowing this made a failed run indistinguishable
      // from a successful one.
      target += `&run_error=${encodeURIComponent(err.message || 'unknown error')}`;
    }
    this.querySelector('#deployed-modal').hide();
    routerNavigate(target);
  }

}

customElements.define('workflow-new-page', WorkflowNewPage);
