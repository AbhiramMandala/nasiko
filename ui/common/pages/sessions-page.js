import styles from './sessions-page.css' with { type: 'css' };
import { icons } from '../utils/icons.js';
import { showToast } from '../utils/toast.js';
import { userMessage } from '../core/errors.js';
import '../design-system/app-button/app-button.js';
// Rendered by the failure and empty branches below. Only sessions.html linked
// it, so on the router path the element never upgraded and the empty state was
// a bare Retry button on an otherwise blank card.
import '../design-system/app-empty-state/app-empty-state.js';
import '../features/app-module-nav.js';
import { escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';
import { navigate as routerNavigate } from '../core/router.js';


document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/// Rows requested per page. `/api/chat/sessions` is keyset-paginated — it
/// previously asked for 50 sessions in one shot and had no way to reach the
/// 51st.
const PAGE_SIZE = 25;

class SessionsPage extends HTMLElement {
  #initialized = false;
  /// Every session loaded so far, across pages.
  #sessions = [];
  /// Opaque keyset cursor for the next page; null once the list is exhausted.
  #nextCursor = null;
  #loadingMore = false;
  #filter = '';
  /// null = not checked yet. Only resolved when the history comes back empty,
  /// since that is the only place it changes what we render.
  #hasAgents = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#render();
    this.#load();
  }

  #render() {
    this.innerHTML = `
      <app-module-nav module="observability"></app-module-nav>
      <div class="sessions-header">
        <div class="sessions-header-info">
          <h1 class="title-page">Execution history</h1>
          <p class="sessions-subtitle">Review all queries across agents. Select a session to open its trace details.</p>
        </div>
        <app-button variant="dark" size="sm" id="btn-new">New Chat</app-button>
      </div>
      <div class="sessions-search-wrap">
        <span class="sessions-search-icon">${icons.search('', 16)}</span>
        <input type="search" class="sessions-search" placeholder="Filter sessions..." aria-label="Filter sessions" />
      </div>
      <div class="session-list" id="session-list">
        ${this.#renderSkeletons()}
      </div>
      <div class="sessions-more" id="sessions-more" hidden>
        <app-button variant="secondary" size="sm" id="btn-more">Load more</app-button>
        <span class="sessions-count" id="sessions-count"></span>
      </div>
    `;

    this.querySelector('#btn-new')?.addEventListener('click', () => {
      // No agent preselected: the orchestrator routes each message, so name it
      // honestly instead of showing the placeholder agent header.
      routerNavigate('/chat?agent_name=Orchestrator');
    });

    this.querySelector('.sessions-search')?.addEventListener('input', (e) => {
      this.#filter = e.target.value;
      this.#applyFilter();
    });

    this.querySelector('#btn-more')?.addEventListener('click', () => this.#load({ more: true }));
  }

  #renderSkeletons() {
    const row = `<div class="session-row-skeleton">
      <div class="skeleton-info">
        <div class="skeleton-line skeleton-line--short"></div>
        <div class="skeleton-line skeleton-line--long"></div>
      </div>
      <div class="skeleton-line skeleton-line--time"></div>
    </div>`;
    return `<div class="sessions-table-skeleton">
      <div class="skeleton-line skeleton-line--head"></div>
      ${row.repeat(4)}
    </div>`;
  }

  /// Loads one page. `more: true` appends the next page instead of replacing.
  async #load({ more = false } = {}) {
    const list = this.querySelector('#session-list');
    const moreBtn = this.querySelector('#btn-more');
    if (more && (this.#loadingMore || !this.#nextCursor)) return;
    this.#loadingMore = more;
    if (more) moreBtn?.setAttribute('loading', '');

    try {
      // One request: `/chat/sessions` already returns trace_count, total_tokens
      // and latency_p50_ms per row (migration 041, SESSION_LIST_SELECT), so the
      // second observability/session/list call this used to fire was redundant —
      // and its result was never read. Referencing an undefined `res` below is
      // what turned an empty history into "Failed to load sessions".
      const res = await call('fetchSessions', '', PAGE_SIZE, more ? this.#nextCursor : null);
      const page = res?.data || [];
      this.#nextCursor = res?.next_cursor || null;

      this.#sessions = more ? [...this.#sessions, ...page] : page;
      // Chat routes every query to a deployed agent, so with an empty fleet the
      // "Start a Chat" CTA leads straight into a failure. Ask for one agent to
      // decide which CTA the empty state gets — its own try/catch, because a
      // fleet-count hiccup must not report the session list as broken.
      if (!more && !page.length && this.#hasAgents === null) {
        try {
          const agents = await call('fetchAgents', '', 1, 1);
          this.#hasAgents = (agents?.total ?? agents?.data?.length ?? 0) > 0;
        } catch {
          this.#hasAgents = true; // unknown — keep the normal CTA
        }
      }
      this.#applyFilter();
    } catch {
      // A failed "load more" must not discard the pages already on screen.
      if (more) {
        showToast('Could not load more sessions.');
        return;
      }
      list.innerHTML = `<app-empty-state
        title="Failed to load sessions"
        description="Something went wrong while loading your chat sessions."
        icon='${icons.xCircle()}'>
        <app-button variant="secondary" size="sm" id="btn-retry">Retry</app-button>
      </app-empty-state>`;
      this.querySelector('#btn-retry')?.addEventListener('click', () => {
        list.innerHTML = this.#renderSkeletons();
        this.#load();
      });
    } finally {
      this.#loadingMore = false;
      moreBtn?.removeAttribute('loading');
      this.#renderPager();
    }
  }

  /// The search box filters the pages already loaded — it is not a server-side
  /// query, so say so in the footer rather than implying the whole history was
  /// searched.
  #applyFilter() {
    const q = this.#filter.toLowerCase().trim();
    const visible = !q ? this.#sessions : this.#sessions.filter(s => {
      const agent = (s.agent_name || 'Orchestrator').toLowerCase();
      const msg = (s.last_message || '').toLowerCase();
      return agent.includes(q) || msg.includes(q);
    });
    this.#renderSessions(visible);
    this.#renderPager();
  }

  #renderPager() {
    const wrap = this.querySelector('#sessions-more');
    const count = this.querySelector('#sessions-count');
    if (!wrap || !count) return;

    const loaded = this.#sessions.length;
    if (!loaded) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    this.querySelector('#btn-more').hidden = !this.#nextCursor;
    count.textContent = this.#nextCursor
      ? `Showing ${loaded} sessions`
      : `Showing all ${loaded} session${loaded === 1 ? '' : 's'}`;
  }

  #renderSessions(sessions) {
    const list = this.querySelector('#session-list');
    if (!sessions.length) {
      if (this.#sessions.length > 0) {
        list.innerHTML = `<app-empty-state
          title="No matching sessions"
          description="Try a different search term."
          icon='${icons.search()}'>
        </app-empty-state>`;
      } else if (this.#hasAgents === false) {
        list.innerHTML = `<app-empty-state
          title="No agents to run yet"
          description="Chat routes every query to a deployed agent. Import one and its queries, traces and token counts show up here."
          icon='${icons.plus()}'>
          <app-button variant="dark" size="sm" id="btn-empty-import">Import agent</app-button>
        </app-empty-state>`;
        this.querySelector('#btn-empty-import')?.addEventListener('click',
          () => routerNavigate('/add-agent'));
      } else {
        list.innerHTML = `<app-empty-state
          title="No sessions yet"
          description="Ask the orchestrator a question and every query, trace and token count shows up here."
          icon='${icons.send()}'>
          <app-button variant="dark" size="sm" id="btn-empty-chat">Start a Chat</app-button>
        </app-empty-state>`;
        this.querySelector('#btn-empty-chat')?.addEventListener('click',
          () => routerNavigate('/chat?agent_name=Orchestrator'));
      }
      return;
    }

    const rows = sessions.map(s => this.#renderRow(s)).join('');
    list.innerHTML = `
      <table class="sessions-table">
        <thead>
          <tr>
            <th>Sessions</th>
            <th>Traces count</th>
            <th title="Platform-paid tokens. “—” means no usage was recorded for this session — an agent using its own API key, or messages from before usage tracking. Open the session's traces for the full picture.">Tokens (billed)</th>
            <th>Latency P50</th>
            <th>Date</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    list.querySelectorAll('.session-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sessionId = btn.dataset.sessionId;
        this.#deleteSession(sessionId);
      });
    });

    list.querySelectorAll('.session-traces').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        routerNavigate(`/observability-session?session_id=${encodeURIComponent(btn.dataset.sessionId)}`);
      });
    });

    list.querySelectorAll('tr[data-href]').forEach(row => {
      row.addEventListener('click', () => { routerNavigate(row.dataset.href); });
    });
  }

  #renderRow(s) {
    const agentName = s.agent_name || 'Orchestrator';
    const preview = s.last_message || '';
    const time = s.updated_at || s.created_at;
    const timeStr = time ? this.#formatDate(new Date(time)) : '—';
    const sessionId = s.session_id;
    const href = `/chat?session_id=${encodeURIComponent(sessionId)}&agent_id=${encodeURIComponent(s.agent_id || '')}&agent_name=${encodeURIComponent(agentName)}`;
    const msgCount = s.message_count ? `<span class="session-msg-count">${s.message_count} msgs</span>` : '';
    // `total_tokens` is null when no usage was recorded at all (a BYO-key agent,
    // or messages predating usage tracking) and reads as "—"; a recorded 0 is a
    // real value and must render as "0", hence the null check rather than a
    // truthiness test. Same for p50 — a sub-millisecond turn is not "no data".
    const traces = s.trace_count ?? '—';
    const tokens = s.total_tokens != null ? this.#fmtCount(s.total_tokens) : '—';
    const p50 = s.latency_p50_ms != null ? this.#fmtMs(s.latency_p50_ms) : '—';

    return `<tr data-href="${href}" tabindex="0">
      <td class="col-session">
        <div class="session-agent">${escHtml(agentName)}${msgCount}</div>
        ${preview ? `<div class="session-preview">${escHtml(preview.slice(0, 90))}</div>` : ''}
      </td>
      <td class="col-num">${traces}</td>
      <td class="col-num">${tokens}</td>
      <td class="col-num">${p50}</td>
      <td class="col-date">${timeStr}</td>
      <td class="col-actions">
        <button class="session-traces" type="button" data-session-id="${escHtml(sessionId)}"
          title="View traces" aria-label="View traces for this session"><span>Traces</span>${icons.chevronRight('', 14)}</button>
        <button class="session-delete" data-session-id="${escHtml(sessionId)}" title="Delete session" aria-label="Delete session">${icons.trash('', 14)}</button>
      </td>
    </tr>`;
  }

  #formatDate(date) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (date >= today) return `Today at ${timeStr}`;
    if (date >= yesterday) return `Yesterday at ${timeStr}`;
    const dateStr = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    return `${dateStr} at ${timeStr}`;
  }

  #fmtCount(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  #fmtMs(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  }

  async #deleteSession(sessionId) {
    let card = null;
    for (const btn of this.querySelectorAll('.session-delete')) {
      if (btn.dataset.sessionId === sessionId) {
        card = btn.closest('tr');
        break;
      }
    }
    if (card) card.style.opacity = '0.4';
    try {
      // No `if (window.deleteSession)` guard. That guard is why this button used
      // to lie: the function was defined only in sessions.preview.js, so in the
      // browser the branch was skipped, the row was removed locally, nothing was
      // sent, and the session came back on reload. If the data function is
      // missing we now fail — and the user sees why.
      await call('deleteSession', sessionId);
      this.#sessions = this.#sessions.filter(s => s.session_id !== sessionId);
      this.#applyFilter();
    } catch (err) {
      if (card) card.style.opacity = '1';
      console.error('[sessions-page] delete failed', err);
      showToast(userMessage(err, 'Could not delete that session.'));
    }
  }

}

customElements.define('sessions-page', SessionsPage);
