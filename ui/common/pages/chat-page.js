import { apiFetch } from '/common/services/api.js';
import { isAbort, userMessage } from '/common/core/errors.js';
import "../design-system/app-chatbox/app-chatbox.js";
import "../features/agent-steps.js";
import { icons } from '/common/utils/icons.js';
import { navigate as routerNavigate } from '/common/core/router.js';
// Both are rendered by the Sessions route's landing states below.
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import { renderMarkdown } from '/common/utils/markdown.js';
import { readA2aStream, frameRenderer, nearBottom } from '/common/utils/a2a-stream.js';
import { askedAt, decidedRows, pendingRows, reconnectAfterHitl } from '/common/services/hitl.js';
import '/common/features/hitl-card.js';
import { usageChipsHtml, usageFromMessage } from '/common/utils/usage-chips.js';
import { transcribeBlob } from '/common/utils/voice-utils.js';
import { call, registerAll } from '/common/core/data-sources.js';
import { isChatSession } from '/common/services/sessions-service.js';

const transcribeAudio = transcribeBlob;
registerAll({ transcribeAudio }, { replace: true });

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./chat-page.css', import.meta.url));
import { escHtml, escAttr } from '/common/utils/escape.js';
// The page mounts an <app-module-nav>, and page-layout.css reserves the desktop
// gutter it pins into. Nothing imported it, so under the client router the
// gutter was reserved and the nav never upgraded.
import '/common/features/app-module-nav.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/**
 * Turns still draining with nobody watching, keyed by the session they belong
 * to. Module level, because the whole point is that they outlive the element
 * that started them.
 *
 * Leaving a chat detaches its turn rather than cancelling it, so the reply is
 * still written when the agent finishes (NAS-690). That fixed the write and
 * not the read: come back to the session before the drain ends and `#enter()`
 * has already re-rendered and re-fetched a transcript that did not contain the
 * answer yet, and nothing told the live view when it landed. The user saw
 * their own question with no reply under it — indistinguishable, from the
 * outside, from the bug that was just fixed.
 *
 * `#detachTurn` files the turn here; the turn's own `finally` takes it out and
 * announces the write. A mounted page for that session hears it and re-reads
 * the transcript. That is also why this is a registry and not a single flag:
 * the same session can be left and re-entered while one turn drains, and two
 * different sessions can drain at once.
 *
 * @type {Map<string, Set<object>>}
 */
const draining = new Map();

/** Event a finished detached turn fires so a mounted view can catch up. */
const PERSISTED_EVENT = "session-message-persisted";

/** File a detached turn against its session. */
function markDraining(turn) {
  if (!turn?.sessionId || turn.done) return;
  if (!draining.has(turn.sessionId)) draining.set(turn.sessionId, new Set());
  draining.get(turn.sessionId).add(turn);
}

/**
 * Take a finished turn out, and — if it was draining unwatched — say so.
 *
 * The announcement comes AFTER the removal on purpose: the listener re-reads
 * the transcript and re-derives the composer from this map, so announcing
 * first would hand it a session that still looks busy and leave the composer
 * locked until the next navigation.
 */
function clearDraining(turn) {
  turn.done = true;
  const set = draining.get(turn.sessionId);
  if (!set?.delete(turn)) return;
  if (!set.size) draining.delete(turn.sessionId);
  document.dispatchEvent(new CustomEvent(PERSISTED_EVENT, {
    detail: { sessionId: turn.sessionId },
  }));
}

/** Is a turn for this session still draining with no view attached? */
function isDraining(sessionId) {
  return Boolean(sessionId) && draining.has(sessionId);
}

/**
 * The Sessions module's route (app.js registers it onto this same page): the
 * same transcript view, but its module nav lists every agent's chats rather
 * than only the ones the orchestrator routed, and it opens the newest one when
 * the url names no session.
 */
const SESSIONS_PATH = '/chats';

/** Transcript placeholder — one message-shaped block per turn, so the wait for
 *  a transcript looks like the transcript that is coming. */
const TRANSCRIPT_SKELETON = `
  <div class="msg-skel is-right"><div class="msg-skel-bubble" style="width:38%"></div></div>
  <div class="msg-skel"><div class="msg-skel-block" style="width:78%">
    <div class="msg-skel-line" style="width:96%"></div>
    <div class="msg-skel-line" style="width:88%"></div>
    <div class="msg-skel-line" style="width:61%"></div>
  </div></div>
  <div class="msg-skel is-right"><div class="msg-skel-bubble" style="width:24%"></div></div>
  <div class="msg-skel"><div class="msg-skel-block" style="width:70%">
    <div class="msg-skel-line" style="width:92%"></div>
    <div class="msg-skel-line" style="width:44%"></div>
  </div></div>`;

class ChatPage extends HTMLElement {
  #initialized = false;
  /** Which rail module owns this view: 'sessions' on SESSIONS_PATH, otherwise
   *  'agents' for a direct agent chat and 'orchestrator' for a routed one. */
  #navModule = 'orchestrator';
  #sessionId = null;
  #contextId = null;
  #agentId = null;
  #agentLabel = null;
  #readOnly = false;
  #lastUserContent = null;
  #sampleQueries = [];
  #sending = false;

  /** The waiting human-in-the-loop card, when this turn paused for a decision. */
  #hitlCard = null;

  /**
   * Serializes reconnects. Two decisions answered back to back each replay their
   * own resume, and both write into the same transcript — chained rather than
   * raced so they append in the order they were answered.
   */
  #resumeTail = Promise.resolve();
  /**
   * Rows already reconnected to. A resume is keyed by the hitl id, and that id's
   * continuation buffer is replayed in full to whoever attaches — so a second
   * reconnect for the same row cannot produce anything new, it just paints the
   * same reply into a second message row. Seen live: one answered decision
   * queued two `#resume` calls (the second fired the instant the first stream
   * closed, via the chain above) and the transcript showed the reply twice.
   */
  #resumed = new Set();

