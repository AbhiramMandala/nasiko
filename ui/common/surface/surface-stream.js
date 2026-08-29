/**
 * The host: one turn of conversation with the generator, rendered as it
 * arrives.
 *
 * POSTs a prompt, reads the SSE response, and re-runs the whole pipeline —
 * parse, materialize, render — on the accumulated buffer every time more text
 * lands. That is what produces the progressive build-up; there is no partial
 * update path, deliberately (see materialize.js).
 *
 * Three things here are the reason this is its own module rather than a few
 * lines in a page:
 *
 *   **Prose is output, not noise.** The generator is told to wrap its DSL in
 *   two plain sentences (agent.yaml rule 12). Those lines are the assistant
 *   talking and belong in the chat log. They also arrive character by character
 *   like everything else, so a line is only emitted once it is no longer the
 *   tail of the buffer — otherwise the user watches "Sure — buil" appear as a
 *   message.
 *
 *   **Paints are coalesced.** A fast stream lands many chunks per frame and
 *   each one re-renders the whole tree. Without coalescing that is dozens of
 *   full layouts a second for no visible benefit.
 *
 *   **The previous turn's raw DSL is the only surface state anywhere.** It goes
 *   back as `context.currentSurface` so the generator can revise by re-emitting
 *   a statement name. Nothing else is remembered, on either side.
 *
 * @module common/surface/surface-stream
 */

import { readSseFrames } from '../services/sse.js';
import { call as callDataSource } from '../core/data-sources.js';
import { parseBuffer } from './parser.js';
import { materialize, buildComponentIndex } from './materialize.js';
import { render } from './render.js';
import { createStore } from './store.js';
import { createQueryManager } from './queries.js';
import { createActionRunner } from './actions.js';

/** Frames the generator sends. Anything else is reported and ignored. */
const FRAMES = new Set(['surface', 'dsl-chunk', 'end', 'fail', 'message', 'note']);

/**
 * @param {{
 *   endpoint: string,
 *   catalog: {catalogVersion?: string, components: Record<string, any>},
 *   container: Element,
 *   onMessage?: (text: string) => void,
 *   onDiagnostics?: (d: object[]) => void,
 *   onStatus?: (s: {phase: string, detail?: string}) => void,
 *   onAction?: (action: object, el: Element) => void,
 *   onAssistant?: (text: string) => void,
 *   callDataSource?: (name: string, ...args: unknown[]) => unknown,
 *   fetchImpl?: typeof fetch,
 *   schedule?: (fn: () => void) => void,
 *   doc?: Document,
 * }} options
 */
