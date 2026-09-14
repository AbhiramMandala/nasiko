/**
 * `<weave-dock>` — Weave as a companion, not a destination.
 *
 * Two pieces of chrome that live outside the router outlet, so a route swap
 * never interrupts a conversation:
 *
 *   1. A launcher pill pinned bottom-right of every page.
 *   2. A right-hand ink drawer holding the thread and the composer.
 *
 * Asking for a screen creates a *view* (state/weave-views.js) and navigates to
 * `/view?id=…`. The page the user was on is left where it was — this is the
 * whole point of generating into a new route rather than replacing the current
 * one — and the drawer stays open across the swap because it is a body child.
 *
 * `/weave` is untouched and remains the surface-runtime workbench. This is the
 * conversational shell around it.
 *
 * `#respond()` runs a real turn against the generator: the words are the
 * model's own (the prose it wraps its DSL in), the elapsed line is measured,
 * and the artifact card links to a view whose DSL was actually produced.
 *
 * The session renders into a detached container on purpose. The dock owns the
 * conversation; `/view` owns the canvas, and draws from the stored DSL. Drawing
 * here too would materialize the same tree twice and run every Query twice for
 * a surface nobody sees.
 *
 * @element weave-dock
 * @note Mounted once, from `ui/oss/app.js`. Never place it inside a page.
 */

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./weave-dock.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

import { icons } from '/common/utils/icons.js';
import { escHtml } from '/common/utils/escape.js';
import { navigate } from '/common/core/router.js';
import { createView, setViewSurface, generateViewTitle, renameView, hydrateView } from '/common/state/weave-views.js';
import { createSurfaceSession } from '/common/surface/surface-stream.js';
import { loadCatalog, withSeverity } from '/common/surface/catalog-load.js';
import { WEAVE_STARTERS } from '/common/surface/starters.js';
import { getJson, postJson } from '/common/services/api.js';
import '/common/design-system/app-chatbox/app-chatbox.js';

const newSessionId = () => `weave_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)}`;

/**
 * "Worked for 12s" — the receipt on a finished turn.
 *
 * Real, not the fixed "24min" the canned version showed. A generation is
 * usually seconds; a number that never moves reads as decoration, and the one
 * time it matters is the turn that took a minute.
 */
