# opencode agent

A2A wrapper around [opencode](https://opencode.ai) (sst/opencode), a general-purpose coding
agent CLI — a standalone agent container, deployed like `weather` or `coding`. Requires Nasiko's
`--writable` deploy flag (see below); getting *that* working correctly required two small, general
platform fixes in `oss/runtime`/`ee/k8s-runtime` (not agent-specific — see DEBUGGING.md #8-9).
Everything else about this agent is a self-contained Dockerfile/entrypoint, zero other core changes.

Three processes run in the container:

1. `opencode serve` — opencode's own HTTP API (`:4096`, never exposed outside the container)
2. [`a2a-opencode`](https://github.com/shashikanth-gs/a2a-wrapper) — A2A protocol wrapper in front
   of it, bound to `:3000` (also internal-only)
3. `nasiko-shim.js` — listens on `:8000` (the port Nasiko routes to) and rewrites Nasiko's
   PascalCase JSON-RPC method names (`SendMessage`, `SendStreamingMessage`, from
   `oss/types/src/a2a.rs`) to the A2A spec's slash-form names (`message/send`, `message/stream`)
   that `a2a-opencode` actually implements — without this, every call from Nasiko's orchestrator
   fails with `-32601 Method not found`.

## Status: working end-to-end, including real model output

Build, deploy, agent card, and `SendMessage` all succeed, and a real coding task (write a file, read
it back) completes correctly against OpenAI. Getting here took ten distinct, non-obvious
platform/library bug fixes — see [DEBUGGING.md](DEBUGGING.md) for the full account (read it before
touching `entrypoint.sh`/`Dockerfile`/`opencode.json`, several lines look removable but aren't).

No deploy-time secrets beyond `OPENAI_API_KEY` are required — `entrypoint.sh` neutralizes
Nasiko's platform-injected `PORT=8000` itself (see DEBUGGING.md #4) before starting
`a2a-opencode`, so this works the same on any Nasiko instance with no extra flags.

Multi-turn session continuity works out of the box: two `SendMessage` calls sharing the same A2A
`contextId` reuse the same opencode session.

## Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `OPENAI_API_KEY` | yes | opencode's model provider credential |

Model is fixed at `openai-chat/gpt-4o` in `config.json`'s `opencode.model` field (passed explicitly
on every prompt call by `a2a-opencode`, not read from an env var) — edit that file to change it.
`openai-chat` is a *custom* provider declared in `opencode.json` (targets `/v1/chat/completions` via
`@ai-sdk/openai-compatible`), not opencode's built-in `openai` provider — see DEBUGGING.md #10 for
why: the built-in provider's streaming Responses API silently drops all output. If you add another
model under `openai-chat`, give it an explicit `limit.output` in `opencode.json` (see DEBUGGING.md
#10) or large prompts will fail with a `max_tokens too large` error.

## Running locally

```sh
just build
OPENAI_API_KEY=sk-... just run
curl -s localhost:8000/.well-known/agent-card.json | jq .
```

Or via the Nasiko CLI (no local Docker needed):

```sh
nasiko upload . --name opencode --port 8000 --writable -e OPENAI_API_KEY=sk-...
nasiko chat opencode "add an add(a, b) fn to lib.rs and run the tests"
```

`--writable` is required — see docs/WRITABLE_STORAGE_FLAG.md; opencode needs a writable `$HOME`
and this platform's pods otherwise have none. `--port 8000` (the `-p`/`--port` flag) is unrelated
to the `PORT` env var discussion in DEBUGGING.md #4 — it tells the platform which container port
the K8s Service should route external traffic to, not what env var value ends up inside the
container.
