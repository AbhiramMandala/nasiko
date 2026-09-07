//! Continuation replay buffer for a resumed HITL execution.
//!
//! `deliver()` (`hitl/mod.rs`) is the sole client of the agent's resume call — decoupled from any
//! browser connection by design (§3.2), so its retry/crash-recovery semantics survive a closed
//! tab. That decoupling is exactly why the resumed agent's real A2A/SSE events never reach the
//! frontend today: nothing captures them.
//!
//! This registry closes that gap without coupling the two together. `deliver()` (and its
//! orchestrator-turn helper) append the *actual* bytes they already read from the agent into a
//! small in-memory buffer, keyed by the `hitl_requests.id` that was just resolved — the same id
//! the frontend already holds, since it's the one it just POSTed to `/resolve`. A reconnecting
//! request (routed through the existing `POST /api/orchestrator/a2a`, gated on
//! `metadata.reconnect_after_hitl_id` — see `a2a_dispatch.rs::reconnect_stream`) replays whatever
//! is already buffered, then live-tails anything appended after that, closing once the buffer is
//! marked terminal. Because replay reads from a durable-for-the-duration-of-the-execution buffer
//! rather than subscribing to a transient broadcast, a reconnect that arrives after the resume
//! already finished still gets the complete sequence — there is no "arrived too late" case.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use uuid::Uuid;

/// One resumed execution's captured event sequence. Bounded by construction — a single HITL
/// resume produces at most a handful of A2A events before completing or pausing again — so no
/// explicit size cap is needed; the registry's TTL sweep (`sweep_expired`) is what keeps overall
/// memory bounded across many executions, not a per-buffer limit.
struct ExecutionBuffer {
    /// Each element is exactly the string that would go into an SSE `data:` line — already
    /// normalized to the same wire shape `agent_stream()`/`orchestrator_stream()` emit on a live
    /// connection (see `normalize_agent_event`), so a reconnecting client's existing SSE-parsing
    /// logic needs no special case for "this came from a reconnect."
    events: Mutex<Vec<String>>,
    /// Registered *before* re-checking `events`/`terminal` in the wait loop (see
    /// `ContinuationRegistry::watch`) — Tokio's `Notify::notified()` future is guaranteed to
    /// observe any `notify_waiters()` call made after the future was created, even if that call
    /// happens before the future is actually polled. That ordering is what makes the
    /// check-then-wait loop race-free without a lock held across the await.
    notify: tokio::sync::Notify,
    /// Set once `deliver()` (or `deliver_maf`'s A2A-driving sibling, if ever extended) has fully
    /// classified the resume's outcome — completed, failed, or paused again. A reconnect that
    /// finds this already `true` on its very first read still replays every buffered event first;
    /// it just never blocks waiting for more.
    terminal: AtomicBool,
    created_at: Instant,
}

impl ExecutionBuffer {
    fn new() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            notify: tokio::sync::Notify::new(),
            terminal: AtomicBool::new(false),
            created_at: Instant::now(),
        }
    }

    /// Snapshot every event from `from` onward, plus whether the buffer is (now) terminal.
    fn snapshot_from(&self, from: usize) -> (Vec<String>, bool) {
        let events = self
            .events
            .lock()
            .expect("continuation buffer lock poisoned");
        let from = from.min(events.len());
        (
            events[from..].to_vec(),
            self.terminal.load(Ordering::SeqCst),
        )
    }
}

/// Process-wide registry of in-flight/recently-finished continuation buffers, one per resolved
/// `hitl_requests.id`. Mirrors `nasiko_flow::FlowEventBus`'s exact shape (a `RwLock`-guarded map,
/// entries created lazily via `entry(...).or_insert_with(...)`) — a proven pattern in this
/// codebase, just re-keyed and re-typed for this purpose rather than reused directly, since
/// `FlowEventBus` is keyed by `flow_id` and carries call-graph telemetry, not agent content.
#[derive(Clone)]
pub struct ContinuationRegistry {
    buffers: Arc<RwLock<HashMap<Uuid, Arc<ExecutionBuffer>>>>,
}

