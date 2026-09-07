/**
 * `<weave-page>` — describe a dashboard, watch it get built.
 *
 * The first host for the surface runtime. Deliberately not the final one: the
 * shape the product wants is a conversation with an acceptance step (NAS-293,
 * NAS-292), and that is still being designed. What this page is for is
 * everything that does not depend on that decision — proving the runtime
 * against the real endpoint, with the real data sources, at a real URL.
 *
 * Three panes, because three things can go wrong and they are not the same
 * thing: the surface itself, the assistant's own words, and the diagnostics.
 * A generated dashboard that renders half of what was asked for looks fine
 * until you read the diagnostics, so they are on screen rather than in the
 * console.
 *
 * @element weave-page
 * @note Talks to `/api/weave/surface` on the control plane, which proxies to
 *   the Weave service. The browser never holds Weave's internal token.
 */

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./weave-page.css', import.meta.url));

import { escHtml } from '/common/utils/escape.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/features/weave-surface/weave-surface.js';
import '/common/services/usage-service.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/**
 * The data-source scope this page generates against.
 *
 * Weave's `dashboard_data_sources.json` is the security boundary and it is
 * backend-owned — the manifest names five read-only usage sources under
 * `tokenops`. Importing `usage-service.js` above is what registers those five
 * names in this page's registry; without it every `Query` would resolve to
 * nothing and the surface would render its declared defaults forever.
 */
const SCOPE = 'tokenops';

/** Something to click on an empty page. Every one of these is answerable with the tokenops sources. */
const STARTERS = [
  'Show me spend and request volume for the last 14 days',
  'Which agents cost the most? Table, with a cost breakdown',
  'Give me a cost dashboard I can switch between cost and operations',
  'Usage by model, with a chart',
];

class WeavePage extends HTMLElement {
  #initialized = false;
  #surface = null;
  #log = null;
  #diagnostics = [];
  #busy = false;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="title-page">Weave</h1>
          <p class="page-sub">Describe a dashboard. It is generated against the
            <code>${escHtml(SCOPE)}</code> data sources and rendered live.</p>
        </div>
        <div class="head-actions">
          <app-badge id="status" variant="neutral">idle</app-badge>
          <app-button id="reset" variant="ghost" size="sm">New</app-button>
        </div>
      </div>

      <form class="composer" id="composer">
        <input class="composer__input" id="prompt" type="text" autocomplete="off"
               placeholder="What should this dashboard show?" aria-label="Prompt" />
        <app-button id="send" variant="primary"size="md" type="submit">Build</app-button>
      </form>

      <div class="starters" id="starters"></div>

      <div class="panes">
        <section class="pane pane--surface" aria-label="Generated surface">
          <weave-surface id="surface" endpoint="/weave/surface"></weave-surface>
          <app-empty-state id="empty" title="Nothing generated yet"
            description="Describe what you want to see, or pick one of the suggestions above."></app-empty-state>
        </section>

        <aside class="pane pane--side">
          <h2 class="pane__title">Assistant</h2>
          <div class="log" id="log" aria-live="polite"></div>
          <h2 class="pane__title">Diagnostics</h2>
          <div class="diagnostics" id="diagnostics" aria-live="polite"></div>
        </aside>
      </div>`;

    this.#surface = this.querySelector('#surface');
    this.#log = this.querySelector('#log');
    this.#surface.context = { scope: SCOPE };

    this.querySelector('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      this.#send(this.querySelector('#prompt').value.trim());
    });
    this.querySelector('#reset').addEventListener('click', () => this.#reset());

    const starters = this.querySelector('#starters');
    for (const text of STARTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'starter';
      b.textContent = text;
      b.addEventListener('click', () => {
        this.querySelector('#prompt').value = text;
        this.#send(text);
      });
      starters.append(b);
    }

    this.#surface.addEventListener('weave-message', (e) => this.#say('assistant', e.detail.text));
    this.#surface.addEventListener('weave-status', (e) => this.#status(e.detail));
    this.#surface.addEventListener('weave-diagnostics', (e) => this.#note(e.detail.diagnostics));
    // One record per turn — codes, counts and timings, no content. Logged here
    // rather than thrown away so the shape is visible while the real sink is
    // still being wired (NAS-211); a page should not be the thing that decides
    // where telemetry goes.
    this.#surface.addEventListener('weave-turn', (e) => console.info('[weave] turn', e.detail.record));
    // `@ToAssistant` — the generated surface asking for another turn. Wiring it
    // here is what makes a "show me last week instead" button inside a
    // dashboard actually do something.
    this.#surface.addEventListener('weave-assistant', (e) => this.#send(e.detail.text));
  }

  disconnectedCallback() {
    this.#surface?.stop();
  }

  async #send(prompt) {
    if (!prompt || this.#busy) return;
    this.#busy = true;
    // `loading` is an attribute on app-button, not a property — assigning
    // `.loading` would set an expando nothing reads.
    this.querySelector('#send').toggleAttribute('loading', true);
    this.querySelector('#empty').hidden = true;
    this.#say('you', prompt);
    try {
      const out = await this.#surface.send(prompt);
      this.#status({ phase: out.status === 'ok' ? 'done' : out.status });
    } finally {
      this.#busy = false;
      this.querySelector('#send').toggleAttribute('loading', false);
      this.querySelector('#prompt').value = '';
    }
  }

  #reset() {
    this.#surface.reset();
    this.#log.replaceChildren();
    this.#diagnostics = [];
    this.querySelector('#diagnostics').replaceChildren();
    this.querySelector('#empty').hidden = false;
    this.#status({ phase: 'idle' });
  }

  #say(who, text) {
    if (!text) return;
    const row = document.createElement('p');
    row.className = `log__line log__line--${who}`;
    row.textContent = text;
    this.#log.append(row);
    this.#log.scrollTop = this.#log.scrollHeight;
  }

  #status({ phase, detail }) {
    const badge = this.querySelector('#status');
    badge.textContent = detail ? `${phase} — ${detail}` : phase;
    badge.setAttribute('variant', VARIANTS[phase] ?? 'neutral');
  }

  /**
   * Diagnostics accumulate rather than replace. A `catalog_version_mismatch`
   * from the first frame is still the explanation for a component that did not
   * render six chunks later, and clearing it would hide exactly that.
   */
  #note(diagnostics) {
    if (!diagnostics?.length) return;
    const host = this.querySelector('#diagnostics');
    for (const d of diagnostics) {
      const key = `${d.source}/${d.code}/${d.message}`;
      if (this.#diagnostics.includes(key)) continue;
      this.#diagnostics.push(key);
      const row = document.createElement('div');
      row.className = 'diag';
      // Painted by severity, because "the chart is missing" and "the stream
      // reconnected" arriving in the same amber were indistinguishable, and the
      // one that matters is the one that got skimmed past.
      if (d.severity) row.dataset.severity = d.severity;
      const code = document.createElement('span');
      code.className = 'diag__code';
      code.textContent = d.code ?? 'note';
      const msg = document.createElement('span');
      msg.className = 'diag__msg';
      msg.textContent = d.message ?? '';
      row.append(code, msg);
      host.append(row);
    }
  }
}

const VARIANTS = {
  idle: 'neutral',
  requesting: 'info',
  streaming: 'info',
  done: 'success',
  ok: 'success',
  failed: 'error',
  http_error: 'error',
  aborted: 'warning',
};

customElements.define('weave-page', WeavePage);
