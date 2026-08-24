/**
 * @param {string} path Relative to `/api`.
 * @param {{ onMessage?: (data: any) => void, onError?: (e: Event) => void, onOpen?: (e: Event) => void }} [handlers]
 * @returns {EventSource}
 */
export function connectSSE(path, { onMessage, onError, onOpen } = {}) {
  // Same multi-tenant seam as apiFetch (see services/api.js): base from
  // window.nasikoConfig, credentialed when cross-origin.
  const base = window.nasikoConfig?.apiBase || "";
  const source = new EventSource(`${base}/api${path}`, base ? { withCredentials: true } : undefined);
  if (onOpen) source.addEventListener("open", onOpen);
  source.addEventListener("message", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (onMessage) onMessage(data);
    } catch {
      if (onMessage) onMessage(e.data);
    }
  });
  source.addEventListener("error", (e) => {
    if (onError) onError(e);
  });
  return source;
}

/**
 * @typedef {object} SseFrame
 * @property {string} event The `event:` field, or `"message"` when absent — the default the format defines.
 * @property {string} data The `data:` field(s) joined with newlines, one trailing newline stripped.
 * @property {string|null} id The `id:` this frame set, else null.
 * @property {number|null} retry The `retry:` this frame set, else null.
 */

/**
 * @typedef {object} SseReadResult
 * @property {string|null} lastEventId Last `id:` seen — what a reconnect sends as `Last-Event-ID`.
 * @property {boolean} aborted True when the caller's signal fired; render nothing further.
 * @property {number} frames Count of frames dispatched.
 */

/**
 * Read an SSE body to completion, dispatching one callback per frame.
 *
 * `EventSource` cannot open a stream whose request carries a body, so a POST
 * that answers `text/event-stream` has to be read by hand. This is a real
 * parser for the wire format rather than a `data:`-line scanner, and the
 * difference matters as soon as a stream uses named events: the format defines
 * a frame as a run of field lines terminated by a *blank line*, so scanning for
 * `data:` mis-reads any multi-line payload and cannot see `event:` at all.
 *
 * Implemented from the format, not from the one stream that exists today:
 *
 *   - `\n`, `\r\n` and a lone `\r` all terminate a line, and a `\r` at a chunk
 *     boundary is held back — the next chunk may open with `\n`, and the pair
 *     is one terminator rather than two
 *   - a blank line dispatches; a frame carrying no `data` field does not fire,
 *     which is how a bare `id:` heartbeat stays invisible to callers
 *   - a leading `:` is a comment (the usual keep-alive) and is skipped
 *   - one optional space after the colon is stripped, no more; a line with no
 *     colon is a field name with an empty value
 *   - repeated `data:` lines join with `\n`, and one trailing `\n` is removed
 *   - `event:` defaults to `message`; `id:` persists as the last-event-id
 *
 * Cancellation follows `utils/a2a-stream.js`, for the reason recorded there:
 * cancelling the reader is what unblocks a pending `read()`, and `aborted` is
 * decided from the signal afterwards, because a cancelled read resolves as
 * `{ done: true }` and is otherwise indistinguishable from a clean end.
 *
 * @param {Response} res A response whose body is an SSE stream.
 * @param {object} handlers
 * @param {(frame: SseFrame) => void} [handlers.onFrame] Called once per dispatched frame.
 * @param {AbortSignal} [handlers.signal] REQUIRED from a component — abort it in
 *   `disconnectedCallback`, or the reader keeps pulling into detached DOM.
 * @param {string|null} [handlers.lastEventId] Seed for a resumed stream.
 * @returns {Promise<SseReadResult>}
 */
export async function readSseFrames(res, { onFrame, signal, lastEventId = null } = {}) {
  if (!res || !res.body) throw new TypeError('readSseFrames() needs a Response with a body');
  /** @type {SseReadResult} */
  const out = { lastEventId, aborted: false, frames: 0 };

  let eventName = '';
  /** @type {string[]} */
  let dataLines = [];
  /** @type {string|null} */
  let frameId = null;
  /** @type {number|null} */
  let retry = null;
  let sawData = false;

  const reset = () => { eventName = ''; dataLines = []; frameId = null; retry = null; sawData = false; };

  const dispatch = () => {
    if (!sawData) { reset(); return; }
    let data = dataLines.join('\n');
    if (data.endsWith('\n')) data = data.slice(0, -1);
    out.frames += 1;
    const frame = { event: eventName || 'message', data, id: frameId, retry };
    reset();
    onFrame?.(frame);
  };

  /** @param {string} line */
  const handleLine = (line) => {
    if (line === '') { dispatch(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') { dataLines.push(value); sawData = true; }
    else if (field === 'id') { frameId = value; out.lastEventId = value; }
    else if (field === 'retry') {
      const ms = Number(value);
      if (Number.isInteger(ms) && ms >= 0) retry = ms;
    }
  };

  /**
   * Drain complete lines out of the buffer.
   * @param {boolean} atEnd True once the body is finished, when a trailing lone
   *   `\r` can no longer be the first half of a `\r\n` and is a terminator in
   *   its own right.
   */
  const drain = (atEnd) => {
    for (;;) {
      const i = buffer.search(/\r\n|\n|\r/);
      if (i === -1) return;
      if (!atEnd && buffer[i] === '\r' && i === buffer.length - 1) return; // hold: may be \r\n
      const width = buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1;
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + width);
      handleLine(line);
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => reader.cancel().catch(() => {});
  if (signal) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      out.aborted = true;
      return out;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
  } finally {
    if (signal?.aborted) out.aborted = true;
    signal?.removeEventListener('abort', onAbort);
  }

  // Nothing below may write through the caller's handlers after a cancellation:
  // the element that owns them is being removed.
  if (out.aborted) return out;

  buffer += decoder.decode();
  drain(true);
  if (buffer) { handleLine(buffer); buffer = ''; }
  // A well-formed stream ends with a blank line, which already dispatched. This
  // is for one that does not — the last frame is still in hand and is real data.
  dispatch();

  return out;
}