  /**
   * The turn this view currently owns, or null.
   *
   * Leaving the page *detaches* the turn instead of cancelling it. Cancelling
   * was the old behaviour and it lost the answer outright: a reply reaches the
   * transcript only once the stream completes — `#persistMessage` below for a
   * direct agent chat, `insert_assistant_message` inside the SSE generator
   * (a2a_dispatch.rs) for an orchestrator-routed one — and dropping the
   * connection drops that generator too, so the agent call was abandoned
   * mid-token and nothing was ever written. The user came back to their own
   * question and no reply, ever. Draining a turn nobody is watching costs one
   * idle fetch, and is what puts the reply there when they return.
   *
   * `detached` gates only the writes that would land somewhere wrong — a
   * re-rendered DOM, or the session the user moved on to — never the read loop.
   *
   * Detached turns are now tracked in `draining` above, which is what lets a
   * returning view know an answer is still coming and catch it when it lands.
   *
   * ponytail: still nothing CAPS how many drain at once; each ends when its own
   * agent does, so the bound remains how fast someone can hop sessions. The set
   * asked for is here now, but the cap it was meant to enable is deliberately
   * not: the only way to enforce one is to abandon a turn, and abandoning a
   * turn is exactly how NAS-690 lost replies in the first place. A cap that
   * re-introduces the bug this code exists to fix is worse than no cap. If the
   * concurrency ever actually bites, the answer is to refuse to START a turn
   * while too many drain — which is a product decision about telling the user
   * why, not a line of bookkeeping.
   */
  #turn = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.addEventListener("route-update", this.#onRouteUpdate);
    // On `document`, not on this element: the turn that fires it was detached
    // precisely because this element stopped owning it, and by then it holds
    // no reference to anything still in the tree.
    document.addEventListener(PERSISTED_EVENT, this.#onPersisted);
    this.#enter();
  }

  /**
   * Same route pattern, different query. The router keeps this element mounted
   * and tells it the URL moved (core/router.js) instead of remounting, and
   * nothing listened — so opening a second session from the module nav moved
   * the address bar and the highlighted row while the first transcript stayed
   * on screen. Re-enter from the new params, abandoning whatever the session we
   * are leaving still has in flight.
   */
  #onRouteUpdate = () => {
    const params = new URLSearchParams(location.search);
    if ((params.get("session_id") || null) === this.#sessionId
        && params.get("agent_id") === this.#agentId) return;
    this.#detachTurn();
    this.#sending = false;
    this.#lastUserContent = null;
    this.#enter();
  };

  /** Read the URL and build the page for it. Called on mount and on every
   *  route-update that names a different session or agent. */
  #enter() {
    const params = new URLSearchParams(location.search);
    this.#agentId = params.get("agent_id");
    this.#sessionId = params.get("session_id") || null;
    this.#contextId = params.get("context_id");

    // A session opened from the Sessions module belongs to that module however
    // it was routed — its list holds every agent's chats.
    const inSessions = location.pathname.replace(/\.html$/, '').replace(/\/+$/, '') === SESSIONS_PATH;
    // Every Sessions row names its agent, so the fallback only covers a
    // hand-typed url — and an unrouted session there is the orchestrator's.
    this.#agentLabel = params.get("agent_name") || (inSessions ? "Orchestrator" : "Agent");
    this.#navModule = inSessions ? "sessions" : (this.#agentId ? "agents" : "orchestrator");
    this.#readOnly = params.get("read_only") === "1";
    this.#hitlCard = null;

