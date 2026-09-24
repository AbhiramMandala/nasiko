/**
 * Session history — every chat session across agents, with per-session trace,
 * token and latency counts (GET /api/chat/sessions).
 *
 * The list is an `<app-table>`: it owns the header, sorting and the skeleton
 * rows. Pagination is `none` because `/chat/sessions` is keyset-paginated and
 * reports no total, so there is no page count to number — the "Load more" pager
 * below the table walks the cursor instead.
 *
 * Search and the time range live in this page's own toolbar rather than in
 * app-table's header, because the range is not a text filter and the two belong
 * in one row.
 *
 * @element sessions-page
 */
import { loadCss } from '/common/utils/css.js';
import { isChatSession } from '/common/services/sessions-service.js';
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
import '../design-system/app-search/app-search.js';
import '../design-system/app-menu/app-menu.js';
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

/// The row's display name. Titles are auto-generated and are often the literal
/// "New chat", which makes every row look the same — fall back to the last
/// message, exactly as the module-nav session rows do (ui/oss/navigation.js).
const sessionLabel = (s) =>
  ((s.title && s.title !== 'New chat' ? s.title : s.last_message) || 'New chat')
    .replace(/\s+/g, ' ').trim().slice(0, 90);

/// Resumes the session in chat. `agent_name` falls back to the orchestrator so
/// the chat header names the router rather than a blank agent.
const chatHref = (s) =>
  `/chat?session_id=${encodeURIComponent(s.session_id)}`
  + `&agent_id=${encodeURIComponent(s.agent_id || '')}`
  + `&agent_name=${encodeURIComponent(s.agent_name || 'Orchestrator')}`
  // A coding-agent session is a transcript of work done elsewhere; chat opens
  // it read-only rather than offering a prompt box that can't be answered.
  + (s.is_coding_agent ? '&read_only=1' : '');

