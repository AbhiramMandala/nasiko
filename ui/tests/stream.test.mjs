/**
 * Cancellation behaviour of the A2A stream reader.
 *
 * The defect being locked out: `readA2aStream` took no AbortSignal, and neither
 * chat-page nor orchestrator-page had a `disconnectedCallback`. Navigating away
 * mid-response left the reader pulling frames and the handlers writing into
 * detached DOM for as long as the agent kept streaming — and in chat-page's case,
 * the partial reply was then persisted to the server as if the agent had finished.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserShim } from './browser-shim.mjs';

installBrowserShim();

const { readA2aStream } = await import(new URL('../common/utils/a2a-stream.js', import.meta.url).href);

/** Build a Response whose body emits `frames`, pausing until each release. */
function frameStream(frames, { holdOpen = false } = {}) {
  let released;
  const gate = new Promise((r) => (released = r));
  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        await new Promise((r) => setTimeout(r, 1));
      }
      if (holdOpen) await gate;
      controller.close();
    },
  });
  return { res: new Response(body), release: () => released() };
}

const reply = (text) => ({
  result: { artifactUpdate: { artifact: { parts: [{ text }] }, lastChunk: true } },
});

test('reads a complete stream and reports not-aborted', async () => {
  const { res } = frameStream([reply('hello')]);
  const seen = [];
  const out = await readA2aStream(res, { onReply: (t) => seen.push(t) });
  assert.equal(out.aborted, false);
  assert.match(out.text, /hello/);
  assert.ok(seen.length >= 1, 'onReply fired');
});

test('an already-aborted signal reads nothing and reports aborted', async () => {
  const { res } = frameStream([reply('should not be seen')]);
  const ctrl = new AbortController();
  ctrl.abort();

  let handlerCalls = 0;
  const out = await readA2aStream(res, {
    signal: ctrl.signal,
    onReply: () => handlerCalls++,
    onProgress: () => handlerCalls++,
    onActivity: () => handlerCalls++,
  });

  assert.equal(out.aborted, true, 'reports the cancellation');
  assert.equal(out.text, '', 'no text accumulated');
  assert.equal(handlerCalls, 0, 'no handler ran — nothing was written into a dying page');
});

test('aborting mid-stream stops the loop and does not reject', async () => {
  const { res, release } = frameStream([reply('first'), reply('second'), reply('third')], {
    holdOpen: true,
  });
  const ctrl = new AbortController();

  // Abort as soon as the first frame has been handled.
  let calls = 0;
  let callsAfterAbort = 0;
  const promise = readA2aStream(res, {
    signal: ctrl.signal,
    onReply: () => {
      calls++;
      if (ctrl.signal.aborted) callsAfterAbort++;
      if (calls === 1) ctrl.abort();
    },
    onProgress: () => {
      if (ctrl.signal.aborted) callsAfterAbort++;
    },
  });

  // A cancellation must resolve, not reject: it is us, not a failure. If this
  // threw, every caller would need an isAbort() guard in its catch — and the two
  // that have one would have rendered "Error: The user aborted a request."
  const out = await promise;
  release();

  assert.equal(out.aborted, true);
  assert.ok(calls >= 1 && calls < 3, `stopped early (handled ${calls} of 3 frames)`);
  // The tail of readA2aStream (trailing-frame flush, progress-text fallback)
  // also calls handlers; on abort none of it may run, because the element that
  // owns those handlers is being removed.
  assert.equal(callsAfterAbort, 0, 'no handler ran after the abort');
});

test('no signal at all still works — the parameter is optional', async () => {
  const { res } = frameStream([reply('ok')]);
  const out = await readA2aStream(res, {});
  assert.equal(out.aborted, false);
  assert.match(out.text, /ok/);
});
