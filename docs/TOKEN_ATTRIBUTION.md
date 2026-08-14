# Token Attribution via `traceparent`

How the platform answers "which user burned these tokens?" for every LLM call, across
any agent language. Developer-facing contract lives in
[AGENT_LIFECYCLE.md](AGENT_LIFECYCLE.md); this is the design.

## The identity model

Two identities ride on every agent→LLM call; neither is optional:

| Identity | Carrier | Set by |
|---|---|---|
| **Agent** | `Authorization: Bearer <jwt>` — minted at deploy, injected as `OPENAI_API_KEY` | platform |
| **User/session** | `traceparent` header — W3C trace context whose **trace_id is the flow id** | agent (forwarded from its inbound request) |

The LLM router verifies the JWT to know *which agent* is calling. The `traceparent`
trace_id names a row in the `flows` table — written synchronously by the agent proxy
**before** the request reaches the agent — which carries `user_id` and
`metadata.context_id`. Joining the two yields per-user, per-session token usage with no
agent cooperation beyond header forwarding.

```
user ──► /api/orchestrator/a2a ──► agent_proxy writes flows row (user_id, context_id)
                                        │  forwards request + traceparent
                                        ▼
                                     agent ──► LLM router (JWT + traceparent)
                                        │        │
                                        │        ▼
                                        │   attribution::resolve:
                                        │     trace_id → flows row → user_id, context_id
                                        ▼
                                   token_usage row (user_id, session_id, attribution source)
```

## Attribution resolution (`oss/llm-router/src/routing/attribution.rs`)

1. **`traceparent` path (precise).** The header's trace_id is looked up in `flows`.
   Billing: `token_usage.user_id` = the flow's **caller** (`flows.user_id`), never the
   agent's owner — an agent serving another user's traffic bills that user.
2. **Active-flow fallback (best-effort).** No `traceparent` (uninstrumented agent) →
   find the agent's `status='running'` flows within `LLM_ATTRIBUTION_WINDOW_SECS`
   (default 300).
   **Never guess under concurrency:** the fallback attributes only when *exactly one*
   active flow exists. Two or more concurrent flows + no `traceparent` ⇒ the usage is
   recorded unattributed — mis-billing a user is worse than a NULL.
3. The chosen path is recorded in `token_usage.metadata.attribution`
   (`"traceparent"` / `"active_flow"`), so TokenOps numbers are auditable.

Direct-chat flows used to stay `running` forever (which would have poisoned the
fallback); `agent_proxy` now marks them completed when the response finishes
(`complete_flow` + the SSE tap), so "active" really means active.

## The `traceparent` contract, per language

Forwarding only works if the agent's HTTP stack actually propagates the header:

| Language | Mechanism | Code needed |
|---|---|---|
| Python | OTel auto-instrumentation (`opentelemetry-instrument`) | none |
| Node.js | `@opentelemetry/auto-instrumentations-node` | none |
| Java / .NET | OTel javaagent / auto-instr | none |
| Go | **loongsuite `otel go build`** (compile-time auto-instr of `net/http`) in the Dockerfile | none — do **not** add `otelhttp` deps; loongsuite pins its own OTel version and conflicts |
| Rust | No auto-instrumentation exists | **manual** — see below |

### The Rust gotcha

`Span::current().context()` inside a `#[tracing::instrument]`ed `chat()` is a *fresh
local span*, not the platform-re-homed trace — injecting from it silently produces
nothing. The working pattern in every Rust agent:

1. `execute()` reads the inbound header (`ctx.service_params["traceparent"]`) and
   builds a remote `opentelemetry::Context` (`remote_context_from_traceparent`).
2. That `parent_cx` is **threaded explicitly** into `chat()` / the LLM call.
3. The outbound request injects via `telemetry::traceparent_for_context(parent_cx)`.

Also: W3C validation is strict — a malformed `traceparent` (e.g. wrong span-id length)
is silently discarded by `TraceContextPropagator`. When debugging "no attribution",
check the header bytes first.

## Why `traceparent` and not a custom header

It is the **only** header every OTel auto-instrumentation forwards for free, in every
language, with zero agent code — and it was already carrying the same identity for
distributed tracing. One header, one identity, two consumers (Tempo traces + router
attribution). A2A SDKs propagate no headers by themselves; the platform's agents
extract/inject explicitly where auto-instrumentation doesn't exist.

## Read path (TokenOps / sessions)

- Usage rows are written by the router regardless of instrumentation — usage is never
  lost, only attribution fidelity varies.
- The finops dashboard (`agent_finops` / `agent_stats`) used to find an agent's traces
  by searching Tempo for `session.id`, which uninstrumented agents never set. It now
  unions Tempo results with the Postgres `session_traces` index (written by the proxy)
  via `SessionIdResolver::traces_for_agent`, and excludes soft-deleted agents so
  redeployed same-name agents don't double-count.
