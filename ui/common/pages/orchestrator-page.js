import { apiFetch } from '/common/services/api.js';
import { isAbort, userMessage } from '/common/core/errors.js';
import { icons } from '/common/utils/icons.js';
import { renderMarkdown } from '/common/utils/markdown.js';
import { readA2aStream, frameRenderer, nearBottom, scrollerFor, stickToBottom } from '/common/utils/a2a-stream.js';
import { reconnectAfterHitl } from '/common/services/hitl.js';
import '/common/features/hitl-card.js';
import { usageChipsHtml } from '/common/utils/usage-chips.js';
import { transcribeBlob } from '/common/utils/voice-utils.js';
import { registerAll } from '/common/core/data-sources.js';
import '/common/design-system/app-chatbox/app-chatbox.js';
import '/common/design-system/app-card/app-card.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-tag/app-tag.js';
import '/common/features/agent-steps.js';
// Both render branches below mount an <app-module-nav>, and page-layout.css holds
// the desktop gutter it pins into. Nothing imported it, so it never upgraded: an
// empty static block in the empty state, and no nav at all in the hero.
import '/common/features/app-module-nav.js';

const transcribeAudio = transcribeBlob;
registerAll({ transcribeAudio }, { replace: true });

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./orchestrator-page.css', import.meta.url));
import { escAttr, escHtml } from '/common/utils/escape.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

class OrchestratorPage extends HTMLElement {
  #initialized = false;
  #sessionId = null;

  /** The waiting human-in-the-loop card, when a delegated call paused. */
  #hitlCard = null;

