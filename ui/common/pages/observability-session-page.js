/**
 * Observability session detail — a turn navigator over the session's traces,
 * with the selected turn's span tree and the selected span's detail below it.
 *
 * A "turn" is one trace: one user query and the agent's answer to it. The
 * question and answer text comes from the chat transcript, joined to the trace
 * on `chat_messages.trace_id`; where a message carries no trace id (BYO-key
 * agents), the trace's own root-span content stands in.
 *
 * @element observability-session-page
 * @note Data sources (see /api/docs):
 *       `call('fetchObservabilitySession', sessionId)` → GET /api/observability/session/{id}
 *       `call('fetchObservabilityTrace', traceId)`     → GET /api/observability/trace/{id}
 *       `call('fetchSpanDetail', traceId, spanId)`     → GET /api/observability/span/{trace_id}/{span_id}
 *       `call('fetchChatSession', sessionId)`          → GET /api/chat/sessions/{id} (chat transcript)
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./observability-session-page.css', import.meta.url));
import { icons } from '../utils/icons.js';
// Both were previously "imported" from inside the docblock above, i.e. never:
// <app-skeleton> and <app-empty-state> rendered as inert unknown elements.
import '/common/design-system/app-skeleton/app-skeleton.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-stat-row/app-stat-row.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-tabs/app-tabs.js';
import '/common/design-system/app-switch/app-switch.js';
import '/common/design-system/app-menu/app-menu.js';
import '/common/features/app-module-nav.js';
import { escAttr, escHtml } from '/common/utils/escape.js';
import { renderMarkdown } from '/common/utils/markdown.js';
import { call } from '../core/data-sources.js';
import '/common/utils/back-link.js';


document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/// Sentinel span id for the synthetic node at the top of each turn's tree. Not
/// a real span — selecting it shows the turn, not a span fetch.
const TURN_ROOT_ID = '__turn_root__';

/// Turn labels in the picker. Long questions are the norm, and the menu is a
/// popover, not a page.
const TURN_LABEL_CHARS = 46;

const fmtInt = (v) => (v == null ? '—' : Number(v).toLocaleString());

/// Cache reads and cache writes as one number, which is how the design shows
/// them. Null only when neither count was served at all — a served 0 is a real
/// measurement and renders as "0".
const cacheTokens = (o) => {
  if (o?.cache_read_tokens == null && o?.cache_creation_tokens == null) return null;
  return (o.cache_read_tokens ?? 0) + (o.cache_creation_tokens ?? 0);
};
/// Dollars at 2dp, sub-cent amounts at 4dp. A fixed 2dp renders a $0.0010 turn
/// as "$0.00", and a fixed 4dp renders a real session total as "$4.8200".
const fmtUsd = (v) => {
  if (v == null) return '—';
  const n = Number(v);
  return `$${n.toFixed(Math.abs(n) >= 0.01 ? 2 : 4)}`;
};
const fmtMs = (ms) => {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
};

class ObservabilitySessionPage extends HTMLElement {
  #initialized = false;
  #sessionId = '';
  #session = null;
  /// One entry per trace, in order: {traceId, entry, question, answer, metrics}.
  #turns = [];
  #turnIndex = 0;
  /// Fingerprint of what the turn strip currently shows, so the span poll does
  /// not rebuild identical markup every two seconds.
  #renderedTurnKey = null;
  /// Chat messages keyed by trace_id, for the question/answer text.
  #messages = [];
  #spans = [];          // flattened {node, depth, traceId} for the current turn
  #span = null;         // currently-selected span's detail payload
  #selected = null;     // {traceId, spanId}
  #rawAttributes = false;
  /// Span ids whose children are folded away in the trace tree.
  #collapsed = new Set();
  #tracesState = 'loading';  // loading | ready | empty | error
  #focusTraceId = '';        // ?trace_id= — preselect this trace
  #pollTimer = null;
  #pollDeadline = 0;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    const params = new URLSearchParams(window.location.search);
    this.#sessionId = params.get('session_id') || '';
    this.#focusTraceId = params.get('trace_id') || '';

    this.innerHTML = `
      <app-module-nav module="observability"></app-module-nav>
      <div class="page-head">
        <app-button variant="tertiary" size="sm" icon-only href="/sessions" data-back
          aria-label="Back">${icons.arrowLeft()}</app-button>
        <!-- Starts as the id and is replaced by the session's title once the
             payload lands (#renderTitle). Not a URL param: that would only
             work when arriving from the list, never on a deep link. -->
        <h1 class="page-title" id="page-title">${escHtml(this.#sessionId)}</h1>
        <button type="button" class="id-chip" data-copy="${escAttr(this.#sessionId)}"
          title="Copy session ID" aria-label="Copy session ID">
          <span class="id-chip__text">${escHtml(this.#sessionId)}</span>
          <span class="id-chip__icon">${icons.copy('', 14)}</span>
        </button>
      </div>
      <app-stat-row id="kpi-strip" variant="chips" loading="6"></app-stat-row>
      <section class="turn-strip" id="turn-strip" aria-label="Session turns">
        <div class="pane-empty" aria-busy="true"><app-skeleton lines="3"></app-skeleton></div>
      </section>
      <div class="panes">
        <section class="pane" id="traces-pane" aria-label="Traces">
          <div class="pane-empty" aria-busy="true"><app-skeleton lines="4"></app-skeleton></div>
        </section>
        <section class="pane" id="detail-pane" aria-label="Span detail">
          <div class="pane-empty">Select a span to see its details</div>
        </section>
      </div>
    `;

    // Delegated on the host: every pane rebuilds its own subtree on refresh, so
    // per-element listeners would be dropped on the next render.
    this.addEventListener('click', (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) { this.#copy(copy); return; }

      const step = e.target.closest('[data-step]');
      if (step) { this.#step(Number(step.dataset.step)); return; }

      const fold = e.target.closest('[data-fold]');
      if (fold) {
        const id = fold.dataset.fold;
        this.#collapsed.has(id) ? this.#collapsed.delete(id) : this.#collapsed.add(id);
        this.#loadTurnTrace();
        return;
      }

      const row = e.target.closest('.span-row');
      if (row) this.#selectSpan(row.dataset.traceId, row.dataset.spanId);
    });

    this.addEventListener('menu-select', (e) => {
      if (e.target.id !== 'turn-menu') return;
      this.#goToTurn(Number(e.detail.id));
    });

    this.#load();
  }

  disconnectedCallback() {
    clearTimeout(this.#pollTimer);
  }

  async #load() {
    // The transcript is what supplies the question and answer text, so it has
    // to be in hand before the turns are built — not raced against them.
    await this.#loadChat();
    await this.#loadSession();
    this.#startPolling();
  }

  /**
   * Agents export spans through a batching OTel exporter, so a trace opened
   * straight after a chat holds only the control plane's own `a2a.dispatch`
   * span — the agent's `a2a.execute` and `ChatCompletion` spans land a few
   * seconds later. Re-fetch until the tree stops growing (or the window
   * closes) instead of showing that half-built trace and never updating.
   */
  #startPolling() {
    const INTERVAL_MS = 2000;
    const WINDOW_MS = 30_000;
    const STABLE_TICKS = 3;

    this.#pollDeadline = Date.now() + WINDOW_MS;
    let lastCount = this.#spans.length;
    let stable = 0;

    const tick = async () => {
      if (Date.now() > this.#pollDeadline) return;
      await this.#loadSession();
      const count = this.#spans.length;
      stable = count === lastCount ? stable + 1 : 0;
      lastCount = count;
      if (stable >= STABLE_TICKS) return;
      this.#pollTimer = setTimeout(tick, INTERVAL_MS);
    };
    this.#pollTimer = setTimeout(tick, INTERVAL_MS);
  }

  async #loadChat() {
    try {
      const resp = await call('fetchChatSession', this.#sessionId);
      this.#messages = resp?.data ?? [];
    } catch {
      // Observability sessions don't always map to a chat session; the trace's
      // own root-span content is the fallback.
      this.#messages = [];
    }
  }

  async #loadSession() {
    let resp;
    try {
      resp = await call('fetchObservabilitySession', this.#sessionId);
    } catch (e) {
      console.error('Session fetch failed:', e);
      this.#tracesState = 'error';
      this.#renderTracesPlaceholder(
        'Traces unavailable',
        'The trace backend could not be reached for this session.',
        icons.xCircle(),
      );
      this.#renderKpis();
      return;
    }
    this.#session = resp?.data?.session ?? null;
    this.#renderTitle();
    this.#buildTurns();
    this.#renderKpis();
    this.#renderTurn();
    await this.#loadTurnTrace();
  }

  /// Sessions that never went through chat have no title; the id the reader
  /// navigated with stays as the heading rather than a blank one.
  #renderTitle() {
    const title = this.#session?.title;
    if (title) this.querySelector('#page-title').textContent = title;
  }

  // ── KPI strip ────────────────────────────────────────────────────────────

  #renderKpis() {
    const s = this.#session;
    const strip = this.querySelector('#kpi-strip');
    // No session, no metrics. Leaving the skeleton up would claim the numbers
    // are still loading, so fold the whole thing away.
    if (!s) {
      strip.items = [];
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    const cost = s.cost_summary ?? {};
    strip.items = [
      { label: 'Total tokens', value: fmtInt(s.token_usage?.total) },
      { label: 'Input tokens', value: fmtInt(cost.prompt?.tokens) },
      { label: 'Output tokens', value: fmtInt(cost.completion?.tokens) },
      { label: 'Cache tokens', value: fmtInt(cacheTokens(s)) },
      { label: 'Total cost', value: fmtUsd(cost.total?.cost) },
      // P50 here and on the session list, so the same session reads the same
      // number on both screens. `latency_avg` is served alongside it.
      { label: 'Latency P50', value: fmtMs(s.latency_p50) },
    ];
  }

  // ── Turns ────────────────────────────────────────────────────────────────

  /**
   * One turn per trace. `chat_messages.trace_id` is what ties a turn's text to
   * its spans; the pairing walks the transcript in order so a user row is
   * matched with the assistant row that answered it.
   */
  #buildTurns() {
    const traces = this.#session?.traces ?? [];
    const byTrace = new Map();
    let pendingUser = null;
    for (const m of this.#messages) {
      if (m.role === 'user') { pendingUser = m; continue; }
      if (!m.trace_id) { pendingUser = null; continue; }
      byTrace.set(m.trace_id, { user: pendingUser, assistant: m });
      pendingUser = null;
    }

    this.#turns = traces.map((entry) => {
      const root = entry.root_span ?? {};
      const pair = byTrace.get(entry.trace_id);
      return {
        traceId: entry.trace_id,
        // `||` not `??`: the server serializes "no content" as an empty
        // string, which must fall through to the next source.
        question: pair?.user?.content || root.input?.value || '',
        answer: pair?.assistant?.content || root.output?.value || '',
        startTime: root.start_time,
        totalTokens: root.cumulative_token_count_total,
        // The trace's own counts first — they cover BYO-key agents too. The
        // chat message's usage is the fallback for turns whose spans carried
        // no token attributes.
        inputTokens: root.input_tokens ?? pair?.assistant?.input_tokens ?? null,
        outputTokens: root.output_tokens ?? pair?.assistant?.output_tokens ?? null,
        cacheTokens: cacheTokens(root),
        cost: root.trace?.cost_summary?.total?.cost ?? null,
        durationMs: root.latency_ms ?? pair?.assistant?.duration_ms ?? null,
      };
    });

    // ?trace_id= (from a chat's "Detailed trace") opens on that turn. Only on
    // the first build — a poll must not yank the reader back.
    if (this.#focusTraceId) {
      const i = this.#turns.findIndex((t) => t.traceId === this.#focusTraceId);
      if (i >= 0) this.#turnIndex = i;
      this.#focusTraceId = '';
    }
    this.#turnIndex = Math.min(this.#turnIndex, Math.max(0, this.#turns.length - 1));
  }

  #turn() { return this.#turns[this.#turnIndex] ?? null; }

  #step(delta) {
    this.#goToTurn(this.#turnIndex + delta);
  }

  async #goToTurn(index) {
    if (!this.#turns.length) return;
    const next = Math.max(0, Math.min(index, this.#turns.length - 1));
    if (next === this.#turnIndex) return;
    this.#turnIndex = next;
    // A different turn is a different trace, so the previous turn's selection
    // means nothing here.
    this.#selected = null;
    this.#renderTurn();
    await this.#loadTurnTrace();
  }

  #renderTurn() {
    const strip = this.querySelector('#turn-strip');
    const turn = this.#turn();
    if (!turn) {
      strip.innerHTML = `<div class="pane-empty">No turns recorded for this session</div>`;
      this.#renderedTurnKey = null;
      return;
    }
    // The span poll re-runs this every 2s for half a minute. Rebuilding
    // identical markup would close an open turn picker under the reader's
    // cursor and throw away any "Show more" they had expanded.
    const key = JSON.stringify([this.#turnIndex, this.#turns.length, turn]);
    if (key === this.#renderedTurnKey) return;
    this.#renderedTurnKey = key;
    const total = this.#turns.length;
    const items = this.#turns.map((t, i) => ({
      id: String(i),
      label: `${i + 1}. ${(t.question || '(no question recorded)')
        .replace(/\s+/g, ' ').trim().slice(0, TURN_LABEL_CHARS)}`,
    }));

    strip.innerHTML = `
      <div class="turn-nav">
        <button type="button" class="turn-step" data-step="-1"
          ${this.#turnIndex === 0 ? 'disabled' : ''} aria-label="Previous turn"
        >${icons.chevronUp('', 14)}</button>
        <app-menu id="turn-menu" align="center" label="Jump to a turn"
          items='${escAttr(JSON.stringify(items))}'
        ><app-button variant="tertiary" size="md" title="Jump to a turn"
          >${escHtml(`${this.#turnIndex + 1}/${total}`)}</app-button></app-menu>
        <button type="button" class="turn-step" data-step="1"
          ${this.#turnIndex === total - 1 ? 'disabled' : ''} aria-label="Next turn"
        >${icons.chevronDown('', 14)}</button>
      </div>
      <div class="turn-body">
        <div class="turn-line">
          <span class="turn-glyph" aria-hidden="true">${icons.info('', 16)}</span>
          <!-- .turn-text is a column: #applyClamps inserts its "Show more"
               button as the clamped block's next sibling, and directly inside
               the row-flex .turn-line that puts it beside the text. -->
          <div class="turn-text">
            <!-- Literal user input: escaped, never parsed as markdown, and
                 pre-wrap so a pasted stack trace keeps its lines. -->
            <div class="turn-question msg-clamp">${escHtml(turn.question || 'No question recorded for this turn')}</div>
          </div>
        </div>
        <div class="turn-line">
          <span class="turn-glyph" aria-hidden="true">${icons.send('', 16)}</span>
          <div class="turn-text">
            <!-- Agent replies are markdown, as they are in the chat transcript
                 this text comes from. Rendering the source verbatim put "##"
                 and "**" on screen and collapsed every newline into one
                 paragraph. -->
            <div class="turn-answer msg-clamp md-body">${turn.answer
              ? renderMarkdown(turn.answer)
              : escHtml('No answer recorded for this turn')}</div>
          </div>
        </div>
        <div class="turn-meta">
          <app-stat-row variant="chips" id="turn-metrics"></app-stat-row>
          <span class="turn-time">${escHtml(this.#fmtDate(turn.startTime))}</span>
        </div>
      </div>
    `;
    this.querySelector('#turn-metrics').items = [
      { label: 'Total tokens', value: fmtInt(turn.totalTokens) },
      { label: 'Input tokens', value: fmtInt(turn.inputTokens) },
      { label: 'Output tokens', value: fmtInt(turn.outputTokens) },
      { label: 'Cache tokens', value: '—' },
      { label: 'Cost', value: fmtUsd(turn.cost) },
      { label: 'Duration', value: fmtMs(turn.durationMs) },
    ];
    // A whole answer can run to thousands of characters; without this the strip
    // grew until it pushed the trace tree off the fold.
    this.#applyClamps(strip);
  }

  // ── Traces ───────────────────────────────────────────────────────────────

  /**
   * The span tree for the selected turn only. This used to fetch every trace in
   * the session up front — one sequential request per turn — to build a single
   * flat list; the tree is per-turn, so all but one of those were thrown away.
   */
  async #loadTurnTrace() {
    const turn = this.#turn();
    if (!turn) {
      this.#spans = [];
      this.#renderTraces();
      return;
    }
    let detail;
    try {
      detail = await call('fetchObservabilityTrace', turn.traceId);
    } catch (e) {
      console.warn(`Trace ${turn.traceId} fetch failed:`, e);
      this.#tracesState = 'error';
      this.#renderTracesPlaceholder(
        'Traces unavailable',
        'The trace backend could not be reached for this turn.',
        icons.xCircle(),
      );
      return;
    }
    // The turn is the root of its own tree. Tempo hands back whatever span
    // happened to start the trace (`a2a.dispatch`, `request`, …), which says
    // nothing about the chat message that caused it — so the query the reader
    // asked sits at the top and every span hangs beneath it, matching
    // `NAM → dept  session.run` in the design.
    const roots = detail?.spans ?? [];
    const turnRoot = {
      span_id: TURN_ROOT_ID,
      name: this.#sessionId,
      operation: 'session.run',
      // Wall-clock for the whole turn, not the sum of its parts: spans overlap.
      latency_ms: turn.durationMs ?? null,
      // One errored span anywhere under the turn makes the turn an error.
      status_code: roots.some((r) => this.#subtreeHasError(r)) ? 'ERROR' : 'OK',
      children: roots,
    };

    const flat = [];
    const walk = (node, depth) => {
      flat.push({ node, depth, traceId: turn.traceId });
      if (this.#collapsed.has(node.span_id)) return;
      (node.children || []).forEach((c) => walk(c, depth + 1));
    };
    walk(turnRoot, 0);
    this.#spans = flat;
    this.#renderTraces();
    if (!flat.length) return;

    // Keep whatever the reader picked; only auto-select when nothing is
    // selected yet or a poll dropped the selected span from the tree.
    const stillThere = this.#selected
      && flat.some((f) => f.node.span_id === this.#selected.spanId);
    if (stillThere) return;
    this.#selectSpan(turn.traceId, TURN_ROOT_ID);
  }

  /**
   * Trace pane with nothing to show. The span-detail pane is meaningless
   * without a span to select, so `.traces-empty` folds it away and this one
   * empty state takes both columns.
   */
  #renderTracesPlaceholder(title, description, icon) {
    this.querySelector('#traces-pane').innerHTML = `
      ${this.#tracesTitle()}
      <app-empty-state title="${escHtml(title)}" description="${escHtml(description)}"
        icon='${icon}'></app-empty-state>
    `;
    this.#syncPanes();
  }

  /** Fold away panes that have no content to carry. */
  #syncPanes() {
    const panes = this.querySelector('.panes');
    if (!panes) return;
    panes.classList.toggle('traces-empty', this.#tracesState === 'empty' || this.#tracesState === 'error');
  }

  #tracesTitle() {
    const traceId = this.#turn()?.traceId;
    return `<h2 class="pane-title">Traces${traceId ? `
      <button type="button" class="id-chip" data-copy="${escAttr(traceId)}"
        title="Copy trace ID" aria-label="Copy trace ID">
        <span class="id-chip__text">${escHtml(traceId)}</span>
        <span class="id-chip__icon">${icons.copy('', 14)}</span>
      </button>` : ''}</h2>`;
  }

  #renderTraces() {
    const pane = this.querySelector('#traces-pane');
    if (!this.#spans.length) {
      this.#tracesState = 'empty';
      this.#renderTracesPlaceholder(
        'No traces for this turn',
        'Nothing was recorded here. Spans appear once an instrumented agent handles a request in this session.',
        icons.trace(),
      );
      return;
    }
    this.#tracesState = 'ready';
    this.#syncPanes();
    pane.innerHTML = `
      ${this.#tracesTitle()}
      ${this.#spans.map(({ node, depth, traceId }) => {
        const kids = (node.children || []).length > 0;
        const folded = this.#collapsed.has(node.span_id);
        return `
        <div class="span-line" style="padding-left:${depth * 16}px">
          ${kids
            ? `<button type="button" class="span-fold" data-fold="${escAttr(node.span_id)}"
                 aria-expanded="${folded ? 'false' : 'true'}"
                 aria-label="${folded ? 'Expand' : 'Collapse'} ${escAttr(node.name)}"
               >${folded ? icons.chevronRight('', 14) : icons.chevronDown('', 14)}</button>`
            : '<span class="span-fold is-leaf" aria-hidden="true"></span>'}
          <button class="span-row" type="button"
            data-trace-id="${escHtml(traceId)}" data-span-id="${escHtml(node.span_id)}">
            <span class="span-icon">${this.#spanIcon(node)}</span>
            <span class="span-name">${escHtml(node.name)}</span>
            ${node.operation ? `<span class="span-op">${escHtml(node.operation)}</span>` : ''}
            <span class="status-dot${this.#isError(node.status_code) ? ' is-error' : ''}"></span>
            <app-badge variant="neutral">${icons.clock('', 12)} ${fmtMs(node.latency_ms)}</app-badge>
          </button>
        </div>`;
      }).join('')}
    `;
    this.#markSelected();
  }

  #markSelected() {
    this.querySelectorAll('.span-row').forEach((row) => {
      row.classList.toggle('is-selected', row.dataset.spanId === this.#selected?.spanId);
    });
  }

  // ── Span detail ──────────────────────────────────────────────────────────

  async #selectSpan(traceId, spanId) {
    this.#selected = { traceId, spanId };
    this.#markSelected();
    const pane = this.querySelector('#detail-pane');

    // The turn root is not a span — there is nothing to fetch. It carries the
    // chat message itself, so selecting it shows the query and the answer.
    if (spanId === TURN_ROOT_ID) {
      this.#span = null;
      this.#renderTurnDetail();
      return;
    }

    pane.innerHTML = '<div class="pane-empty" aria-busy="true"><app-skeleton lines="4"></app-skeleton></div>';
    let resp;
    try {
      resp = await call('fetchSpanDetail', traceId, spanId);
    } catch (e) {
      console.error('Span fetch failed:', e);
      pane.innerHTML = '<div class="pane-empty">Failed to load span details</div>';
      return;
    }
    this.#span = resp?.data?.span ?? null;
    this.#renderDetail();
  }

  /** Detail pane for the turn root: the chat message and the turn's totals. */
  #renderTurnDetail() {
    const pane = this.querySelector('#detail-pane');
    const turn = this.#turn();
    if (!turn) {
      pane.innerHTML = '<div class="pane-empty">Select a span to see its details</div>';
      return;
    }
    pane.innerHTML = `
      <div class="detail-head">
        <h3>${escHtml(this.#sessionId)}</h3>
        <app-badge variant="info">session.run</app-badge>
      </div>
      <div class="detail-section-title">User</div>
      <div class="msg-block"><div class="msg-content msg-clamp">${escHtml(
        turn.question || 'No question recorded for this turn')}</div></div>
      <div class="detail-section-title">Assistant</div>
      <div class="msg-block"><div class="msg-content msg-clamp md-body">${turn.answer
        ? renderMarkdown(turn.answer)
        : escHtml('No answer recorded for this turn')}</div></div>
      <div class="detail-section-title">Usage</div>
      <dl class="kv">
        <dt>Total tokens</dt><dd>${escHtml(fmtInt(turn.totalTokens))}</dd>
        <dt>Input tokens</dt><dd>${escHtml(fmtInt(turn.inputTokens))}</dd>
        <dt>Output tokens</dt><dd>${escHtml(fmtInt(turn.outputTokens))}</dd>
        <dt>Cache tokens</dt><dd>${escHtml(fmtInt(turn.cacheTokens))}</dd>
        <dt>Cost</dt><dd>${escHtml(fmtUsd(turn.cost))}</dd>
        <dt>Duration</dt><dd>${escHtml(fmtMs(turn.durationMs))}</dd>
      </dl>
    `;
    this.#applyClamps(pane);
  }

  #renderDetail() {
    const s = this.#span;
    const pane = this.querySelector('#detail-pane');
    if (!s) {
      pane.innerHTML = '<div class="pane-empty">Select a span to see its details</div>';
      return;
    }
    const attrs = s.attributes ?? {};
    // Served as top-level fields; the nested semconv attributes stay as the
    // fallback for spans recorded before that promotion.
    const provider = s.provider ?? attrs.gen_ai?.system ?? null;
    const model = s.model ?? attrs.gen_ai?.request?.model ?? attrs.gen_ai?.response?.model ?? null;

    pane.innerHTML = `
      <div class="detail-head">
        <h3>${escHtml(s.name)}</h3>
        <app-badge variant="info">${escHtml(s.span_kind || 'internal')}</app-badge>
        <app-switch id="raw-toggle" size="sm" label="View raw attributes"
          ${this.#rawAttributes ? 'checked' : ''}></app-switch>
      </div>
      ${provider || model ? `<div class="detail-origin">
        ${provider ? `<span><b>Provider:</b> ${escHtml(provider)}</span>` : ''}
        ${model ? `<span><b>Model:</b> ${escHtml(model)}</span>` : ''}
      </div>` : ''}
      ${this.#rawAttributes
        ? `<pre class="raw-json">${escHtml(JSON.stringify(attrs, null, 2))}</pre>`
        : `<app-tabs>
            <div data-tab="input" data-label="Input">${this.#inputTabHtml()}</div>
            <div data-tab="usage" data-label="Usage">${this.#usageTabHtml()}</div>
            <div data-tab="events" data-label="Metadata &amp; events">${this.#eventsTabHtml()}</div>
          </app-tabs>
          ${this.#outputHtml()}`}
    `;
    // Bound to the element, not delegated on the page. app-switch re-renders
    // inside its own change handler, so by the time a delegated listener runs
    // the <input> that fired has been detached and `closest()` finds nothing —
    // the toggle looked wired and did nothing at all.
    pane.querySelector('#raw-toggle')?.addEventListener('change', (e) => {
      this.#rawAttributes = !!e.currentTarget.checked;
      this.#renderDetail();
    });
    // Both panels are rendered up front — app-tabs owns the switch, so there is
    // no re-render to hang the clamp pass off. #applyClamps measures, and a
    // hidden panel measures as zero, so only the visible one gets a toggle.
    this.#applyClamps(pane);
  }

  /** Messages from the span, as `{role, content}` pairs. */
  #messagesFor(which) {
    const s = this.#span;
    const attrs = s?.attributes ?? {};
    // tempo.rs builds a flat dotted-key attribute map, but the span-detail API
    // re-nests it before serializing (`unflatten_attrs` in
    // oss/server/src/observability/service.rs), so the wire shape is
    // `attributes.gen_ai.input.messages` — a flat `attrs['gen_ai.input.messages']`
    // lookup can never match. The server also resolves the raw content into
    // `input.value`/`output.value`, so that field is the primary source here.
    //
    // `llm.*` is the older OpenInference convention, kept first for spans
    // recorded before OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental
    // — a fallback chain rather than a version check, matching how this repo
    // handles A2A payload drift. `||` not `??`: the server serializes "no
    // content" as an empty string, which must fall through.
    return which === 'input'
      ? this.#extractMessages(attrs.llm?.input_messages,
        s?.input?.value || attrs.gen_ai?.input?.messages || s?.input_content)
      : this.#extractMessages(attrs.llm?.output_messages,
        s?.output?.value || attrs.gen_ai?.output?.messages || s?.output_content);
  }

  #msgBlocksHtml(msgs, emptyText) {
    if (!msgs.length) return `<div class="pane-empty">${escHtml(emptyText)}</div>`;
    return msgs.map((m) => `
      <div class="msg-block">
        <div class="msg-role">${escHtml(m.role || '')}</div>
        <!-- Escaped, not markdown: span payloads are often raw JSON or tool
             output, which a markdown pass would mangle. -->
        <div class="msg-content msg-clamp">${escHtml(m.content || '')}</div>
      </div>`).join('');
  }

  #inputTabHtml() {
    return this.#msgBlocksHtml(this.#messagesFor('input'), 'No input message available');
  }

  #outputHtml() {
    return `
      <div class="detail-section-title">Output</div>
      ${this.#msgBlocksHtml(this.#messagesFor('output'), 'No output message available')}
    `;
  }

  /** Per-span usage: the token split, the cache counts and the cost. */
  #usageTabHtml() {
    const s = this.#span;
    const cost = s.cost_summary ?? {};
    const rows = [
      ['Total tokens', fmtInt(s.token_count_total)],
      ['Input tokens', fmtInt(cost.prompt?.tokens)],
      ['Output tokens', fmtInt(cost.completion?.tokens)],
      ['Cache tokens', fmtInt(cacheTokens(s))],
      ['Input cost', fmtUsd(cost.prompt?.cost)],
      ['Output cost', fmtUsd(cost.completion?.cost)],
      ['Total cost', fmtUsd(cost.total?.cost)],
      ['Latency', fmtMs(s.latency_ms)],
    ];
    return `<dl class="usage-grid">${rows.map(([k, v]) => `
      <dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join('')}</dl>`;
  }

  /**
   * Span events plus the status line. Instrumentation that emits no events at
   * all is normal, so the empty branch states that rather than reading as a
   * failure.
   */
  #eventsTabHtml() {
    const s = this.#span;
    const meta = [
      ['Span ID', s.span_id],
      ['Parent span', s.parent_id || '—'],
      ['Status', s.status_code || '—'],
      ['Status message', s.status_message || '—'],
      ['Started', this.#fmtDate(s.start_time)],
      ['Ended', this.#fmtDate(s.end_time)],
    ];
    const events = Array.isArray(s.events) ? s.events : [];
    return `
      <dl class="usage-grid">${meta.map(([k, v]) => `
        <dt>${escHtml(k)}</dt><dd>${escHtml(String(v))}</dd>`).join('')}</dl>
      <div class="detail-section-title">Events</div>
      ${events.length
        ? events.map((ev) => `<pre class="raw-json">${escHtml(JSON.stringify(ev, null, 2))}</pre>`).join('')
        : '<div class="pane-empty">No events recorded for this span</div>'}
    `;
  }

  /** Messages may live in OTel genai attributes or in the raw input/output value. */
  #extractMessages(attrMsgs, rawValue) {
    if (Array.isArray(attrMsgs) && attrMsgs.length) {
      return attrMsgs.map((m) => {
        const msg = m.message || m;
        return { role: msg.role, content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) };
      });
    }
    if (!rawValue) return [];
    try {
      const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
      if (Array.isArray(parsed?.messages)) {
        return parsed.messages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }));
      }
      // GenAI semconv shape (gen_ai.input/output.messages):
      // [{role, parts: [{type:"text",content}|{type:"tool_call",name,arguments}|
      //                 {type:"tool_call_response",response}]}]
      if (Array.isArray(parsed)) {
        return parsed.map((m) => ({
          role: m.role || '',
          content: Array.isArray(m.parts) ? m.parts.map((p) => this.#partText(p)).join('\n') : JSON.stringify(m),
        }));
      }
    } catch { /* plain text below */ }
    return [{ role: '', content: String(rawValue) }];
  }

  /** Render one GenAI semconv message part as display text. */
  #partText(p) {
    if (p?.type === 'tool_call') {
      const args = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {});
      return `⚒ ${p.name || 'tool'}(${args})`;
    }
    if (p?.type === 'tool_call_response') {
      return typeof p.response === 'string' ? p.response : JSON.stringify(p.response ?? '');
    }
    if (typeof p?.content === 'string') return p.content;
    return JSON.stringify(p ?? '');
  }

  // ── Shared helpers ───────────────────────────────────────────────────────

  async #copy(btn) {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy || '');
    } catch {
      return; // clipboard denied — leave the button as it was rather than lying
    }
    const icon = btn.querySelector('.id-chip__icon');
    if (!icon) return;
    icon.innerHTML = icons.check('', 14);
    setTimeout(() => { icon.innerHTML = icons.copy('', 14); }, 1500);
  }

  /**
   * Add a Show more/less toggle to every clamped block that actually
   * overflows — measured, so short messages get no stray control.
   */
  #applyClamps(root) {
    root.querySelectorAll('.msg-clamp').forEach((el) => {
      if (el.scrollHeight <= el.clientHeight + 4) return;
      el.classList.add('is-clamped');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msg-more';
      btn.textContent = 'Show more';
      btn.addEventListener('click', () => {
        const open = el.classList.toggle('is-expanded');
        btn.textContent = open ? 'Show less' : 'Show more';
      });
      el.after(btn);
    });
  }

  #spanIcon(node) {
    // ponytail: provider picks the LLM glyph, not a per-vendor mark — the icon
    // set carries no OpenAI/Anthropic logos and the name is on the row already.
    if (node.provider || node.model || node.name?.toLowerCase().includes('chatcompletion')) {
      return icons.cube('', 14);
    }
    if (node.name?.toLowerCase().startsWith('tool')) return icons.terminal('', 14);
    return icons.trace('', 14);
  }

  /** True when this span or anything beneath it failed. */
  #subtreeHasError(node) {
    if (this.#isError(node.status_code)) return true;
    return (node.children || []).some((c) => this.#subtreeHasError(c));
  }

  #isError(status) {
    return typeof status === 'string' && status.toUpperCase().includes('ERROR');
  }

  #fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} · ${d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  }

}

customElements.define('observability-session-page', ObservabilitySessionPage);