    if (this.#agentId) document.title = `Nasiko — Chat with ${this.#agentLabel}`;

    // Neither chat route is in the nav, so the rail has no way to work out which
    // module it belongs to — without this, opening a session leaves the rail
    // with nothing selected.
    document.querySelector("app-header")?.setAttribute("active-module", this.#navModule);

    // Landing on the Sessions route itself, before a session is chosen: the
    // newest chat opens in a moment. Deliberately NOT #render() — its welcome
    // state is an agent avatar, "Ask me anything" and a composer, which on this
    // route reads as the orchestrator page. This one reads sessions; starting a
    // new one is the orchestrator's job, and the empty state links there.
    if (inSessions && !this.#sessionId) {
      this.#renderSessionsLanding();
      this.#openFirstSession();
      return;
    }

    this.#render();
    this.#bindEvents();

    if (this.#sessionId) {
      // Re-entering a session whose turn is still draining: the composer stays
      // shut. `#onRouteUpdate` clears `#sending` on every navigation, which is
      // right for a session with nothing in flight and wrong for this one —
      // unlocked, it accepts a second message while the first is still
      // running, and both persist whenever they happen to finish, so a reload
      // shows them in completion order rather than the order they were sent.
      //
      // The trade, stated plainly: an agent that never answers now holds this
      // session's composer shut across navigations, where before you could get
      // it back by leaving and returning. That escape was the bug — it is what
      // let a second message into a session with a turn still running — and the
      // stream carries `timeout: 0` by design, so there is no deadline to lean
      // on. A reload clears it, since this map lives with the document.
      this.#sending = isDraining(this.#sessionId);
      const messagesEl = this.querySelector("#messages");
      messagesEl.innerHTML = TRANSCRIPT_SKELETON;
      this.#loadMessages(messagesEl);
    } else if (this.#agentId) {
      this.#loadSampleQueries();
    }
  }

  disconnectedCallback() {
    this.removeEventListener("route-update", this.#onRouteUpdate);
    document.removeEventListener(PERSISTED_EVENT, this.#onPersisted);
    this.#detachTurn();
  }

  /**
   * A turn that finished with nobody watching just wrote to this session.
   *
   * Re-reads the whole transcript rather than appending the new row, and that
   * is the deliberate choice here. Appending is one fetch cheaper and opens a
   * duplicate: `#loadMessages` may still be in flight from `#enter()`, and if
   * its response lands after an appended row and already contains that row —
   * which it will, once the write beats the read — the reply shows twice. The
   * alternative is threading message ids through the event and de-duplicating
   * against the DOM, which is real bookkeeping to avoid one request on a path
   * that fires at most once per abandoned turn.
   *
   * `#loadMessages` clears and rebuilds from the server, so running it twice
   * costs a fetch and converges. The bug being fixed here is a transcript that
   * disagrees with the server; re-reading the server is the fix that cannot
   * itself disagree.
   */
  #onPersisted = (e) => {
    if (!this.#sessionId || e.detail?.sessionId !== this.#sessionId) return;
    const messagesEl = this.querySelector("#messages");
    if (messagesEl) this.#loadMessages(messagesEl);
  };

  /** Let the in-flight turn run to completion and persist, but stop it writing
   *  into this element — about to be removed, or re-rendered for another
   *  session. See #turn. */
  #detachTurn() {
    if (this.#turn) {
      this.#turn.detached = true;
      // Only a turn that is still running: `#turn` keeps pointing at the last
      // one after it settles, so detaching on a navigation away from an idle
      // chat would file a finished turn that never gets taken out again — a
      // session permanently marked busy, with a locked composer to match.
      markDraining(this.#turn);
    }
    this.#turn = null;
  }

  /** The Sessions route's own view: its module nav (the session list) beside a
   *  transcript slot, and nothing that invites a new chat — see #enter. */
  #renderSessionsLanding() {
    this.innerHTML = `
      <app-module-nav module="sessions"></app-module-nav>
      <div class="messages" id="messages">${TRANSCRIPT_SKELETON}</div>`;
  }

  /** SESSIONS_PATH with no `session_id`: land on the newest chat — the same
   *  first row the module nav beside it renders, since both read the one
   *  `/chat/sessions` ordering. replaceState rather than a navigation: the
   *  session is which view of this page is open, not a step in history, and
   *  #enter() repaints it from there. */
  async #openFirstSession() {
    let first = null;
    let failed = false;
    try {
      // Over-fetch rather than limit=1: the nav beside this drops MAF runs
      // (isChatSession), so asking for a single row could hand back a session
      // that is not in the list this page has to agree with.
      const res = await call('fetchSessions', '', 25);
      first = (res?.data || []).find(isChatSession) || null;
    } catch { failed = true; }
    // Navigated away, or a row was clicked, while the list was in flight.
    if (!this.isConnected || this.#sessionId) return;
    if (!first?.session_id) { this.#renderSessionsEmpty(failed); return; }
    const params = new URLSearchParams({ session_id: first.session_id });
    if (first.agent_id) params.set('agent_id', first.agent_id);
    params.set('agent_name', first.agent_name || 'Orchestrator');
    if (first.is_coding_agent) params.set('read_only', '1');
    history.replaceState(null, '', `${SESSIONS_PATH}?${params}`);
    this.#enter();
  }

  /** Nothing to open. `failed` keeps the two apart: telling someone they have
   *  no sessions because a request wobbled is a lie, and the fix is a retry,
   *  not a new chat. */
  #renderSessionsEmpty(failed) {
    const messagesEl = this.querySelector('#messages');
    if (!messagesEl) return;
    messagesEl.innerHTML = `
      <div class="welcome-state">
        <app-empty-state ${failed ? 'variant="error"' : ''}
          heading="${failed ? 'Failed to load sessions' : 'No sessions yet'}"
          description="${failed
            ? 'Something went wrong while loading your chat sessions.'
            : 'Every chat, across every agent, is listed here. Pick an agent to start one.'}"
          ${failed ? '' : `icon='${icons.send()}'`}>
          <app-button variant="${failed ? 'tertiary' : 'dark'}" size="sm" id="btn-sessions-empty"
            >${failed ? 'Retry' : 'Start a chat'}</app-button>
        </app-empty-state>
      </div>`;
    this.querySelector('#btn-sessions-empty')?.addEventListener('click', () => {
      // The agent hub, not a blank orchestrator chat: a chat starts by choosing
      // who it is with, and that page is where every agent is listed.
      if (!failed) { routerNavigate('/agents'); return; }
      this.#renderSessionsLanding();
      this.#openFirstSession();
    });
  }

  #render() {
    const initial = this.#agentLabel.charAt(0).toUpperCase();
    const agentCardUrl = this.#agentId && !this.#readOnly ? `/agent-card?id=${encodeURIComponent(this.#agentId)}` : null;

    this.innerHTML = `
      ${this.#navModule === 'agents' ? '' : `<app-module-nav module="${this.#navModule}"></app-module-nav>`}
      <div class="chat-header">
        <div class="chat-header-avatar" aria-hidden="true">${initial}</div>
        <div class="chat-header-info">
          <span class="chat-agent-name">${escHtml(this.#agentLabel)}</span>
          <span class="chat-agent-status"><span class="status-dot${this.#readOnly ? ' is-recorded' : ''}"></span> ${this.#readOnly ? 'Recorded coding-agent session' : 'Running'}</span>
        </div>
        ${agentCardUrl ? `<a class="chat-header-link" href="${agentCardUrl}" title="View agent card">${icons.externalLink('', 16)}</a>` : ''}
      </div>
      <div class="messages" id="messages">
        ${this.#sessionId ? '' : this.#renderWelcome()}
      </div>
      ${this.#readOnly
        ? '<div class="readonly-notice">This is a recorded coding-agent conversation. Continue it in the original coding agent.</div>'
        : `<div class="input-area">
            <app-chatbox
              id="chat-input"
              placeholder="Type a message..."
              transcription-callback="transcribeAudio"
            ></app-chatbox>
          </div>`}
    `;
  }

  #renderWelcome(prompts) {
    const chips = (prompts || []).length
      ? prompts
      : ["Help me debug a failing deployment", "Explain how container networking works", "Generate a Dockerfile for my service"];
    return `
      <div class="welcome-state">
        <div class="welcome-avatar" aria-hidden="true">${this.#agentLabel.charAt(0).toUpperCase()}</div>
        <h2 class="welcome-title">${escHtml(this.#agentLabel)}</h2>
        <p class="welcome-subtitle">Ask me anything</p>
        <div class="welcome-prompts">
          ${chips.map(p => `<button type="button" class="welcome-chip">${escHtml(p)}</button>`).join('')}
        </div>
      </div>
    `;
  }

