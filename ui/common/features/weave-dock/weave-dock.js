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
import { createView, setViewSurface } from '/common/state/weave-views.js';
import { createSurfaceSession } from '/common/surface/surface-stream.js';
import '/common/design-system/app-chatbox/app-chatbox.js';

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
  '/session-trace': 'Ask Weave about this trace…',
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

/** The history menu's canned recents, below a "New chat" action. */
const RECENT_CHATS = ['Traces page details', 'Adding filters to tokenops'];

class WeaveDock extends HTMLElement {
  #initialized = false;
  /** Turns rendered in the thread: `{ role, text, view? }`. */
  #turns = [];
  #open = false;
  #busy = false;
  /** The generation session, built on first send and reused for follow-ups. */
  #surfaceSession = null;
  /** Prose the generator wrapped its DSL in, collected during the turn. */
  #said = [];

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
    this.#surfaceSession?.dispose();
    this.#surfaceSession = null;
    document.documentElement.style.removeProperty('--app-dock-width');
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
            aria-haspopup="menu" aria-expanded="false">${icons.history('', 16, 1.25)}</button>
          <button class="bar-btn" type="button" data-settings aria-label="Weave settings"
            >${icons.settings('', 16, 1.25)}</button>
          <h2 class="drawer__title">Weave</h2>
          <button class="bar-btn" type="button" data-close aria-label="Close Weave"
            >${icons.panelLeft('', 16, 1.25)}</button>
          <div class="history" role="menu" hidden>
            <button class="history__item" type="button" role="menuitem" data-new-chat>New chat</button>
            <p class="history__label">Recent chats</p>
            ${RECENT_CHATS.map((c) => `<button class="history__item" type="button" role="menuitem">${escHtml(c)}</button>`).join('')}
          </div>
        </header>

        <div class="thread" id="thread" aria-live="polite"></div>

        <div class="composer">
          <app-chatbox placeholder="Ask weave anything..." aria-label="Ask Weave"></app-chatbox>
        </div>
      </aside>`;

    this.querySelector('[data-open]').addEventListener('click', () => this.open());
    this.querySelector('[data-close]').addEventListener('click', () => this.close());
    this.querySelector('[data-history]').addEventListener('click', () => this.#toggleHistory());
    this.querySelector('[data-new-chat]').addEventListener('click', () => this.#newChat());
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
    menu.toggleAttribute('hidden', !next);
    this.querySelector('[data-history]').setAttribute('aria-expanded', String(next));
  }

  #newChat() {
    this.#toggleHistory(false);
    this.#turns = [];
    this.#paintThread();
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

    // The view exists before the answer does — the route it opens is what
    // renders the generating state, so navigating first is not a race.
    const view = createView(text);
    navigate(`/view?id=${encodeURIComponent(view.id)}`);
    this.#respond(view);
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
    this.#surfaceSession ??= createSurfaceSession({
      endpoint: '/weave/surface',
      container: document.createElement('div'),
      onMessage: (text) => { this.#said.push(text); },
    });
    return this.#surfaceSession;
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
  async #respond(view) {
    this.#turns.push({ role: 'working' });
    this.#paintThread();
    this.#said.length = 0;
    const startedAt = Date.now();

    let out = null;
    try {
      out = await this.#session().send(view.prompt);
    } catch (err) {
      out = { status: 'failed', surface: '', catalogVersion: null, error: err };
    }

    this.#turns.pop(); // the working line
    if (out.status !== 'ok' || !out.surface) {
      // Said plainly rather than as a canned apology: the user is about to
      // land on a /view that has nothing on it, and the reason belongs here
      // where they asked, not only in a diagnostic pill.
      this.#turns.push({
        role: 'assistant',
        text: this.#said.at(-1)
          || 'I could not build that one. The generator did not return a surface — try rephrasing, or check that Weave is reachable.',
      });
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
      this.#turns.push(
        // The elapsed line stays after the answer: it is the receipt for how
        // much work the answer represents, and it is the handle into the trace.
        { role: 'elapsed', text: elapsedLabel(Date.now() - startedAt) },
        { role: 'assistant', text: this.#said.at(-1) || `Built ${view.title}.` },
        { role: 'artifact', text: view.title, view },
      );
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
        ${STARTERS.map((s) => `<button class="chip" type="button">${escHtml(s)}</button>`).join('')}
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
      node.innerHTML = `
        <button class="artifact" type="button">
          ${icons.layers('artifact__icon', 16, 1.25)}
          <span class="artifact__text">
            <span class="artifact__title">${escHtml(turn.text)}</span>
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
