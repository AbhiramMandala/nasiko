/**
 * Execution history — every chat session across agents, with per-session trace,
 * token and latency counts (GET /api/chat/sessions).
 *
 * The list is an `<app-table>`: it owns the search box, the header, sorting and
 * the skeleton rows. Pagination is `none` because `/chat/sessions` is
 * keyset-paginated and reports no total, so there is no page count to number —
 * the "Load more" pager below the table walks the cursor instead, and the
 * table's search filters everything loaded so far.
 *
 * @element sessions-page
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./sessions-page.css', import.meta.url));
import { icons } from '../utils/icons.js';
import { showToast } from '../utils/toast.js';
import { userMessage } from '../core/errors.js';
import '../design-system/app-button/app-button.js';
// Rendered by the failure and empty branches below. Only sessions.html linked
// it, so on the router path the element never upgraded and the empty state was
// a bare Retry button on an otherwise blank card.
import '../design-system/app-empty-state/app-empty-state.js';
import '../design-system/app-table/app-table.js';
import '../features/app-module-nav.js';
import { escAttr, escHtml } from '/common/utils/escape.js';
import { call } from '../core/data-sources.js';
import { navigate as routerNavigate } from '../core/router.js';


document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/// Rows requested per page. `/api/chat/sessions` is keyset-paginated — it
/// previously asked for 50 sessions in one shot and had no way to reach the
/// 51st.
const PAGE_SIZE = 25;

const fmtCount = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

const fmtDate = (date) => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (date >= today) return `Today at ${timeStr}`;
  if (date >= yesterday) return `Yesterday at ${timeStr}`;
  const dateStr = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${dateStr} at ${timeStr}`;
};

class SessionsPage extends HTMLElement {
  #initialized = false;
  /// Every session loaded so far, across pages.
  #sessions = [];
  /// Opaque keyset cursor for the next page; null once the list is exhausted.
  #nextCursor = null;
  #loadingMore = false;
  /// null = not checked yet. Only resolved when the history comes back empty,
  /// since that is the only place it changes what we render.
  #hasAgents = null;
  /// Settles when the first page has landed. The table's data function awaits
  /// it, so app-table holds its skeleton rows until there is something to show
  /// instead of resolving instantly against an empty array and flashing its
  /// "nothing here" row before the first fetch returns.
  #ready = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#render();
    // Synchronous up to its first await, so #ready is assigned before the
    // table's own deferred first refresh runs.
    this.#load();
  }

  #render() {
    this.innerHTML = `
      <app-module-nav module="observability"></app-module-nav>
      <div class="sessions-header">
        <div class="sessions-header-info">
          <h1 class="title-page">Execution history</h1>
          <p class="sessions-subtitle">Review all queries across agents. Select a session to open its
            trace details.</p>
        </div>
        <app-button variant="dark" size="md" id="btn-new">New chat</app-button>
      </div>
      <div class="session-list" id="session-list"></div>
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

    this.querySelector('#btn-more')?.addEventListener('click', () => this.#load({ more: true }));

    // Delegated on the container, not the rows: app-table rebuilds its whole
    // tbody on every refresh and sort, so per-row listeners would be dropped.
    this.querySelector('#session-list').addEventListener('click', (e) => {
      const del = e.target.closest('.session-delete');
      if (del) {
        e.preventDefault();
        this.#deleteSession(del.dataset.sessionId);
        return;
      }
      const traces = e.target.closest('.session-traces');
      if (traces) {
        e.preventDefault();
        routerNavigate(`/observability-session?session_id=${encodeURIComponent(traces.dataset.sessionId)}`);
      }
    });

    this.#mountTable();
  }

  #mountTable() {
    const list = this.querySelector('#session-list');
    list.innerHTML = `<app-table id="sessions-table" search pagination="none"
      search-placeholder="Filter sessions..." limit="4"></app-table>`;
    const table = list.querySelector('#sessions-table');

    table.columns = [
      {
        key: 'session_id',
        label: 'Sessions',
        width: '27%',
        render: (_v, s) => {
          const agent = s.agent_name || 'Orchestrator';
          const href = `/chat?session_id=${encodeURIComponent(s.session_id)}`
            + `&agent_id=${encodeURIComponent(s.agent_id || '')}`
            + `&agent_name=${encodeURIComponent(agent)}`;
          const msgs = s.message_count
            ? `<span class="session-msg-count">${s.message_count} msgs</span>` : '';
          const preview = s.last_message
            ? `<span class="session-preview">${escHtml(s.last_message.slice(0, 90))}</span>` : '';
          return `<a class="session-link" href="${escAttr(href)}">
            <span class="session-agent">${escHtml(agent)}${msgs}</span>${preview}</a>`;
        },
      },
      // `trace_count`/`total_tokens`/`latency_p50_ms` are null when nothing was
      // recorded at all (a BYO-key agent, or messages predating usage tracking)
      // and read as "—"; a recorded 0 is a real value and must render as "0",
      // hence the null checks rather than truthiness tests.
      { key: 'trace_count', label: 'Traces', width: '11%', render: (v) => v ?? '—' },
      { key: 'total_tokens', label: 'Tokens', width: '11%', render: (v) => (v != null ? fmtCount(v) : '—') },
      { key: 'latency_p50_ms', label: 'Latency P50', width: '16%', render: (v) => (v != null ? fmtMs(v) : '—') },
      {
        key: 'updated_at',
        label: 'Date',
        width: '19%',
        render: (_v, s) => {
          const t = s.updated_at || s.created_at;
          return t ? fmtDate(new Date(t)) : '—';
        },
      },
      // Blank label: app-table reads that as a row-action column, so it gets no
      // sort control (there is nothing to order by) and stays pinned to the
      // right edge while the rest of the table scrolls.
      {
        key: 'session_id',
        label: '',
        width: '16%',
        render: (v) => `
          <button class="session-traces" type="button" data-session-id="${escAttr(v)}"
            title="View traces" aria-label="View traces for this session"
          ><span>Traces</span>${icons.chevronRight('', 14)}</button>
          <button class="session-delete" type="button" data-session-id="${escAttr(v)}"
            title="Delete session" aria-label="Delete session">${icons.trash('', 14)}</button>`,
      },
    ];

    // The search box is app-table's; it filters the pages already loaded — this
    // is not a server-side query, which is what the footer count says.
    table.dataFn = async (query) => {
      await this.#ready;
      return { data: this.#visible(query) };
    };
    return table;
  }

  #visible(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return this.#sessions;
    return this.#sessions.filter((s) => {
      const agent = (s.agent_name || 'Orchestrator').toLowerCase();
      return agent.includes(q) || (s.last_message || '').toLowerCase().includes(q);
    });
  }

  /// Loads one page. `more: true` appends the next page instead of replacing.
  async #load({ more = false } = {}) {
    const moreBtn = this.querySelector('#btn-more');
    if (more && (this.#loadingMore || !this.#nextCursor)) return;
    this.#loadingMore = more;
    if (more) moreBtn?.setAttribute('loading', '');

    // One request: `/chat/sessions` already returns trace_count, total_tokens
    // and latency_p50_ms per row (migration 041, SESSION_LIST_SELECT), so the
    // second observability/session/list call this used to fire was redundant —
    // and its result was never read.
    const req = call('fetchSessions', '', PAGE_SIZE, more ? this.#nextCursor : null);
    // Resolved, never rejected: the table only needs to know the first fetch is
    // over, and the failure branch below owns what the page shows.
    if (!more) this.#ready = req.then(() => {}, () => {});

    try {
      const res = await req;
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
      this.#syncList();
    } catch {
      // A failed "load more" must not discard the pages already on screen.
      if (more) {
        showToast('Could not load more sessions.');
        return;
      }
      this.#renderState(`<app-empty-state
        heading="Failed to load sessions"
        description="Something went wrong while loading your chat sessions."
        icon='${icons.xCircle()}'>
        <app-button variant="secondary" size="sm" id="btn-retry">Retry</app-button>
      </app-empty-state>`);
      this.querySelector('#btn-retry')?.addEventListener('click', () => {
        this.#mountTable();
        this.#load();
      });
    } finally {
      this.#loadingMore = false;
      moreBtn?.removeAttribute('loading');
      this.#renderPager();
    }
  }

  /// Table when there is anything to list, CTA empty state when there is not —
  /// app-table's own empty row is a sentence, and with no history at all the
  /// useful thing to show is a button.
  #syncList() {
    // Both empty states carry their own CTA, so the header button would be a duplicate.
    this.querySelector('#btn-new')?.toggleAttribute('hidden', !this.#sessions.length);
    if (this.#sessions.length) {
      const table = this.querySelector('#sessions-table');
      table ? table.refresh() : this.#mountTable();
    } else if (this.#hasAgents === false) {
      this.#renderState(`<app-empty-state
        heading="No agents to run yet"
        description="Chat routes every query to a deployed agent. Import one and its queries, traces and token counts show up here."
        icon='${icons.plus()}'>
        <app-button variant="dark" id="btn-empty-import">Import agent</app-button>
      </app-empty-state>`);
      this.querySelector('#btn-empty-import')?.addEventListener('click',
        () => routerNavigate('/add-agent'));
    } else {
      this.#renderState(`<app-empty-state
        heading="No sessions yet"
        description="Ask the orchestrator a question and every query, trace and token count shows up here."
        icon='${icons.send()}'>
        <app-button variant="dark" id="btn-empty-chat">Start a Chat</app-button>
      </app-empty-state>`);
      this.querySelector('#btn-empty-chat')?.addEventListener('click',
        () => routerNavigate('/chat?agent_name=Orchestrator'));
    }
    this.#renderPager();
  }

  /// Replaces the table with a standalone card (empty or failed). The table is
  /// remounted by #syncList / Retry when there is data again.
  #renderState(html) {
    this.querySelector('#session-list').innerHTML = html;
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

  async #deleteSession(sessionId) {
    const row = this.querySelector(`.session-delete[data-session-id="${CSS.escape(sessionId)}"]`)
      ?.closest('tr');
    if (row) row.style.opacity = '0.4';
    try {
      // No `if (window.deleteSession)` guard. That guard is why this button used
      // to lie: the function was defined only in sessions.preview.js, so in the
      // browser the branch was skipped, the row was removed locally, nothing was
      // sent, and the session came back on reload. If the data function is
      // missing we now fail — and the user sees why.
      await call('deleteSession', sessionId);
      this.#sessions = this.#sessions.filter((s) => s.session_id !== sessionId);
      this.#syncList();
    } catch (err) {
      if (row) row.style.opacity = '1';
      console.error('[sessions-page] delete failed', err);
      showToast(userMessage(err, 'Could not delete that session.'));
    }
  }

}

customElements.define('sessions-page', SessionsPage);
