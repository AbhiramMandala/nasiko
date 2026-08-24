/**
 * The stream state machine: frames in, one spec object out.
 *
 * This is the load-bearing property of the protocol — collecting every frame
 * yields exactly the spec that a saved surface would be, so streamed render,
 * preview and replay are one code path rather than three that drift. Keeping it
 * here, pure and DOM-free, is what makes that checkable in a unit test instead
 * of by eye.
 *
 * It also owns the protocol's revision rules, because they are state rules
 * rather than paint rules:
 *
 *   - `surface` is at most once. Absent means the turn was conversation, not a
 *     build, and the caller keeps whatever surface it already had.
 *   - `node` and `data` are both idempotent by key — resend to revise. One
 *     revision model, not two.
 *   - A redeclared `data` whose (source, args, select) is unchanged is a no-op,
 *     so a generator that re-emits its declarations does not cost a request per
 *     emission.
 *   - Reachability from `root` is evaluated only at `end`. Mid-stream an
 *     unreachable node is normal: it is either not yet attached, or it was
 *     deliberately detached by resending its parent with a shorter `children`,
 *     which is how a node is removed.
 *
 * @module features/weave-surface/collect
 */

/** Frame names that carry surface state, as opposed to chat or diagnostics. */
const STRUCTURAL = new Set(['surface', 'data', 'node']);

function emptySpec() {
  return {
    specVersion: /** @type {string|null} */ (null),
    catalogVersion: /** @type {string|null} */ (null),
    surfaceId: /** @type {string|null} */ (null),
    title: /** @type {string|null} */ (null),
    /** @type {Record<string, any>} */ data: {},
    /** @type {Record<string, any>} */ nodes: {},
  };
}

/** Stable identity of a declaration, for the no-op check. */
function declKey(d) {
  return JSON.stringify([d?.source ?? null, d?.args ?? null, d?.select ?? null]);
}

/**
 * A running mirror of the stream.
 *
 * `apply()` returns what changed rather than mutating something the caller then
 * has to diff. That is what lets the renderer repaint one subtree instead of
 * the world, and it is why the return is a descriptor and not a boolean.
 *
 * @param {{ nodeCap?: number }} [limits]
 */
