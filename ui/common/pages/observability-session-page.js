/**
 * Observability session detail — three panes: chat history, trace/span tree,
 * span detail (info/attributes with input/output messages).
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
import { renderMarkdown } from '/common/utils/markdown.js';
// Both were previously "imported" from inside the docblock above, i.e. never:
// <app-skeleton> and <app-empty-state> rendered as inert unknown elements.
import '/common/design-system/app-skeleton/app-skeleton.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-stat-row/app-stat-row.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-tabs/app-tabs.js';
import { escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';
import '/common/utils/back-link.js';


document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

class ObservabilitySessionPage extends HTMLElement {
  #initialized = false;
  #sessionId = '';
  #session = null;
  #spans = [];          // flattened {span, depth, traceId}
  #span = null;         // currently-selected span's detail payload
  #selected = null;     // {traceId, spanId}
  #tracesState = 'loading';  // loading | ready | empty | error
  #chatState = 'loading';    // loading | ready | empty
  #focusTraceId = '';        // ?trace_id= — preselect this trace's root span
  #pollTimer = null;
  #pollDeadline = 0;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    const params = new URLSearchParams(window.location.search);
    this.#sessionId = params.get('session_id') || '';
    this.#focusTraceId = params.get('trace_id') || '';

    this.innerHTML = `
      <div class="page-head">
        <app-button variant="tertiary" size="sm" icon-only href="/sessions" data-back
          aria-label="Back">${icons.arrowLeft()}</app-button>
        <h1 class="page-title">${escHtml(this.#sessionId)}</h1>
      </div>
      <app-stat-row id="kpi-strip" loading="5"></app-stat-row>
      <div class="panes">
        <section class="pane" id="chat-pane" aria-label="Chat history">
          <h2 class="pane-title">Chat History <button type="button" class="pane-collapse" id="chat-collapse" aria-label="Collapse chat history">${icons.chevronLeft('', 14)}</button></h2>
          <div class="pane-empty" aria-busy="true"><app-skeleton lines="4"></app-skeleton></div>
        </section>
        <section class="pane" id="traces-pane" aria-label="Traces">
          <h2 class="pane-title">Traces</h2>
          <div class="pane-empty" aria-busy="true"><app-skeleton lines="4"></app-skeleton></div>
        </section>
        <section class="pane" id="detail-pane" aria-label="Span detail">
          <div class="pane-empty">Select a span to see its details</div>
        </section>
      </div>
    `;

    this.querySelector('#chat-pane').addEventListener('click', (e) => {
      if (e.target.closest('.pane-collapse')) {
        this.querySelector('.panes').classList.toggle('chat-collapsed');
        return;
      }
      const copyBtn = e.target.closest('.md-code-copy');
      if (copyBtn) {
        const codeEl = copyBtn.closest('.md-code-block')?.querySelector('code');
        if (codeEl) {
          navigator.clipboard.writeText(codeEl.textContent).catch(() => {});
          copyBtn.innerHTML = icons.check('', 14);
          setTimeout(() => { copyBtn.innerHTML = icons.copy('', 14); }, 1500);
        }
      }
    });
    this.querySelector('#traces-pane').addEventListener('click', (e) => {
      const row = e.target.closest('.span-row');
      if (row) this.#selectSpan(row.dataset.traceId, row.dataset.spanId);
    });
    this.#load();
  }

  disconnectedCallback() {
    clearTimeout(this.#pollTimer);
  }

  async #load() {
    await Promise.all([this.#loadSession(), this.#loadChat()]);
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
    this.#renderKpis();
    await this.#loadTraces();
  }

  #renderKpis() {
    const s = this.#session;
    const strip = this.querySelector('#kpi-strip');
    // No session, no metrics. Leaving the skeleton up would claim the numbers
    // are still loading, and an emptied strip still paints its two hairlines —
    // so fold the whole thing away.
    if (!s) {
      strip.items = [];
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    strip.items = [
      { label: 'Traces count', value: s.num_traces ?? 0 },
      { label: 'Total tokens', value: (s.token_usage?.total ?? 0).toLocaleString() },
      { label: 'Total cost', value: `$ ${(s.cost_summary?.total?.cost ?? 0).toFixed(3)}` },
      { label: 'Latency P50', value: `${((s.latency_p50 ?? 0) / 1000).toFixed(1)} s` },
      { label: 'Latency P99', value: `${((s.latency_p99 ?? 0) / 1000).toFixed(1)} s` },
    ];
    // The chat pane loads in parallel and often wins the race, rendering its
    // chips before #session exists; refresh them once the totals are in.
    this.#renderChatMeta();
  }

  #renderChatMeta() {
    const meta = this.querySelector('.chat-meta');
    if (!meta) return;
    const s = this.#session;
    // `?? 0` used to render every absent metric as a confident 0 / $ 0.00 /
    // 0.0 s. When the trace backend is unconfigured or hasn't ingested the
    // session yet these are *unknown*, and asserting a zero cost is worse than
    // admitting we don't know — an em dash is the convention elsewhere.
    const num = (v, fmt) => (v == null ? '—' : fmt(v));
    meta.innerHTML = `
      <app-badge variant="neutral">${icons.layers('', 12)} ${num(s?.token_usage?.total, (v) => v.toLocaleString())}</app-badge>
      <app-badge variant="neutral">${num(s?.cost_summary?.total?.cost, (v) => `$ ${v.toFixed(2)}`)}</app-badge>
      <app-badge variant="neutral">${icons.clock('', 12)} ${num(s?.latency_p50, (v) => `${(v / 1000).toFixed(1)} s`)}</app-badge>
    `;
  }

  /** Expand each trace of the session into a flattened, indented span list. */
  async #loadTraces() {
    const traces = this.#session?.traces ?? [];
    const flat = [];
    for (const entry of traces) {
      const traceId = entry.trace_id;
      let detail;
      try {
        detail = await call('fetchObservabilityTrace', traceId);
      } catch (e) {
        console.warn(`Trace ${traceId} fetch failed:`, e);
        continue;
      }
      const roots = detail?.spans ?? [];
      const walk = (node, depth) => {
        flat.push({ node, depth, traceId });
        (node.children || []).forEach((c) => walk(c, depth + 1));
      };
      roots.forEach((r) => walk(r, 0));
    }
    this.#spans = flat;
    this.#renderTraces();
    if (!flat.length) return;
    // Keep whatever the reader picked; only auto-select when nothing is
    // selected yet or a poll dropped the selected span from the tree.
    const stillThere = this.#selected
      && flat.some((f) => f.traceId === this.#selected.traceId && f.node.span_id === this.#selected.spanId);
    if (stillThere) return;
    // ?trace_id= (from a chat's "Detailed trace") focuses that turn's trace.
    const focused = this.#focusTraceId
      && flat.find((f) => f.traceId === this.#focusTraceId);
    const pick = focused || flat[0];
    this.#selectSpan(pick.traceId, pick.node.span_id);
  }

  /**
   * Trace pane with nothing to show. The span-detail pane is meaningless
   * without a span to select, so `.traces-empty` folds it away and this one
   * empty state takes both columns — instead of two stub sentences sitting
   * in two tall blank panes.
   */
  #renderTracesPlaceholder(title, description, icon) {
    this.querySelector('#traces-pane').innerHTML = `
      <h2 class="pane-title">Traces</h2>
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
    panes.classList.toggle('chat-empty', this.#chatState === 'empty');
  }

  #renderTraces() {
    const pane = this.querySelector('#traces-pane');
    if (!this.#spans.length) {
      this.#tracesState = 'empty';
      this.#renderTracesPlaceholder(
        'No traces for this session',
        'Nothing was recorded here. Spans appear once an instrumented agent handles a request in this session.',
        icons.trace(),
      );
      return;
    }
    this.#tracesState = 'ready';
    this.#syncPanes();
    pane.innerHTML = `
      <h2 class="pane-title">Traces</h2>
      ${this.#spans.map(({ node, depth, traceId }) => `
        <button class="span-row" type="button"
          data-trace-id="${escHtml(traceId)}" data-span-id="${escHtml(node.span_id)}"
          style="margin-left:${depth * 16}px; width:calc(100% - ${depth * 16}px)">
          ${depth > 0 ? '<span class="span-tree" aria-hidden="true">└</span>' : ''}
          <span class="span-icon">${this.#spanIcon(node)}</span>
          <span class="span-name">${escHtml(node.name)}</span>
          <span class="status-dot${this.#isError(node.status_code) ? ' is-error' : ''}"></span>
          <app-badge variant="neutral">${icons.clock('', 12)} ${this.#fmtLatency(node.latency_ms)}</app-badge>
        </button>
      `).join('')}
    `;
    this.#markSelected();
  }

  #markSelected() {
    this.querySelectorAll('.span-row').forEach((row) => {
      row.classList.toggle('is-selected',
        row.dataset.spanId === this.#selected?.spanId && row.dataset.traceId === this.#selected?.traceId);
    });
  }

  async #selectSpan(traceId, spanId) {
    this.#selected = { traceId, spanId };
    this.#markSelected();
    const pane = this.querySelector('#detail-pane');
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

  #renderDetail() {
    const s = this.#span;
    const pane = this.querySelector('#detail-pane');
    if (!s) {
      pane.innerHTML = '<div class="pane-empty">Select a span to see its details</div>';
      return;
    }
    const tokens = s.token_count_total ?? 0;
    const cost = s.cost_summary?.total?.cost ?? 0;
    pane.innerHTML = `
      <div class="detail-head">
        <h3>${escHtml(s.name)}</h3>
        <app-badge variant="info">${escHtml(s.span_kind || 'internal')}</app-badge>
      </div>
      <div class="detail-chips">
        <app-badge variant="neutral">${icons.clock('', 12)} ${s.latency_ms != null ? `${Math.round(s.latency_ms)}ms` : '—'}</app-badge>
        <app-badge variant="neutral">${icons.layers('', 12)} ${tokens.toLocaleString()}</app-badge>
        <app-badge variant="neutral">${icons.code('', 12)} $${cost.toFixed(3)}</app-badge>
        <app-badge variant="neutral">${icons.calendar('', 12)} ${this.#fmtDate(s.start_time)}</app-badge>
      </div>
      <app-tabs>
        <div data-tab="info" data-label="Info">${this.#infoTabHtml()}</div>
        <div data-tab="attributes" data-label="Attributes">${this.#attributesTabHtml()}</div>
      </app-tabs>
    `;
    // Both panels are rendered up front — app-tabs owns the switch, so there is
    // no re-render to hang the clamp pass off. Only the visible panel gets a
    // toggle: #applyClamps measures, and a hidden panel measures as zero.
    this.#applyClamps(pane);
  }

  #infoTabHtml() {
    const s = this.#span;
    // tempo.rs builds a flat dotted-key attribute map, but the span-detail API
    // re-nests it before serializing (`unflatten_attrs` in
    // oss/server/src/observability/service.rs), so the wire shape is
    // `attributes.gen_ai.input.messages` — a flat `attrs['gen_ai.input.messages']`
    // lookup can never match. The server also resolves the raw content into
    // `input.value`/`output.value` (preferring the `input.value` attribute, then
    // `gen_ai.input.messages`), so that field is the primary source here.
    //
    // `gen_ai.input/output.messages` is what the official GenAI instrumentation
    // emits once OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental is set
    // (the injector always sets it — see oss/observability/src/injector.rs). Its
    // value is a JSON *string*, not an array, so it is passed as the `rawValue`
    // argument: that branch JSON.parses and understands the semconv `parts[]`
    // shape. `llm.*` is the older OpenInference convention, kept first for spans
    // recorded before the opt-in — a fallback chain rather than a version check,
    // matching how this repo handles A2A payload drift. `||` not `??`: the
    // server serializes "no content" as an empty string, which must fall through.
    const attrs = s.attributes ?? {};
    const inputMsgs = this.#extractMessages(
      attrs.llm?.input_messages,
      s.input?.value || attrs.gen_ai?.input?.messages || s.input_content,
    );
    const outputMsgs = this.#extractMessages(
      attrs.llm?.output_messages,
      s.output?.value || attrs.gen_ai?.output?.messages || s.output_content,
    );
    const section = (title, msgs, emptyText) => `
      <div class="detail-section-title">${title}</div>
      ${msgs.length
        ? msgs.map((m) => `
            <div class="msg-block">
              <div class="msg-role">${escHtml(m.role || '')}</div>
              <!-- Escaped, not markdown: span payloads are often raw JSON or
                   tool output, which a markdown pass would mangle. -->
              <div class="msg-content msg-clamp">${escHtml(m.content || '')}</div>
            </div>`).join('')
        : `<div class="pane-empty">${emptyText}</div>`}
    `;
    return `
      ${section('Input messages', inputMsgs, 'No input message available')}
      ${section('Output messages', outputMsgs, 'No output message available')}
    `;
  }

  #attributesTabHtml() {
    const attrs = this.#span?.attributes ?? {};
    return `<pre class="raw-json">${escHtml(JSON.stringify(attrs, null, 2))}</pre>`;
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

  #chatPaneTitle() {
    return `<h2 class="pane-title">Chat History <button type="button" class="pane-collapse" id="chat-collapse" aria-label="Collapse chat history">${icons.chevronLeft('', 14)}</button></h2>`;
  }

  async #loadChat() {
    const pane = this.querySelector('#chat-pane');
    let messages = [];
    try {
      const resp = await call('fetchChatSession', this.#sessionId);
      messages = resp?.data ?? [];
    } catch {
      // Observability sessions don't always map to a chat session.
    }
    if (!messages.length) {
      this.#chatState = 'empty';
      pane.innerHTML = `${this.#chatPaneTitle()}
        <app-empty-state title="No transcript"
          description="This session has no stored chat messages."
          icon='${icons.document()}'></app-empty-state>`;
      this.#syncPanes();
      return;
    }
    this.#chatState = 'ready';
    pane.innerHTML = `
      ${this.#chatPaneTitle()}
      <div class="chat-card">
        ${messages.map((m) => m.role === 'user'
          // User turns are literal input — escaped, never parsed as markdown.
          ? `<div class="msg-user"><div class="msg-clamp">${escHtml(m.content)}</div></div>`
          : `<div class="msg-assistant"><div class="msg-clamp md-body">${renderMarkdown(m.content ?? '')}</div></div>`).join('')}
        <div class="chat-meta"></div>
      </div>
    `;
    this.#renderChatMeta();
    this.#applyClamps(pane);
    this.#syncPanes();
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
    if (node.name?.toLowerCase().includes('chatcompletion') || node.model) return icons.cube('', 14);
    if (node.name?.toLowerCase().startsWith('tool')) return icons.terminal('', 14);
    return icons.trace('', 14);
  }

  #isError(status) {
    return typeof status === 'string' && status.toUpperCase().includes('ERROR');
  }

  #fmtLatency(ms) {
    if (ms == null) return '—';
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
  }

  #fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.toLocaleDateString('en-US')}, ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  }

}

customElements.define('observability-session-page', ObservabilitySessionPage);