  async #loadSampleQueries() {
    try {
      const res = await apiFetch(`/agents/${encodeURIComponent(this.#agentId)}`);
      if (!res.ok) { console.warn('loadSampleQueries: fetch failed', res.status); return; }
      const body = await res.json();
      const agent = body.data || body;
      if (agent.display_name) {
        this.#agentLabel = agent.display_name;
      }
      const skills = agent.skills || [];
      const queries = skills
        .map(s => s.sample_query || (Array.isArray(s.examples) && s.examples[0]) || null)
        .filter(Boolean)
        .slice(0, 3);
      if (!queries.length) { console.warn('loadSampleQueries: no examples found in skills', skills); return; }
      this.#sampleQueries = queries;
      const welcome = this.querySelector('.welcome-state');
      if (!welcome) { console.warn('loadSampleQueries: .welcome-state not found in DOM'); return; }
      welcome.outerHTML = this.#renderWelcome(queries);
      this.#bindWelcomeChips();
    } catch (err) { console.warn('loadSampleQueries failed:', err); }
  }

  #bindWelcomeChips() {
    const chatInput = this.querySelector("#chat-input");
    for (const chip of this.querySelectorAll(".welcome-chip")) {
      chip.addEventListener("click", () => {
        // Through app-chatbox's own API, not its inner #textarea: the composer
        // rebuilds its markup on render, so a page that reaches inside is one
        // refactor away from silently doing nothing.
        chatInput.value = chip.textContent;
        chatInput.focus();
      });
    }
  }

  #bindEvents() {
    const messagesEl = this.querySelector("#messages");
    const chatInput = this.querySelector("#chat-input");

    // Welcome prompt chips
    this.#bindWelcomeChips();

    // Copy code blocks (delegated)
    messagesEl.addEventListener("click", (e) => {
      const copyBtn = e.target.closest(".md-code-copy");
      if (copyBtn) {
        const codeEl = copyBtn.closest(".md-code-block")?.querySelector("code");
        if (codeEl) {
          navigator.clipboard.writeText(codeEl.textContent).catch(() => {});
          copyBtn.innerHTML = icons.check('', 14);
          setTimeout(() => { copyBtn.innerHTML = icons.copy('', 14); }, 1500);
        }
        return;
      }

      // Message action: copy
      const msgCopyBtn = e.target.closest(".msg-action-copy");
      if (msgCopyBtn) {
        const row = msgCopyBtn.closest(".msg-row");
        const msgEl = row?.querySelector(".msg, .stream-content");
        if (msgEl) {
          navigator.clipboard.writeText(msgEl.textContent).catch(() => {});
          msgCopyBtn.innerHTML = icons.check('', 14);
          setTimeout(() => { msgCopyBtn.innerHTML = icons.copy('', 14); }, 1500);
        }
        return;
      }

      // Message action: retry
      const retryBtn = e.target.closest(".msg-action-retry");
      if (retryBtn && this.#lastUserContent) {
        this.#sendMessage(this.#lastUserContent);
      }
    });

    chatInput?.addEventListener("chatbox-submit", async (e) => {
      const content = e.detail.value;
      if (!content) {
        chatInput.setLoading(false);
        return;
      }
      this.#sendMessage(content);
    });

    // The card resolves the row itself; what the page owns is what happens
    // next. Cancelling triggers no resume at all — the request is withdrawn,
    // so there is nothing to reconnect to and the composer simply frees up.
    this.addEventListener("hitl-resolved", (e) => this.#resume(e.detail.id));
    this.addEventListener("hitl-canceled", () => this.#syncComposer());
  }

  async #sendMessage(content) {
    if (this.#sending || this.#readOnly) return;
    this.#sending = true;
    // Snapshot the session this turn belongs to: the reply is persisted after
    // the stream ends, and by then `this.#sessionId` may name whichever session
    // the user moved to — which is where the answer used to get filed.
    const turn = { sessionId: this.#sessionId, detached: false, done: false };
    this.#turn = turn;
    const messagesEl = this.querySelector("#messages");
    const chatInput = this.querySelector("#chat-input");

    // Remove welcome state if present
    const welcome = this.querySelector(".welcome-state");
    if (welcome) welcome.remove();

    this.#lastUserContent = content;
    this.#appendMsg(messagesEl, "user", content);
    chatInput.reset();
    chatInput.setLoading(true);

    // Immediate feedback: typing dots from the moment the prompt is sent —
    // session create + response headers can take seconds on slow agents.
    const pendingRow = document.createElement("div");
    pendingRow.className = "msg-row is-assistant";
    pendingRow.innerHTML = `<div class="typing-indicator" aria-label="Agent is responding"><span></span><span></span><span></span></div>`;
    messagesEl.appendChild(pendingRow);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    try {
      if (!this.#sessionId) {
        const res = await apiFetch("/chat/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `first_prompt` is what makes the server title this session with a
          // real LLM call instead of leaving it stuck on the "New chat"
          // fallback forever — same field orchestrator-page.js sends.
          body: JSON.stringify({ agent_id: this.#agentId, first_prompt: content.slice(0, 100) }),
        });
        if (!res.ok) throw new Error("Failed to create session");
        const body = await res.json();
        // POST /api/chat/sessions wraps the session in {data, status_code,
        // message}; tolerate a bare object for older servers.
        const session = body.data || body;
        this.#sessionId = session.session_id || session.id;
        if (!this.#sessionId) throw new Error("Session created without an id");
        turn.sessionId = this.#sessionId;
        // A first message in a brand-new chat can be navigated away from before
        // the session POST answers, and `#detachTurn` had nothing to file it
        // under — `turn.sessionId` was still null. Now that it has one, file it,
        // or the reply this turn is about to write would be exactly the case
        // this whole mechanism exists for and the one it misses.
        if (turn.detached) markDraining(turn);
        // The module nav lists chat sessions — tell it there is a new one, and
        // which one, so it can highlight the row for the chat on screen.
        document.dispatchEvent(new CustomEvent("session-created", {
          detail: { sessionId: this.#sessionId },
        }));
        const params = new URLSearchParams(location.search);
        const nameParam = params.get("agent_name")
          ? `&agent_name=${encodeURIComponent(params.get("agent_name"))}`
          : "";
        // location.pathname, not a literal `/chat`: this page also serves the
        // Sessions route, and hardcoding the other one moved the user out of
        // the module they started the chat in.
        history.replaceState(
          null,
          "",
          `${location.pathname}?agent_id=${this.#agentId}&session_id=${this.#sessionId}${nameParam}`,
        );
      }

      // Reuse the CP session id as the A2A contextId, the same convention the
      // CLI follows (see a2a_dispatch.rs "the CLI reuses its CP session id as
      // contextId"). A freshly minted random id here broke observability: the
      // server keys `session_traces` and the dispatch span's `session.id` on
      // contextId, so traces landed under a throwaway id while every link in
      // the UI (and this page's URL) carries `session_id` — the session detail
      // page then 404'd and showed no traces at all. It also cost multi-turn
      // continuity, since a reloaded session got a brand-new contextId.
      if (!this.#contextId) this.#contextId = this.#sessionId;

      this.#persistMessage(this.#sessionId, "user", content);

      const body = {
        jsonrpc: "2.0",
        id: crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2) + Date.now().toString(36),
        method: "message/stream",
        params: {
          message: {
            messageId: crypto.randomUUID
              ? crypto.randomUUID()
              : Math.random().toString(36).slice(2) + Date.now().toString(36),
            contextId: this.#contextId,
            agentId: this.#agentId || undefined,
            role: "ROLE_USER",
            parts: [{ text: content }],
          },
          metadata: {
            ...(this.#agentId && { agent_id: this.#agentId }),
            ...(this.#sessionId && { session_id: this.#sessionId }),
          },
        },
      };

      // `timeout: 0` disables the API funnel's default 30s deadline — this is a
      // long-lived stream, not a request/response. Deliberately unsignalled:
      // this fetch has to survive navigation so the turn finishes and persists
      // (see #turn).
      const res = await apiFetch("/orchestrator/a2a", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeout: 0,
      });
      if (!res.ok) {
        const errBody = await res.text();
        try {
          const j = JSON.parse(errBody);
          throw new Error(j.error?.message || errBody);
        } catch (parseErr) {
          if (parseErr.message !== errBody) throw parseErr;
          throw new Error(errBody);
        }
      }

      pendingRow.remove();
      const { text: reply, traceId, usage, aborted, paused, contentEl } = await this.#readA2aStream(res, messagesEl, turn);
      // Paused, not finished: there is no reply to store yet, and the resumed
      // one is persisted by #resume when it arrives.
      if (paused) return;
      // An aborted stream returns normally (it is a cancellation, not a
      // failure), so this guard is what stops a half-received reply from being
      // written to the server as if the agent had finished saying it.
      if (aborted) return;
      const persisted = await this.#persistMessage(turn.sessionId, "assistant", reply, { traceId, usage });
      // Surface any files this turn produced on the just-streamed message. The
      // server captures the agent's `/workspace` writes onto the message and
      // returns them here, session-scoped. Attach to this turn's own element so
      // an interleaved second message can't steal the chips.
      if (persisted?.file_parts?.length && contentEl?.isConnected) {
        contentEl.insertAdjacentHTML("beforeend", this.#filesHtml(persisted.file_parts));
      }
      if (!turn.detached) this.#updateRetryButtons(messagesEl);
    } catch (err) {
      pendingRow.remove();
      // A cancellation is us, not a failure — see orchestrator-page. Also don't
      // persist a partial reply: the stream was cut, not completed. A detached
      // turn has no one to tell either: its transcript is off screen.
      if (!isAbort(err) && !turn.detached) {
        this.#appendMsg(messagesEl, "assistant", `Error: ${userMessage(err)}`);
      }
      if (!turn.detached) this.#updateRetryButtons(messagesEl);
    } finally {
      // Takes the turn out of `draining` and, if it was in there, announces the
      // write so a view that came back to this session re-reads the transcript.
      // Unconditional: a turn that was never detached is not in the map, and
      // clearDraining says nothing for one it did not remove.
      clearDraining(turn);
      // Only the live turn owns the composer: a detached one finishing later
      // must not unlock a composer that belongs to whatever is on screen now.
      if (!turn.detached) {
        this.#sending = false;
        this.#syncComposer();
      }
    }
  }

  /**
   * Mount the waiting card at the end of `container`.
   *
   * `rows` is one stream frame, or every pending row for the session on load —
   * the card pages through them so only one decision is on screen at a time.
   */
  #mountHitl(container, rows, { track = true } = {}) {
    const list = Array.isArray(rows) ? rows : [rows];
    const card = document.createElement("hitl-card");
    // A direct-chat frame carries no `agent` field — there is exactly one agent
    // in the conversation and the page already knows its name (§11.2).
    card.actor = list[0]?.agent || this.#agentLabel;
    card.rows = list;
    container.appendChild(card);
    // Already-decided rows replayed from history are not `track`ed: the
    // composer follows the row still waiting, and a receipt is not one.
    if (track) this.#hitlCard = card;
    return card;
  }

  /**
   * Close the composer while the card is waiting, and say why.
   *
   * Every pause kind is answered in the card — buttons for an approval, the
   * card's own field for a question — so a live composer beside it would only
   * offer a way to start a second turn while the agent is still paused.
   */
  #syncComposer({ streaming = false } = {}) {
    const chatInput = this.querySelector("#chat-input");
    if (!chatInput) return;
    const card = this.#hitlCard;
    // A turn draining for this session counts as streaming even though this
    // view is not the one reading it — the agent is still answering, and the
    // composer means the same thing to the person looking at it either way.
    const busy = streaming || isDraining(this.#sessionId);
    chatInput.setAttribute("placeholder", card?.composerHint || "Type a message...");
    chatInput.setLoading(busy || Boolean(card?.blocksComposer));
  }

  /**
   * Attach to what the resume actually produced.
   *
   * Resolving only records the decision — delivery to the paused agent is
   * asynchronous and tied to no browser connection — so reconnecting is the
   * only way to see the resumed events, and it ends in either the reply or the
   * next pause in the chain. Reading it back through #readA2aStream is what
   * makes a chain of pauses work without any extra code: a resumed stream that
   * pauses again mounts the next card the same way the first one did.
   */
  #resume(id) {
    const messagesEl = this.querySelector("#messages");
    if (this.#resumed.has(id)) return;
    this.#resumed.add(id);
    this.#resumeTail = this.#resumeTail.then(async () => {
      const turn = { sessionId: this.#sessionId, detached: false, done: false };
      this.#turn = turn;
      this.#syncComposer({ streaming: true });
      try {
        const res = await reconnectAfterHitl(id);
        const { text, aborted, paused } = await this.#readA2aStream(res, messagesEl, turn);
        if (aborted || paused || !text) return;
        // No persist here: the resumed turn is the server's to record — the
        // HITL dispatcher writes the reply itself (`persist_resume_reply`,
        // oss/server/src/hitl/mod.rs). Writing it from here too stored every
        // resumed reply twice, so the transcript showed it twice on reload.
        // Unlike the normal send path, where the direct-agent branch of
        // a2a_dispatch persists nothing and this page owns the write.
        if (!turn.detached) this.#updateRetryButtons(messagesEl);
      } catch (err) {
        if (!isAbort(err) && !turn.detached) {
          this.#appendMsg(messagesEl, "assistant", `Error: ${userMessage(err)}`);
        }
      } finally {
        // Worth naming the difference from the send path above: this reply is
        // the SERVER's write (`persist_resume_reply`), not ours, so the refetch
        // this triggers races a write we do not control. If it arrives first
        // the transcript is simply unchanged — no worse than before this
        // existed, where nothing refetched at all — and the next navigation
        // still shows it. Announcing on our own completion is the closest
        // signal available without the server telling us.
        clearDraining(turn);
        if (!turn.detached) this.#syncComposer();
      }
    });
  }

  async #loadMessages(messagesEl) {
    try {
      const res = await apiFetch(`/chat/sessions/${this.#sessionId}/messages`);
      if (!res.ok) {
        // Blanking the pane rendered a failed history load as a brand-new
        // conversation — the user's own messages apparently gone. A 404 IS a
        // new conversation (the session has no messages yet); anything else
        // is us failing to read one that exists.
        if (res.status === 404) { messagesEl.innerHTML = ''; return; }
        this.#renderHistoryFailure(messagesEl);
        return;
      }
      const result = await res.json();
      const msgs = result.data || result;
      messagesEl.innerHTML = '';
      // Rows already decided are part of the conversation: a question someone
      // answered, and what they answered. Without them a reloaded session
      // showed the agent acting on an answer nobody can see — so they are
      // replayed in place, by when they were asked, between the messages.
      const replay = decidedRows(result.hitl);
      const flushHitl = (before) => {
        while (replay.length && (before === null || askedAt(replay[0]) <= before)) {
          const row = document.createElement('div');
          row.className = 'msg-row is-assistant';
          messagesEl.appendChild(row);
          this.#mountHitl(row, [replay.shift()], { track: false });
        }
      };
      if (Array.isArray(msgs) && msgs.length) {
        for (const m of msgs) {
          flushHitl(Date.parse(m.timestamp) || 0);
          try {
            this.#appendMsg(messagesEl, m.role, m.content, {
              usage: usageFromMessage(m),
              traceId: m.trace_id,
              metadata: m.metadata,
              files: m.file_parts,
            });
            if (m.role === 'user') this.#lastUserContent = m.content;
          } catch (error) {
            console.error('Failed to render stored chat message', m.id, error);
          }
        }
        this.#updateRetryButtons(messagesEl);
      }
      flushHitl(null);
      // A pause outlives the connection it arrived on, so the live SSE frame
      // alone would lose it on a reload. The session's own `hitl` array is the
      // surface that puts it back (§4.1).
      const waiting = pendingRows(result.hitl);
      if (waiting.length) {
        const row = document.createElement('div');
        row.className = 'msg-row is-assistant';
        messagesEl.appendChild(row);
        this.#mountHitl(row, waiting);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      // Same typing dots the send path shows, for a turn that is still running
      // somewhere else. Without them the transcript is the user's question and
      // nothing under it — which is the exact picture this bug was reported as,
      // and looks identical whether an answer is coming or was lost.
      if (isDraining(this.#sessionId)) this.#appendDrainingIndicator(messagesEl);
      this.#syncComposer();
    } catch (error) {
      console.error('Failed to load stored chat messages', error);
      this.#renderHistoryFailure(messagesEl);
    }
  }

  /**
   * A failed history read. Both callers used to render an absence — one a
   * bare line of text, the other a completely blank pane identical to a new
   * conversation, which is the worst of the two: it tells the user their
   * messages are gone.
   */
  #renderHistoryFailure(messagesEl) {
    messagesEl.innerHTML = `
      <div class="welcome-state">
        <app-empty-state variant="error"
          heading="Couldn't load this conversation"
          description="Your messages are still there — we just couldn't fetch them.">
          <app-button variant="tertiary" size="sm" id="btn-history-retry">Retry</app-button>
        </app-empty-state>
      </div>`;
    messagesEl.querySelector('#btn-history-retry')?.addEventListener('click', () => {
      messagesEl.innerHTML = '';
      this.#loadMessages(messagesEl);
    });
  }

  /** Typing dots for a turn draining out of sight. Same markup as the send
   *  path's, so the two states read identically to the user; removed by the
   *  next `#loadMessages`, which the turn's completion triggers. */
  #appendDrainingIndicator(messagesEl) {
    const row = document.createElement("div");
    row.className = "msg-row is-assistant";
    row.innerHTML = `<div class="typing-indicator" aria-label="Agent is responding"><span></span><span></span><span></span></div>`;
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  #appendMsg(messagesEl, role, content, { usage = null, traceId = null, metadata = null, files = null } = {}) {
    // Sessions are written by multiple clients: the web UI stores replies as
    // "assistant" while the CLI/TUI store them as "agent". Anything that is
    // not the user renders as an agent reply (markdown + assistant styling).
    const isUser = role === 'user';
    const roleClass = isUser ? 'is-user' : 'is-assistant';

    const row = document.createElement("div");
    row.className = `msg-row ${roleClass}`;

    const div = document.createElement("div");
    div.className = `msg ${roleClass}${isUser ? '' : ' md-body'}`;

    if (isUser) {
      div.textContent = content;
    } else {
      div.innerHTML = renderMarkdown(content);
    }

    const toolCalls = metadata?.coding_agent?.tool_calls;
    let steps = null;
    if (!isUser && Array.isArray(toolCalls)) {
      steps = document.createElement('agent-steps');
      row.appendChild(steps);
    }

    const filesHtml = this.#filesHtml(files);
    if (filesHtml) div.insertAdjacentHTML('beforeend', filesHtml);
    row.appendChild(div);

    // Message actions toolbar
    if (!isUser) {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      actions.innerHTML = `
        <button type="button" class="msg-action-copy" aria-label="Copy message" title="Copy">${icons.copy('', 14)}</button>
        ${usageChipsHtml(usage)}
        ${this.#traceLinkHtml(traceId)}
      `;
      row.appendChild(actions);
    }

    messagesEl.appendChild(row);
    // `agent-steps` initializes its internal list in connectedCallback, which
    // runs only after the detached message row is attached to the document.
    if (steps) steps.loadToolCalls(toolCalls);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  #updateRetryButtons(messagesEl) {
    // Remove existing retry buttons
    for (const btn of messagesEl.querySelectorAll(".msg-action-retry")) {
      btn.remove();
    }
    if (this.#readOnly) return;
    // Add retry only to the last assistant message
    const lastAssistant = messagesEl.querySelector(".msg-row.is-assistant:last-child .msg-actions");
    if (lastAssistant && this.#lastUserContent) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "msg-action-retry";
      retryBtn.setAttribute("aria-label", "Retry");
      retryBtn.title = "Retry";
      retryBtn.innerHTML = icons.refresh('', 14);
      lastAssistant.appendChild(retryBtn);
    }
  }

  async #readA2aStream(res, messagesEl, turn) {
    // Create unified streaming area
    const streamRow = document.createElement("div");
    streamRow.className = "msg-row is-assistant";
    const streamArea = document.createElement("div");
    streamArea.className = "assistant-stream";

    const stepsEl = document.createElement("agent-steps");

    const contentEl = document.createElement("div");
    contentEl.className = "stream-content md-body";

    const typingEl = document.createElement("div");
    typingEl.className = "typing-indicator";
    typingEl.setAttribute("aria-label", "Agent is responding");
    typingEl.innerHTML = "<span></span><span></span><span></span>";

    streamArea.appendChild(stepsEl);
    streamArea.appendChild(typingEl);
    streamArea.appendChild(contentEl);
    streamRow.appendChild(streamArea);
    messagesEl.appendChild(streamRow);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Follow the stream only while the user is at the bottom.
    const follow = () => {
      if (nearBottom(messagesEl)) messagesEl.scrollTop = messagesEl.scrollHeight;
    };

    const showContent = (html, { progress = false } = {}) => {
      typingEl.remove();
      contentEl.classList.add("is-visible");
      contentEl.classList.toggle("is-progress", progress);
      contentEl.innerHTML = html;
      follow();
    };

    const renderReply = frameRenderer((text) => {
      stepsEl.finish();
      showContent(renderMarkdown(text));
    });
    const out = await readA2aStream(res, {
      onReply: renderReply,
      // Working prose goes to the activity timeline, not into the message
      // body: it is the agent's tool activity, and rendering it there as a
      // growing blob only to overwrite it with the reply lost the sequence
      // and read as a flicker. `out.progressText` still backs the
      // no-reply fallback below.
      onActivity: (line) => {
        stepsEl.onActivity(line);
        follow();
      },
      onData: (d) => {
        stepsEl.onEvent(d);
        follow();
      },
      onError: (message) => {
        stepsEl.finish();
        showContent(`<span style="color:var(--color-error)">${escHtml(message)}</span>`);
      },
    });

    // Paused for a human. The stream closing with no reply is the expected
    // shape here, not a failure, so the turn's outcome is the card — and
    // nothing is written to the transcript as if the agent had answered.
    if (out.hitl) {
      stepsEl.awaitInput();
      typingEl.remove();
      // A pause belonging to a turn the user has navigated away from must not
      // mount here: #mountHitl sets #hitlCard, which would lock the composer of
      // whatever session is on screen now on someone else's decision. #loadMessages
      // replays it from `pendingRows` when they come back to that session.
      if (!turn?.detached) this.#mountHitl(streamArea, out.hitl);
      return { text: "", traceId: out.traceId, usage: out.usage, aborted: out.aborted, paused: true };
    }

    // Finalize
    stepsEl.finish();
    typingEl.remove();
    let fullText = out.text;
    if (out.failed && !fullText) {
      fullText = out.errorMessage;
      showContent(`<span style="color:var(--color-error)">${escHtml(fullText)}</span>`);
    } else if (!fullText) {
      showContent(renderMarkdown("No response"));
      fullText = "No response";
    } else {
      // The frame renderer may still have a queued paint; settle on the
      // final text synchronously so actions append below rendered content.
      showContent(renderMarkdown(fullText));
    }

    // Add actions to stream row
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.innerHTML = `
      <button type="button" class="msg-action-copy" aria-label="Copy message" title="Copy">${icons.copy('', 14)}</button>
      ${usageChipsHtml(out.usage)}
      ${this.#traceLinkHtml(out.traceId)}
    `;
    streamArea.appendChild(actions);

    // Hand back the content element for this turn so the caller can attach file
    // chips to *this* reply — not `:last-child`, which drifts to a newer row if
    // the user sends another message while the persist is still awaiting.
    return { text: fullText, traceId: out.traceId, usage: out.usage, aborted: out.aborted, contentEl };
  }

  // Opens the full Observability session view with this turn's trace
  // preselected — the same page the sessions table links to. It used to point
  // at session-trace.html, a flat span list with no span detail, no
  // attributes and no transcript; that page is now a redirect stub.
  #traceLinkHtml(traceId) {
    if (!traceId) return '';
    const q = new URLSearchParams({ trace_id: traceId });
    if (this.#sessionId) q.set('session_id', this.#sessionId);
    return `<a class="msg-action-trace" href="/observability-session?${q}"
      aria-label="View trace" title="View trace">${icons.trace('', 14)}<span>Detailed trace</span></a>`;
  }

  // Assistant rows carry their usage_meta + trace id so chips and the
  // "Detailed trace" link survive a history reload.
  // Returns the persisted message (with any `file_parts` the server captured
  // from the agent's `/workspace` this turn), or null on failure — persistence
  // stays best-effort, but the reply chips need the response.
  async #persistMessage(sessionId, role, content, { traceId = null, usage = null } = {}) {
    const body = { role, content };
    if (traceId || usage) {
      body.usage = {
        input_tokens: usage?.input_tokens ?? null,
        output_tokens: usage?.output_tokens ?? null,
        // Without these the reloaded chip would disagree with the one just shown live,
        // shrinking by whatever the provider cache served.
        cache_read_tokens: usage?.cache_read_tokens ?? null,
        cache_creation_tokens: usage?.cache_creation_tokens ?? null,
        model: usage?.model ?? null,
        duration_ms: usage?.duration_ms ?? null,
        cost_usd: usage?.cost_usd ?? null,
        estimated: usage?.estimated ?? null,
        trace_id: traceId,
      };
    }
    try {
      const res = await apiFetch(`/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const j = await res.json();
      return j.data || j;
    } catch {
      return null;
    }
  }

  // Files a turn produced, as real download links. Platform-driven: the server
  // captures the agent's `/workspace` writes onto the message and serves them,
  // session-scoped, from the fixed `/chat/files/{id}/download` route — so any
  // agent's files become downloadable with no Nasiko-awareness in the agent.
  #filesHtml(files) {
    if (!Array.isArray(files) || !files.length) return '';
    const rows = files
      .map(
        (f) => `
        <a class="chat-msg-file" href="/api/chat/files/${encodeURIComponent(f.id)}/download"
           download="${escAttr(f.name)}" title="Download ${escAttr(f.name)}">
          ${icons.arrowDown('', 14)}<span class="chat-msg-file-name">${escHtml(f.name)}</span>
          <span class="chat-msg-file-size">${this.#formatSize(f.size)}</span>
        </a>`,
      )
      .join('');
    return `<div class="chat-msg-files">${rows}</div>`;
  }

  #formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let n = bytes / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

}

customElements.define("chat-page", ChatPage);