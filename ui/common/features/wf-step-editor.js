/**
 * Editable workflow step list — instruction textarea + agent picker per step,
 * with add / remove / reorder. Used by the create page and the detail page.
 *
 * Reorder is drag-and-drop from the grip in each card's header, and the same
 * grip is a focusable control that moves the step with ArrowUp / ArrowDown —
 * a drag never fires for a keyboard, so the grip has to carry both.
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
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-combobox/app-combobox.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./wf-step-editor.css', import.meta.url));
import { escAttr, escHtml } from '/common/utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

class WfStepEditor extends HTMLElement {
  #steps = [];
  #agents = [];
  #pendingFocusIndex = null;
  /** Persistent announcer — see the note in #render(). */
  #live = Object.assign(document.createElement('div'), { className: 'sr-only' });

  constructor() {
    super();
    this.#live.setAttribute('role', 'status');
    this.#live.setAttribute('aria-live', 'polite');
  }

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
    this.addEventListener('combobox-select', this.#onSelect);
    this.addEventListener('keydown', this.#onKeyDown);
    this.addEventListener('pointerdown', this.#onPointerDown);
    this.#render();
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#onClick);
    this.removeEventListener('input', this.#onInput);
    this.removeEventListener('combobox-select', this.#onSelect);
    this.removeEventListener('keydown', this.#onKeyDown);
    this.removeEventListener('pointerdown', this.#onPointerDown);
    this.#endDrag();
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
    // data-index is the step this insert point sits after; -1 for the point
    // above the first card, so the new step lands at index 0.
    else if (act === 'insert') this.#insertAt(i + 1);
    else return;
    this.#render();
    this.#emit();
  };

  // ── Reorder ───────────────────────────────────────────────────────────────

  /**
   * Live drag state, or null. Pointer Events rather than HTML5 drag-and-drop:
   * the native API hands you a translucent screenshot dropped at the cursor
   * with no way to animate anything around it, and it is mouse-only. Here the
   * card tracks the finger, the cards it passes slide out of the way, and the
   * gesture works the same on a touchscreen.
   */
  #drag = null;

  /** Distance before a press on the grip becomes a drag rather than a click. */
  static #DRAG_THRESHOLD = 4;
  /** Slide/settle duration. Matches the transition in the stylesheet. */
  static #SETTLE_MS = 180;
  /** Distance from a scroller edge at which the drag starts scrolling it. */
  static #EDGE = 72;
  /** Auto-scroll speed range, px per frame — floor anywhere inside the band,
   *  peak at its outer boundary. */
  static #MIN_SPEED = 5;
  static #MAX_SPEED = 20;

  /** Nearest ancestor that actually scrolls — the floating content card on
   *  desktop, the document on narrow screens. */
  static #scrollParent(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  #onPointerDown = (e) => {
    if (e.button > 0) return;
    const grip = e.target.closest?.('.step-grip');
    if (!grip || this.#drag) return;
    const card = grip.closest('.step-card');
    const cards = [...this.querySelectorAll('.step-card')];
    if (cards.length < 2) return;
    // Suppress the text selection a press-drag would otherwise start.
    e.preventDefault();

    const rects = cards.map((c) => c.getBoundingClientRect());
    const from = cards.indexOf(card);
    const scroller = WfStepEditor.#scrollParent(this);
    this.#drag = {
      grip, card, cards, rects, from, to: from,
      scroller,
      // Everything below is measured against the layout as it stands right now.
      // Once the list auto-scrolls those viewport rects are off by exactly how
      // far it has scrolled since, so that distance is added back in.
      scrollTop0: scroller.scrollTop,
      pointerY: e.clientY,
      // The vertical space one card occupies in the flow, so the cards it
      // passes can be translated by exactly the gap it will leave behind.
      span: rects[from].height + (rects.length > 1 ? rects[1].top - rects[0].bottom : 0),
      startY: e.clientY,
      started: false,
      pointerId: e.pointerId,
      raf: 0,
    };
    grip.setPointerCapture(e.pointerId);
    grip.addEventListener('pointermove', this.#onPointerMove);
    grip.addEventListener('pointerup', this.#onPointerUp);
    grip.addEventListener('pointercancel', this.#onPointerUp);
  };

  #onPointerMove = (e) => {
    const d = this.#drag;
    if (!d) return;
    d.pointerY = e.clientY;
    if (!d.started) {
      if (Math.abs(e.clientY - d.startY) < WfStepEditor.#DRAG_THRESHOLD) return;
      d.started = true;
      this.classList.add('is-reordering');
      d.card.classList.add('is-lifted');
      d.raf = requestAnimationFrame(this.#tick);
    }
    this.#applyDrag();
  };

  /**
   * Place the lifted card under the pointer and slide the cards it has passed
   * into the gap it left. Driven both by pointermove and by the auto-scroll
   * frame, because scrolling moves the card relative to the pointer too.
   */
  #applyDrag() {
    const d = this.#drag;
    if (!d?.started) return;
    const rest = d.rects[d.from];
    const last = d.rects[d.rects.length - 1];
    // Clamped to the list's own bounds. Not just so the card can't be flung off
    // into the page: a transform extends the scrollable overflow area, so an
    // unclamped drag grew the scroller as fast as the edge-scroll consumed it
    // and a pointer held at the bottom scrolled forever.
    const dy = Math.min(
      Math.max(d.pointerY - d.startY + (d.scroller.scrollTop - d.scrollTop0),
        d.rects[0].top - rest.top),
      last.bottom - rest.bottom,
    );

    // Where the dragged card's midpoint now sits, against the resting midpoints
    // of the others: the first neighbour it has passed is its new home.
    const mid = rest.top + rest.height / 2 + dy;
    // Inclusive comparisons: at either end the clamp above puts the midpoint
    // exactly on the neighbour's, and a strict test would leave the first and
    // last slots unreachable by a drag.
    let to = d.from;
    while (to > 0 && mid <= d.rects[to - 1].top + d.rects[to - 1].height / 2) to -= 1;
    while (to < d.cards.length - 1 && mid >= d.rects[to + 1].top + d.rects[to + 1].height / 2) to += 1;
    d.to = to;

    d.card.style.transform = `translateY(${dy}px) scale(1.01)`;
    d.cards.forEach((c, j) => {
      if (j === d.from) return;
      const shift = (j > d.from && j <= to) ? -d.span : (j < d.from && j >= to) ? d.span : 0;
      c.style.transform = shift ? `translateY(${shift}px)` : '';
    });
    this.#renumber();
  }

  /**
   * Auto-scroll while the pointer is held near an edge of the scrolling box —
   * without it, a step can only be dragged as far as the list you can see, so
   * moving the first of five steps to the end was simply not reachable.
   *
   * A pointer held still inside the edge band keeps scrolling, which is why
   * this is a frame loop rather than something driven by pointermove.
   */
  #tick = () => {
    const d = this.#drag;
    if (!d?.started) return;
    const { scroller } = d;
    const doc = scroller === document.scrollingElement;
    const top = doc ? 0 : scroller.getBoundingClientRect().top;
    const bottom = doc ? window.innerHeight : scroller.getBoundingClientRect().bottom;
    const EDGE = WfStepEditor.#EDGE;
    const MAX_SPEED = WfStepEditor.#MAX_SPEED;
    const MIN_SPEED = WfStepEditor.#MIN_SPEED;

    // Ramps toward MAX_SPEED the deeper into the band the pointer is, but off a
    // floor rather than off zero: a pure 0→max ramp makes the outer half of the
    // band read as dead, and you end up holding at the very edge to get
    // anywhere.
    const rate = (over) => MIN_SPEED + (MAX_SPEED - MIN_SPEED) * Math.min(1, over / EDGE);
    let dv = 0;
    if (d.pointerY < top + EDGE) dv = -rate(top + EDGE - d.pointerY);
    else if (d.pointerY > bottom - EDGE) dv = rate(d.pointerY - (bottom - EDGE));

    if (dv) {
      const before = scroller.scrollTop;
      scroller.scrollTop += dv;
      if (scroller.scrollTop !== before) this.#applyDrag();
    }
    d.raf = requestAnimationFrame(this.#tick);
  };

  #onPointerUp = () => {
    const d = this.#drag;
    if (!d) return;
    if (!d.started) return this.#endDrag();

    // Settle into the slot the neighbours have already opened, then commit. The
    // rests are the pre-drag geometry, so landing below means landing on the
    // target's bottom edge minus this card's own height.
    const rest = d.rects[d.from];
    const target = d.rects[d.to];
    // No scroll term here, unlike `dy`: both the card's own flow position and
    // the slot it is landing in move with the content, so the scroll cancels.
    const landing = (d.to > d.from ? target.bottom - rest.height : target.top) - rest.top;
    d.card.classList.add('is-settling');
    d.card.style.transform = `translateY(${landing}px)`;
    let committed = false;
    const commit = () => {
      // Both the transitionend and the backstop timer below can arrive; the
      // second one must not splice the same step a second time.
      if (committed) return;
      committed = true;
      const { from, to } = d;
      this.#endDrag();
      if (from === to) return this.#render();
      this.#steps.splice(to, 0, ...this.#steps.splice(from, 1));
      this.#render();
      // #render() replaced every card, so whatever was focused is gone. Put it
      // back on the step that moved — the same place the keyboard path leaves
      // it, and the only sensible anchor after the list reshuffles.
      this.querySelector(`.step-grip[data-index="${to}"]`)?.focus();
      this.#announce(to);
      this.#emit();
    };
    // transitionend is the signal; the timer is the backstop for the case where
    // the card is already exactly where it lands and no transition ever runs.
    // The event bubbles, and the remove button and the agent picker both carry
    // 150ms transitions that finish inside the settle — so an unfiltered
    // listener commits early and cuts the animation off.
    d.card.addEventListener('transitionend', (e) => {
      if (e.target === d.card && e.propertyName === 'transform') commit();
    });
    d.settleTimer = setTimeout(commit, WfStepEditor.#SETTLE_MS + 60);
  };

  /** Drop all drag state and inline styling. Safe to call twice. */
  #endDrag() {
    const d = this.#drag;
    if (!d) return;
    this.#drag = null;
    cancelAnimationFrame(d.raf);
    clearTimeout(d.settleTimer);
    d.grip.removeEventListener('pointermove', this.#onPointerMove);
    d.grip.removeEventListener('pointerup', this.#onPointerUp);
    d.grip.removeEventListener('pointercancel', this.#onPointerUp);
    if (d.grip.hasPointerCapture?.(d.pointerId)) d.grip.releasePointerCapture(d.pointerId);
    this.classList.remove('is-reordering');
    for (const c of d.cards) {
      c.style.transform = '';
      c.classList.remove('is-lifted', 'is-settling');
    }
  }

  /**
   * Captions only, while a drag is in flight — the cards keep their DOM order
   * until it commits, so "Step 3" has to be told it is showing third.
   */
  #renumber() {
    const d = this.#drag;
    if (!d) return;
    const order = d.cards.map((_, j) => j);
    order.splice(d.to, 0, ...order.splice(d.from, 1));
    d.cards.forEach((card, j) => {
      const n = order.indexOf(j) + 1;
      const title = card.querySelector('.step-title');
      if (title) title.textContent = `Step ${n}`;
      // The labels have to move with the caption, or a screen reader reads the
      // card's pre-drag position while the page shows its new one.
      card.setAttribute('aria-label', `Step ${n}`);
      card.querySelector('.step-grip')
        ?.setAttribute('aria-label', WfStepEditor.#gripLabel(n));
      card.querySelector('[data-act="remove"]')?.setAttribute('aria-label', `Remove step ${n}`);
    });
  }

  static #gripLabel(n) {
    return `Reorder step ${n} — drag, or press the up and down arrow keys`;
  }

  /**
   * Say where the step landed. A reorder is a change to a list the person
   * cannot see, and neither a drag nor an arrow key announces itself: without
   * this the whole interaction is silent to a screen reader.
   */
  #announce(to) {
    this.#live.textContent = `Step moved to position ${to + 1} of ${this.#steps.length}`;
  }

  /** Keyboard equivalent of a drag: the grip moves its step one place. */
  #onKeyDown = (e) => {
    const grip = e.target.closest?.('.step-grip');
    if (!grip) return;
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    const i = Number(grip.dataset.index);
    const to = i + delta;
    if (to < 0 || to >= this.#steps.length) return;
    e.preventDefault();
    [this.#steps[i], this.#steps[to]] = [this.#steps[to], this.#steps[i]];
    this.#render();
    this.#emit();
    // The re-render threw away the focused node; follow the step that moved.
    this.querySelector(`.step-grip[data-index="${to}"]`)?.focus();
    this.#announce(to);
  };

  /** Splices a blank step in at `index` and moves focus into its textarea. */
  #insertAt(index) {
    this.#steps.splice(index, 0, { taskDescription: '', agentId: '', agentName: '', suggested: false });
    this.#pendingFocusIndex = index;
  }

  #onInput = (e) => {
    const area = e.target.closest('textarea[data-index]');
    if (!area) {
      this.#onPickerInput(e);
      return;
    }
    this.#steps[Number(area.dataset.index)].taskDescription = area.value;
    this.#emit();
  };

  // The picker is <app-combobox>: `data-index` is on the host and the pick
  // arrives as `combobox-select`. Neither this nor free-typing re-renders the
  // card — that would tear the open listbox and the caret out from under the
  // person using it.
  #onSelect = (e) => {
    const picker = e.target.closest('app-combobox[data-index]');
    if (!picker) return;
    const step = this.#steps[Number(picker.dataset.index)];
    step.agentId = e.detail?.option?.value || '';
    step.agentName = e.detail?.option?.label || '';
    this.#clearSuggested(step, picker);
    this.#emit();
  };

  // Free text that is not an agent means "no agent" — the orchestrator picks
  // one at run time, which is what the empty box promises.
  #onPickerInput = (e) => {
    const picker = e.target.closest('app-combobox[data-index]');
    if (!picker) return;
    const step = this.#steps[Number(picker.dataset.index)];
    const match = this.#agents.find((a) => a.name === picker.value.trim());
    step.agentId = match?.id || '';
    step.agentName = match?.name || '';
    this.#clearSuggested(step, picker);
    this.#emit();
  };

  #clearSuggested(step, picker) {
    if (!step.suggested) return;
    step.suggested = false;
    picker.closest('.step-card')?.querySelector('[data-suggested]')?.remove();
  }

  #agentOptions() {
    return JSON.stringify(this.#agents.map((a) => ({ label: a.name, value: a.id })));
  }

  /**
   * One step: the grip and caption in the header, remove on the right, then the
   * instruction well and the agent picker.
   *
   * The drag starts on the grip alone. A press anywhere on the card would fight
   * the textarea inside it, and selecting instruction text would drag the step.
   */
  #stepCard(step, i) {
    const n = i + 1;
    // Nothing to reorder against on a one-step workflow, so the grip goes
    // inert the same way the remove button does — it was already a no-op, it
    // just didn't look like one.
    const alone = this.#steps.length <= 1;
    return `
      <div class="step-card" role="group" aria-label="Step ${n}" data-index="${i}">
        <div class="step-head">
          <span class="step-grip" tabindex="${alone ? -1 : 0}" role="button" data-index="${i}"
            ${alone ? 'aria-disabled="true"' : 'title="Drag to reorder"'}
            aria-label="${alone ? `Step ${n}` : WfStepEditor.#gripLabel(n)}"
            >${icons.grip()}</span>
          <span class="step-title">Step ${n}</span>
          <app-button variant="ghost" size="sm" icon-only data-act="remove" data-index="${i}"
            title="Remove step" aria-label="Remove step ${n}"
            ${this.#steps.length <= 1 ? 'disabled' : ''}>${icons.x()}</app-button>
        </div>
        <textarea rows="2" data-index="${i}" aria-label="Instructions for step ${n}"
          placeholder="Tell this agent what to do...">${escHtml(step.taskDescription)}</textarea>
        <div class="agent-row">
          <span class="agent-label">Choose agent</span>
          ${step.suggested && step.agentId
            ? '<app-badge variant="warning" data-suggested>Suggested</app-badge>' : ''}
        </div>
        <app-combobox data-index="${i}" aria-label="Agent for step ${n}"
          value="${escAttr(step.agentName)}"
          placeholder="Find agent or leave blank for orchestrator to suggest on run"
          options="${escAttr(this.#agentOptions())}"></app-combobox>
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
    this.#endDrag();
    const cards = this.#steps.length
      ? this.#steps.map((s, i) => this.#insertPoint(i - 1) + this.#stepCard(s, i)).join('')
      : `<app-empty-state
          heading="No steps yet"
          description="Add the first step, then tell it what to do and which agent should run it."
        ></app-empty-state>`;
    this.innerHTML = `
      ${cards}
      <app-button variant="ghost" size="sm" icon-only class="add-step" data-act="add"
        title="Add step" aria-label="Add step">${icons.plus()}</app-button>`;
    if (this.#pendingFocusIndex !== null) {
      this.querySelector(`textarea[data-index="${this.#pendingFocusIndex}"]`)?.focus();
      this.#pendingFocusIndex = null;
    }
    // Re-attached rather than re-rendered: a live region only announces text
    // that lands in a region the screen reader was already watching, and every
    // reorder ends in a #render(). One that ships inside this innerHTML is born
    // holding its message and is silent.
    this.append(this.#live);
  }

}

customElements.define('wf-step-editor', WfStepEditor);