export function createSurfaceSession(options) {
  const {
    endpoint, catalog, container,
    onMessage, onDiagnostics, onStatus, onAction, onAssistant,
    call = callDataSource,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    schedule = (fn) => (globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 0)))(fn),
    doc,
  } = options;

  const index = buildComponentIndex(catalog);

  let buffer = '';          // raw DSL accumulated this turn
  let currentSurface = '';  // the last turn that actually produced a surface
  let proseEmitted = 0;     // how many prose lines onMessage has seen
  let lastDiagnosticsKey = '';
  let painting = false;
  let ended = false;

  const store = createStore();
  /** Diagnostics raised outside a draw pass — a fetch that failed later, say. */
  const liveDiagnostics = [];
  const queries = createQueryManager({
    call,
    onChange: () => paint(),
    onDiagnostic: (d) => { liveDiagnostics.push(d); onDiagnostics?.([d]); },
  });
  /** The evaluator belonging to the most recent pass. Actions read through it. */
  let lastOut = null;

  const actions = createActionRunner({
    store,
    queries,
    // Synchronous re-walk. `@Set` then `@Run` in one Action only works because
    // this runs between them — see actions.js.
    refresh: () => walk(),
    onAssistant: (text) => onAssistant?.(text),
    onDiagnostic: (d) => onDiagnostics?.([d]),
  });

  // A `$state` write repaints. It never re-fetches: that is `@Run`'s job alone
  // (agent.yaml rule 5), and queries.sync() is what keeps that promise.
  store.subscribe(() => paint());

  /** Coalesced repaint: many chunks inside one frame paint once. */
  function paint() {
    if (painting) return;
    painting = true;
    schedule(() => { painting = false; draw(); });
  }

  /**
   * Parse and materialize, without touching the DOM.
   *
   * Split out from `draw()` because an Action needs a fresh symbol table
   * mid-flight — after `@Set` and before `@Run` — and doing that through a
   * repaint would make the fetch depend on a frame having been scheduled.
   */
  function walk() {
    const { statements } = parseBuffer(buffer);
    const out = materialize(statements, index, {
      store,
      queryResults: queries.results,
      mutationResults: queries.mutationResults,
    });
    // Declared defaults first: `@Reset` resets to what the DSL says, and a
    // revision turn can move that.
    store.initialize(out.stateDefaults);
    queries.sync(out.queries, out.mutations);
    lastOut = out;
    return out;
  }

  function draw() {
    const { prose } = parseBuffer(buffer);

    // A prose line still being typed is the tail of the buffer. Holding that
    // one back is what stops half a sentence appearing as a chat message.
    const tail = prose[prose.length - 1];
    const settled = ended || !tail || !buffer.trimEnd().endsWith(tail) ? prose.length : prose.length - 1;
    for (let i = proseEmitted; i < settled; i++) onMessage?.(prose[i]);
    proseEmitted = Math.max(proseEmitted, settled);

    const out = walk();
    const diagnostics = [...out.diagnostics];

    render(out.root, container, catalog, {
      doc,
      onAction: (action, el) => {
        // The evaluator handed over is the one from the pass that built this
        // element — an `@Each` row lives in its scope chain and nowhere else.
        const ev = out.evaluateAst;
        onAction?.(action, el);
        void actions.run(action, ev);
      },
      onDiagnostic: (d) => diagnostics.push(d),
    });

    // Once per settled pass, and only when the set changed — the same
    // diagnostics on every chunk is noise nobody reads.
    const key = JSON.stringify(diagnostics);
    if (key !== lastDiagnosticsKey) {
      lastDiagnosticsKey = key;
      if (diagnostics.length) onDiagnostics?.(diagnostics);
    }

    return out;
  }

  /**
   * Run one turn.
   *
   * @param {string} prompt
   * @param {{signal?: AbortSignal, context?: object}} [opts]
   * @returns {Promise<{status: string, surface: string, catalogVersion: string|null}>}
   */
  async function send(prompt, opts = {}) {
    buffer = '';
    proseEmitted = 0;
    lastDiagnosticsKey = '';
    ended = false;
    let status = 'ok';
    let remoteCatalogVersion = null;

    onStatus?.({ phase: 'requesting' });

    // Same multi-tenant seam as apiFetch: base from window.nasikoConfig.
    const base = globalThis.window?.nasikoConfig?.apiBase || '';
    const res = await fetchImpl(`${base}/api${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        prompt,
        context: { ...(opts.context || {}), currentSurface: currentSurface || undefined },
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      onStatus?.({ phase: 'failed', detail: `HTTP ${res.status}` });
      return { status: 'http_error', surface: currentSurface, catalogVersion: null };
    }

    onStatus?.({ phase: 'streaming' });

    await readSseFrames(res, {
      signal: opts.signal,
      onFrame: ({ event, data }) => {
        if (!FRAMES.has(event)) {
          onDiagnostics?.([{ source: 'stream', code: 'unknown_frame', message: `ignored "${event}"` }]);
          return;
        }
        let body = {};
        if (data) {
          try {
            body = JSON.parse(data);
          } catch {
            onDiagnostics?.([{ source: 'stream', code: 'malformed_frame', message: `frame "${event}" carried unparseable JSON` }]);
            return;
          }
        }

        switch (event) {
          case 'surface':
            remoteCatalogVersion = body.catalogVersion ?? null;
            // Not fatal — the generator may legitimately be a version behind.
            // Saying so beats a dashboard quietly wrong about which components
            // exist and what their arguments mean.
            if (remoteCatalogVersion && catalog.catalogVersion
                && remoteCatalogVersion !== catalog.catalogVersion) {
              onDiagnostics?.([{
                source: 'stream',
                code: 'catalog_version_mismatch',
                message: `generator built against ${remoteCatalogVersion}, this client has ${catalog.catalogVersion}`,
              }]);
            }
            break;

          case 'dsl-chunk':
            buffer += body.text ?? '';
            paint();
            break;

          case 'message': // the generator answering rather than building
            if (body.text) onMessage?.(body.text);
            break;

          case 'note':
            onDiagnostics?.([{ source: 'generator', code: body.code ?? 'note', message: body.message }]);
            break;

          case 'end':
            status = body.status ?? 'ok';
            break;

          case 'fail':
            status = 'failed';
            onDiagnostics?.([{ source: 'generator', code: body.code ?? 'stream_failed', message: body.message }]);
            break;

          default:
            break;
        }
      },
    });

    ended = true;
    // One final synchronous pass, so the last chunk and the closing sentence
    // are on screen before this resolves rather than a frame later.
    const out = draw();

    // Only a turn that produced a surface replaces the one a revision builds
    // from. A conversational turn must not wipe the dashboard.
    if (out.root) currentSurface = buffer;

    onStatus?.({ phase: status === 'ok' ? 'done' : 'failed' });
    return { status, surface: currentSurface, catalogVersion: remoteCatalogVersion };
  }

  return {
    send,
    /** Raw DSL of the last surface-producing turn. */
    get currentSurface() { return currentSurface; },
    /** Accumulated text of the turn in flight. */
    get buffer() { return buffer; },
    /** `$state`, for a host that wants to read or seed it. */
    store,
    /** Query manager, for tests and for a host that needs to await settlement. */
    queries,
    /** Fire an Action by hand — the acceptance flow and tests use this. */
    runAction: (action) => actions.run(action, lastOut?.evaluateAst ?? null),
    /** The most recent materialization. */
    get lastResult() { return lastOut; },
    reset() {
      buffer = '';
      currentSurface = '';
      proseEmitted = 0;
      lastDiagnosticsKey = '';
      lastOut = null;
      liveDiagnostics.length = 0;
      queries.reset();
      store.clear();
      container.replaceChildren();
    },
    dispose() { queries.dispose(); },
  };
}