impl ContinuationRegistry {
    pub fn new() -> Self {
        Self {
            buffers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn get_or_create(&self, id: Uuid) -> Arc<ExecutionBuffer> {
        if let Some(existing) = self
            .buffers
            .read()
            .expect("continuation registry lock poisoned")
            .get(&id)
        {
            return existing.clone();
        }
        self.buffers
            .write()
            .expect("continuation registry lock poisoned")
            .entry(id)
            .or_insert_with(|| Arc::new(ExecutionBuffer::new()))
            .clone()
    }

    /// Whether a buffer for `id` already exists — i.e. whether *something* (a `ContinuationGuard`
    /// or an `alias`) has actually claimed this id for delivery. Unlike `watch`, this never creates
    /// one: it's the caller's way to tell "in flight or already finished" (a buffer exists) apart
    /// from "nothing has ever been dispatched for this id, and nothing ever will be until it is"
    /// (no buffer, and `watch` would otherwise conjure one up that nothing ever terminates).
    pub fn exists(&self, id: Uuid) -> bool {
        self.buffers
            .read()
            .expect("continuation registry lock poisoned")
            .contains_key(&id)
    }

    /// Makes `alias` resolve to the exact same buffer as `target`. Needed for the MCP-mirror pause
    /// case: `resolve_display_row` (`oss/hitl/src/store.rs`) shows the frontend the *real*
    /// `mcp_tool` row's id, so that's the id a reconnect arrives with — but `deliver()` only ever
    /// runs (and keys its `ContinuationGuard`) on the *mirror* row's id, the one
    /// `auto_resolve_linked_direct_chat_row` (`oss/server/src/router/hitl.rs`) actually resolves to
    /// trigger the resume. Without this, a reconnect for the real row's id watches a buffer nothing
    /// ever writes to or terminates. Call site sets this up before the dispatcher can possibly
    /// finish delivering, so a reconnect racing ahead of `deliver()` still lands on the shared
    /// buffer either way — `get_or_create` is what makes the two insertion orders equivalent.
    pub fn alias(&self, alias: Uuid, target: Uuid) {
        let buffer = self.get_or_create(target);
        self.buffers
            .write()
            .expect("continuation registry lock poisoned")
            .insert(alias, buffer);
    }

    /// Append one real, already-normalized SSE `data:` payload for `id`'s resume. Infallible and
    /// non-blocking (a `Mutex` around a `Vec` push, no I/O) by design — this must never be able to
    /// affect `deliver()`'s own retry/completion logic.
    pub fn append(&self, id: Uuid, data: String) {
        let buffer = self.get_or_create(id);
        buffer
            .events
            .lock()
            .expect("continuation buffer lock poisoned")
            .push(data);
        buffer.notify.notify_waiters();
    }

    /// Marks `id`'s resume as fully classified — no more events will ever be appended. Called
    /// exactly once per resume, from `deliver()`'s `ContinuationGuard::drop` (so every early
    /// return, not just the success path, still terminates the buffer a reconnecting client might
    /// be waiting on).
    fn mark_terminal(&self, id: Uuid) {
        let buffer = self.get_or_create(id);
        buffer.terminal.store(true, Ordering::SeqCst);
        buffer.notify.notify_waiters();
    }

    /// Replay-then-live-tail `id`'s buffer as a plain async generator of already-normalized SSE
    /// data strings. The caller (`a2a_dispatch.rs::reconnect_stream`) wraps each yielded string in
    /// an `Event::default().data(...)`, identical to how a live turn's own generator does — this
    /// function only knows about the buffer, not the HTTP/SSE framing around it.
    pub fn watch(&self, id: Uuid) -> impl futures::Stream<Item = String> + 'static {
        let buffer = self.get_or_create(id);
        async_stream::stream! {
            let mut cursor = 0usize;
            loop {
                // Register the waiter BEFORE snapshotting — see `ExecutionBuffer::notify`'s doc
                // comment for why this ordering is what makes the loop race-free.
                let notified = buffer.notify.notified();
                let (new_events, terminal) = buffer.snapshot_from(cursor);
                if !new_events.is_empty() {
                    cursor += new_events.len();
                    for event in new_events {
                        yield event;
                    }
                    continue;
                }
                if terminal {
                    break;
                }
                notified.await;
            }
        }
    }

    /// Drops any buffer that reached `terminal` more than `ttl` ago, plus (defense-in-depth) any
    /// buffer that's been sitting non-terminal for far longer than any real delivery should ever
    /// take — `reconnect_stream`'s own checks (still-`pending`, unmirrored `mcp_tool`) close the
    /// known ways to create one of these, but a buffer that somehow never gets marked terminal
    /// would otherwise sit in the registry, and be watchable, forever. Spawned once at startup
    /// (`state.rs`) on a fixed interval, same shape as the build worker's own stuck-job sweep —
    /// this is what keeps total memory bounded across many executions, since an individual
    /// buffer's own size is already small by construction (one HITL resume's worth of events).
    fn sweep_expired(&self, ttl: Duration) {
        let mut buffers = self
            .buffers
            .write()
            .expect("continuation registry lock poisoned");
        buffers.retain(|_, buffer| {
            let terminal = buffer.terminal.load(Ordering::SeqCst);
            let age = buffer.created_at.elapsed();
            !((terminal && age > ttl) || (!terminal && age > STALE_NON_TERMINAL_TTL))
        });
    }
}

impl Default for ContinuationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII guard tying a continuation buffer's lifetime to `deliver()`'s own call frame. `deliver()`
/// has many early-return paths (agent lookup failure, flow-guard rejection, HTTP error, ...) —
/// rather than adding a `mark_terminal` call to each one, this guard's `Drop` impl marks the
/// buffer terminal unconditionally once `deliver()` returns by any path, including an unwind.
/// `push` is the only other operation exposed — appending is the one thing `deliver()`'s
/// consumption helpers need mid-flight.
pub struct ContinuationGuard {
    registry: ContinuationRegistry,
    id: Uuid,
}

impl ContinuationGuard {
    pub fn new(registry: ContinuationRegistry, id: Uuid) -> Self {
        registry.get_or_create(id);
        Self { registry, id }
    }

    pub fn push(&self, data: String) {
        self.registry.append(self.id, data);
    }
}

impl Drop for ContinuationGuard {
    fn drop(&mut self) {
        self.registry.mark_terminal(self.id);
    }
}

/// How long a finished buffer is kept around for a late reconnect before the sweep evicts it.
/// Generous on purpose: a human reading a final response and only then closing/reloading the tab
/// should still find it there a few minutes later.
const BUFFER_TTL: Duration = Duration::from_secs(10 * 60);
/// Backstop only — no real `deliver()` call should ever take this long. Long enough that it never
/// fires on a genuinely slow-but-live delivery, short enough that a bug reintroducing an
/// un-terminated buffer still gets cleaned up rather than growing the registry forever.
const STALE_NON_TERMINAL_TTL: Duration = Duration::from_secs(60 * 60);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

/// Spawned once at server startup (`state.rs`), same shape as every other periodic sweep in this
/// codebase (e.g. the build worker's stuck-job recovery).
pub async fn sweep_loop(registry: ContinuationRegistry) {
    loop {
        tokio::time::sleep(SWEEP_INTERVAL).await;
        registry.sweep_expired(BUFFER_TTL);
    }
}