export function createCollector({ nodeCap = 500 } = {}) {
  let spec = emptySpec();
  /** @type {{level: string, code: string, message?: string, pointer?: string}[]} */
  const diagnostics = [];
  /** @type {string[]} */
  const messages = [];
  let status = 'open';
  let sawSurface = false;
  /** @type {string|null} */
  let terminal = null;

  const note = (code, message, pointer) => {
    diagnostics.push({ level: 'warn', code, ...(message && { message }), ...(pointer && { pointer }) });
  };

  /**
   * Apply one frame.
   * @param {{event: string, data: string|object, id?: string|null}} frame
   * @returns {{type: string, [k: string]: any}}
   */
  function apply(frame) {
    const { event } = frame;
    let payload = frame.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        note('malformed_frame', `frame "${event}" carried unparseable JSON`, String(frame.id ?? ''));
        return { type: 'ignored', reason: 'malformed_frame' };
      }
    }
    const body = /** @type {any} */ (payload) || {};

    if (terminal && STRUCTURAL.has(event)) {
      note('frame_after_terminal', `"${event}" arrived after ${terminal}`, String(frame.id ?? ''));
      return { type: 'ignored', reason: 'frame_after_terminal' };
    }

    switch (event) {
      case 'surface': {
        if (sawSurface) {
          note('duplicate_surface', 'a second surface frame was ignored');
          return { type: 'ignored', reason: 'duplicate_surface' };
        }
        sawSurface = true;
        spec.specVersion = body.specVersion ?? null;
        spec.catalogVersion = body.catalogVersion ?? null;
        spec.surfaceId = body.surfaceId ?? null;
        spec.title = body.title ?? null;
        return { type: 'surface', surface: { ...spec } };
      }

      case 'data': {
        const bind = body.bind;
        if (typeof bind !== 'string' || !bind) {
          note('malformed_frame', 'a data frame arrived with no bind');
          return { type: 'ignored', reason: 'malformed_frame' };
        }
        const next = { source: body.source, args: body.args ?? {}, select: body.select ?? null };
        const prev = spec.data[bind];
        // Identical redeclaration: the generator re-emitted what it already
        // said. Refetching here would cost one request per emission for no new
        // information.
        if (prev && declKey(prev) === declKey(next)) {
          return { type: 'data', bind, changed: false, refetch: false };
        }
        spec.data[bind] = next;
        return { type: 'data', bind, changed: true, refetch: true, replaced: Boolean(prev) };
      }

      case 'node': {
        const id = body.id;
        if (typeof id !== 'string' || !id) {
          note('malformed_frame', 'a node frame arrived with no id');
          return { type: 'ignored', reason: 'malformed_frame' };
        }
        if (!spec.nodes[id] && Object.keys(spec.nodes).length >= nodeCap) {
          note('node_limit_exceeded', `surface exceeded ${nodeCap} nodes`, id);
          return { type: 'ignored', reason: 'node_limit_exceeded' };
        }
        const prev = spec.nodes[id];
        spec.nodes[id] = {
          type: body.type,
          ...(body.props && { props: body.props }),
          ...(body.children && { children: body.children }),
          ...(body.repeat !== undefined && { repeat: body.repeat }),
          ...(body.slot && { slot: body.slot }),
        };
        return { type: 'node', id, changed: true, replaced: Boolean(prev) };
      }

      case 'message': {
        const text = typeof body.text === 'string' ? body.text : '';
        if (text) messages.push(text);
        return { type: 'message', text };
      }

      case 'note': {
        diagnostics.push({
          level: body.level ?? 'info',
          code: body.code ?? 'note',
          ...(body.message && { message: body.message }),
          ...(body.pointer && { pointer: body.pointer }),
        });
        return { type: 'note', note: body };
      }

      case 'end': {
        terminal = 'end';
        const dropped = sweepUnreachable();
        status = body.status === 'partial' || dropped.length ? 'partial' : (body.status ?? 'ok');
        return { type: 'end', status, dropped, declaredNodeCount: body.nodeCount ?? null };
      }

      case 'fail': {
        terminal = 'fail';
        status = 'failed';
        diagnostics.push({ level: 'error', code: body.code ?? 'stream_failed', message: body.message });
        return { type: 'fail', code: body.code ?? 'stream_failed', message: body.message };
      }

      default:
        note('unknown_frame', `ignored unrecognised frame "${event}"`);
        return { type: 'ignored', reason: 'unknown_frame' };
    }
  }

  /**
   * Drop every node not reachable from `root`, and report each one.
   *
   * Run once, at `end`. Running it mid-stream would flag every node that
   * arrived before its parent, which the protocol explicitly permits.
   */
  function sweepUnreachable() {
    const ids = Object.keys(spec.nodes);
    if (!ids.length) return [];
    if (!spec.nodes.root) {
      note('no_root', 'the surface declared no root node');
      return [];
    }
    const seen = new Set();
    const walk = (id) => {
      if (seen.has(id) || !spec.nodes[id]) return;
      seen.add(id);
      for (const child of spec.nodes[id].children ?? []) walk(child);
    };
    walk('root');
    const dropped = ids.filter((id) => !seen.has(id));
    for (const id of dropped) {
      note('orphan_node', 'not reachable from root at end of stream', id);
      delete spec.nodes[id];
    }
    return dropped;
  }

  return {
    apply,
    get spec() { return spec; },
    get diagnostics() { return diagnostics; },
    get messages() { return messages; },
    get status() { return status; },
    get hasSurface() { return sawSurface; },
    get terminal() { return terminal; },
    reset() {
      spec = emptySpec();
      diagnostics.length = 0;
      messages.length = 0;
      status = 'open';
      sawSurface = false;
      terminal = null;
    },
  };
}

/**
 * Convenience for tests and for replaying a saved stream: frames in, spec out.
 * @param {{event: string, data: string|object, id?: string|null}[]} frames
 * @param {{ nodeCap?: number }} [limits]
 */
export function collect(frames, limits) {
  const c = createCollector(limits);
  for (const f of frames) c.apply(f);
  return { spec: c.spec, diagnostics: c.diagnostics, messages: c.messages, status: c.status, hasSurface: c.hasSurface };
}
