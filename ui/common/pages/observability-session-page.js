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
import '/common/design-system/app-menu/app-menu.js';
import '/common/features/app-module-nav.js';
import { escAttr, escHtml } from '/common/utils/escape.js';
import { renderMarkdown } from '/common/utils/markdown.js';
import { call } from '../core/data-sources.js';
import '/common/features/agent-steps.js';
import { errorStateHtml } from '/common/design-system/app-empty-state/error-state.js';


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
/// Sum two counts that may be absent. Null only when neither side was served:
/// a folded trace with no tokens must not erase the tokens already counted.
const addCounts = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

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
  /// One entry per turn, in order: {traceId, traceIds, question, answer, metrics}.
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
  /// Span ids whose children are folded away in the trace tree.
  #collapsed = new Set();
  #tracesState = 'loading';  // loading | ready | empty | error
  #focusTraceId = '';        // ?trace_id= — preselect this trace
  #pollTimer = null;
  #pollDeadline = 0;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.innerHTML = `
      <app-module-nav module="observability"></app-module-nav>
      <div class="page-head">
        <!-- A plain link, deliberately not a data-back popper: the module nav's
             session rows lead back here, so every switch is a history entry and
             popping one landed on the previous session. Back means the list. -->
        <app-button variant="tertiary" size="sm" icon-only href="/sessions"
          aria-label="Back">${icons.arrowLeft()}</app-button>
        <!-- Starts as the id and is replaced by the session's title once the
             payload lands (#renderTitle). Not a URL param: that would only
             work when arriving from the list, never on a deep link. -->
        <h1 class="page-title" id="page-title"></h1>
        <button type="button" class="id-chip" aria-label="Copy session ID">
          <span class="id-chip__text"></span>
          <span class="id-chip__icon">${icons.copy('', 14)}</span>
        </button>
      </div>
      <app-stat-row id="kpi-strip" variant="chips" loading="6"></app-stat-row>
      <section class="turn-strip" id="turn-strip" aria-label="Session turns"></section>
      <div class="panes">
        <section class="pane" id="traces-pane" aria-label="Traces"></section>
        <section class="pane" id="detail-pane" aria-label="Span detail"></section>
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

    // The module nav's session rows point at this same route, so the router
    // keeps the page mounted and only fires `route-update` — without this,
    // clicking a row moved the URL and left the old session on screen.
    this.addEventListener('route-update', this.#onRouteUpdate);
    this.addEventListener('stat-row-retry', this.#onStripRetry);

    this.#enter();
  }

  #onRouteUpdate = () => {
    const params = new URLSearchParams(window.location.search);
    if ((params.get('session_id') || '') === this.#sessionId
      && (params.get('trace_id') || '') === this.#focusTraceId) return;
    this.#enter();
  };

  /** Read the session out of the URL and build the page for it. Called on
   *  mount and on every route-update that names a different session. */
  #enter() {
    const params = new URLSearchParams(window.location.search);
    this.#sessionId = params.get('session_id') || '';
    this.#focusTraceId = params.get('trace_id') || '';

    // Every field below describes the session being left; carried over, the new
    // session renders under the old turn strip, spans and KPIs.
    clearTimeout(this.#pollTimer);
    this.#session = null;
    this.#turns = [];
    this.#turnIndex = 0;
    this.#renderedTurnKey = null;
    this.#messages = [];
    this.#spans = [];
    this.#span = null;
    this.#selected = null;
    this.#collapsed.clear();
    this.#tracesState = 'loading';

    this.querySelector('#page-title').textContent = this.#sessionId;
    const chip = this.querySelector('.page-head .id-chip');
    chip.dataset.copy = this.#sessionId;
    chip.querySelector('.id-chip__text').textContent = this.#sessionId;
    const kpis = this.querySelector('#kpi-strip');
    kpis.hidden = false;
    kpis.setAttribute('loading', '6');
    this.querySelector('#turn-strip').innerHTML =
      '<div class="pane-empty" aria-busy="true"><app-skeleton lines="3"></app-skeleton></div>';
    this.querySelector('#traces-pane').innerHTML =
      '<div class="pane-empty" aria-busy="true"><app-skeleton lines="4"></app-skeleton></div>';
    this.querySelector('#detail-pane').innerHTML =
      '<div class="pane-empty">Select a span to see its details</div>';

    this.#load();
  }

  /**
   * Retry on the KPI strip's failure state. Bound on the host and delegated,
   * because the strip rewrites its own contents on every render — the button
   * that fires this does not survive one.
   */
  #onStripRetry = () => {
    const kpis = this.querySelector('#kpi-strip');
    kpis.removeAttribute('error');
    kpis.setAttribute('loading', '6');
    this.#load();
  };

  disconnectedCallback() {
    this.removeEventListener('route-update', this.#onRouteUpdate);
    this.removeEventListener('stat-row-retry', this.#onStripRetry);
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
   * seconds later. Re-fetch for the full export window instead of treating a
   * temporarily stable span count as proof that the trace is complete.
   *
   * The transcript is re-read alongside the spans: turns are built from chat
   * messages, so an assistant row that lands late would otherwise never show.
   */
  #startPolling() {
    const INTERVAL_MS = 2000;
    const WINDOW_MS = 30_000;

    this.#pollDeadline = Date.now() + WINDOW_MS;

    const polling = this.#sessionId;
    const tick = async () => {
      if (Date.now() > this.#pollDeadline || this.#sessionId !== polling) return;
      await this.#loadChat();
      if (this.#sessionId !== polling) return;
      await this.#loadSession();
      if (this.#sessionId !== polling) return;
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
      // own root-span content is the fallback. Deliberately not cleared: the
      // poll re-reads this every 2s, and one failed read must not imply the
      // messages vanished. #enter() resets it when the session changes.
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
      );
      this.#renderKpis();
      // The turn strip's own skeleton is only ever cleared by `#renderTurn`,
      // which the success path below reaches and this one does not — so it
      // kept shimmering forever, leaving ~120px of dead animation between
      // the failed KPI strip and the Traces panel. There are no turns to
      // show and nothing still coming.
      this.querySelector('#turn-strip').innerHTML = '';
      return;
    }
    this.#session = resp?.data?.session ?? null;
    this.#renderTitle();
    this.#buildTurns();
    this.#renderKpis();
    this.#renderTurn();
    await this.#loadTurnTrace();
  }

  /// The session's own `title` is the chat title, which is auto-generated and
  /// is usually the literal "New chat" — so the first user message stands in,
  /// the same fallback the session list and the module nav apply. Sessions that
  /// never went through chat have neither, and keep the id the reader navigated
  /// with rather than a blank heading.
  #renderTitle() {
    const t = this.#session?.title;
    const title = (t && t !== 'New chat' ? t : this.#firstQuestion())
      || this.#session?.agent_name || '';
    const el = this.querySelector('#page-title');
    if (!title) return;
    el.textContent = title.replace(/\s+/g, ' ').trim().slice(0, 90);
    // The heading is clipped to one line, so the untruncated text has to be
    // reachable somewhere.
    el.title = title;
  }

  /// The transcript is loaded before the session (#load), so this is available
  /// on the first title render. Falls back to the first trace's root-span input
  /// for BYO-key agents, whose messages carry no trace id.
  #firstQuestion() {
    const msg = this.#messages.find((m) => m.role === 'user')?.content;
    return this.#plainText(msg || this.#session?.traces?.[0]?.root_span?.input?.value);
  }

  // ── KPI strip ────────────────────────────────────────────────────────────

  #renderKpis() {
    const s = this.#session;
    const strip = this.querySelector('#kpi-strip');
    // A failed session fetch and a session that simply has no metrics used to
    // fold the strip away identically. They are different answers: one says
    // there is nothing to count, the other that we could not count. The strip
    // fails as one block because one request filled all of it.
    if (!s && this.#tracesState === 'error') {
      strip.hidden = false;
      strip.removeAttribute('loading');
      strip.setAttribute('error', "Couldn't load these metrics");
      return;
    }
    strip.removeAttribute('error');
    // No session, no metrics. Leaving the skeleton up would claim the numbers
    // are still loading, so fold the whole thing away.
    if (!s) {
      strip.items = [];
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    const cost = s.cost_summary ?? {};
    // The server sets metrics_complete=false when the trace search was capped
    // or a trace failed to load. The totals are a lower bound then, and a
    // confident number is worse than an em dash — fmtInt/fmtUsd render null
    // as "—" already, so blanking the value is enough.
    const whole = (v) => (s.metrics_complete === false ? null : v);
    strip.items = [
      { label: 'Total tokens', value: fmtInt(whole(s.token_usage?.total)) },
      { label: 'Input tokens', value: fmtInt(whole(cost.prompt?.tokens)) },
      { label: 'Output tokens', value: fmtInt(whole(cost.completion?.tokens)) },
      { label: 'Cache tokens', value: fmtInt(whole(cacheTokens(s))) },
      { label: 'Total cost', value: fmtUsd(whole(cost.total?.cost)) },
      // P50 here and on the session list, so the same session reads the same
      // number on both screens. `latency_avg` is served alongside it.
      { label: 'Latency P50', value: fmtMs(s.latency_p50) },
    ];
  }

  // ── Turns ────────────────────────────────────────────────────────────────

  /**
   * One turn per trace, except traces with no message of their own, which fold
   * into the turn before them (HITL resumes and proxy-only hops).
   * `chat_messages.trace_id` is what ties a turn's text to its spans; the
   * pairing walks the transcript in order so a user row is matched with the
   * assistant row that answered it.
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

    this.#turns = [];
    for (const entry of traces) {
      const root = entry.root_span ?? {};
      const pair = byTrace.get(entry.trace_id);
      // `||` not `??`: the server serializes "no content" as an empty
      // string, which must fall through to the next source.
      const question = this.#plainText(pair?.user?.content || root.input?.value);
      const answer = this.#plainText(pair?.assistant?.content || root.output?.value);
      const prev = this.#turns[this.#turns.length - 1];
      // A trace carrying neither a question nor an answer is not a turn of its
      // own — it is the rest of the turn before it (a HITL resume, a
      // proxy-only hop). Fold it into that turn so the reader sees one chat
      // entry with both traces under its root, not an empty second entry.
      if (!question && !answer && prev) {
        prev.traceIds.push(entry.trace_id);
        prev.totalTokens = addCounts(prev.totalTokens, root.cumulative_token_count_total);
        prev.inputTokens = addCounts(prev.inputTokens, root.input_tokens);
        prev.outputTokens = addCounts(prev.outputTokens, root.output_tokens);
        prev.cacheTokens = addCounts(prev.cacheTokens, cacheTokens(root));
        prev.cost = addCounts(prev.cost, root.trace?.cost_summary?.total?.cost);
        // Max, not sum: the folded trace usually overlaps the one it belongs
        // to (same wall clock, different exporter), so summing double-counts.
        prev.durationMs = root.latency_ms == null ? prev.durationMs
          : Math.max(prev.durationMs ?? 0, root.latency_ms);
        continue;
      }
      this.#turns.push({
        traceId: entry.trace_id,
        /// Every trace shown under this turn, primary first.
        traceIds: [entry.trace_id],
        question,
        answer,
        startTime: root.start_time,
        // Coding-agent turns carry the steps they took on the message itself.
        toolCalls: pair?.assistant?.metadata?.coding_agent?.tool_calls ?? null,
        totalTokens: root.cumulative_token_count_total,
        // The trace's own counts first — they cover BYO-key agents too. The
        // chat message's usage is the fallback for turns whose spans carried
        // no token attributes.
        inputTokens: root.input_tokens ?? pair?.assistant?.input_tokens ?? null,
        outputTokens: root.output_tokens ?? pair?.assistant?.output_tokens ?? null,
        cacheTokens: cacheTokens(root),
        cost: root.trace?.cost_summary?.total?.cost ?? null,
        durationMs: root.latency_ms ?? pair?.assistant?.duration_ms ?? null,
      });
    }

    // ?trace_id= (from a chat's "Detailed trace") opens on that turn. Only on
    // the first build — a poll must not yank the reader back.
    if (this.#focusTraceId) {
      const i = this.#turns.findIndex((t) => t.traceIds.includes(this.#focusTraceId));
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
        ><button type="button" class="turn-count" title="Jump to a turn"
          ><span class="turn-count-current">${this.#turnIndex + 1}</span>/${total}</button></app-menu>
        <button type="button" class="turn-step" data-step="1"
          ${this.#turnIndex === total - 1 ? 'disabled' : ''} aria-label="Next turn"
        >${icons.chevronDown('', 14)}</button>
      </div>
      <div class="turn-body">
        <div class="turn-line">
          <span class="turn-glyph" aria-hidden="true">${icons.helpCircle('', 16)}</span>
          <!-- .turn-text is a column: #applyClamps inserts its "Show more"
               button as the clamped block's next sibling, and directly inside
               the row-flex .turn-line that puts it beside the text. -->
          <div class="turn-text">
            <!-- Literal user input: escaped, never parsed as markdown, and
                 pre-wrap so a pasted stack trace keeps its lines. Blank lines
                 are dropped *here only*: the preview is two lines tall, and a
                 question whose second line is the paragraph break spent one of
                 them on whitespace — a one-line question with a gap under it.
                 The detail pane below keeps the text as written. -->
            <div class="turn-question msg-clamp">${escHtml(
              (turn.question || 'No question recorded for this turn').replace(/\n\s*\n/g, '\n'))}</div>
          </div>
        </div>
        <div class="turn-line">
          <span class="turn-glyph" aria-hidden="true">${icons.message('', 16)}</span>
          <div class="turn-text">
            <!-- Agent replies are markdown, as they are in the chat transcript
                 this text comes from. Rendering the source verbatim put "##"
                 and "**" on screen and collapsed every newline into one
                 paragraph. -->
            ${Array.isArray(turn.toolCalls) ? '<agent-steps></agent-steps>' : ''}
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
    // Set after the markup lands: agent-steps takes the calls through a
    // method, not an attribute.
    strip.querySelector('agent-steps')?.loadToolCalls(turn.toolCalls);
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
    let details;
    try {
      details = await Promise.all(
        turn.traceIds.map((id) => call('fetchObservabilityTrace', id)));
    } catch (e) {
      console.warn(`Trace ${turn.traceIds.join(', ')} fetch failed:`, e);
      this.#tracesState = 'error';
      this.#renderTracesPlaceholder(
        'Traces unavailable',
        'The trace backend could not be reached for this turn.',
      );
      return;
    }
    // The turn is the root of its own tree. Tempo hands back whatever span
    // happened to start the trace (`a2a.dispatch`, `request`, …), which says
    // nothing about the chat message that caused it — so the query the reader
    // asked sits at the top and every span hangs beneath it, matching
    // `NAM → dept  session.run` in the design. A turn that folded in a
    // message-less trace roots that trace's spans here too.
    const roots = details.flatMap((detail, i) =>
      (detail?.spans ?? []).map((node) => ({ node, traceId: turn.traceIds[i] })));
    const turnRoot = {
      span_id: TURN_ROOT_ID,
      name: this.#sessionId,
      operation: 'session.run',
      // Wall-clock for the whole turn, not the sum of its parts: spans overlap.
      latency_ms: turn.durationMs ?? null,
      // One errored span anywhere under the turn makes the turn an error.
      status_code: roots.some((r) => this.#subtreeHasError(r.node)) ? 'ERROR' : 'OK',
      children: roots.map((r) => r.node),
    };

    const flat = [];
    const seen = new Set();
    const walk = (node, depth, traceId) => {
      const key = `${traceId}:${node.span_id}`;
      if (seen.has(key)) return;
      seen.add(key);
      flat.push({ node, depth, traceId });
      if (this.#collapsed.has(node.span_id)) return;
      (node.children || []).forEach((c) => walk(c, depth + 1, traceId));
    };
    flat.push({ node: turnRoot, depth: 0, traceId: turn.traceId });
    if (!this.#collapsed.has(TURN_ROOT_ID)) {
      roots.forEach(({ node, traceId }) => walk(node, 1, traceId));
    }
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
  /**
   * The trace pane's placeholder, for all three of its non-data states.
   *
   * Which one it is comes off `#tracesState`, which every caller has already
   * set on the line above — rather than from an icon each passes in. That is
   * what keeps the failure states drawing the shared failure look instead of
   * each picking a glyph: the two that set `error` used to hand over
   * `icons.xCircle()`, which reads as a plain absence, so "the backend could
   * not be reached" was dressed the same way as "nothing was recorded here".
   *
   * @param {string} heading
   * @param {string} description
   * @param {string} [icon] Markup for the glyph, for the non-error states
   *   only; `variant="error"` brings its own.
   */
  #renderTracesPlaceholder(heading, description, icon) {
    const failed = this.#tracesState === 'error';
    this.querySelector('#traces-pane').innerHTML = `
      ${this.#tracesTitle()}
      <app-empty-state ${failed ? 'variant="error"' : ''}
        heading="${escHtml(heading)}" description="${escHtml(description)}"
        ${failed ? '' : `icon='${icon || ''}'`}></app-empty-state>
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
        aria-label="Copy trace ID">
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
      // Was a bare line where the skeleton had been — true, but nothing
      // that looked like the rest of the product and no way to try again.
      pane.innerHTML = errorStateHtml("Couldn't load this span");
      pane.querySelector('[data-retry]')
        ?.addEventListener('click', () => this.#selectSpan(traceId, spanId));
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
      </div>
      ${provider || model ? `<div class="detail-origin">
        ${provider ? `<span><b>Provider:</b> ${escHtml(provider)}</span>` : ''}
        ${model ? `<span><b>Model:</b> ${escHtml(model)}</span>` : ''}
      </div>` : ''}
      <app-tabs label="Span sections">
        <div data-tab="input" data-label="Input">${this.#inputTabHtml()}</div>
        <div data-tab="usage" data-label="Usage">${this.#usageTabHtml()}</div>
        <div data-tab="events" data-label="Metadata &amp; events">${this.#eventsTabHtml()}</div>
        <div data-tab="raw" data-label="Raw attributes"><pre class="raw-json">${
          escHtml(JSON.stringify(attrs, null, 2))}</pre></div>
      </app-tabs>
      <app-tabs class="output-tabs" label="Span output">
        <div data-tab="output" data-label="${escHtml(this.#outputTitle())}">${this.#outputHtml()}</div>
      </app-tabs>
    `;
    // Every panel is rendered up front — app-tabs owns the switch, so there is
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
    const attrs = this.#span?.attributes ?? {};
    if (!this.#isToolSpan(attrs)) {
      return this.#msgBlocksHtml(this.#messagesFor('input'), 'No input message available');
    }
    const s = this.#span;
    return `
      <div class="detail-section-title">Tool execution</div>
      <div class="msg-block">
        <div class="msg-content">${escHtml([
          `Tool: ${attrs.tool?.name || 'unknown'}`,
          `Status: ${attrs.tool?.status || s.status_code || 'unknown'}`,
          `Duration: ${fmtMs(s.latency_ms)}`,
          attrs.tool?.call?.id ? `Call ID: ${attrs.tool.call.id}` : '',
        ].filter(Boolean).join('\n'))}</div>
      </div>
      <div class="detail-section-title">Arguments</div>
      ${this.#msgBlocksHtml(this.#messagesFor('input'), 'No arguments captured')}
    `;
  }

  /** Tool spans name their output by outcome; everything else is just "Output". */
  #outputTitle() {
    const attrs = this.#span?.attributes ?? {};
    if (!this.#isToolSpan(attrs)) return 'Output';
    return attrs.tool?.status === 'failed' ? 'Error' : 'Result';
  }

  #outputHtml() {
    return this.#msgBlocksHtml(this.#messagesFor('output'),
      this.#isToolSpan(this.#span?.attributes ?? {})
        ? 'No result captured'
        : 'No output message available');
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

  /**
   * Trace root input/output carry the raw agent payload, which for HITL turns
   * is a serialized GenAI message array rather than prose. Flatten it to the
   * text a reader expects; anything that isn't a message envelope (ordinary
   * chat content included) falls through unchanged.
   */
  #plainText(raw) {
    if (!raw) return '';
    const text = this.#extractMessages(null, raw)
      .map((m) => m.content).filter(Boolean).join('\n\n').trim();
    return text || String(raw);
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

  /** True for a GenAI tool-execution span, whichever convention recorded it. */
  #isToolSpan(attrs = {}) {
    return attrs.gen_ai?.operation?.name === 'execute_tool' || !!attrs.tool?.name;
  }

  #spanIcon(node) {
    // ponytail: provider picks the LLM glyph, not a per-vendor mark — the icon
    // set carries no OpenAI/Anthropic logos and the name is on the row already.
    if (node.provider || node.model || node.name?.toLowerCase().includes('chatcompletion')) {
      return icons.cube('', 14);
    }
    if (this.#isToolSpan(node.attributes) || node.name?.toLowerCase().startsWith('tool')) {
      return icons.terminal('', 14);
    }
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