  /** Serializes reconnects so two answered decisions append in order. */
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
   * Leaving the page *detaches* the turn instead of cancelling it. Aborting was
   * the old behaviour, and here it lost the answer outright: this page never
   * persists a reply itself — `insert_assistant_message` (a2a_dispatch.rs) does,
   * from inside the SSE generator — and dropping the connection drops that
   * generator, so the orchestrator turn was abandoned mid-token and no reply was
   * ever recorded. Draining a turn nobody is watching costs one idle fetch and
   * is what puts the reply in the session when the user comes back to it.
   *
   * `detached` gates only the writes that would land in a dead view, never the
   * read loop.
   */
  #turn = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <app-module-nav module="orchestrator"></app-module-nav>
      <div class="hero-icon" aria-hidden="true">${icons.route('', 24)}</div>
      <h1 class="title">Orchestrate a task</h1>
      <p class="subtitle">Describe a task and Nasiko will orchestrate the right agents to execute it</p>
      <div class="recent-agents" id="recent-agents">
        <div class="recent-agents-grid" id="recent-agents-grid">
          <app-card loading></app-card>
          <app-card loading></app-card>
          <app-card loading></app-card>
        </div>
      </div>
      <div class="messages" id="messages"></div>
      <div class="input-wrap">
        <app-chatbox
          id="chatbox"
          placeholder="Describe the task you want to execute"
          transcription-callback="transcribeAudio"
        ></app-chatbox>
      </div>
      <div class="wf-banner">
        <span class="wf-banner-icon" aria-hidden="true">${icons.workflow('', 20)}</span>
        <span class="wf-banner-text">
          <span class="wf-banner-title">Need multiple coordinated steps or agents?</span>
          <span class="wf-banner-sub">Create a workflow to structure complex tasks and reusable operations.</span>
        </span>
        <app-button variant="secondary" size="sm" href="/workflow-new">Create workflow</app-button>
      </div>
    `;

    this.#loadRecentAgents();

    const chatbox = this.querySelector('#chatbox');
    const messagesEl = this.querySelector('#messages');

    // Copy code blocks (delegated on messages container)
    messagesEl.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.md-code-copy');
      if (copyBtn) {
        const codeEl = copyBtn.closest('.md-code-block')?.querySelector('code');
        if (codeEl) {
          navigator.clipboard.writeText(codeEl.textContent).catch(() => {});
          copyBtn.innerHTML = icons.check('', 14);
          setTimeout(() => { copyBtn.innerHTML = icons.copy('', 14); }, 1500);
        }
        return;
      }

      const msgCopyBtn = e.target.closest('.msg-action-copy');
      if (msgCopyBtn) {
        const row = msgCopyBtn.closest('.msg-row');
        const msgEl = row?.querySelector('.msg, .stream-content');
        if (msgEl) {
          navigator.clipboard.writeText(msgEl.textContent).catch(() => {});
          msgCopyBtn.innerHTML = icons.check('', 14);
          setTimeout(() => { msgCopyBtn.innerHTML = icons.copy('', 14); }, 1500);
        }
      }
    });

    // The card resolves its own row; the page owns what happens next. A
    // withdrawn request triggers no resume, so there is nothing to reconnect to.
    this.addEventListener('hitl-resolved', (e) => this.#resume(e.detail.id));
    this.addEventListener('hitl-canceled', () => this.#syncComposer());

    chatbox.addEventListener('chatbox-submit', async (e) => {
      const { value: content, files } = e.detail;
      if (!content && files.length === 0) return;

      chatbox.reset();
      chatbox.setLoading(true);
      this.classList.add('has-response');

      const turn = { detached: false };
      this.#turn = turn;

      // Append user message
      this.#appendMsg(messagesEl, 'user', content);

      // Typing indicator
      const pendingRow = document.createElement('div');
      pendingRow.className = 'msg-row is-assistant';
      pendingRow.innerHTML = `<div class="typing-indicator" aria-label="Agent is responding"><span></span><span></span><span></span></div>`;
      messagesEl.appendChild(pendingRow);
      stickToBottom(messagesEl);

      try {
        // Create session on first message, reuse for subsequent ones
        if (!this.#sessionId) {
          const sessionRes = await apiFetch('/chat/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ first_prompt: content.slice(0, 100) }),
          });
          if (!sessionRes.ok) throw new Error('Failed to create session');
          const sessionBody = await sessionRes.json();
          const session = sessionBody.data || sessionBody;
          this.#sessionId = session.session_id || session.id;
          // The module nav lists chat sessions — tell it there is a new one, and
          // which one, so it can highlight the row for the chat on screen.
          document.dispatchEvent(new CustomEvent('session-created', {
            detail: { sessionId: this.#sessionId },
          }));
        }

        // Persist user message
        if (this.#sessionId) {
          apiFetch(`/chat/sessions/${this.#sessionId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'user', content }),
          }).catch(() => {});
        }

        const body = {
          jsonrpc: '2.0',
          id: (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)),
          method: 'message/stream',
          params: {
            message: {
              messageId: (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)),
              role: 'ROLE_USER',
              parts: [{ text: content }],
              contextId: this.#sessionId || undefined,
            },
            metadata: this.#sessionId ? { session_id: this.#sessionId } : undefined,
          },
        };

        // `timeout: 0` disables the API funnel's default 30s deadline — this is
        // a long-lived stream, not a request/response. Deliberately unsignalled:
        // the fetch has to survive navigation so the server-side turn runs to
        // its own persist (see #turn).
        const res = await apiFetch('/orchestrator/a2a', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeout: 0,
        });
        if (!res.ok) throw new Error(await res.text());

        pendingRow.remove();
        await this.#readStream(res, messagesEl, turn);
        // Assistant reply is persisted server-side by the orchestrator dispatch
        // (insert_assistant_message in a2a_dispatch.rs) — no client-side write
        // needed, unlike the agent chat page whose direct-agent path does not.
      } catch (err) {
        pendingRow.remove();
        // A cancellation is us, not a failure: the element is being removed, so
        // there is nobody to tell. Same for a detached turn — its view is gone.
        if (!isAbort(err) && !turn.detached) {
          this.#appendMsg(messagesEl, 'assistant', `Error: ${userMessage(err)}`);
        }
      } finally {
        if (!turn.detached) this.#syncComposer();
      }
    });
  }

  /**
   * Mount the waiting card at the end of `container`.
   *
   * Unlike direct chat, an orchestrator frame names the sub-agent that is
   * asking — the orchestrator can delegate to several agents in one turn, so
   * "who wants this" is real information here (§13.3).
   */
  #mountHitl(container, rows) {
    const list = Array.isArray(rows) ? rows : [rows];
    const card = document.createElement('hitl-card');
    card.actor = list[0]?.agent || 'Orchestrator';
    card.rows = list;
    container.appendChild(card);
    this.#hitlCard = card;
    return card;
  }

  /**
   * Close the composer while the card is waiting, and say why — every pause
   * kind is answered in the card, so typing here could only start a new turn.
   */
  #syncComposer({ streaming = false } = {}) {
    const chatbox = this.querySelector('#chatbox');
    if (!chatbox) return;
    const card = this.#hitlCard;
    chatbox.setAttribute('placeholder', card?.composerHint || 'Describe the task you want to execute');
    chatbox.setLoading(streaming || Boolean(card?.blocksComposer));
  }

  /**
   * Attach to what the resume actually produced.
   *
   * For an orchestrator pause this is worth more than it is anywhere else: the
   * sub-agent's resume feeds the orchestrator's own reasoning loop back into
   * the turn, and reconnecting streams those real events — every tool call and
   * incremental reply — rather than a summary. It ends in either the final
   * answer or the next pause in the chain, which mounts its own card the same
   * way the first one did.
   */
  #resume(id) {
    const messagesEl = this.querySelector('#messages');
    if (this.#resumed.has(id)) return;
    this.#resumed.add(id);
    this.#resumeTail = this.#resumeTail.then(async () => {
      const turn = { detached: false };
      this.#turn = turn;
      this.#syncComposer({ streaming: true });
      try {
        const res = await reconnectAfterHitl(id);
        await this.#readStream(res, messagesEl, turn);
      } catch (err) {
        if (!isAbort(err) && !turn.detached) {
          this.#appendMsg(messagesEl, 'assistant', `Error: ${userMessage(err)}`);
        }
      } finally {
        if (!turn.detached) this.#syncComposer();
      }
    });
  }

  disconnectedCallback() {
    this.#detachTurn();
  }

  /** Let the in-flight turn run to completion and persist server-side, but stop
   *  it writing into this element, which is being removed. See #turn. */
  #detachTurn() {
    if (this.#turn) this.#turn.detached = true;
    this.#turn = null;
  }

  #appendMsg(messagesEl, role, content, { usage = null, traceId = null } = {}) {
    const isUser = role === 'user';
    const roleClass = isUser ? 'is-user' : 'is-assistant';

    const row = document.createElement('div');
    row.className = `msg-row ${roleClass}`;

    const div = document.createElement('div');
    div.className = `msg ${roleClass}${isUser ? '' : ' md-body'}`;

    if (isUser) {
      div.textContent = content;
    } else {
      div.innerHTML = renderMarkdown(content);
    }

    row.appendChild(div);

    if (!isUser) {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML = `
        <button type="button" class="msg-action-copy" aria-label="Copy message" title="Copy">${icons.copy('', 14)}</button>
        ${usageChipsHtml(usage)}
        ${this.#traceLinkHtml(traceId)}
      `;
      row.appendChild(actions);
    }

    messagesEl.appendChild(row);
    stickToBottom(messagesEl);
  }

  #traceLinkHtml(traceId) {
    if (!traceId) return '';
    const q = new URLSearchParams({ trace_id: traceId });
    if (this.#sessionId) q.set('session_id', this.#sessionId);
    return `<a class="msg-action-trace" href="/observability-session?${q}"
      aria-label="View trace" title="View trace">${icons.trace('', 14)}<span>Detailed trace</span></a>`;
  }

  async #loadRecentAgents() {
    const grid = this.querySelector('#recent-agents-grid');
    try {
      const res = await apiFetch('/agents?status=running&limit=6');
      if (!res.ok) throw new Error('Failed to fetch');
      const body = await res.json();
      const agents = Array.isArray(body) ? body : (body.data || []);

      if (!agents.length) {
        // ponytail: nothing to route to, so the composer is dead UI — swap the
        // whole page for the deploy CTA instead of a prompt box that can only fail.
        // Same shape as the workflows empty state (tile → title → sub → pills → CTA),
        // reusing this page's own hero/title/subtitle rules for the top three.
        this.classList.add('is-empty');
        this.innerHTML = `
          <app-module-nav module="orchestrator"></app-module-nav>
          <div class="empty-wrap">
            <app-empty-state
              heading="No agents available"
              description="Your orchestrator is ready, but there aren't any agents to run yet. Create a new agent or deploy one from the Artifact Registry to start building workflows."
              icon='${icons.layers('', 40)}'>
              <div class="empty-pills">
                <app-tag size="sm">${icons.layers('', 12)} Pick an agent</app-tag>
                ${icons.chevronRight('empty-arrow', 12)}
                <app-tag size="sm">${icons.upload('', 12)} Deploy</app-tag>
                ${icons.chevronRight('empty-arrow', 12)}
                <app-tag size="sm">${icons.route('', 12)} Orchestrate</app-tag>
              </div>
              <app-button variant="primary" href="/add-agent">Import agent ${icons.plus()}</app-button>
            </app-empty-state>
          </div>`;
        return;
      }

      // <app-card> is the one card component — it owns the surface, the name
      // row, the two-line description clamp and the keyboard/click activation
      // this page used to hand-roll. No `agent-id`, so the card renders no
      // Details/Chat footer: the whole card is the chat link.
      grid.innerHTML = agents.map(agent => {
        const displayName = agent.display_name || agent.name || agent.id;
        const href = `/chat?agent_name=${encodeURIComponent(agent.name)}&agent_id=${encodeURIComponent(agent.id)}`;
        return `
          <app-card
            name="${escAttr(displayName)}"
            ${agent.description ? `description="${escAttr(agent.description)}"` : ''}
            href="${escAttr(href)}"
            aria-label="Chat with ${escAttr(displayName)}">
            <span data-slot="actions" class="agent-card-go">${icons.arrowUpRight('', 14)}</span>
          </app-card>
        `;
      }).join('');
    } catch {
      // The section used to delete itself — not even the designed empty
      // state, just gone, so a failed fetch was indistinguishable from a
      // deployment with nothing running. The composer above still works, so
      // this says what broke and offers a way back without taking the page.
      grid.innerHTML = `
        <app-empty-state inline variant="error" description="Couldn't load your agents">
          <app-button id="recent-retry" variant="tertiary" size="sm">Retry</app-button>
        </app-empty-state>`;
      grid.querySelector('#recent-retry')?.addEventListener('click', () => {
        grid.innerHTML = Array.from({ length: 3 }, () => '<app-card loading></app-card>').join('');
        this.#loadRecentAgents();
      });
    }
  }

  async #readStream(res, messagesEl, turn) {
    const streamRow = document.createElement('div');
    streamRow.className = 'msg-row is-assistant';
    const streamArea = document.createElement('div');
    streamArea.className = 'assistant-stream';

    const stepsEl = document.createElement('agent-steps');

    const contentEl = document.createElement('div');
    contentEl.className = 'stream-content md-body';

    const typingEl = document.createElement('div');
    typingEl.className = 'typing-indicator';
    typingEl.setAttribute('aria-label', 'Agent is responding');
    typingEl.innerHTML = '<span></span><span></span><span></span>';

    streamArea.appendChild(stepsEl);
    streamArea.appendChild(typingEl);
    streamArea.appendChild(contentEl);
    streamRow.appendChild(streamArea);
    messagesEl.appendChild(streamRow);
    stickToBottom(messagesEl);

    const follow = () => {
      if (nearBottom(scrollerFor(messagesEl))) stickToBottom(messagesEl);
    };

    const showContent = (html, { progress = false } = {}) => {
      typingEl.remove();
      contentEl.classList.add('is-visible');
      contentEl.classList.toggle('is-progress', progress);
      contentEl.innerHTML = html;
      follow();
    };

    const renderReply = frameRenderer((text) => {
      stepsEl.finish();
      showContent(renderMarkdown(text));
    });
    const out = await readA2aStream(res, {
      onReply: renderReply,
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

    // Paused for a human: the stream closing with no reply is the expected
    // shape, not a failure, so the outcome is the card and nothing is rendered
    // as if the orchestrator had answered.
    if (out.hitl) {
      stepsEl.awaitInput();
      typingEl.remove();
      // A pause from a turn the user has navigated away from must not mount:
      // #mountHitl sets #hitlCard, which locks the composer of whatever is on
      // screen now on someone else's decision.
      if (!turn?.detached) this.#mountHitl(streamArea, out.hitl);
      return { text: '', traceId: out.traceId, usage: out.usage, paused: true };
    }

    stepsEl.finish();
    typingEl.remove();
    let fullText = out.text;
    if (out.failed && !fullText) {
      fullText = out.errorMessage;
      showContent(`<span style="color:var(--color-error)">${escHtml(fullText)}</span>`);
    } else if (!fullText) {
      showContent(renderMarkdown('No response'));
      fullText = 'No response';
    } else {
      showContent(renderMarkdown(fullText));
    }

    // Add actions to stream row
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = `
      <button type="button" class="msg-action-copy" aria-label="Copy message" title="Copy">${icons.copy('', 14)}</button>
      ${usageChipsHtml(out.usage)}
      ${this.#traceLinkHtml(out.traceId)}
    `;
    streamArea.appendChild(actions);

    return { text: fullText, traceId: out.traceId, usage: out.usage };
  }

}

customElements.define('orchestrator-page', OrchestratorPage);