function elapsedLabel(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `Worked for ${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `Worked for ${m}m ${rest}s` : `Worked for ${m}m`;
}

/** Drawer width, and the gutter the content card gives up to it. One number. */
const DOCK_WIDTH = '432px';

/** Survives a reload; the drawer is a workspace, not a popup. */
const OPEN_KEY = 'weave-dock-open';

/**
 * What the launcher offers, by route. A pill that names the data under the
 * cursor is an invitation; "Ask Weave anything" is wallpaper.
 */
const LAUNCHER_LABELS = {
  '/tokenops': 'Ask Weave to explore your TokenOps data…',
  '/sessions': 'Ask Weave to explore your TokenOps data…',
  '/observability-session': 'Ask Weave to explore your TokenOps data…',
  '/session-trace': 'Ask Weave to explore your TokenOps data…',
  '/agents': 'Ask Weave about your agents…',
  '/custom-views': 'Ask Weave to build a new view…',
};
const LAUNCHER_DEFAULT = 'Ask Weave anything…';

/** Empty-thread suggestions. Two build something, two answer something. */
const STARTERS = [
  'Create a view for monitoring costs',
  'Help me configure an LLM provider',
  'What needs my attention?',
  'Create a new agent',
];

class WeaveDock extends HTMLElement {
  #initialized = false;
  /** Turns rendered in the thread: `{ role, text, view? }`. */
  #turns = [];
  #open = false;
  #busy = false;
  /** The generation session, built on first send and reused for follow-ups. */
  #sessionPromise = null;
  /** Prose the generator wrapped its DSL in, collected during the turn. */
  #said = [];
  /** Diagnostics raised during the turn, so the answer can be qualified. */
  #faults = [];
  #chatSessionId = null;

  #onRouteChange = () => this.#paintLauncher();
  #onDocumentClick = (e) => {
    if (!this.querySelector('.history')?.hasAttribute('hidden')
        && !e.target.closest('.history, [data-history]')) this.#toggleHistory(false);
  };

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#open = localStorage.getItem(OPEN_KEY) === 'true';
      this.#render();
    }
    // Every connect, not just the first: teardown below runs on every
    // disconnect, so a re-parented dock would otherwise lose both permanently.
    document.addEventListener('route-change', this.#onRouteChange);
    document.addEventListener('click', this.#onDocumentClick);
    this.#applyOpen();
  }

  disconnectedCallback() {
    document.removeEventListener('route-change', this.#onRouteChange);
    document.removeEventListener('click', this.#onDocumentClick);
    // The session holds query subscriptions and an open stream. A turn already
    // in flight still resolves — #respond and #paintThread both tolerate a
    // detached dock — but nothing new starts.
    this.#disposeSession();
    document.documentElement.style.removeProperty('--app-dock-width');
  }

  #disposeSession() {
    this.#sessionPromise?.then((session) => session.dispose()).catch(() => {});
    this.#sessionPromise = null;
  }

  /** Open the drawer, optionally with the composer prefilled. */
  open(prompt = '') {
    this.#open = true;
    this.#applyOpen();
    const box = this.querySelector('app-chatbox');
    if (prompt) box.value = prompt;
    box.focus();
  }

  close() {
    this.#open = false;
    this.#applyOpen();
  }

  // ── Render ────────────────────────────────────────────────────────────

  #render() {
    this.innerHTML = `
      <button class="launcher" type="button" data-open>
        ${icons.sparkles('launcher__icon', 16, 1.5)}
        <span class="launcher__label"></span>
      </button>

      <aside class="drawer" aria-label="Weave">
        <header class="drawer__bar">
          <button class="bar-btn" type="button" data-history aria-label="Chat history"
            aria-haspopup="true" aria-expanded="false">${icons.history('', 16, 1.25)}</button>
          <h2 class="drawer__title">Weave</h2>
          <button class="bar-btn" type="button" data-close aria-label="Close Weave"
            >${icons.panelLeft('', 16, 1.25)}</button>
          <!-- A plain popover, not role="menu": the search box is not a valid
               menu descendant, and native buttons need no menu semantics. -->
          <div class="history" hidden>
            <button class="history__item" type="button" data-new-chat>New chat</button>
            <p class="history__label" hidden>Recent chats</p>
            <input class="history__search" type="search" placeholder="Search sessions"
              aria-label="Search sessions" hidden>
            <div class="history__list"></div>
          </div>
        </header>

        <div class="thread" id="thread" aria-live="polite"></div>

        <div class="composer">
          <app-chatbox no-attachments placeholder="Ask weave anything..." aria-label="Ask Weave"></app-chatbox>
        </div>
      </aside>`;

    this.querySelector('[data-open]').addEventListener('click', () => this.open());
    this.querySelector('[data-close]').addEventListener('click', () => this.close());
    this.querySelector('[data-history]').addEventListener('click', () => this.#toggleHistory());
    this.querySelector('[data-new-chat]').addEventListener('click', () => this.#newChat());
    this.querySelector('.history__search').addEventListener('input', (e) => this.#filterHistory(e.target.value));
    this.addEventListener('chatbox-submit', (e) => this.#send(e.detail.value));

    this.#paintLauncher();
    this.#paintThread();
  }

  #paintLauncher() {
    const path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    this.querySelector('.launcher__label').textContent = LAUNCHER_LABELS[path] ?? LAUNCHER_DEFAULT;
  }

  /**
   * The drawer's width is handed to the shell as a custom property rather than
   * painted over the page: the content card should *shrink*, so nothing the
   * user is reading ends up underneath the conversation about it.
   */
  #applyOpen() {
    this.classList.toggle('is-open', this.#open);
    const root = document.documentElement.style;
    if (this.#open) root.setProperty('--app-dock-width', DOCK_WIDTH);
    else root.removeProperty('--app-dock-width');
    try { localStorage.setItem(OPEN_KEY, String(this.#open)); } catch { /* private mode */ }
  }

  #toggleHistory(force) {
    const menu = this.querySelector('.history');
    const next = force ?? menu.hasAttribute('hidden');
    if (next) this.#paintHistory();
    menu.toggleAttribute('hidden', !next);
    this.querySelector('[data-history]').setAttribute('aria-expanded', String(next));
  }

  #newChat() {
    this.#toggleHistory(false);
    this.#turns = [];
    this.#chatSessionId = null;
    this.#disposeSession();
    this.#paintThread();
  }

  async #paintHistory() {
    const menu = this.querySelector('.history');
    const label = menu.querySelector('.history__label');
    const search = menu.querySelector('.history__search');
    const list = menu.querySelector('.history__list');
    list.replaceChildren();
    search.value = '';

    let sessions = [];
    try {
      // `weave=true`: the dock's chats are hidden from every other session
      // list (Sessions page, Orchestrator nav, `nasiko sessions`), so this is
      // the only caller that asks for them — server-side, by session-id prefix.
      // 100 is the server's clamp on `limit` (`oss/server/src/chat/routes.rs`).
      const body = await getJson('/chat/sessions?limit=100&weave=true');
      const rows = body?.data ?? body ?? [];
      sessions = Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.error('[weave-dock] could not load chat history', err);
    }

    label.hidden = sessions.length === 0;
    search.hidden = sessions.length === 0;
    for (const session of sessions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'history__item';
      item.dataset.sessionId = session.session_id;
      item.textContent = session.title;
      item.addEventListener('click', () => {
        this.#toggleHistory(false);
        this.#openSession(session.session_id);
      });
      list.append(item);
    }
  }

  /** Client-side title filter — the whole list is already in the DOM. */
  #filterHistory(query) {
    const needle = query.trim().toLowerCase();
    for (const item of this.querySelectorAll('.history__list [data-session-id]')) {
      item.hidden = needle !== '' && !item.textContent.toLowerCase().includes(needle);
    }
  }

  async #openSession(sessionId) {
    this.#turns = [];
    this.#chatSessionId = sessionId;
    this.#disposeSession();
    this.#paintThread();

    let messages = [];
    try {
      const body = await getJson(`/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
      messages = body?.data ?? body ?? [];
    } catch (err) {
      console.error('[weave-dock] could not load chat session messages', err);
    }
    if (!Array.isArray(messages)) messages = [];

    let lastView = null;
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      this.#turns.push({ role: m.role, text: m.content });
      const viewId = m.file_parts?.weave_view_id;
      if (viewId) {
        lastView = {
          id: viewId,
          title: m.file_parts.weave_title,
          dsl: m.file_parts.dsl,
          catalogVersion: m.file_parts.catalog_version,
        };
      }
    }
    this.#paintThread();

    if (lastView) {
      hydrateView(lastView);
      navigate(`/view?id=${encodeURIComponent(lastView.id)}`);
      if (lastView.dsl) {
        try {
          // What the user SEES comes from hydrateView above — /view reads the
          // store and draws it. This is for the turn after: the session needs
          // `currentSurface` set, or the first revision on a resumed chat is
          // sent with no prior surface and the model rebuilds from scratch
          // instead of patching by name.
          //
          // It is not free. The dock's container is a detached div, so this
          // renders a tree nobody looks at and fires every Query in it for
          // real — one round of fetches to seed one string. Worth it because
          // the alternative is a silently worse first revision, but worth
          // knowing: if `show()` ever grows a "parse and seed, do not draw"
          // mode, this is its caller.
          (await this.#session()).show(lastView.dsl, { catalogVersion: lastView.catalogVersion });
        } catch (err) {
          console.error('[weave-dock] could not seed the resumed dashboard state', err);
        }
      }
    }
  }

  // ── Conversation ──────────────────────────────────────────────────────

  async #send(prompt) {
    const text = (prompt || '').trim();
    const box = this.querySelector('app-chatbox');
    if (!text || this.#busy) { box.setLoading(false); return; }
    this.#busy = true;
    box.reset();
    this.#turns.push({ role: 'user', text });
    this.#paintThread();

    const sessionReady = this.#ensureChatSession(text);
    sessionReady.then((id) => this.#persistMessage(id, 'user', text));

    // The view exists before the answer does — the route it opens is what
    // renders the generating state, so navigating first is not a race.
    const view = createView(text);
    navigate(`/view?id=${encodeURIComponent(view.id)}`);
    this.#retitle(view, text);
    this.#respond(view, sessionReady);
  }

  async #ensureChatSession(firstPrompt) {
    if (this.#chatSessionId) return this.#chatSessionId;
    const id = newSessionId();
    try {
      const body = await postJson('/chat/sessions', { session_id: id, first_prompt: firstPrompt });
      this.#chatSessionId = body?.data?.session_id ?? id;
    } catch (err) {
      console.error('[weave-dock] could not create a chat session', err);
      this.#chatSessionId = id;
    }
    return this.#chatSessionId;
  }

  async #persistMessage(sessionId, role, content, extra = {}) {
    if (!sessionId) return;
    try {
      await postJson(`/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { role, content, ...extra });
    } catch (err) {
      console.error('[weave-dock] could not persist a message', err);
    }
  }

  /**
   * Replace the view's fallback title with the model's own, in place.
   *
   * Fired alongside `#respond`, not awaited by it: the title call is one
   * short, cheap completion (`POST /weave/title`) that resolves well before
   * the actual generation does, so by the time an artifact card exists for
   * this view its title has almost always already landed. `#paintThread`
   * covers the rare case where generation is fast enough that it hasn't.
   */
  async #retitle(view, prompt) {
    const title = await generateViewTitle(prompt);
    if (!title || title === view.title) return;
    view.title = title;
    try { await renameView(view.id, title); } catch { /* the mutation above still shows */ }
    this.#paintThread();
  }

  /**
   * The generation session.
   *
   * Its container is a detached div and stays that way: the dock owns the
   * conversation, not the canvas. The surface is rendered by `/view`, from the
   * DSL this turn stores — which is also what makes a saved view reopenable
   * later, and what a reload gets back. Rendering here as well would draw the
   * same tree twice and fire every Query twice for a canvas nobody sees.
   *
   * Built once and reused, so a follow-up turn carries `currentSurface` as
   * context and the model revises rather than starting over.
   */
  #session() {
    // A promise, not the session: the catalog has to be fetched first, and two
    // turns racing to build the session would otherwise each start their own
    // and one would be thrown away mid-flight.
    this.#sessionPromise ??= (async () => {
      // Required, not optional. Without it `buildComponentIndex` throws on the
      // first property read and every turn dies before the request is even
      // built — which is exactly what happened, and it looked like Weave being
      // unreachable rather than a missing argument.
      const catalog = await loadCatalog();
      return createSurfaceSession({
        endpoint: '/weave/surface',
        catalog,
        container: document.createElement('div'),
        sessionId: this.#chatSessionId ?? undefined,
        onMessage: (text) => { this.#said.push(text); },
        // Collected so the turn's own claim can be checked against what the
        // runtime actually managed. The model writes its closing sentence
        // before anything renders, so on a bad turn it says "here's your chart"
        // with conviction and nothing contradicts it.
        onDiagnostics: (list) => { this.#faults.push(...withSeverity(list)); },
      });
    })();
    return this.#sessionPromise;
  }

  /**
   * One real turn.
   *
   * The two-phase shape the canned version had is kept because both halves are
   * still true: "I am working" must appear the moment the user presses send,
   * and the artifact card must not appear before there is an artifact. What
   * changed is that the wait is now the model's, and the words are its own —
   * `onMessage` collects the sentences the generator wraps its DSL in, so the
   * dock says what was actually built instead of a sentence written here.
   */
  async #respond(view, sessionReady) {
    this.#turns.push({ role: 'working' });
    this.#paintThread();
    this.#said.length = 0;
    this.#faults.length = 0;
    const startedAt = Date.now();
    const sessionId = await sessionReady;

    let out = null;
    try {
      out = await (await this.#session()).send(view.prompt);
    } catch (err) {
      out = { status: 'failed', surface: '', catalogVersion: null, error: err };
    }

    this.#turns.pop(); // the working line
    if (out.status !== 'ok' || !out.surface) {
      // Said plainly rather than as a canned apology: the user is about to
      // land on a /view that has nothing on it, and the reason belongs here
      // where they asked, not only in a diagnostic pill.
      const text = this.#said.at(-1)
        || 'I could not build that one. The generator did not return a surface — try rephrasing, or check that Weave is reachable.';
      this.#turns.push({ role: 'assistant', text });
      this.#persistMessage(sessionId, 'assistant', text);
    } else {
      // Awaited: on a view the user has already saved this is a real PATCH, and
      // a surface the user can see but the server cannot is the bug it avoids.
      // A failure there must not swallow the answer, so it is logged and the
      // turn finishes — the DSL is on the local row either way.
      try {
        await setViewSurface(view.id, { dsl: out.surface, catalogVersion: out.catalogVersion });
      } catch (err) {
        console.error('[weave-dock] could not persist the generated surface', err);
      }
      // The model writes its closing sentence before a single component has
      // rendered, so on a turn that dropped something it still says "here's
      // your chart" — which is exactly what happened, and the screen was the
      // only place that disagreed. A fatal diagnostic makes that sentence
      // untrue, so it is followed by what actually went wrong rather than left
      // to stand on its own.
      const fatal = this.#faults.filter((d) => d.severity === 'fatal');
      const assistantText = this.#said.at(-1) || `Built ${view.title}.`;
      this.#turns.push(
        // The elapsed line stays after the answer: it is the receipt for how
        // much work the answer represents, and it is the handle into the trace.
        { role: 'elapsed', text: elapsedLabel(Date.now() - startedAt) },
        { role: 'assistant', text: assistantText },
        { role: 'artifact', text: view.title, view },
      );
      this.#persistMessage(sessionId, 'assistant', assistantText, {
        file_parts: {
          weave_view_id: view.id,
          weave_title: view.title,
          dsl: out.surface,
          catalog_version: out.catalogVersion,
        },
      });
      if (fatal.length) {
        this.#turns.push({
          role: 'assistant',
          text: `Not all of that reached the page — ${
            [...new Set(fatal.map((d) => d.why || d.code))].join('; ')
          }. The view shows the detail.`,
        });
      }
    }

    this.#busy = false;
    this.querySelector('app-chatbox')?.setLoading(false);
    this.#paintThread();
  }

  #paintThread() {
    // A turn that resolves after the dock is gone has nothing to paint into.
    const thread = this.querySelector('#thread');
    if (!thread) return;
    thread.replaceChildren();
    if (!this.#turns.length) {
      thread.append(this.#heroNode());
      return;
    }
    for (const turn of this.#turns) thread.append(this.#turnNode(turn));
    thread.scrollTop = thread.scrollHeight;
  }

  #heroNode() {
    const hero = document.createElement('div');
    hero.className = 'hero';
    hero.innerHTML = `
      ${icons.sparkles('hero__mark', 28, 1.25)}
      <h3 class="hero__title">What are you working on?</h3>
      <p class="hero__sub">Ask a question, create something new, or describe what you want to change.</p>
      <div class="hero__chips">
        ${WEAVE_STARTERS.map((s) => `<button class="chip" type="button">${escHtml(s)}</button>`).join('')}
      </div>`;
    for (const chip of hero.querySelectorAll('.chip')) {
      chip.addEventListener('click', () => this.#send(chip.textContent));
    }
    return hero;
  }

  #turnNode(turn) {
    const node = document.createElement('div');
    node.className = `turn turn--${turn.role}`;
    if (turn.role === 'working') {
      node.innerHTML = `<span class="turn__working">Working…</span>`;
    } else if (turn.role === 'elapsed') {
      node.innerHTML = `<button class="elapsed" type="button">${escHtml(turn.text)}${icons.chevronRight('', 14, 1.25)}</button>`;
    } else if (turn.role === 'artifact') {
      // `turn.view.title`, not the `turn.text` snapshot taken when the turn
      // was pushed — `#retitle` mutates the view in place, and reading it
      // live here is what makes a rename after the card already rendered
      // actually show up on repaint.
      node.innerHTML = `
        <button class="artifact" type="button">
          ${icons.layers('artifact__icon', 16, 1.25)}
          <span class="artifact__text">
            <span class="artifact__title">${escHtml(turn.view.title)}</span>
            <span class="artifact__sub">Version 1</span>
          </span>
        </button>`;
      node.querySelector('.artifact').addEventListener('click',
        () => navigate(`/view?id=${encodeURIComponent(turn.view.id)}`));
    } else {
      node.textContent = turn.text;
    }
    return node;
  }
}

customElements.define('weave-dock', WeaveDock);

/** Mount the single instance. Idempotent — calling twice is a no-op. */
export function mountWeaveDock() {
  if (document.querySelector('weave-dock')) return;
  document.body.append(document.createElement('weave-dock'));
}
