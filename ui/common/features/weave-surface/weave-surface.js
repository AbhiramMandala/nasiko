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
 * @fires weave-diagnostics - `{detail: {diagnostics}}` anything the runtime could not
 *   honour. Each carries `severity`: `fatal` (the surface is wrong), `advisory`
 *   (a mistake the runtime corrected) or `runtime` (a failed source or stream,
 *   which says nothing about the generation).
 * @fires weave-turn        - `{detail: {record}}` one per turn: codes, counts and timings,
 *   never prompt or DSL content. The reporting sink subscribes here (NAS-211).
 */

import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./weave-surface.css', import.meta.url));

import { createSurfaceSession } from '/common/surface/surface-stream.js';

/**
 * Every "ready" element in `dsl-catalog.json`, imported for its side effect
 * (`customElements.define`) only.
 *
 * `render.js` builds a generated surface with plain `document.createElement`
 * — it has no loader, and the catalog carries no module path (that's
 * `design-system/catalog.json`'s `source` field, deliberately stripped by
 * `gen-dsl-catalog.mjs`, since the DSL vocabulary is supposed to be
 * import-agnostic). So somewhere, once, every component the model is allowed
 * to name has to actually be imported, or `document.createElement` returns
 * an undefined element the browser can't render: no shadow DOM, no styling,
 * attributes that go nowhere. This is that place — the one seam between the
 * runtime and the rest of the app already promises to own "a vocabulary."
 *
 * That was the intent and it had drifted: fifteen of the catalog's forty-one
 * were missing, app-segmented-control and app-tabs among them. A generated
 * surface naming one got an inert element — an empty box with the right tag,
 * no diagnostic, nothing in the console. Worse, it was order-dependent: the
 * SPA shares one custom-element registry, so a component was defined if the
 * user had happened to visit a page that imports it, and undefined on a fresh
 * load straight to /view. The same DSL rendered two different ways.
 *
 * `ui-lint`'s `weave-imports-every-catalog-element` now compares this list
 * against the catalog and fails on a difference, so the next component added
 * to the vocabulary cannot be added to it alone.
 */
import '/common/design-system/app-menu/app-menu.js';
import '/common/design-system/app-accordion/app-accordion.js';
import '/common/design-system/app-alert/app-alert.js';
import '/common/design-system/app-banner/app-banner.js';
import '/common/design-system/app-combobox/app-combobox.js';
import '/common/design-system/app-date-field/app-date-field.js';
import '/common/design-system/app-field/app-field.js';
import '/common/design-system/app-list/app-list.js';
import '/common/design-system/app-list-item/app-list-item.js';
import '/common/design-system/app-progress/app-progress.js';
import '/common/design-system/app-segmented-control/app-segmented-control.js';
import '/common/design-system/app-slider/app-slider.js';
import '/common/design-system/app-tabs/app-tabs.js';
import '/common/design-system/app-tag-group/app-tag-group.js';
import '/common/design-system/app-toggle/app-toggle.js';
import '/common/design-system/app-toggle-group/app-toggle-group.js';
import '/common/design-system/app-avatar/app-avatar.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-card/app-card.js';
import '/common/design-system/app-chart/app-chart.js';
import '/common/design-system/app-chatbox/app-chatbox.js';
import '/common/design-system/app-checkbox/app-checkbox.js';
import '/common/design-system/app-code-snippet/app-code-snippet.js';
import '/common/design-system/app-divider/app-divider.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-grid/app-grid.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-modal/app-modal.js';
import '/common/design-system/app-radio/app-radio.js';
import '/common/design-system/app-row/app-row.js';
import '/common/design-system/app-search/app-search.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-skeleton/app-skeleton.js';
import '/common/design-system/app-stack/app-stack.js';
import '/common/design-system/app-stat-card/app-stat-card.js';
import '/common/design-system/app-stat-row/app-stat-row.js';
import '/common/design-system/app-switch/app-switch.js';
import '/common/design-system/app-table/app-table.js';
import '/common/design-system/app-tag/app-tag.js';
import '/common/design-system/app-text/app-text.js';
import '/common/design-system/app-trace-tree/app-trace-tree.js';
import '/common/design-system/app-toolbar/app-toolbar.js';

