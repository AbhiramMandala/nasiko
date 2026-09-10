/**
 * `<hitl-card>` — the human-in-the-loop prompt shown inline in a transcript.
 *
 * One component for every kind of pause, because the API is one family: the
 * request body for `POST /api/hitl/{id}/resolve` depends only on `kind`, and
 * `origin` is correlation metadata, never a dispatch key
 * (FRONTEND_HITL_API_CONTRACT.md §16.2). So a paused MCP tool call, a broken
 * connector credential and an agent asking a plain question are the same card
 * with different actions.
 *
 * Usage — the page hands it rows and listens for the outcome:
 *
 *   const card = document.createElement('hitl-card');
 *   card.actor = 'Orchestrator';        // who is asking, for the title
 *   card.rows = [dtoOrStreamFrame];     // a partial frame is hydrated via GET
 *   card.addEventListener('hitl-resolved', (e) => reconnect(e.detail.id));
 *
 * `hitl-resolved` fires once per answered row, carrying the id to reconnect
 * with. `hitl-canceled` fires when the human withdraws the request instead.
 *
 * Several rows can be pending at once (two tool calls in one turn), so the card
 * pages through them — one decision on screen at a time.
 */

import { NasikoElement, defineElement, html, nothing } from '/common/core/element.js';
import {
  agentConnectors, answeredSummary, cancelHitl, connectorFor, detailRows, getHitl, resolveHitl,
  structuredOptions, toolLabel,
} from '/common/services/hitl.js';
import { showToast } from '/common/utils/toast.js';
import { userMessage } from '/common/core/errors.js';
import { icons } from '/common/utils/icons.js';
import { unsafeHTML } from '/common/vendor/lit-all.esm.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-checkbox/app-checkbox.js';

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./hitl-card.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/**
 * Icons are SVG *strings* (utils/icons.js), and every Lit interpolation is
 * escaped by construction — so a bare `${icons.x()}` renders as visible markup.
 * These are our own constant strings, never user data.
 */
const ico = (glyph, size) => unsafeHTML(glyph('', size));

/**
 * An agent-supplied link, or null. The value reaches us from the paused agent,
 * so the scheme is checked rather than trusted: `window.open('javascript:…')`
 * runs in this page. Only http(s) is a place a human can sign in.
 */
