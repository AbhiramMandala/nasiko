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
 *   two plain sentences (agent.yaml's two-sentence wrapper rule). Those lines
 *   are the assistant
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
import { router } from '../core/router.js';
import { parseBuffer } from './parser.js';
import { materialize, buildComponentIndex } from './materialize.js';
import { render } from './render.js';
import { captureFocus, restoreFocus } from './focus.js';
import { createStore } from './store.js';
import { pruneUnreachable } from './gc.js';
import { createQueryManager } from './queries.js';
import { createActionRunner } from './actions.js';
import { createSurfaceTelemetry } from './telemetry.js';

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

/** How many times a dropped stream is picked back up before giving up. */
const MAX_RESUMES = 2;
const RESUME_BACKOFF_MS = 250;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A developer pointing this browser at a Weave running on their own machine.
 *
 * The control-plane proxy at `POST /api/weave/surface` is the normal path and
 * holds the token server-side; this exists for the case the proxy cannot
 * cover — reaching a Weave the control plane is not configured for, without
 * rebuilding the Rust server. The alternative people reach for is hardcoding
 * the endpoint and the shared secret into this file, which is how a secret
 * gets published. The values come from the developer's own browser instead:
 *
 *   localStorage.setItem('weave-direct', JSON.stringify({
 *     baseUrl: 'http://localhost:8801', token: '…'
 *   }))
 *
 * Absent in every normal build, so the request is same-origin and the token
 * stays server-side where it belongs.
 */
function readDirectConfig() {
  const configured = globalThis.window?.nasikoConfig?.weaveDirect;
  if (configured?.baseUrl) return configured;
  try {
    const raw = globalThis.localStorage?.getItem('weave-direct');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.baseUrl ? parsed : null;
  } catch {
    return null; // a browser with storage disabled is not a broken browser
  }
}

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
 *   call?: (name: string, ...args: unknown[]) => unknown,
 *   routes?: {has(path: string): boolean}|null,
 *   navigate?: (path: string) => void,
 *   onTurn?: (record: object) => void,
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
    // The live route table, not a copy — see render.js and actions.js. A host
    // may inject a stand-in for tests; passing null refuses every route.
    routes = router,
    navigate = (path) => router.navigate(path),
    onTurn,
    fetchImpl = globalThis.fetch?.bind(globalThis),
    schedule = (fn) => (globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 0)))(fn),
    // Resolved here rather than left undefined for render.js to fall back on.
    // The fallback made this field look optional while `activeElement` needs a
    // real one: captureFocus would have taken undefined and returned null on
    // every paint, so the caret fix would have been dead in production and
    // green in every test that injects a recorder.
    doc = globalThis.document,
  } = options;

  // Checked here rather than left to the first property read, because the two
  // failures look nothing alike from the outside. Omitted, `buildComponentIndex`
  // threw `Cannot read properties of undefined (reading 'components')` from
  // inside the constructor — a host that wrapped its send in a try/catch saw
  // only a failed turn and told the user Weave was unreachable, which sent the
  // debugging at a running server instead of at the missing argument.
  if (!catalog || typeof catalog !== 'object' || !catalog.components) {
    throw new TypeError(
      'createSurfaceSession requires a `catalog` — load /common/surface/dsl-catalog.json '
      + '(common/surface/catalog-load.js#loadCatalog) and pass it. Without it no turn can '
      + 'be built, and the failure surfaces as an unreachable generator.',
    );
  }

  const index = buildComponentIndex(catalog);

  let buffer = '';          // raw DSL accumulated this turn
  let currentSurface = '';  // the last turn that actually produced a surface
  let proseEmitted = 0;     // how many prose lines onMessage has seen
  let lastDiagnosticsKey = '';
  let painting = false;
  let ended = false;

  const telemetry = createSurfaceTelemetry({ report: onTurn });
  /** Every diagnostic, wherever it came from, is both shown and counted. */
  const emitDiagnostics = (list) => {
    if (!list?.length) return;
    telemetry.record(list);
    onDiagnostics?.(list);
  };

  const store = createStore();
  /** Diagnostics raised outside a draw pass — a fetch that failed later, say. */
  const liveDiagnostics = [];
  const queries = createQueryManager({
    call,
    onChange: () => paint(),
    onDiagnostic: (d) => { liveDiagnostics.push(d); emitDiagnostics([d]); },
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
    onDiagnostic: (d) => emitDiagnostics([d]),
    routes,
    navigate,
  });

  // A `$state` write repaints. It never re-fetches: that is `@Run`'s job alone
  // (agent.yaml rule 5), and queries.sync() is what keeps that promise.
  store.subscribe(() => paint());

  /** Coalesced repaint: many chunks inside one frame paint once. */
  function paint() {
    if (painting) return;
    painting = true;
    schedule(() => {
      painting = false;
      // A throw here is not a component's fault — render.js already catches
      // those per node — so it is ours, on half-arrived text. Letting it escape
      // would abandon the turn: `painting` is already false, but nothing would
      // ever call draw() again for chunks that might well parse. Report and
      // keep the stream alive; the buffer only grows, so the next chunk gets
      // another attempt at the same statements.
      try {
        draw();
      } catch (err) {
        emitDiagnostics([{
          source: 'stream',
          code: 'paint_failed',
          message: `a paint failed and was skipped: ${err?.message ?? err}`,
        }]);
      }
    });
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
      emitDiagnostics([{
        source: 'stream',
        code: 'catalog_version_mismatch',
        message: `generator built against catalog ${remote}, this client has ${mine} — `
          + 'component arguments may not mean what the generator thinks they mean',
      }]);
      return;
    }

    emitDiagnostics([{
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
      // Orphan reporting waits for the last pass. Mid-stream a statement is
      // routinely unreferenced for a chunk or two, until the parent that
      // points at it arrives.
      complete: ended,
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

    // Every paint replaces the whole tree, including whatever the user is
    // typing into — and a `$state` write is itself a paint, so a filter box
    // wired to @Set($q, $event) destroys itself on its own keystroke. Captured
    // here rather than inside render.js: that module is a pure tree-to-DOM
    // function, testable without a document, and `activeElement` is not its
    // business. See focus.js for why the restore refuses rather than guesses.
    const focused = captureFocus(container, doc);

    render(out.root, container, catalog, {
      doc,
      onAction: (action, el, domEvent) => {
        // Two things travel with the action. The evaluator from the pass that
        // built this element, because an `@Each` row lives in its scope chain
        // and nowhere else. And the DOM event, because `$event` is the only
        // way a step can read what the user just typed.
        const evaluator = out.evaluateAst;
        onAction?.(action, el, domEvent);
        void actions.run(action, evaluator, domEvent);
      },
      routes,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    restoreFocus(container, focused);

    // Once per settled pass, and only when the set changed — the same
    // diagnostics on every chunk is noise nobody reads.
    const key = JSON.stringify(diagnostics);
    if (key !== lastDiagnosticsKey) {
      lastDiagnosticsKey = key;
      if (diagnostics.length) emitDiagnostics(diagnostics);
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
    // Seeded with the previous turn's pruned surface, not emptied. agent.yaml
    // rule 8 tells the generator that on a revision turn it must ONLY EMIT
    // STATEMENTS THAT ARE NEW OR ACTUALLY CHANGING — and materialize.js's own
    // symbol table already implements "a later statement with the same name
    // replaces the earlier one" as, in its own words, "the whole revision
    // model". But that model only replaces what it is actually handed: an
    // empty buffer means a delta-only turn's parsed statements ARE the whole
    // symbol table, so `root` itself (never re-emitted, because it did not
    // change) is simply absent and the entire surface disappears. Seeding
    // with `currentSurface` here — pure DSL; gc.js's pruning never keeps
    // prose — is what makes both halves true at once: the model only sends
    // the diff, and the screen keeps showing everything else, because the
    // new statements naturally override the seeded ones by name.
    // No trailing newline from pruneUnreachable's own join, so a newline is
    // added here — without it the first incoming chunk (usually the prose
    // sentence) would concatenate directly onto the seed's last DSL line with
    // nothing separating them, corrupting the parser's line-based statement
    // boundary.
    //
    // Captured once as `turnSeed`, not recomputed inline at every reset point:
    // a mid-turn restart (the `sawSurface` branch in handleFrame, below) must
    // discard back to this SAME seed, not to '' — otherwise a restart mid a
    // delta-only revision turn would drop the very thing this fix exists to
    // keep, silently reintroducing the blank-screen bug in that one path.
    const turnSeed = currentSurface ? `${pruneUnreachable(currentSurface, store)}\n` : '';
    buffer = turnSeed;
    proseEmitted = 0;
    lastDiagnosticsKey = '';
    ended = false;
    let status = 'ok';
    let remoteCatalogVersion = null;
    let sawSurface = false;

    telemetry.begin({ promptLength: String(prompt ?? '').length, catalogVersion: catalog.catalogVersion });
    onStatus?.({ phase: 'requesting' });

    // Where the request goes.
    //
    // Normally same-origin: the control plane proxies to Weave and adds the
    // shared secret server-side, so the browser never holds it. Until that
    // proxy is what a normal build talks to, and it holds the token. A
    // developer can still point straight at a local Weave — but the token for
    // that comes from the developer's own machine, never from this file. A
    // secret in shipped source is a secret that is published, whatever the
    // comment above it says.
    const direct = readDirectConfig();
    if (direct) {
      emitDiagnostics([{
        source: 'stream',
        code: 'weave_direct',
        message: `talking to ${direct.baseUrl} directly, with a token held in this browser — `
          + 'local development only, and never how a deployed build should work',
      }]);
    }
    const base = direct?.baseUrl ?? (globalThis.window?.nasikoConfig?.apiBase || '');
    const url = `${base}/api${endpoint}`;
    const body = JSON.stringify({
      prompt,
      context: {
        ...(opts.context || {}),
        // The vocabulary this client will actually render with. The generator
        // treats it as the authority and refetches if it is holding anything
        // else, which is what closes the window where a deploy lands between
        // its catalog fetch and this request.
        catalogVersion: catalog.catalogVersion,
        // Pruned and re-stated here rather than when it was stored, because
        // both corrections are only true as of now. Statements nothing
        // references are dropped, so a card the model wrote and orphaned
        // three turns ago stops being handed back as though it were on
        // screen. And each `$state` line is rewritten to what the store
        // actually holds — the user does their switching *after* the turn
        // ends, so a value frozen at turn end would always be the stale one,
        // and the model would revise the cost view while the user sits on
        // ops.
        currentSurface: currentSurface ? pruneUnreachable(currentSurface, store) : undefined,
      },
    });

    let attempt = 0;
    let lastEventId = null;
    let terminal = false;

    while (!terminal) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(direct?.token ? { 'x-weave-internal-token': direct.token } : {}),
          // A resumed request says where it got to. A server that honours it
          // replays from there; one that does not starts over, which the
          // `surface` frame below detects.
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        },
        body,
        signal: opts.signal,
      });

      if (!res.ok) {
        // Say which status, and what the body said. The proxy answers a JSON
        // `{error}` that names the actual problem — "weave generation is not
        // configured on this deployment" for a missing token, "the generation
        // service is unreachable" for a dead upstream. Reporting a bare
        // `http_error` threw that away and left the status pill as the only
        // evidence, which is a symptom with the cause already in hand.
        //
        // Bounded and best-effort: an error body is small, but this must not
        // hang or throw on a server that sends something else.
        let detail = '';
        try {
          const text = (await res.text()).slice(0, 300).trim();
          if (text) {
            try { detail = JSON.parse(text).error ?? text; } catch { detail = text; }
          }
        } catch { /* a body we cannot read is not worse than no body */ }
        emitDiagnostics([{
          source: 'stream',
          code: 'http_error',
          message: `${url} answered ${res.status}${detail ? ` — ${detail}` : ''}`,
        }]);
        onStatus?.({ phase: 'failed', detail: `HTTP ${res.status}` });
        telemetry.end({ status: 'http_error', rendered: false });
        return { status: 'http_error', surface: currentSurface, catalogVersion: null };
      }

      // A 200 that is not an event stream is not a stream that dropped — it is
      // something else answering. The shape that cost an evening: a control
      // plane with no `/api/weave/surface` route falls the request through to
      // the SPA fallback, which serves index.html with a 200. Read as a stream,
      // that is indistinguishable from a dead connection — no frames, no
      // terminal frame — so the resume loop below spends two more requests
      // proving it again and then reports "the stream dropped", which sends you
      // looking at the network instead of at the router.
      //
      // The answer was in the response headers the whole time.
      const contentType = res.headers?.get?.('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        emitDiagnostics([{
          source: 'stream',
          code: 'not_an_event_stream',
          message: `${url} answered ${res.status} with `
            + `${contentType || 'no content-type'} — that is not the generator. `
            + 'A control plane without the /api/weave/surface route serves the '
            + 'page shell here instead.',
        }]);
        onStatus?.({ phase: 'failed', detail: 'not an event stream' });
        telemetry.end({ status: 'not_an_event_stream', rendered: false });
        return {
          status: 'not_an_event_stream',
          surface: currentSurface,
          catalogVersion: null,
        };
      }

      onStatus?.({ phase: attempt ? 'resuming' : 'streaming' });

      const read = await readSseFrames(res, {
        signal: opts.signal,
        lastEventId,
        onFrame: (frame) => { if (handleFrame(frame)) terminal = true; },
      });
      lastEventId = read.lastEventId ?? lastEventId;

      if (terminal || read.aborted || opts.signal?.aborted) break;

      // The stream ended without saying it was finished, which means the
      // connection dropped. Losing the turn here costs the user a re-prompt
      // and costs us a second generation anyway, so retrying is cheaper than
      // not — but only a couple of times, because a server that closes
      // immediately would otherwise be an infinite loop.
      attempt++;
      if (attempt > MAX_RESUMES) {
        status = 'interrupted';
        emitDiagnostics([{
          source: 'stream',
          code: 'stream_interrupted',
          message: `the stream dropped and did not recover after ${MAX_RESUMES} attempts`,
        }]);
        break;
      }
      emitDiagnostics([{
        source: 'stream',
        code: 'stream_resumed',
        message: `the stream dropped mid-generation; resuming from ${lastEventId ?? 'the start'}`,
      }]);
      await delay(RESUME_BACKOFF_MS * attempt);
    }

    onStatus?.({ phase: 'streaming' });

    /** @returns {boolean} true when this frame ends the turn */
    function handleFrame({ event, data }) {
      if (!FRAMES.has(event)) {
        emitDiagnostics([{ source: 'stream', code: 'unknown_frame', message: `ignored "${event}"` }]);
        return false;
      }
      let body = {};
      if (data) {
        try {
          body = JSON.parse(data);
        } catch {
          emitDiagnostics([{ source: 'stream', code: 'malformed_frame', message: `frame "${event}" carried unparseable JSON` }]);
          return false;
        }
      }

      switch (event) {
        case 'surface':
          // A second `surface` frame means the server started the generation
          // over rather than replaying from Last-Event-ID. Whatever is in the
          // buffer belongs to the abandoned attempt, and appending to it would
          // splice two different dashboards together. Discarded back to
          // `turnSeed`, not '' — this turn may itself be a revision turn, and
          // '' would drop the seeded prior surface a restart has no reason to
          // touch.
          if (sawSurface) {
            buffer = turnSeed;
            proseEmitted = 0;
            emitDiagnostics([{
              source: 'stream',
              code: 'stream_restarted',
              message: 'the generator restarted rather than resuming; the partial surface was discarded',
            }]);
          }
          sawSurface = true;
          remoteCatalogVersion = body.catalogVersion ?? null;
          telemetry.identify({ surfaceId: body.surfaceId, catalogVersion: remoteCatalogVersion });
          reportCatalogVersion(remoteCatalogVersion);
          return false;

        case 'dsl-chunk':
          buffer += body.text ?? '';
          telemetry.chunk();
          paint();
          return false;

        case 'message': // the generator answering rather than building
          if (body.text) onMessage?.(body.text);
          return false;

        case 'note':
          emitDiagnostics([{ source: 'generator', code: body.code ?? 'note', message: body.message }]);
          return false;

        case 'end':
          status = body.status ?? 'ok';
          return true;

        case 'fail':
          status = 'failed';
          emitDiagnostics([{ source: 'generator', code: body.code ?? 'stream_failed', message: body.message }]);
          return true;

        default:
          return false;
      }
    }

    ended = true;
    // One final synchronous pass, so the last chunk and the closing sentence
    // are on screen before this resolves rather than a frame later.
    const out = draw();

    // Only a turn that produced a surface replaces the one a revision builds
    // from. A conversational turn must not wipe the dashboard.
    //
    // Stored raw: this is the faithful record of what the model emitted, and
    // pruning belongs at send time instead — see the call site below.
    if (out.root) currentSurface = buffer;

    onStatus?.({ phase: status === 'ok' ? 'done' : 'failed' });
    // One record for the whole turn. `rendered` is the honest measure of
    // whether the user got anything — a turn can end "ok" and draw nothing.
    telemetry.end({
      status,
      statements: lastOut?.symbols?.size ?? 0,
      rendered: Boolean(out.root),
    });
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
    runAction: (action, ev = null) => actions.run(action, lastOut?.evaluateAst ?? null, ev),
    /** The most recent materialization. */
    get lastResult() { return lastOut; },
    /** Subscribe to the per-turn telemetry record. */
    onTurn: (fn) => telemetry.onTurn(fn),
    /**
     * Render a finished DSL string, with no network call.
     *
     * Reopening a saved view is not a generation: the DSL already exists and
     * asking the model to produce it again would be slower, cost tokens and
     * return something different. But `send()` was the only way in — every
     * other entry point is wired to a live SSE turn — so a stored surface had
     * nowhere to go. This is that entry point.
     *
     * Deliberately the same `draw()` the stream uses, not a parallel path.
     * Queries fire, Actions bind, `$state` seeds, focus is preserved and every
     * diagnostic reports exactly as it does live. A second renderer that
     * "just draws it" would drift from the real one, and the drift would show
     * up as a saved dashboard behaving subtly differently from the one the
     * user watched being generated — the hardest kind of bug to be told about.
     *
     * `catalogVersion` is checked the same way a streamed one is. A view saved
     * six weeks ago against an older catalog is the case that check exists
     * for: positional arguments may have been rebound underneath it, and the
     * caller gets `catalog_version_mismatch` rather than a plausible-looking
     * dashboard whose columns have quietly shifted.
     *
     * @param {string} dsl the stored surface text, exactly as it was saved
     * @param {{catalogVersion?: string|null}} [opts]
     * @returns {{root: object|null, diagnostics: object[], unresolved: string[]}}
     */
    show(dsl, { catalogVersion = null } = {}) {
      this.reset();
      buffer = String(dsl ?? '');
      // Nothing more is coming, so `complete` diagnostics — orphans, the root
      // check — run on the first and only pass rather than waiting for an end
      // frame that will never arrive.
      ended = true;
      reportCatalogVersion(catalogVersion);
      const out = draw();
      currentSurface = buffer;
      return out;
    },

    reset() {
      buffer = '';
      currentSurface = '';
      proseEmitted = 0;
      lastDiagnosticsKey = '';
      // Turn state like the three above. Left set, a reset after show() would
      // leave the next paint believing a surface it has not seen is finished.
      // send() happens to clear it too; that is its own defence, not this one's.
      ended = false;
      lastOut = null;
      liveDiagnostics.length = 0;
      queries.reset();
      store.clear();
      container.replaceChildren();
    },
    dispose() { queries.dispose(); },
  };
}
