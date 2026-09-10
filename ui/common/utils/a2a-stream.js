/**
 * Shared reader for A2A `message/stream` SSE responses.
 *
 * One parser for every frame shape the proxy can forward (see
 * `normalize_agent_event` in oss/server/src/router/a2a_dispatch.rs):
 *
 *  - `statusUpdate` / `result.statusUpdate` — task status frames. WORKING
 *    text is progress prose, COMPLETED text is the authoritative reply.
 *  - `artifactUpdate` / `result.artifactUpdate` — reply text chunks
 *    (append or replace mode, `lastChunk` marks the final one).
 *  - flat `message` / `result.message` — 0.3.x agents reply with a bare
 *    Message instead of task frames.
 *  - `task` / `result.task` — task-wrapped replies carrying `artifacts`
 *    and/or `status.message`.
 *  - `error` — JSON-RPC error frames.
 *
 * Callers receive semantic callbacks and never touch frame shapes:
 *
 *   const out = await readA2aStream(res, {
 *     onProgress(text)  {}  // cumulative working/progress prose
 *     onActivity(line)  {}  // one new line of working prose (tool activity)
 *     onReply(text)     {}  // cumulative reply text (call renders it)
 *     onData(part)      {}  // data parts (agent-steps events)
 *     onHitl(row)       {}  // the turn paused for a human — {id, kind, question, …}
 *     onTraceMeta(meta) {}  // { trace_id }
 *     onUsageMeta(meta) {}  // usage footer (tokens/cost), when present
 *     onError(message)  {}  // stream-level failure text
 *     signal            {}  // AbortSignal — REQUIRED from a component; abort it
 *                           // in disconnectedCallback or the reader keeps
 *                           // pulling into detached DOM after navigation.
 *   });
 *   // out = { text, progressText, traceId, usage, failed, errorMessage, aborted, hitl }
 */

function textOfParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts.filter((p) => p && p.text).map((p) => p.text).join("");
}

/** Accumulate working text from senders that mix cumulative + delta styles. */
function mergeProgress(accumulated, incoming) {
  if (!incoming) return accumulated;
  if (incoming.startsWith(accumulated)) return incoming; // cumulative re-send
  return accumulated + incoming; // delta
}

// A2A's own spec uses lowercase task states ("working", "completed", "submitted",
// "failed", "canceled" — see the A2A protocol's TaskState enum). Nasiko's own
// synthesized frames (the trace_meta/usage_meta bookends the dispatch proxy
// injects) use uppercase TASK_STATE_* instead. A directly-proxied agent's own
// raw status-update frames come through in the spec's lowercase form untouched,
// so both conventions have to be recognized here.
const TASK_STATE_ALIASES = {
  working: "TASK_STATE_WORKING",
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
  canceled: "TASK_STATE_CANCELED",
};

function normalizeTaskState(state) {
  return TASK_STATE_ALIASES[state] ?? state;
}