const externalUrl = (value) => {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

class HitlCard extends NasikoElement {
  // Mounted into a live transcript, never present in a page's first paint, so
  // there is no geometry to reserve against an upgrade.
  static needsUpgradeReservation = false;

  /** @type {Array<any>} */ #rows = [];
  #index = 0;
  #busy = false;
  /** Rows whose external sign-in the human has been sent off to start. */
  #authStarted = new Set();
  /** row id -> the labels checked so far, for the multi-select rows. */
  #selected = new Map();
  /** Rows where the human opened single-select's "Something else" field. */
  #customOpen = new Set();
  /** connector_id -> { name, logo_url }, for the tool/connector identity. */
  #connectors = new Map();
  /** Who is asking. The sub-agent name on an orchestrator frame, else the agent. */
  actor = 'This agent';

  set rows(list) {
    this.#rows = (Array.isArray(list) ? list : [list]).filter(Boolean);
    this.#index = 0;
    this.requestUpdate();
    this.#hydrate();
  }

  get rows() {
    return this.#rows;
  }

  /** The row currently on screen. */
  get #row() {
    return this.#rows[Math.min(this.#index, this.#rows.length - 1)] || null;
  }

  /**
   * A stream frame carries only `id`/`kind`/`question` (§11.2) — enough to
   * resolve, not enough to render: the connector identity and the agent it
   * belongs to live on the full DTO. Fetch it, and let the partial render in
   * the meantime rather than holding the card back.
   */
  async #hydrate() {
    for (const [i, row] of this.#rows.entries()) {
      if (row.execution) continue;
      const full = await this.run(({ signal }) => getHitl(row.id, { signal }));
      if (full) {
        this.#rows[i] = full;
        this.requestUpdate();
      }
    }
    await this.#loadConnectors();
  }

  /**
   * Connector display name + logo for the rows that did not arrive with one.
   *
   * `tool_approval` now carries `connector_name`/`connector_logo_url` inline,
   * so the common path needs no request at all — this covers `auth_required`
   * (whose `connector` is a slug, not a display name) and any row from a
   * server that predates those fields.
   *
   * Identity only; it never gates the card.
   */
  async #loadConnectors() {
    const agentIds = new Set(this.#rows
      .filter((r) => !this.#inlineConnector(r) && r.question?.connector_id)
      .map((r) => r.execution?.agent_id)
      .filter(Boolean));
    for (const agentId of agentIds) {
      const found = await this.run(({ signal }) => agentConnectors(agentId, { signal }));
      for (const [id, connector] of found || []) this.#connectors.set(id, connector);
      this.requestUpdate();
    }
  }

  /** True once we have a display name without asking the server for one. */
  #inlineConnector(row) {
    return row?.question?.connector_name ? connectorFor(row.question) : null;
  }

  #connectorOf(row) {
    return connectorFor(row?.question, this.#connectors);
  }

  #title(row) {
    const connector = this.#connectorOf(row);
    if (row.kind === 'tool_approval') {
      return `${this.actor} wants to use ${toolLabel(row.question?.tool_name, connector?.name)}`;
    }
    if (row.kind === 'auth_required') {
      return connector?.name
        ? `Sign in to ${connector.name} again`
        : 'An account needs to be reconnected';
    }
    return row.question?.message || 'The agent needs your input';
  }

  /** The message line, unless it is already serving as the title. */
  #subtitle(row) {
    if (row.kind === 'input_required') return null;
    return row.question?.message || null;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Send one decision. A 409 means the row reached a different terminal state
   * first (expired, or an OAuth callback auto-resolved it) — the row on screen
   * is stale, so re-read it instead of insisting. `already_resolved` on a 200
   * is a successful no-op, not an error.
   */
  async #send(row, body) {
    if (this.#busy) return;
    this.#busy = true;
    this.requestUpdate();
    try {
      // The response is the resolved row itself — `status` and the
      // `human_response` the server actually stored — so the receipt reads
      // from the same place a reloaded row does instead of remembering which
      // button was clicked.
      const resolved = await resolveHitl(row.id, body, { signal: this.signal });
      const patch = { status: 'resolved', ...(resolved || {}) };
      // What we sent is the fallback for a response that carries no stored
      // answer back — the receipt must never be left with nothing to show.
      if (!patch.human_response) patch.human_response = body;
      this.#settle(row, patch);
      // Resolving records the decision; the answer reaches the agent
      // asynchronously. The page reconnects with this id to see what happens.
      this.emit('hitl-resolved', { id: row.id, row });
    } catch (err) {
      if (err?.status === 409 || err?.status === 404) await this.#refresh(row);
      else showToast(userMessage(err, 'Could not send your decision.'));
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  async #cancel(row) {
    if (this.#busy) return;
    this.#busy = true;
    this.requestUpdate();
    try {
      const canceled = await cancelHitl(row.id, { signal: this.signal });
      this.#settle(row, canceled || { status: 'canceled' });
      this.emit('hitl-canceled', { id: row.id, row });
    } catch (err) {
      if (err?.status === 409 || err?.status === 404) await this.#refresh(row);
      else showToast(userMessage(err, 'Could not withdraw the request.'));
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  /** Re-read a row whose state moved under us, and show what it actually is. */
  async #refresh(row) {
    const full = await this.run(({ signal }) => getHitl(row.id, { signal }));
    // Gone entirely: nothing left to answer, so show it as withdrawn.
    this.#settle(row, full || { status: 'canceled' });
    this.requestUpdate();
  }

  /**
   * Fold a decided row's new state in, and move to the next one still waiting.
   *
   * The row itself carries the outcome from here on — `status` and
   * `human_response` — which is what `#receipt` renders and what a row loaded
   * back from the session already has, so both paths read the same.
   */
  #settle(row, patch) {
    const i = this.#rows.findIndex((r) => r.id === row.id);
    if (i >= 0) this.#rows[i] = { ...this.#rows[i], ...patch };
    const next = this.#rows.findIndex((r) => !this.#answered(r));
    this.#index = next >= 0 ? next : this.#rows.length - 1;
  }

  /** A row is done when its own status says so — answered here, or before. */
  #answered(row) {
    return Boolean(row?.status) && row.status !== 'pending';
  }

  /**
   * Answer the `input_required` row on screen with typed text.
   *
   * Multi-select is the one shape where `answer` is not the typed string — it
   * is the array of ticked labels, with the text as `custom_answer` — so the
   * public entry point delegates rather than sending a wrong-shaped body a 400
   * would bounce.
   */
  answer(text) {
    const row = this.#row;
    if (!row || row.kind !== 'input_required') return false;
    const spec = structuredOptions(row.question);
    if (spec?.multiSelect) return this.#submitMulti(row, spec);
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    this.#send(row, { answer: trimmed });
    return true;
  }

  /** Resolve a single-select row with one of its own labels — one click, no Submit. */
  #pick(row, label) {
    this.#send(row, { answer: label });
  }

  #toggle(row, label, on) {
    const picked = this.#selected.get(row.id) || new Set();
    if (on) picked.add(label);
    else picked.delete(label);
    this.#selected.set(row.id, picked);
  }

  /**
   * Multi-select's Submit. No minimum and no maximum on the ticks — the only
   * body the server rejects is nothing ticked *and* no text, so that is the
   * only thing checked here, and it is checked to spare the human a 400 rather
   * than in place of the server's own check.
   */
  #submitMulti(row, spec) {
    const answer = [...(this.#selected.get(row.id) || [])];
    const custom = spec.allowCustom ? String(this.#input()?.value || '').trim() : '';
    if (!answer.length && !custom) {
      showToast('Pick an option, or type an answer.');
      return false;
    }
    this.#send(row, custom ? { answer, custom_answer: custom } : { answer });
    return true;
  }

  /** The card's one text field, when a row has one on screen. */
  #input() {
    return this.querySelector('app-input');
  }

  /** True while some row still needs a human. The page blocks the composer on this. */
  get isPending() {
    return this.#rows.some((r) => !this.#answered(r));
  }

  /** The kind on screen. */
  get kind() {
    return this.#row?.kind || null;
  }

  /**
   * What the composer should say while this card waits, or null when it is
   * free. Lives here rather than in each page because the copy follows from
   * `kind`, which is the card's business.
   */
  get composerHint() {
    if (!this.isPending) return null;
    if (this.kind === 'input_required') return 'Answer the question above to continue';
    if (this.kind === 'auth_required') return 'Sign in to continue here';
    return 'Approve or reject to continue here';
  }

  /**
   * True while the card is waiting — every kind, including a question. The
   * answer goes in the card's own field, so a live composer beside it would
   * offer a second place to type that starts a new turn instead of replying.
   */
  get blocksComposer() {
    return this.isPending;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render() {
    const row = this.#row;
    if (!row) return nothing;
    if (!this.isPending) return this.#receipt(row);

    const connector = this.#connectorOf(row);
    const details = detailRows(row.question);
    const waiting = this.#rows.filter((r) => !this.#answered(r)).length;

    return html`
      <div class="hc" role="group" aria-label="Action needs your approval">
        <div class="hc-head">
          ${this.#logo(connector, row.kind)}
          <div class="hc-titles">
            <span class="hc-title">${this.#title(row)}</span>
            ${this.#subtitle(row) ? html`<span class="hc-sub">${this.#subtitle(row)}</span>` : nothing}
          </div>
          ${waiting > 1 ? this.#pager(waiting) : nothing}
          <!-- Every kind can be dismissed. A waiting card holds the composer,
               so without this a human with nothing to decide — a tool they
               never wanted, an approval that is someone else's call — could
               not carry on the conversation at all. Withdrawing abandons the
               paused turn rather than answering it: no resume follows, which
               is the point. -->
          <button type="button" class="hc-x" title="Dismiss and keep chatting"
            aria-label="Withdraw this request" @click=${() => this.#cancel(row)}
            >${ico(icons.x, 14)}</button>
        </div>
        ${details.length
          ? html`<dl class="hc-rows">
              ${details.map(([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`)}
            </dl>`
          : nothing}
        ${this.#options(row)}
        <div class="hc-actions">${this.#actions(row)}</div>
      </div>
    `;
  }

  /**
   * The connector's mark, when the pause is about a connector at all. A plain
   * question is not, so it gets no square — there is nothing to identify.
   */
  #logo(connector, kind) {
    if (!connector?.name) {
      return kind === 'input_required'
        ? nothing
        : html`<span class="hc-logo" aria-hidden="true">${ico(icons.server, 16)}</span>`;
    }
    return html`<span class="hc-logo" aria-hidden="true"
      >${connector.name.charAt(0).toUpperCase()}${connector.logo_url
        ? html`<img src=${connector.logo_url} alt="" loading="lazy" />`
        : nothing}</span>`;
  }

  /** Position among the rows still waiting — resolved ones drop out of the count. */
  #pager(waiting) {
    const order = this.#rows.filter((r) => !this.#answered(r));
    const at = order.findIndex((r) => r.id === this.#row?.id) + 1;
    const step = (delta) => {
      const i = this.#rows.indexOf(order[Math.min(Math.max(at - 1 + delta, 0), order.length - 1)]);
      if (i >= 0) this.#index = i;
      this.requestUpdate();
    };
    return html`
      <div class="hc-pager">
        <button type="button" aria-label="Previous request" ?disabled=${at <= 1}
          @click=${() => step(-1)}>${ico(icons.chevronLeft, 14)}</button>
        <span>${at}/${waiting}</span>
        <button type="button" aria-label="Next request" ?disabled=${at >= waiting}
          @click=${() => step(1)}>${ico(icons.chevronRight, 14)}</button>
      </div>
    `;
  }

  /**
   * The selectable options of a structured `input_required` question, or
   * nothing at all for every other row — a plain question and both approval
   * kinds render exactly as they did before this existed.
   *
   * Single-select options are buttons because a click *is* the answer;
   * multi-select ones are checkboxes because a click is only a selection and
   * Submit is the answer. "Something else" is a UI affordance either way — its
   * label is never sent, only whatever the human then types.
   */
  #options(row) {
    const spec = row.kind === 'input_required' ? structuredOptions(row.question) : null;
    if (!spec) return nothing;
    const picked = this.#selected.get(row.id) || new Set();
    const opened = this.#customOpen.has(row.id);
    return html`
      ${spec.header ? html`<p class="hc-opt-head">${spec.header}</p>` : nothing}
      <!-- No whitespace between the <li>s: a text node between flex items
           renders as a stray line box under the last row. -->
      <ul class="hc-opts" role="list">${spec.options.map((opt, i) => html`<li>${spec.multiSelect
            ? html`<div class="hc-opt hc-opt--check" @click=${(e) => this.#rowClick(e)}>
                <app-checkbox aria-label=${opt.label} ?checked=${picked.has(opt.label)}
                  ?disabled=${this.#busy}
                  @change=${(e) => this.#toggle(row, opt.label, e.target.checked)}></app-checkbox>
                ${this.#optionText(opt)}
              </div>`
            : html`<button type="button" class="hc-opt" ?disabled=${this.#busy}
                @click=${() => this.#pick(row, opt.label)}>
                <span class="hc-opt-n">${i + 1}</span>
                ${this.#optionText(opt)}
                <span class="hc-opt-go" aria-hidden="true">${ico(icons.chevronRight, 14)}</span>
              </button>`}</li>`)}${spec.allowCustom && !spec.multiSelect
          ? html`<li><button type="button" class="hc-opt" aria-expanded=${opened}
              ?disabled=${this.#busy}
              @click=${() => { this.#customOpen.add(row.id); this.requestUpdate(); }}>
              <span class="hc-opt-n">${ico(icons.editThin, 12)}</span>
              ${this.#optionText({ label: 'Something else' })}
            </button></li>`
          : nothing}</ul>
    `;
  }

  /**
   * One line per option: the label, then its description beside it in muted
   * text. Stacked, the description made that one row taller than its
   * neighbours — a list of options should read as a list of equal choices, so
   * the description shares the line and truncates rather than growing the row.
   */
  #optionText(opt) {
    return html`
      <span class="hc-opt-text">
        <span class="hc-opt-label">${opt.label}</span>
        ${opt.description ? html`<span class="hc-opt-desc">${opt.description}</span>` : nothing}
      </span>
    `;
  }

  /**
   * The whole multi-select row is the hit target, not just the box and its own
   * label — a 4-row list where only the left third responds reads as broken.
   * A click on the checkbox itself is left alone; forwarding it would toggle
   * twice and land back where it started.
   */
  #rowClick(e) {
    const box = e.currentTarget.querySelector('app-checkbox');
    if (!box || box.contains(e.target)) return;
    box.input?.click();
  }

  /**
   * `allowed_actions` on the DTO is informational only — computed from `kind`
   * and blind to `status` (§7.4) — so the buttons come from `kind` directly and
   * the real 403/409 from the action is what corrects a stale card.
   */
  #actions(row) {
    const busy = this.#busy;
    // Nothing may be templated *into* <app-input>: it rewrites its own
    // innerHTML on every render, which would destroy the Lit part markers
    // inside it and break this whole row on the next update. Every other call
    // site slots icons from a plain innerHTML string; a Lit template can only
    // bind attributes on the host and keep the element childless.
    if (row.kind === 'tool_approval') {
      return html`
        <app-button variant="tertiary" size="sm" ?disabled=${busy}
          @click=${() => this.#send(row, { decision: 'reject' })}>Deny</app-button>
        <app-button variant="tertiary" size="sm" ?disabled=${busy}
          @click=${() => this.#send(row, { decision: 'approve', scope: 'session' })}
          >Always allow</app-button>
        <app-button variant="primary" size="sm" ?loading=${busy}
          @click=${() => this.#send(row, { decision: 'approve', scope: 'once' })}
          >Allow once</app-button>
      `;
    }
    if (row.kind === 'auth_required') {
      // Two clicks by design: `start` records that the human began the external
      // step and leaves the row pending; `confirm` is their assertion it is
      // done — intent, not proof. There is no deny action for this kind.
      const started = row.human_response != null || this.#authStarted.has(row.id);
      return html`
        <app-button variant="tertiary" size="sm" ?disabled=${busy}
          @click=${() => this.#startAuth(row)}>${started ? 'Open sign-in again' : 'Sign in'}</app-button>
        <app-button variant="primary" size="sm" ?loading=${busy} ?disabled=${!started}
          @click=${() => this.#send(row, { auth_action: 'confirm' })}
          >I have signed in</app-button>
      `;
    }
    const spec = structuredOptions(row.question);
    if (spec?.multiSelect) {
      // Ticking a box resolves nothing, so this kind always carries a Submit —
      // and the free-text field, when offered, is fillable whatever is ticked.
      return html`
        ${spec.allowCustom ? this.#field(busy, 'Something else') : nothing}
        <app-button variant="primary" size="sm" ?loading=${busy}
          @click=${() => this.#submitMulti(row, spec)}>Submit</app-button>
      `;
    }
    // Single-select answers itself on click; its field appears only once the
    // human has asked for one, and then Submit is what resolves — not the click
    // on "Something else", which is why that button has no send of its own.
    if (spec && !this.#customOpen.has(row.id)) return nothing;
    return html`
      ${this.#field(busy, 'Enter your input')}
      <app-button variant="primary" size="sm" icon-only aria-label="Send answer" ?loading=${busy}
        @click=${() => this.answer(this.#input()?.value)}
        >${ico(icons.arrowUp, 12)}</app-button>
    `;
  }

  /** The one text field an `input_required` row can carry. */
  #field(busy, placeholder) {
    return html`
      <div class="hc-field">
        <span class="hc-field-icon" aria-hidden="true">${ico(icons.editThin, 12)}</span>
        <app-input size="sm" type="text" placeholder=${placeholder}
          aria-label="Your answer" ?disabled=${busy}
          @keydown=${(e) => { if (e.key === 'Enter') this.answer(e.target.value); }}></app-input>
      </div>
    `;
  }

  /**
   * `start` deliberately does not change `status` — it is a `human_response`
   * write that keeps the row pending — so this arms the confirm button and
   * hands off to whatever will actually take the sign-in.
   *
   * `question.auth_url` is the agent's own authorize link — a well-known key
   * the pause hoists out of the A2A metadata (External Agent Contract, and
   * `WELL_KNOWN_QUESTION_KEYS` in oss/types/src/a2a.rs) — and it is the only
   * destination an external agent has: those rows carry no `connector_id` at
   * all, so keying off the connector alone opened nothing and the button did
   * visibly nothing. The connector detail page is the fallback for our own
   * gateway connectors, whose OAuth flow starts there rather than at a URL.
   */
  async #startAuth(row) {
    this.#authStarted.add(row.id);
    await this.run(({ signal }) => resolveHitl(row.id, { auth_action: 'start' }, { signal }));
    const id = row.question?.connector_id;
    // Same two positions `structuredOptions` reads: hoisted, else still in the
    // agent's own metadata on a row that predates the hoist.
    const target = externalUrl(row.question?.auth_url || row.question?.metadata?.auth_url)
      || (id ? `/mcp-detail?id=${encodeURIComponent(id)}` : null);
    if (target) window.open(target, '_blank', 'noopener');
    else showToast('This request carries no sign-in link.');
    this.requestUpdate();
  }

  /**
   * What is left in the transcript once a row is decided: the question that was
   * asked and the answer that was given. A bare "sent" line was indistinguishable
   * from the next one down, and said nothing at all on reload — but this is
   * history, not a control, so it stays a quiet block rather than a card.
   */
  #receipt(row) {
    const { label, answer } = answeredSummary(row);
    return html`
      <div class="hc hc--done">
        <span class="hc-done-icon" aria-hidden="true">${ico(icons.checkCircle, 14)}</span>
        <div class="hc-done-body">
          <span class="hc-done-q">${this.#title(row)}</span>
          <span class="hc-done-a">
            <span class="hc-done-label">${label}</span>
            ${answer ? html`<span class="hc-done-text">${answer}</span>` : nothing}
          </span>
        </div>
      </div>
    `;
  }
}

defineElement('hitl-card', HitlCard);
