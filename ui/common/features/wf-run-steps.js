/**
 * Vertical per-step timeline for one workflow execution (MAF step_results).
 *
 * The server snapshots `step_results` on every transition, so re-assigning
 * `steps` while polling GET /api/maf/execution/{id} yields a live timeline.
 *
 * @element wf-run-steps
 * @prop {Array} steps - Raw `step_results` rows ({step_index, agent_name,
 *       status, error, prompt, extracted_info, tokens_used, latency_ms}).
 * @prop {Object} labels - Optional map step_id → task_description, used as
 *       the step title when the caller has the workflow's maf_json handy.
 * @prop {number} totalTokens - The execution's `tokens_used`. Optional; when
 *       given, a trailing row accounts for the difference between it and the
 *       steps, so the column adds up (see `#runLevelRow`).
 * @prop {Array} hitl - Pending `hitl_requests` rows for this execution, as
 *       `GET /api/maf/execution/{id}` returns them alongside the exec. Each is
 *       mounted as an `<hitl-card>` in the step it paused — the timeline is the
 *       only thing that knows which step that is, so the correlation lives here
 *       rather than in each page that shows a run.
 */
import { icons } from '/common/utils/icons.js';
import '/common/features/hitl-card.js';
import { renderMarkdown } from '/common/utils/markdown.js';
import { fmtDuration, fmtTokens } from '/common/utils/units.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./wf-run-steps.css', import.meta.url));
import { escHtml } from '/common/utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/**
 * Execution status → how a run is spoken about, shared by every page that shows
 * one. The wire values are snake_case and two of them ('success',
 * 'awaiting_human') are not what a person would call the state they describe;
 * before this was shared, one page said "Awaiting action" and the other printed
 * the raw `awaiting_human`.
 */
export const EXEC_STATUS = {
  success:        { label: 'Complete',        variant: 'success' },
  failed:         { label: 'Failed',          variant: 'error' },
  running:        { label: 'Running…',        variant: 'success' },
  awaiting_human: { label: 'Awaiting action', variant: 'warning' },
  stopped:        { label: 'Stopped',         variant: 'neutral' },
  pending:        { label: 'Queued',          variant: 'neutral' },
};

/** Statuses a run can still move on from — it polls, and it opens expanded. */
export const EXEC_ACTIVE = new Set(['pending', 'running', 'awaiting_human']);

const STATUS_META = {
  success:        { label: 'Complete',       cls: 'is-success' },
  failed:         { label: 'Failed',         cls: 'is-failed' },
  running:        { label: 'Running',        cls: 'is-running' },
  awaiting_human: { label: 'Awaiting action', cls: 'is-awaiting' },
  stopped:        { label: 'Stopped',        cls: 'is-stopped' },
  pending:        { label: 'Pending',        cls: 'is-pending' },
};

class WfRunSteps extends HTMLElement {
  #steps = [];
  #stepsKey = '';
  #labels = {};
  #totalTokens = 0;
  #hitl = [];
  /** hitl row id → the card on screen for it, so a mount pass that finds one
   *  already in place leaves it alone. */
  #cards = new Map();
  #openTab = {}; // step index → 'output' | 'prompt'