export async function readA2aStream(res, handlers = {}) {
  // `handlers.signal` is how a component stops this loop. Without it the reader
  // kept pulling — and the handlers kept writing — after the element had been
  // removed from the DOM, because nothing connected navigation to the stream.
  const signal = handlers.signal;
  const out = {
    text: "",
    progressText: "",
    traceId: null,
    usage: null,
    failed: false,
    errorMessage: null,
    /** True when the caller aborted; the caller should render nothing further. */
    aborted: false,
    /** The `hitl` data part, when this turn paused for a human instead of replying. */
    hitl: null,
  };
  // Tracked separately from out.progressText: activity is reported for the
  // whole stream, progressText only until a reply exists.
  let activitySeen = "";
  const emitReply = () => {
    if (out.text) handlers.onReply?.(out.text);
  };

  const handleDataParts = (parts) => {
    for (const part of parts || []) {
      if (!part || !part.data) continue;
      const d = part.data;
      if (d.type === "trace_meta" && d.trace_id) {
        out.traceId = d.trace_id;
        handlers.onTraceMeta?.(d);
        continue;
      }
      if (d.type === "usage_meta") {
        out.usage = d;
        handlers.onUsageMeta?.(d);
        continue;
      }
      // A human-in-the-loop pause. The server yields this synthetic part once
      // the row is durably committed, then the stream ends with no reply — so
      // it is the turn's outcome, not a step, and it must not reach the
      // activity timeline. `id`/`kind`/`question` are already the real row's
      // even when the pause is a two-row mirror, so this id is always the one
      // to resolve. See FRONTEND_HITL_API_CONTRACT.md §11.2/§13.3.
      if (d.type === "hitl" && d.id) {
        out.hitl = d;
        handlers.onHitl?.(d);
        continue;
      }
      handlers.onData?.(d);
    }
  };

  const handleMessage = (msg) => {
    // A flat agent Message is a complete reply.
    if (!msg) return;
    const text = textOfParts(msg.parts);
    if (text && text.length >= out.text.length) {
      out.text = text;
      emitReply();
    }
    handleDataParts(msg.parts);
  };

  const handleTask = (task) => {
    if (!task) return;
    let text = "";
    for (const artifact of task.artifacts || []) {
      text += textOfParts(artifact.parts);
    }
    if (!text) text = textOfParts(task.status?.message?.parts);
    if (text && text.length >= out.text.length) {
      out.text = text;
      emitReply();
    }
    handleDataParts(task.status?.message?.parts);
  };

  const handleStatusUpdate = (su) => {
    const state = normalizeTaskState(su.status?.state);
    const msg = su.status?.message;
    if (!msg || !msg.parts) return;
    const text = textOfParts(msg.parts);

    if (state === "TASK_STATE_COMPLETED") {
      // The completed status carries the full reply — prefer it over any
      // partial/replace-mode chunk accumulation.
      if (text && text.length >= out.text.length) {
        out.text = text;
        emitReply();
      }
    } else if (state === "TASK_STATE_WORKING") {
      // Most agents relay tool activity here as plain text rather than as
      // structured data parts — a real infra-agent stream carries exactly
      // `dns_lookup: example.com` / `ip_info: 104.20.23.154` this way, and
      // nothing else. Emit it ALWAYS: these frames interleave with reply
      // tokens (the first artifactUpdate arrives before the first tool call),
      // so gating on `!out.text` — as this branch used to — dropped every
      // tool line the agent reported and left the activity view empty.
      if (text) {
        const previousActivity = activitySeen;
        activitySeen = mergeProgress(previousActivity, text);
        const delta = activitySeen.startsWith(previousActivity)
          ? activitySeen.slice(previousActivity.length)
          : text;
        const line = delta.trim();
        if (line) handlers.onActivity?.(line);
      }
      // `progressText` is a different job: the reply fallback when a stream
      // ends without one. That one genuinely only applies before any reply.
      if (text && !out.text) {
        out.progressText = mergeProgress(out.progressText, text);
        handlers.onProgress?.(out.progressText);
      }
    } else if (state === "TASK_STATE_FAILED") {
      out.failed = true;
      out.errorMessage = text || "The agent reported a failure.";
      handlers.onError?.(out.errorMessage);
    }
    handleDataParts(msg.parts);
  };

  const handleArtifactUpdate = (au) => {
    const text = textOfParts(au.artifact?.parts);
    // `append: false` opens a fresh artifact, and that is a reset even when the
    // frame carries no text — which is exactly how a turn starts (the first
    // chunk is empty, every chunk after it appends). Skipping empty frames
    // wholesale left the PREVIOUS turn's reply sitting in the accumulator, and
    // a resumed HITL turn — whose buffer replays the sub-agent's own reply and
    // then the orchestrator's — appended the second onto the first and printed
    // both in one bubble. Reloading the page showed one, because the transcript
    // stores only the final reply.
    if (au.append) {
      if (!text) return;
      out.text += text;
    } else {
      out.text = text;
    }
    if (out.text) emitReply();
  };

  const handleFrame = (evt) => {
    const statusUpdate = evt.statusUpdate || evt.result?.statusUpdate;
    const artifactUpdate = evt.artifactUpdate || evt.result?.artifactUpdate;
    const message = evt.message || evt.result?.message;
    const task = evt.task || evt.result?.task;

    if (statusUpdate) handleStatusUpdate(statusUpdate);
    if (artifactUpdate) handleArtifactUpdate(artifactUpdate);
    if (message && !statusUpdate && !artifactUpdate) handleMessage(message);
    if (task && !statusUpdate && !artifactUpdate) handleTask(task);

    if (evt.error && !out.failed) {
      out.failed = true;
      out.errorMessage = evt.error.message || "Stream error";
      handlers.onError?.(out.errorMessage);
    }
  };

  const handleLine = (line) => {
    // Spec-legal SSE allows both `data: {...}` and `data:{...}`.
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    try {
      handleFrame(JSON.parse(raw));
    } catch (err) {
      console.debug("a2a-stream: unparseable frame skipped", err);
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Cancelling the reader is what actually unblocks a pending `read()`; checking
  // the signal alone would only take effect after the next frame arrived, which
  // for an idle stream could be never.
  //
  // Note the consequence: `reader.cancel()` resolves the pending read as
  // `{ done: true }`, which is indistinguishable from a stream that ended
  // normally. So `aborted` is decided from the signal in `finally`, not from the
  // shape of the loop exit — setting it inside the loop meant a mid-stream abort
  // reported `aborted: false` and the caller happily persisted a partial reply.
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
    while (true) {
      const { done, value } = await reader.read();
      if (done || signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    }
  } finally {
    if (signal?.aborted) out.aborted = true;
    signal?.removeEventListener('abort', onAbort);
  }
  // Everything below writes through the caller's handlers, so it must not run
  // after a cancellation: the element that owns those handlers is being removed.
  if (out.aborted) return out;

  buffer += decoder.decode();
  if (buffer) handleLine(buffer); // trailing frame without final newline

  if (!out.text && out.progressText && !out.failed && !out.hitl) {
    // Stream ended without a final artifact/completed text — keep the last
    // progress text rather than discarding what the user already saw.
    //
    // Except when the turn paused: a pause legitimately ends the stream with
    // no reply, and promoting the agent's working prose to `text` there would
    // render "Reviewing the policy set…" as its answer — and persist it as
    // one.
    out.text = out.progressText;
    emitReply();
  }
  return out;
}

/**
 * Batches repeated cumulative-text renders into animation frames so long
 * streams don't re-render markdown on every SSE event.
 */
export function frameRenderer(render) {
  let pending = null;
  let scheduled = false;
  return (text) => {
    pending = text;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (pending != null) render(pending);
      pending = null;
    });
  };
}

/** True when the scroller is close enough to the bottom to keep following. */
export function nearBottom(el, slack = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
}

/**
 * The element that actually scrolls `el`'s content: `el` itself when it has its
 * own overflow, else the document.
 *
 * A transcript is an internal scroller only in the layouts that cap its height
 * (the desktop pinned-composer ones). Where the page scrolls as a single
 * document instead, `el.scrollTop` is not writable in any useful sense and
 * following the stream has to move the document.
 */
export function scrollerFor(el) {
  return el.scrollHeight > el.clientHeight + 1
    ? el
    : document.scrollingElement || document.documentElement;
}

/** Pin `el`'s content to its latest line, whichever element does the scrolling. */
export function stickToBottom(el) {
  const scroller = scrollerFor(el);
  scroller.scrollTop = scroller.scrollHeight;
}