import { loadCatalog, loadSeverities, withSeverity } from '/common/surface/catalog-load.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

class WeaveSurface extends HTMLElement {
  #initialized = false;
  #session = null;
  #stage = null;
  #abort = null;
  /** Set by a host before the first `send()`; the preview fixtures use it. */
  catalog = null;
  /**
   * Extra request context. The proxy rebuilds the upstream body from the keys
   * it knows, so anything here that the server does not read is dropped at the
   * boundary rather than reaching the generator — in particular the data-source
   * scope, which is decided server-side and is deliberately not something a
   * page can ask to widen.
   */
  context = {};
  /**
   * The automatic repair turn (surface/repair.js), forwarded to the session.
   *
   * Public for the same reason `catalog` and `context` are: it is a knob a
   * host legitimately sets, and the element was swallowing it. `rounds: 0`
   * turns the loop off for a host that would rather show the diagnostics than
   * spend a round trip.
   *
   * It also makes the loop observable without waiting for the model to make a
   * mistake. The default excludes advisories — a user should not wait on a
   * round trip to tidy a pre-fetch placeholder — and advisories are most of
   * what a good generation produces, so on a healthy turn the loop correctly
   * does nothing and there is nothing to watch. From the console:
   *
   *     document.querySelector('weave-surface').repair =
   *       { rounds: 1, includeAdvisory: true };
   *
   * and the next turn repairs its own `default_is_whole_response`, which is
   * the same code path a fatal takes.
   *
   * Read at session creation, so set it before the first send().
   */
  repair = undefined;

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
        diagnostics: withSeverity([{ source: 'host', code: 'request_failed', message: String(err?.message ?? err) }]),
      });
      return { status: 'failed', surface: '', catalogVersion: null };
    }
  }

  /**
   * Render a surface that already exists, with no request.
   *
   * Reopening a saved view is not a generation. Asking the model to rebuild it
   * would cost tokens, take seconds and hand back a different dashboard from
   * the one that was saved — so the stored DSL is drawn as-is.
   *
   * Still a live surface, not a picture: Queries fetch, Actions fire, `$state`
   * works. Only the generation is skipped.
   *
   * `catalogVersion` is the one the DSL was generated against, and it is
   * checked. A view saved before a design-system change can have had its
   * positional arguments rebound underneath it, and the host hears about that
   * through the same `catalog_version_mismatch` diagnostic a live turn raises.
   *
   * @param {string} dsl
   * @param {{catalogVersion?: string|null}} [opts]
   */
  async show(dsl, { catalogVersion = null } = {}) {
    const session = await this.#ensureSession();
    // A turn still streaming would overwrite what we are about to draw.
    this.#abort?.abort();
    this.#abort = null;
    return session.show(dsl, { catalogVersion });
  }

  /** The raw DSL of the last turn that produced a surface. */
  get currentSurface() { return this.#session?.currentSurface ?? ''; }
  /** `$state`, for a host that wants to read it. */
  get store() { return this.#session?.store ?? null; }

  async #ensureSession() {
    if (this.#session) return this.#session;
    // Together, so the manifest costs no latency of its own.
    const [catalog] = await Promise.all([
      this.catalog ?? loadCatalog(),
      loadSeverities(),
    ]);
    this.#session = createSurfaceSession({
      endpoint: this.getAttribute('endpoint') || '/weave/surface',
      catalog,
      ...(this.repair !== undefined && { repair: this.repair }),
      container: this.#stage,
      onMessage: (text) => this.#emit('weave-message', { text }),
      onAssistant: (text) => this.#emit('weave-assistant', { text }),
      onStatus: (s) => this.#emit('weave-status', s),
      onDiagnostics: (diagnostics) => this.#emit('weave-diagnostics', { diagnostics: withSeverity(diagnostics) }),
      onTurn: (record) => this.#emit('weave-turn', { record }),
    });
    return this.#session;
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

customElements.define('weave-surface', WeaveSurface);