  /**
   * Every setter here re-renders only on a real change.
   *
   * A caller polling a live run re-assigns all three on every pass, and this
   * element's DOM is not only its own: the executions page mounts a
   * `<hitl-card>` into a waiting step's slot, and `NasikoElement` aborts its
   * AbortSignal for good on disconnect. So a re-render under a card being
   * answered does not just lose the typed text — it leaves a dead card that
   * can no longer resolve anything. An unchanged poll must be a no-op.
   */
  set steps(value) {
    const next = Array.isArray(value) ? value : [];
    const key = JSON.stringify(next);
    if (key === this.#stepsKey) return;
    this.#stepsKey = key;
    this.#steps = next;
    this.#render();
  }

  set labels(value) {
    const next = value || {};
    if (JSON.stringify(next) === JSON.stringify(this.#labels)) return;
    this.#labels = next;
    this.#render();
  }

  set totalTokens(value) {
    const next = Number(value) || 0;
    if (next === this.#totalTokens) return;
    this.#totalTokens = next;
    this.#render();
  }

  set hitl(value) {
    this.#hitl = Array.isArray(value) ? value.filter((r) => r.status === 'pending') : [];
    this.#mountHitl();
  }

  connectedCallback() {
    this.addEventListener('click', this.#onClick);
    this.#render();
  }

  /**
   * Put each waiting card in the step that is waiting.
   *
   * `<hitl-card>` is the same component the orchestrator and agent chat mount,
   * unchanged: a paused MAF step, a gated MCP tool call and an agent asking a
   * question are one API family, so they are one card. Rows are grouped by
   * `execution.maf_step_index` — a step can pause on more than one thing at
   * once, and the card pages through them itself.
   *
   * A card is mounted once and then left alone: it owns typed text, ticked
   * boxes and an AbortSignal that `NasikoElement` kills for good on disconnect,
   * so it must never be moved or rebuilt while it is still being answered.
   * That is also why every setter above re-renders only on a real change.
   */
  #mountHitl() {
    if (!this.#hitl.length) return;
    const byStep = new Map();
    for (const row of this.#hitl) {
      // A row with no step index belongs to whichever step is paused — there is
      // only ever one, and stranding the card is worse than inferring it.
      const at = row.execution?.maf_step_index
        ?? this.#steps.find((st) => st.status === 'awaiting_human')?.step_index;
      if (at == null) continue;
      byStep.set(at, [...(byStep.get(at) || []), row]);
    }
    for (const [at, group] of byStep) {
      const slot = this.querySelector(`.step-hitl[data-hitl-step="${CSS.escape(String(at))}"]`);
      if (!slot) continue;
      const live = this.#cards.get(group[0].id);
      if (live?.isConnected && slot.contains(live)) continue;
      slot.replaceChildren();
      const card = document.createElement('hitl-card');
      card.actor = this.#steps.find((st) => st.step_index === at)?.agent_name || 'This agent';
      card.rows = group;
      slot.appendChild(card);
      this.#cards.set(group[0].id, card);
    }
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#onClick);
  }

  #onClick = (e) => {
    const pill = e.target.closest('[data-tab]');
    if (!pill) return;
    this.#openTab[pill.dataset.step] = pill.dataset.tab;
    this.#render();
  };

  /** Complete and failed get their glyph; everything still ahead gets its step
   *  number, so the timeline reads as a numbered plan (mockup). */
  #statusIcon(status, n) {
    if (status === 'success') return icons.checkCircle('', 16);
    if (status === 'failed') return icons.xCircle('', 16);
    if (status === 'stopped') return icons.circle('', 16);
    return `<span class="step-n">${n}</span>`;
  }

  #detailHtml(step, i) {
    const prompt0 = step.prompt || '';
    // A step that is waiting on a human shows what it is about to do, plus the
    // empty well the page drops the <hitl-card> into. Nothing else is known yet.
    if (step.status === 'awaiting_human' || step.status === 'stopped') {
      return `<div class="step-detail">
        ${prompt0 ? `<p class="step-prompt">${escHtml(prompt0)}</p>` : ''}
        <div class="step-hitl" data-hitl-step="${step.step_index ?? i}"></div>
      </div>`;
    }
    // Pending/running steps stay compact rows — prompts only matter post-hoc.
    if (step.status !== 'success' && step.status !== 'failed') return '';
    const output = step.extracted_info || '';
    const prompt = step.prompt || '';
    const error = step.error || '';
    if (!output && !prompt && !error) return '';

    const tab = this.#openTab[i] || (output ? 'output' : 'prompt');
    const pills = [];
    if (output) pills.push(['output', 'Output']);
    if (prompt) pills.push(['prompt', 'Prompt']);
    const pillRow = pills.length > 1
      ? `<div class="pane-tabs">${pills.map(([key, label]) =>
          `<button type="button" class="pane-tab${tab === key ? ' is-active' : ''}"
            data-step="${i}" data-tab="${key}">${label}</button>`).join('')}</div>`
      : '';

    let pane = '';
    if (error) {
      pane = `<div class="pane pane--error">${escHtml(error)}</div>`;
    } else if (tab === 'prompt' && prompt) {
      pane = `<div class="pane pane--mono">${escHtml(prompt)}</div>`;
    } else if (output) {
      pane = `<div class="pane md-body">${renderMarkdown(output)}</div>`;
    }
    return `<div class="step-detail">${pillRow}${pane}</div>`;
  }

  /**
   * Trailing row for the tokens that belong to the run rather than to any
   * step — runtime planning and the final synthesis.
   *
   * Without it the timeline invites a subtraction that never works out: the
   * header shows the execution total while the step chips only ever cover
   * per-step work, so the two visibly disagree with nothing to explain the
   * gap. Rendered only when there is a positive remainder, so a run whose
   * total is still being written doesn't show a nonsense negative.
   */
  #runLevelRow() {
    const stepTokens = this.#steps.reduce((sum, s) => sum + (s.tokens_used || 0), 0);
    const remainder = this.#totalTokens - stepTokens;
    if (remainder <= 0) return '';
    return `
      <div class="step step--run-level">
        <div class="rail-col">${icons.sparkles('', 16)}</div>
        <div class="step-body">
          <div class="step-head">
            <span class="step-title">Planning &amp; final synthesis</span>
            <span class="meta">${fmtTokens(remainder)}</span>
          </div>
        </div>
      </div>`;
  }

  #render() {
    if (!this.#steps.length) {
      this.innerHTML = '';
      return;
    }
    const runLevel = this.#runLevelRow();
    this.innerHTML = this.#steps.map((step, i) => {
      const meta = STATUS_META[step.status] || STATUS_META.pending;
      const label = this.#labels[step.step_id] || '';
      const title = label
        ? `Step ${i + 1} — ${escHtml(label)}`
        : `Step ${i + 1} — ${escHtml(step.agent_name || 'Unassigned')}`;
      const chips = [
        label ? `<span class="meta">${escHtml(step.agent_name || '')}</span>` : '',
        `<span class="meta status ${meta.cls}">${meta.label}</span>`,
        step.latency_ms ? `<span class="meta">${fmtDuration(step.latency_ms)}</span>` : '',
        step.tokens_used ? `<span class="meta">${fmtTokens(step.tokens_used)}</span>` : '',
      ].filter(Boolean).join('');
      return `
        <div class="step">
          <div class="rail-col ${meta.cls}">
            ${this.#statusIcon(step.status, i + 1)}
            ${i < this.#steps.length - 1 || runLevel ? '<span class="rail-line"></span>' : ''}
          </div>
          <div class="step-body">
            <div class="step-head">
              <span class="step-title">${title}</span>
              ${chips}
            </div>
            ${this.#detailHtml(step, i)}
          </div>
        </div>`;
    }).join('') + runLevel;
    // The slots are new elements, so whatever was mounted in the old ones is
    // gone with them. Only a real change gets this far (see the setters), and a
    // real change means the pause those cards belonged to has moved on.
    this.#cards.clear();
    this.#mountHitl();
  }

}

customElements.define('wf-run-steps', WfRunSteps);