/// Time-range presets, newest-first like the list itself. `ms: null` is "all
/// time" — no cutoff, and the pager behaves exactly as it did before ranges
/// existed.
const RANGES = [
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { id: '1h',  label: 'Last hour',       ms: 60 * 60_000 },
  { id: '6h',  label: 'Last 6 hours',    ms: 6 * 60 * 60_000 },
  { id: '24h', label: 'Last 24 hours',   ms: 24 * 60 * 60_000 },
  { id: '7d',  label: 'Last 7 days',     ms: 7 * 24 * 60 * 60_000 },
  { id: '30d', label: 'Last 30 days',    ms: 30 * 24 * 60 * 60_000 },
];
const DEFAULT_RANGE = '7d';

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
  /// Current time-range preset id; see RANGES.
  #range = DEFAULT_RANGE;
  /// Toolbar search text. The table's own search box is off — this page owns it.
  #query = '';

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
          <h1 class="title-page">Session history</h1>
          <p class="sessions-subtitle">Review all queries across agents. Select a session to open its
            trace details.</p>
        </div>
      </div>
      <div class="sessions-toolbar">
        <app-search id="sessions-search" size="sm" placeholder="Search sessions"
          aria-label="Search sessions"></app-search>
        <app-menu id="range-menu" align="end" label="Time range"
          items='${escAttr(JSON.stringify(RANGES.map(({ id, label }) => ({ id, label }))))}'
        ><app-button variant="tertiary" size="sm">
          <span class="range-label">${escHtml(this.#rangeLabel())}</span>${icons.chevronDownSmall('', 16)}
        </app-button></app-menu>
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

    this.querySelector('#sessions-search')?.addEventListener('input', (e) => {
      this.#query = e.target.value || '';
      this.querySelector('#sessions-table')?.refresh();
      this.#renderPager();
    });

    this.querySelector('#range-menu')?.addEventListener('menu-select', (e) => {
      this.#range = e.detail.id;
      // The trigger doubles as the filter's current value; relabel the span
      // rather than app-button's `label` setter, which would drop the chevron.
      this.querySelector('.range-label').textContent = this.#rangeLabel();
      this.#syncList();
    });

    // Delegated on the container, not the rows: app-table rebuilds its whole
    // tbody on every refresh and sort, so per-row listeners would be dropped.
    this.querySelector('#session-list').addEventListener('click', (e) => {
      const del = e.target.closest('.session-delete');
      if (del) {
        e.preventDefault();
        this.#deleteSession(del.dataset.sessionId);
        return;
      }
      // The chat CTA is an <app-button href>: the router's own anchor handler
      // navigates it, so this only has to keep the row handler below off it.
      if (e.target.closest('.session-open')) return;
      // Anywhere else in the row — the title link included — opens the traces.
      // The link carries the href so it stays a real, middle-clickable anchor.
      const link = e.target.closest('tr')?.querySelector('.session-link');
      if (link) {
        e.preventDefault();
        routerNavigate(link.getAttribute('href'));
      }
    });

    this.#mountTable();
  }

  #mountTable() {
    const list = this.querySelector('#session-list');
    list.innerHTML = `<app-table id="sessions-table" pagination="none" limit="4"></app-table>`;
    const table = list.querySelector('#sessions-table');

    table.columns = [
      {
        key: 'session_id',
        label: 'Sessions',
        width: '32%',
        render: (_v, s) => {
          const href = `/observability-session?session_id=${encodeURIComponent(s.session_id)}`;
          // The design's status dot is not drawn: nothing in the platform
          // records a session's running/success/error state, and there is no
          // plan to add one. Title only.
          return `<a class="session-link" href="${escAttr(href)}">
            <span class="session-title">${escHtml(sessionLabel(s))}</span></a>`;
        },
      },
      // `trace_count`/`total_tokens`/`latency_p50_ms` are null when nothing was
      // recorded at all (a BYO-key agent, or messages predating usage tracking)
      // and read as "—"; a recorded 0 is a real value and must render as "0",
      // hence the null checks rather than truthiness tests.
      { key: 'trace_count', label: 'Traces count', width: '11%', render: (v) => v ?? '—' },
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
        // A MAF run is listed here — its traces and spend are exactly what this
        // module is for, and the title still opens them. What it has no
        // business offering is "Open session": that leads to a chat transcript,
        // and a workflow run has none.
        render: (v, s) => `
          ${isChatSession(s) ? `<app-button class="session-open" variant="ghost" size="sm"
            href="${escAttr(chatHref(s))}"
            title="Open session" aria-label="Open this session's chat"
          >Open session${icons.chevronRight()}</app-button>` : ''}
          <app-button class="session-delete" variant="ghost-danger" size="sm" icon-only
            data-session-id="${escAttr(v)}"
            title="Delete session" aria-label="Delete session">${icons.trash()}</app-button>`,
      },
    ];

    // The search box is app-table's; it filters the pages already loaded — this
    // is not a server-side query, which is what the footer count says.
    table.dataFn = async (query) => {
      await this.#ready;
      return { data: this.#visible() };
    };
    return table;
  }

  #rangeLabel() {
    return (RANGES.find((r) => r.id === this.#range) || RANGES[0]).label;
  }

  /// Epoch ms before which a session is out of range, or null for all time.
  #cutoff() {
    const range = RANGES.find((r) => r.id === this.#range);
    return range?.ms ? Date.now() - range.ms : null;
  }

  static #stamp(s) {
    const t = Date.parse(s.updated_at || s.created_at || '');
    return Number.isNaN(t) ? null : t;
  }

  /// Rows in range, then matching the search box.
  ///
  /// The range filter is exact without a server-side param because
  /// `/chat/sessions` orders by `updated_at DESC`: every session newer than the
  /// cutoff sorts before every older one, so the in-range set is always a
  /// prefix of what has been loaded. #rangeExhausted below is the other half —
  /// it decides when the prefix is known to be complete.
  #inRange() {
    const cutoff = this.#cutoff();
    if (cutoff === null) return this.#sessions;
    return this.#sessions.filter((s) => {
      const t = SessionsPage.#stamp(s);
      // An undated row can't be placed on either side of the cutoff. Keep it:
      // hiding a session because its timestamp failed to parse is the worse
      // failure of the two.
      return t === null || t >= cutoff;
    });
  }

  /// True when every session inside the current range has been loaded — either
  /// the cursor ran out, or a loaded row already falls outside it and, by the
  /// DESC ordering, so does everything after it.
  #rangeExhausted() {
    if (!this.#nextCursor) return true;
    const cutoff = this.#cutoff();
    if (cutoff === null) return false;
    return this.#sessions.some((s) => {
      const t = SessionsPage.#stamp(s);
      return t !== null && t < cutoff;
    });
  }

  #visible() {
    const rows = this.#inRange();
    const q = this.#query.toLowerCase().trim();
    if (!q) return rows;
    return rows.filter((s) => {
      const agent = (s.agent_name || 'Orchestrator').toLowerCase();
      return sessionLabel(s).toLowerCase().includes(q)
        || agent.includes(q)
        || (s.last_message || '').toLowerCase().includes(q);
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
      // `variant="error"` rather than a hand-passed icon: this page already
      // told failure apart from empty, but it did so in its own dialect. The
      // variant is what makes it the same failure the rest of the product
      // draws, and it brings the icon, the tint and `role="alert"` along.
      this.#renderState(`<app-empty-state variant="error"
        heading="Failed to load sessions"
        description="Something went wrong while loading your chat sessions.">
        <app-button variant="tertiary" size="sm" id="btn-retry">Retry</app-button>
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
    if (this.#sessions.length && !this.#inRange().length && this.#rangeExhausted()) {
      // History exists, just none of it inside the selected window. No CTA:
      // "Start a Chat" would be answering a question nobody asked, and the
      // range control that fixes this is already in the toolbar above.
      this.#renderState(`<app-empty-state
        heading="No sessions in this range"
        description="Nothing ran in the ${escHtml(this.#rangeLabel().toLowerCase())}. Widen the time range to see older sessions."
        icon='${icons.clock()}'></app-empty-state>`);
    } else if (this.#sessions.length) {
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

    // Counted over what the table is actually showing, not over every page
    // fetched: with a range applied those two differ, and the footer that
    // says "all 25" under 4 visible rows is the one nobody believes again.
    const shown = this.#visible().length;
    if (!this.#sessions.length) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    // Nothing more to fetch, or the range is already fully covered — see
    // #rangeExhausted. Paging further could only return older, out-of-range rows.
    const exhausted = this.#rangeExhausted();
    this.querySelector('#btn-more').hidden = exhausted;
    count.textContent = exhausted
      ? `Showing all ${shown} session${shown === 1 ? '' : 's'}`
      : `Showing ${shown} sessions`;
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
