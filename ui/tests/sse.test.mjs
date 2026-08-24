/**
 * `readSseFrames` — the wire-format parser behind any POST-bodied SSE stream.
 *
 * These lock the parts a `data:`-line scanner gets wrong, because that is what
 * the codebase had and what the Weave surface stream cannot be read with: named
 * events, multi-line payloads, keep-alive comments, and the `\r` that arrives
 * at the end of one chunk with its `\n` at the start of the next.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { readSseFrames } = await import(new URL('../common/services/sse.js', import.meta.url).href);

/** A Response whose body emits `chunks` verbatim, one per tick. */
function stream(chunks, { holdOpen = false } = {}) {
  let release;
  const gate = new Promise((r) => (release = r));
  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
        await new Promise((r) => setTimeout(r, 1));
      }
      if (holdOpen) await gate;
      controller.close();
    },
  });
  return { res: new Response(body), release: () => release() };
}

const collect = async (chunks, opts) => {
  const frames = [];
  const { res } = stream(chunks);
  const out = await readSseFrames(res, { onFrame: (f) => frames.push(f), ...opts });
  return { frames, out };
};

test('reads named events with ids', async () => {
  const { frames, out } = await collect([
    'id: 1\nevent: surface\ndata: {"surfaceId":"s1"}\n\n',
    'id: 2\nevent: node\ndata: {"id":"root"}\n\n',
  ]);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { event: 'surface', data: '{"surfaceId":"s1"}', id: '1', retry: null });
  assert.equal(frames[1].event, 'node');
  assert.equal(out.lastEventId, '2');
  assert.equal(out.frames, 2);
});

test('an event with no event: field defaults to message', async () => {
  const { frames } = await collect(['data: hello\n\n']);
  assert.equal(frames[0].event, 'message');
});

test('joins repeated data lines with newlines and strips one trailing newline', async () => {
  const { frames } = await collect(['event: note\ndata: line one\ndata: line two\ndata:\n\n']);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, 'line one\nline two');
});

test('skips comments and does not fire for a data-less frame', async () => {
  // A keep-alive comment and a bare id heartbeat must both stay invisible — a
  // scanner that fires on every line turns each into a phantom frame.
  const { frames, out } = await collect([': keep-alive\n\n', 'id: 7\n\n', 'data: real\n\n']);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, 'real');
  assert.equal(out.lastEventId, '7', 'a data-less frame still advances the resume id');
});

test('strips exactly one space after the colon', async () => {
  const { frames } = await collect(['data:  two spaces\n\n', 'data:none\n\n']);
  assert.equal(frames[0].data, ' two spaces');
  assert.equal(frames[1].data, 'none');
});

test('handles CRLF and lone CR terminators', async () => {
  const { frames } = await collect(['event: a\r\ndata: crlf\r\n\r\n', 'event: b\rdata: cr\r\r']);
  assert.deepEqual(frames.map((f) => [f.event, f.data]), [['a', 'crlf'], ['b', 'cr']]);
});

test('a CR split across chunks is one terminator, not two', async () => {
  // The failure this locks out: treating the trailing \r as a line end emits a
  // spurious blank line, which dispatches the frame one field early.
  const { frames } = await collect(['event: split\r', '\ndata: body\r', '\n\r\n']);
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].event, frames[0].data], ['split', 'body']);
});

test('dispatches a final frame that has no trailing blank line', async () => {
  const { frames } = await collect(['event: end\ndata: {"status":"ok"}']);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'end');
});

test('reads retry and ignores an unknown field', async () => {
  const { frames } = await collect(['retry: 2500\nfoo: bar\ndata: x\n\n']);
  assert.equal(frames[0].retry, 2500);
});

test('a frame split across chunk boundaries is reassembled', async () => {
  const { frames } = await collect(['eve', 'nt: nod', 'e\nda', 'ta: {"id":"roo', 't"}\n', '\n']);
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].event, frames[0].data], ['node', '{"id":"root"}']);
});

test('aborting mid-stream stops the reader and reports aborted', async () => {
  const controller = new AbortController();
  const frames = [];
  const { res } = stream(['data: one\n\n', 'data: two\n\n'], { holdOpen: true });
  const out = await readSseFrames(res, {
    signal: controller.signal,
    onFrame: (f) => {
      frames.push(f);
      if (frames.length === 1) controller.abort();
    },
  });
  assert.equal(out.aborted, true);
  assert.ok(frames.length <= 2, 'no frames after the abort resolves');
});

test('an already-aborted signal reads nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const { res } = stream(['data: one\n\n']);
  const frames = [];
  const out = await readSseFrames(res, { signal: controller.signal, onFrame: (f) => frames.push(f) });
  assert.equal(out.aborted, true);
  assert.equal(frames.length, 0);
});

test('seeds and advances lastEventId for a resumed stream', async () => {
  const { out } = await collect(['data: x\n\n'], { lastEventId: '41' });
  assert.equal(out.lastEventId, '41', 'a frame with no id: leaves the seed in place');
  const second = await collect(['id: 42\ndata: y\n\n'], { lastEventId: '41' });
  assert.equal(second.out.lastEventId, '42');
});

test('rejects a response with no body', async () => {
  await assert.rejects(() => readSseFrames(/** @type {any} */ ({}), {}), TypeError);
});
