/**
 * `<weave-surface>` — a generated dashboard, mounted.
 *
 * Everything interesting happens in `common/surface/`; this element is the
 * seam between that runtime and the rest of the app. It owns three things the
 * runtime deliberately does not:
 *
 *   **A lifetime.** The runtime has no idea when it stops being wanted. This
 *   element aborts the in-flight request and disposes the query manager on
 *   disconnect, so a stream does not keep painting into detached DOM after the
 *   user has navigated away — the failure the `AbortController` work in
 *   `services/api.js` was added to stop.
 *
 *   **A vocabulary.** The catalog is loaded once, here, from the generated
 *   `dsl-catalog.json`. A host may override it (the preview fixtures do), but
 *   nothing has to know where it lives.
 *
 *   **Events instead of callbacks.** The runtime reports through callbacks
 *   because it is a plain module. A host page wants DOM events, so the
 *   translation happens once rather than in every page that mounts one.
 *
 * Light DOM, `createElement` only — `ui-lint`'s
 * `weave-renderer-is-createelement-only` rule covers this directory, and it
 * covers it precisely because everything rendered here was written by a model.
 *
 * @element weave-surface
 * @attr {string} endpoint - control-plane path, default `/weave/surface`
 * @fires weave-message     - `{detail: {text}}` an assistant sentence
 * @fires weave-assistant   - `{detail: {text}}` `@ToAssistant` — the surface asking for a new turn
 * @fires weave-status      - `{detail: {phase, detail}}` requesting / streaming / done / failed
 * @fires weave-diagnostics - `{detail: {diagnostics}}` anything the runtime could not honour
 */

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./weave-surface.css', import.meta.url));

import { createSurfaceSession } from '/common/surface/surface-stream.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** The generated vocabulary. Fetched once for the whole app. */
let catalogPromise = null;
function loadCatalog() {
  catalogPromise ??= fetch(new URL('/common/surface/dsl-catalog.json', document.baseURI))
    .then((res) => {
      if (!res.ok) throw new Error(`dsl-catalog.json: ${res.status}`);
      return res.json();
    });
  return catalogPromise;
}

class WeaveSurface extends HTMLElement {
  #initialized = false;
  #session = null;
  #stage = null;
  #abort = null;
  /** Set by a host before the first `send()`; the preview fixtures use it. */
  catalog = null;
  /** Extra request context — `scope`, and whatever else the backend grows. */
  context = {};

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#stage = document.createElement('div');
    this.#stage.className = 'weave-surface__stage';
    this.replaceChildren(this.#stage);
  }

  disconnectedCallback() {
    this.#abort?.abort();
    this.#abort = null;
    this.#session?.dispose();
    this.#session = null;
  }

  /** Fresh conversation: no surface, no data, no state. */
  reset() {
    this.#abort?.abort();
    this.#abort = null;
    this.#session?.reset();
  }

  /** Stop the current turn but keep what is already on screen. */
  stop() {
    this.#abort?.abort();
    this.#abort = null;
  }

  /**
   * One turn.
   *
   * @param {string} prompt
   * @returns {Promise<{status: string, surface: string, catalogVersion: string|null}>}
   */
  async send(prompt) {
    const session = await this.#ensureSession();
    this.#abort?.abort();
    this.#abort = new AbortController();
    try {
      return await session.send(prompt, { signal: this.#abort.signal, context: this.context });
    } catch (err) {
      // An abort is this element doing its job, not a failure to report.
      if (err?.name === 'AbortError') return { status: 'aborted', surface: '', catalogVersion: null };
      this.#emit('weave-status', { phase: 'failed', detail: String(err?.message ?? err) });
      this.#emit('weave-diagnostics', {
        diagnostics: [{ source: 'host', code: 'request_failed', message: String(err?.message ?? err) }],
      });
      return { status: 'failed', surface: '', catalogVersion: null };
    }
  }

  /** The raw DSL of the last turn that produced a surface. */
  get currentSurface() { return this.#session?.currentSurface ?? ''; }
  /** `$state`, for a host that wants to read it. */
  get store() { return this.#session?.store ?? null; }

  async #ensureSession() {
    if (this.#session) return this.#session;
    const catalog = this.catalog ?? (await loadCatalog());
    this.#session = createSurfaceSession({
      endpoint: this.getAttribute('endpoint') || '/weave/surface',
      catalog,
      container: this.#stage,
      onMessage: (text) => this.#emit('weave-message', { text }),
      onAssistant: (text) => this.#emit('weave-assistant', { text }),
      onStatus: (s) => this.#emit('weave-status', s),
      onDiagnostics: (diagnostics) => this.#emit('weave-diagnostics', { diagnostics }),
    });
    return this.#session;
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

customElements.define('weave-surface', WeaveSurface);
