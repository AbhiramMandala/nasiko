/**
 * Create workflow — name it, describe the outcome, let the planner draft the
 * steps (POST /api/maf/generate), edit them, then save (POST /api/maf/workflows).
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
import { escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';
import { navigate as routerNavigate } from '../core/router.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const SUBTITLE = 'Connect multiple AI agents into a structured workflow to automate complex tasks.';

class WorkflowNewPage extends HTMLElement {
  #initialized = false;
  #drafting = false;
  #saved = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <div class="col">
        <header class="page-head">
          <app-button variant="tertiary" size="sm" icon-only href="/workflows"
            aria-label="Back to workflows">${icons.chevronLeft()}</app-button>
          <div class="head-text">
            <h1 class="title" id="page-title">Create workflow</h1>
            <p class="subtitle" id="page-sub">${SUBTITLE}</p>
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
    this.querySelector('#wf-desc').addEventListener('chatbox-submit', (e) => this.#draft(e.detail.value));
    this.querySelector('#save-btn').addEventListener('click', () => this.#save({ deploy: false }));
    this.querySelector('#deploy-btn').addEventListener('click', () => this.#save({ deploy: true }));
    this.querySelector('#library-btn').addEventListener('click', () => routerNavigate('/workflows'));
    this.querySelector('#run-btn').addEventListener('click', () => this.#run());
    this.#syncActions();
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

  /** Once the workflow has a name, the name IS the page title (mockup). */
  #syncHeader() {
    const name = this.#name;
    this.querySelector('#page-title').textContent = name || 'Create workflow';
    this.querySelector('#page-sub').hidden = !!name;
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

  /** Saving needs a name and at least one instruction — nothing else is usable. */
  #syncActions() {
    const ready = !!this.#name
      && !this.#drafting
      && this.querySelector('#editor').steps.some((s) => s.taskDescription.trim());
    for (const id of ['#save-btn', '#deploy-btn']) {
      this.querySelector(id).toggleAttribute('disabled', !ready);
    }
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
      // A plan exists now, so the same button re-runs it rather than making one.
      this.querySelector('#wf-desc').setAttribute('submit-label', 'Regenerate plan');
      this.#syncHeader();
    } catch (err) {
      this.#notice(this.#generateErrorHtml(err));
    } finally {
      this.#setDrafting(false);
    }
  }

  #generateErrorHtml(err) {
    if (err.status === 503) {
      return `AI drafting isn't available — this server has no OpenAI API key configured.
        You can still add steps manually below.`;
    }
    if (err.status === 400) {
      return `You don't have any agents yet, so there's nothing to plan with.
        <a href="/agents">Deploy an agent</a> first, then draft steps.`;
    }
    if (err.status === 422) {
      return `Nasiko couldn't draft steps from that description — try rephrasing it,
        or add the steps manually below.`;
    }
    return `Drafting failed: ${escHtml(err.message)}`;
  }

  /**
   * ponytail: "draft" and "deploy" both POST the same workflow — `mafs` has no
   * deployed flag yet (see the same note in workflows-page.js). Deploy is the
   * one that opens the confirmation; wire the flag through here when it lands.
   */
  async #save({ deploy }) {
    const btn = this.querySelector(deploy ? '#deploy-btn' : '#save-btn');
    const steps = this.querySelector('#editor').steps
      .map((s) => ({ task_description: s.taskDescription.trim(), agent_id: s.agentId || undefined }))
      .filter((s) => s.task_description);
    if (!steps.length) {
      this.#notice('Add at least one step with instructions before saving.');
      return;
    }
    this.#notice('');
    btn.setAttribute('loading', '');
    try {
      const workflow = await call('createWorkflow', {
        name: this.#name || undefined,
        description: this.querySelector('#wf-desc').value.trim() || undefined,
        steps,
      });
      this.#saved = workflow;
      btn.removeAttribute('loading');
      if (deploy) this.querySelector('#deployed-modal').show();
      else routerNavigate(`/workflow?id=${encodeURIComponent(workflow.id)}`);
    } catch (err) {
      btn.removeAttribute('loading');
      showToast(`Save failed: ${err.message}`);
    }
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
