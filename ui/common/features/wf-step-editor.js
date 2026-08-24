/**
 * Editable workflow step list — instruction textarea + agent picker per step,
 * with add / remove / reorder. Used by the create page and the detail page.
 *
 * @element wf-step-editor
 * @prop {Array} steps - [{taskDescription, agentId, agentName, suggested}];
 *       `agentId` empty string means "Auto-select at run time" (the routing
 *       engine assigns the agent when the workflow is saved/run).
 * @prop {Array} agents - [{id, name}] options for the per-step picker.
 * @fires wf-steps-change - Any edit (text, agent, add, remove, reorder).
 */
import { icons } from '/common/utils/icons.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-divider/app-divider.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-select/app-select.js';

import styles from './wf-step-editor.css' with { type: 'css' };
import { escHtml } from '/common/utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

class WfStepEditor extends HTMLElement {
  #steps = [];
  #agents = [];

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
    else return;
    this.#render();
    this.#emit();
  };

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
        ${last ? '' : '<span class="connector" aria-hidden="true"></span>'}
      </div>`;
  }

  #render() {
    const cards = this.#steps.length
      ? this.#steps.map((s, i) => this.#stepCard(s, i)).join('')
      : `<app-empty-state
          title="No steps yet"
          description="Add the first step, then tell it what to do and which agent should run it."
        ></app-empty-state>`;
    this.innerHTML = `
      ${cards}
      <app-button variant="ghost" size="sm" class="add-step" data-act="add"
        >Add step ${icons.plus()}</app-button>`;
  }

}

customElements.define('wf-step-editor', WfStepEditor);
