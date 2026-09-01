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

/**
 * A catalog version this client can actually compare against.
 *
 * Ours is a content hash — twelve hex characters of sha256 over the vocabulary
 * (`gen-dsl-catalog.mjs:135`) — so two catalogs match if and only if every
 * component, attribute and parameter position matches. A hand-written literal
 * like "1.0" cannot express that: it stays "1.0" while the vocabulary underneath
 * it changes, which is the exact failure the hash exists to catch.
 */
const CONTENT_HASH = /^[0-9a-f]{12}$/;

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
   * Compare catalog versions, and say something useful either way.
   *
   * Comparing a hash to a literal is not a version check — the two can never be
   * equal, so a plain `!==` fired on every single turn. A warning that is always
   * on is a warning nobody reads, which means the day the catalogs genuinely
   * diverge it looks exactly like every other day. So an incomparable version is
   * reported as its own thing, once per turn, and only two real hashes are ever
   * compared for equality.
   */
  function reportCatalogVersion(remote) {
    const mine = catalog.catalogVersion;
    if (!remote || !mine) return;
    if (remote === mine) return;

    if (CONTENT_HASH.test(remote) && CONTENT_HASH.test(mine)) {
      onDiagnostics?.([{
        source: 'stream',
        code: 'catalog_version_mismatch',
        message: `generator built against catalog ${remote}, this client has ${mine} — `
          + 'component arguments may not mean what the generator thinks they mean',
      }]);
      return;
    }

    onDiagnostics?.([{
      source: 'stream',
      code: 'catalog_version_unverifiable',
      message: `generator reported catalog version "${remote}", which is not a content hash — `
        + `drift against this client's ${mine} cannot be detected`,
    }]);
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
    // TEMPORARY LOCAL TEST PATCH: no Rust proxy for /api/weave/surface exists yet
    // on `development`, so point straight at a locally-running weave2.0 instead of
    // going through nasikoConfig.apiBase (which every other call still uses).
    // Remove once the real control-plane proxy route lands.
    const base = 'http://localhost:8801';
    const res = await fetchImpl(`${base}/api${endpoint}`, {
      method: 'POST',
      // TEMPORARY LOCAL TEST PATCH: weave2.0 requires this header from the caller.
      // In the real architecture the Rust proxy adds it server-side (the browser
      // never holds it) — sent here only because we're bypassing that proxy locally.
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-weave-internal-token': 'local-dev-secret',
      },
      body: JSON.stringify({
        prompt,
        context: {
          ...(opts.context || {}),
          // The vocabulary this client will actually render with. The generator
          // treats it as the authority and refetches if it is holding anything
          // else, which is what closes the window where a deploy lands between
          // its catalog fetch and this request.
          catalogVersion: catalog.catalogVersion,
          currentSurface: currentSurface || undefined,
        },
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
            reportCatalogVersion(remoteCatalogVersion);
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
