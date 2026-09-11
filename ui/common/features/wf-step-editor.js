/**
 * Editable workflow step list — instruction textarea + agent picker per step,
 * with add / remove / reorder. Used by the create page and the detail page.
 *
 * @element wf-step-editor
 * @prop {Array} steps - [{taskDescription, agentId, agentName, suggested}];
 *       `agentId` empty string means "Auto-select at run time" (the routing
 *       engine assigns the agent when the workflow is saved/run).
 * @prop {Array} agents - [{id, name}] options for the per-step picker.
 * @fires wf-steps-change - Any edit (text, agent, add, remove, reorder, insert).
 */
import { icons } from '/common/utils/icons.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-divider/app-divider.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-select/app-select.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./wf-step-editor.css', import.meta.url));
import { escHtml } from '/common/utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

class WfStepEditor extends HTMLElement {
  #steps = [];
  #agents = [];
  #pendingFocusIndex = null;

  set steps(value) {
    this.#steps = (value || []).map((s) => ({
      taskDescription: s.taskDescription || '',
      agentId: s.agentId || '',
      agentName: s.agentName || '',
      suggested: !!s.suggested,
    }));
    this.#render();
  }

  get steps() {
    return this.#steps.map((s) => ({ ...s }));
  }

  set agents(value) {
    this.#agents = value || [];
    this.#render();
  }

  connectedCallback() {
    this.addEventListener('click', this.#onClick);
    this.addEventListener('input', this.#onInput);
    this.addEventListener('change', this.#onChange);
    this.#render();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('input', this.#onInput);
    this.removeEventListener('change', this.#onChange);
  }

  #emit() {
    this.dispatchEvent(new CustomEvent('wf-steps-change', { bubbles: true }));
  }

  #onClick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const i = Number(btn.dataset.index ?? -1);
    const act = btn.dataset.act;
    if (act === 'add') this.#steps.push({ taskDescription: '', agentId: '', agentName: '', suggested: false });
    else if (act === 'remove') this.#steps.splice(i, 1);
    else if (act === 'up' && i > 0) [this.#steps[i - 1], this.#steps[i]] = [this.#steps[i], this.#steps[i - 1]];
    else if (act === 'down' && i < this.#steps.length - 1) [this.#steps[i + 1], this.#steps[i]] = [this.#steps[i], this.#steps[i + 1]];
    // data-index is the step this insert point sits after; -1 for the point
    // above the first card, so the new step lands at index 0.
    else if (act === 'insert') this.#insertAt(i + 1);
    else return;
    this.#render();
    this.#emit();
  };

  /** Splices a blank step in at `index` and moves focus into its textarea. */
  #insertAt(index) {
    this.#steps.splice(index, 0, { taskDescription: '', agentId: '', agentName: '', suggested: false });
    this.#pendingFocusIndex = index;
  }

  #onInput = (e) => {
    const area = e.target.closest('textarea[data-index]');
    if (!area) return;
    this.#steps[Number(area.dataset.index)].taskDescription = area.value;
    this.#emit();
  };

  // The picker is <app-select>, so `data-index` lives on the host — the inner
  // <select> the event comes from does not carry it.
  #onChange = (e) => {
    const picker = e.target.closest('app-select[data-index]');
    if (!picker) return;
    const step = this.#steps[Number(picker.dataset.index)];
    step.agentId = picker.value;
    step.agentName = picker.select?.selectedOptions[0]?.dataset.name || '';
    step.suggested = false;
    this.#render();
    this.#emit();
  };

  #agentOptions(step) {
    const options = [`<option value="">Auto-select at run time</option>`];
    let seen = false;
    for (const a of this.#agents) {
      const selected = a.id === step.agentId;
      seen = seen || selected;
      options.push(`<option value="${escHtml(a.id)}" data-name="${escHtml(a.name)}"
        ${selected ? 'selected' : ''}>${escHtml(a.name)}</option>`);
    }
    // Keep a previously-assigned agent visible even if it's no longer listed.
    if (step.agentId && !seen) {
      options.push(`<option value="${escHtml(step.agentId)}" data-name="${escHtml(step.agentName)}" selected>
        ${escHtml(step.agentName || step.agentId)}</option>`);
    }
    return options.join('');
  }

  /**
   * One step. The ordinal lives in the gold chip alone — the old "Step N"
   * caption next to it said the same thing twice — and the chip doubles as the
   * anchor the connector spine runs through, so the card needs no header row:
   * instruction and agent picker stack as a single unit with the reorder /
   * remove controls parked in a right-hand rail.
   */
  #stepCard(step, i) {
    const last = i === this.#steps.length - 1;
    const n = i + 1;
    return `
      <div class="step-block">
        <div class="step-card" role="group" aria-label="Step ${n}">
          <span class="step-num" aria-hidden="true">${n}</span>
          <textarea rows="2" data-index="${i}" aria-label="Instructions for step ${n}"
            placeholder="Tell this agent what to do">${escHtml(step.taskDescription)}</textarea>
          <div class="step-tools">
            <app-button variant="ghost" size="sm" icon-only data-act="up" data-index="${i}"
              title="Move step up" aria-label="Move step ${n} up"
              ${i === 0 ? 'disabled' : ''}>${icons.arrowUp()}</app-button>
            <app-button variant="ghost" size="sm" icon-only data-act="down" data-index="${i}"
              title="Move step down" aria-label="Move step ${n} down"
              ${last ? 'disabled' : ''}>${icons.arrowDown()}</app-button>
            <app-divider vertical aria-hidden="true"></app-divider>
            <app-button variant="ghost-danger" size="sm" icon-only data-act="remove" data-index="${i}"
              title="Remove step" aria-label="Remove step ${n}"
              ${this.#steps.length <= 1 ? 'disabled' : ''}>${icons.trash()}</app-button>
          </div>
          <div class="agent-row">
            <span class="agent-label">Agent</span>
            <app-select data-index="${i}" aria-label="Agent for step ${n}"
              >${this.#agentOptions(step)}</app-select>
            ${step.suggested && step.agentId ? '<app-badge variant="warning">Suggested</app-badge>' : ''}
          </div>
        </div>
        ${last ? '' : this.#insertPoint(i)}
      </div>`;
  }

  /**
   * The connector spine doubles as an "insert step here" hit target: a
   * hairline by default, a plus button on hover/focus. `after` is the index
   * this point sits below — the new step lands at `after + 1` — or -1 for
   * the point above the first card, landing the new step at index 0.
   */
  #insertPoint(after) {
    const label = after < 0 ? 'Insert step at the beginning' : `Insert step after step ${after + 1}`;
    return `
      <button type="button" class="connector" data-act="insert" data-index="${after}"
        title="${label}" aria-label="${label}">${icons.plus('', 12)}</button>`;
  }

  #render() {
    const cards = this.#steps.length
      ? this.#insertPoint(-1) + this.#steps.map((s, i) => this.#stepCard(s, i)).join('')
      : `<app-empty-state
          title="No steps yet"
          description="Add the first step, then tell it what to do and which agent should run it."
        ></app-empty-state>`;
    this.innerHTML = `
      ${cards}
      <app-button variant="ghost" size="sm" class="add-step" data-act="add"
        >Add step ${icons.plus()}</app-button>`;
    if (this.#pendingFocusIndex !== null) {
      this.querySelector(`textarea[data-index="${this.#pendingFocusIndex}"]`)?.focus();
      this.#pendingFocusIndex = null;
    }
  }

}

customElements.define('wf-step-editor', WfStepEditor);
