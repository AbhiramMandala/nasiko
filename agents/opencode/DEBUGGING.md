# opencode agent — integration debugging log

Summary of getting the `opencode` A2A agent (wraps [opencode](https://opencode.ai) via
[`a2a-opencode`](https://github.com/shashikanth-gs/a2a-wrapper)) working end-to-end on the EE
Kubernetes runtime. Kept for future reference — most of these are real, non-obvious platform/library
interactions that would otherwise cost another multi-hour debugging pass.

## Result

The agent runs end-to-end, including genuine model output: build → deploy → agent card →
`SendMessage` all succeed, and a real coding task (write a file, read it back) completes correctly
against OpenAI. Bugs #1-7, #10, and #11 below required **zero changes to nasiko-cloud-rs core** —
every fix lived in this agent's own `Dockerfile`/`entrypoint.sh`/`nasiko-shim.js`/config. Bugs #8-9
(below) surfaced only after switching `$HOME` from the ad-hoc `/dev/shm` workaround to the
platform's proper `--writable` `/workspace` mount (see `docs/WRITABLE_STORAGE_FLAG.md`) — those two
*did* require small, general-purpose fixes in `oss/runtime`/`ee/k8s-runtime` (not agent-specific
hacks), since they were real bugs in the writable-storage feature itself, not this agent's
Dockerfile. Bug #12 is an **open, unfixed** platform-sizing limitation (see below) — real deploys
through `nasiko upload --writable` need a manual, out-of-band memory bump to avoid an OOM kill until
the platform exposes a way to request more than its 512Mi default.

## Bugs found and fixed

Each was confirmed by reproducing the real failure locally (matching the cluster's exact pod
security context: `--read-only --user 65534:65534 --cap-drop=ALL --cpus=0.5 --memory=512m`) before
and after the fix — not just theorized.

1. **`/api/agents/upload` requires a Python entrypoint, unconditionally.**
   `oss/server/src/agents/upload.rs`'s `validate_agent_zip` checks for `main.py`/`__main__.py`
   regardless of the agent's actual language, and only that endpoint (not `/import/upload`, which
   the OSS vanilla-JS UI uses) enforces it — EE's Flutter "Upload zip" UI calls the Python-checking
   one. Fix: ship a harmless `src/__main__.py` stub (never executed; the real build uses the
   Dockerfile).

2. **`opencode serve` needs a writable `$HOME` — pods have none.**
   EE agent pods run `readOnlyRootFilesystem: true`, `runAsUser: 65534` (no `/etc/passwd` entry →
   `HOME` resolves to `/nonexistent`), and mount zero volumes anywhere (confirmed in
   `ee/k8s-runtime/src/lib.rs:1037-1062`). `/dev/shm` is the one path that stays writable regardless
   (a separate tmpfs mount Docker/Kubernetes both provide unconditionally). Fix: `ENV
   HOME=/dev/shm/home` in the Dockerfile, `mkdir -p "$HOME"` in the entrypoint.

3. **`a2a-opencode` silently rebinds off the pod's real IP, not loopback.**
   Its config loader (`config/loader.ts:77,82`) reads the standard `HOSTNAME` env var — which
   Docker *and* Kubernetes both auto-inject as the container/pod's own hostname — and lets it
   override `config.json`'s `server.hostname` outright. That resolves via `/etc/hosts` to the pod's
   real routable IP, which is unreachable from *within the same pod* under this cluster's
   networking (works fine under Docker Desktop's simpler bridge network, which is why this only
   showed up on the real cluster). Fix: `export HOSTNAME=127.0.0.1` in the entrypoint before
   starting `a2a-opencode`, forcing a genuine literal-IP loopback bind (`net.isIP()` short-circuits
   any hostname resolution).

4. **`PORT` env-var collision with our own shim.**
   Nasiko injects `PORT=8000` into every agent container as a deliberate, documented convention
   (`oss/server/src/state.rs:424`, Heroku/Smithery-style "bind `$PORT`"). `a2a-opencode`'s loader
   *also* reads `PORT` (same mechanism as `HOSTNAME`) and tries to bind it directly — colliding with
   `nasiko-shim.js`, which needs port 8000 for itself (the port Nasiko's Service actually routes
   to). Originally worked around with an explicit `PORT=3000` **agent secret** set at deploy time —
   but that meant every deploy had to remember an extra flag with no way for the zip itself to
   enforce it. Fixed for real, the same way as bug #3's `HOSTNAME`: `entrypoint.sh` now does
   `export PORT=3000` right before starting `a2a-opencode` (matching `config.json`'s own
   `server.port`), overriding whatever the platform injected — `nasiko-shim.js` is unaffected either
   way since it listens on `SHIM_PORT` (baked into the image), never on `PORT`. Confirmed working
   with the platform's default `PORT=8000` injection and no `-e PORT=...` override at all. The K8s
   Service still correctly routes external traffic to container port 8000 where the shim lives —
   these are two independent mechanisms once decoupled.

5. **`a2a-opencode`'s startup health-check can hang forever.**
   `executor.ts`'s `initialize()` calls `this.client.health()` once, wrapped in a
   try/catch that just logs a warning and continues on failure — but the underlying
   `@opencode-ai/sdk` call can hang indefinitely (never resolves *or* rejects) rather than fail
   fast, confirmed only on the real cluster (opencode's own `/global/health` endpoint answers
   instantly when queried directly with plain `http`/`fetch` — the hang is specific to the SDK
   client's call path). Fix: patch the compiled `executor.js` at Docker build time (`sed`) to race
   the call against a 5s timeout, so the existing catch-and-continue path actually gets a chance to
   run.

6. **`MCP_GATEWAY_URL` crashes `a2a-opencode` on startup.**
   `a2a-opencode` auto-registers *any* env var matching `MCP_<NAME>_URL` as an MCP server config of
   the shape `{url: ...}` — no `type` field (`config/loader.ts:124-131`). Nasiko injects
   `MCP_GATEWAY_URL` into every agent for its own MCP gateway feature, which collides with that
   convention by coincidence: `mcp-manager.js`'s `registerOne` assumes a `type`-less entry is a
   local/stdio server and crashes trying to build a `command` array that was never provided. Fix:
   `unset MCP_GATEWAY_URL` in the entrypoint before starting `a2a-opencode` (we don't use Nasiko's
   MCP gateway from this agent yet).

7. **`/dev/shm`'s 64Mi budget is too small for opencode's first-run downloads.**
   opencode downloads a ripgrep binary + a ~4MB model catalog into `$HOME` on first use — fine
   normally, but at runtime `$HOME` is the 64Mi `/dev/shm` tmpfs (the only writable path at all),
   and that alone ate ~60MB, leaving too little room for opencode's own session SQLite database
   (`SQLiteError: database or disk is full`, confirmed on the real cluster). Fix: trigger that
   bootstrap once at Docker **build** time (`opencode serve &`, wait for `models.json`, kill it),
   stash the result at `/opt/opencode-warm/` (a normal image layer, not tmpfs), and have
   `entrypoint.sh` copy it into the fresh `$HOME` at container startup instead of re-downloading.
   Ripgrep itself is downloaded lazily on first actual tool-use (not server startup), so it wasn't
   fully pre-bakeable without a real session at build time — left as a smaller (~2.6MB), acceptable
   remaining cost.

8. **A plain sized `tmpfs`/`emptyDir` isn't writable by a non-root UID — a platform bug, not this
   agent's.** After Nasiko gained a `--writable` flag (mounts `/workspace`, capped at 128Mi — see
   `docs/WRITABLE_STORAGE_FLAG.md`), pointing `$HOME` there to replace the `/dev/shm` hack (bug #7)
   hit `cp: cannot create directory '/workspace/./.cache': Permission denied`. Root cause: a plain
   `--tmpfs` mount's default mode is root-only — `/dev/shm` only "just works" because the kernel
   gives *that specific* mount 1777 by long-standing convention, which a custom tmpfs mount does
   not inherit. The identical bug existed in the *pre-existing* `/tmp` tmpfs under `harden`
   (`oss/runtime/src/docker/mod.rs`) — never caught because nothing had exercised a
   `harden: true` deploy with an actual write to `/tmp` yet. On Kubernetes, `emptyDir` has the same
   class of problem: kubelet creates it root-owned unless a pod-level `fsGroup` is set, and no
   agent pod set one. Fixed in the platform itself (not a per-agent workaround): `oss/runtime`'s
   Docker tmpfs strings now include `mode=1777` (both `/workspace` and the pre-existing `/tmp`);
   `ee/k8s-runtime` now sets `securityContext.fsGroup: 65534` at the pod level whenever
   `spec.writable` is set.

9. **opencode's own "background dependency install" bug turns a size cap into unbounded
   consumption.** Confirmed upstream bug (anomalyco/opencode#30908 and related issues): opencode
   tries to `npm install @opencode-ai/plugin@local` every session — `"local"` isn't a valid npm
   version specifier, so it always fails, and (per the linked issues) keeps retrying rather than
   giving up once. Harmless on a real filesystem (a wasted retry), but on our size-capped
   `/workspace` it raced to fill the *entire* 128Mi with npm cache churn before opencode's own
   session database got a chance to write anything (`ENOSPC`) — the exact same "disk full" class of
   failure as bug #7, just from an entirely different, unbounded source now that `/workspace` was
   actually writable (bug #7's `/dev/shm` version silently failed the same install for the same
   ENOSPC reason, but that got misread as one bounded, one-time cost rather than a retrying,
   unbounded one). Fix: `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, the documented upstream workaround —
   we don't use opencode's plugin system from this agent anyway. Note this doesn't fully eliminate
   the attempt (a `background dependency install failed (ENOSPC)` warning still logs once per
   session in testing), but it now fails within seconds without consuming meaningful disk, rather
   than racing to fill the entire budget — confirmed stable disk usage (~69%, not climbing) across
   repeated real chat requests.

10. **opencode's default OpenAI provider silently drops all output over the streaming Responses
    API.** Confirmed upstream bug (`vercel/ai#6534`, `anomalyco/opencode#26170`): with a real,
    credited API key, every prompt "completed" with `finishReason: "unknown"` and zero output
    tokens — no error surfaced anywhere, just an empty artifact
    (`"No text response was returned."`). Root cause: opencode's built-in `openai` provider uses
    `@ai-sdk/openai`, which targets the newer streaming `/v1/responses` API by default; the
    underlying Vercel AI SDK doesn't handle certain SSE event types on that endpoint and silently
    falls back to an empty result instead of erroring. Fix: declare OpenAI as a *custom* provider
    (`openai-chat`) via `@ai-sdk/openai-compatible` in `opencode.json`, which targets the older,
    simpler `/v1/chat/completions` instead — `config.json`'s `opencode.model` points at
    `"openai-chat/gpt-4o"`, not the built-in `"openai/gpt-4o"`. Two follow-on issues surfaced while
    landing this, both fixed in the same Dockerfile RUN step (see its comments):
    - The custom provider's model entry needs an explicit `limit.output` (opencode.json) — without
      it, opencode defaults to `max_tokens: 32000`, which `/v1/chat/completions` rejects outright
      for `gpt-4o` (`max_tokens is too large... supports at most 16384`), surfaced by
      `a2a-opencode` as a misleadingly generic `"Cannot reach OpenCode server..."` error with the
      real cause visible only in opencode's own log.
    - Actually *using* the custom provider for the first time (not opencode's cheaper internal
      "title" sub-call, which resolves it but doesn't fully exercise it) triggers the same
      background-dependency-install path as bug #9 — race it to fill `/workspace` before the
      original warm-up step (which only waited for the ripgrep/model-catalog download, not this)
      finished capturing state. Fix: also wait for the build-time `opencode.log` to go quiet (3s of
      no growth, capped at 90s) before snapshotting `/opt/opencode-warm/`, and set
      `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` for that warm-up run too (previously only set in
      `entrypoint.sh`, i.e. at runtime — the build-time warm-up was missing it).
    Verified end-to-end via a manual, hardened `docker run` (matching the real pod's security
    context) with a real credited key passed straight through: a `SendMessage` returns genuine
    model text, and a file-write + read-back coding task completes correctly, with `/workspace`
    disk usage stable around 108Mi/128Mi (not climbing) across repeated requests. That bypasses two
    more issues that only show up going through the *real* deploy pipeline (`nasiko upload
    --writable`) — bugs #11 and #12 below.

11. **The platform's LLM router gateway silently overwrites `OPENAI_API_KEY`/`OPENAI_BASE_URL` on
    every deploy — by design, not a bug in the platform, but it broke this agent.** Confirmed
    against a real `nasiko upload --writable -e OPENAI_API_KEY=<real key>`: the deployed container's
    `OPENAI_API_KEY` was a ~260-char JWT, not the real key, and it also had an `OPENAI_BASE_URL` of
    `http://host.docker.internal:9090/v1` that we never set. Root cause:
    `oss/server/src/llm_router/wiring.rs`'s `inject_agent_llm_env` runs on every upload/deploy and
    — per its own doc comment — "deploy is authoritative: when the gateway is configured, the
    injected `*_BASE_URL`/`*_API_KEY` overwrite any pre-existing values," including a user-supplied
    secret of the same name. This is a genuine, separate platform feature (`oss/llm-router`,
    mounted at `/v1/...` in `oss/server/src/lib.rs`) for centralizing LLM spend/observability
    through the platform's own key — every agent using the `OPENAI_API_KEY`/`OPENAI_BASE_URL`
    convention is expected to route through it, not call the real provider directly. Our custom
    `openai-chat` provider (bug #10) hardcoded `baseURL: "https://api.openai.com/v1"` in
    `opencode.json`, so it kept calling the *real* OpenAI API, just with the gateway's JWT as the
    bearer token — OpenAI correctly rejected it (`401 invalid_issuer`). Fix: `opencode.json` now
    reads `baseURL` from `{env:OPENAI_BASE_URL}` instead of hardcoding it, so it transparently
    routes through the gateway when deployed on the platform; `entrypoint.sh` defaults that env var
    to real OpenAI (`: "${OPENAI_BASE_URL:=https://api.openai.com/v1}"`) for standalone testing
    (`just run`/`docker run`, no platform, no gateway) where it's never set. Verified directly
    against the gateway's `/v1/chat/completions` with the injected JWT — it returns a genuine
    completion using the platform's own configured key, confirming the fix routes correctly. A
    practical consequence: a personal API key passed via `-e OPENAI_API_KEY=...` on a platform with
    this gateway configured is silently ignored — the platform's own key is what's actually used.

12. **The platform's default 512Mi agent memory limit can OOM-kill opencode under real chat load,
    not just slow its startup.** `entrypoint.sh` already had a comment (before this bug was found)
    about 512Mi/0.5-CPU making *startup* slow under contention (three JS/Bun runtimes starting
    concurrently) — but a real `nasiko upload --writable` deploy showed the container's `opencode
    serve` process getting `OOMKilled` (`docker inspect` → `State.OOMKilled: true`) partway through
    handling an actual prompt, not just at startup; every manual local test up to this point used an
    unconstrained or generously-sized (`--memory=768m`) `docker run`, which never exercised the
    platform's real default. No fix landed in this agent for this one — it needs either a
    platform-level per-agent memory-override flag (doesn't exist yet; `oss/runtime/src/types.rs`'s
    `ResourceLimits` defaults to `512Mi`/`0.5` CPU with no CLI-exposed way to raise it) or the
    platform's own default to be reconsidered for JS/Bun-heavy agents. For now, testing this agent
    against a *real* deploy locally requires manually raising the container's memory after the fact
    (`docker update --memory=768m --memory-swap=768m <container>` + `docker restart`) — not something
    an end user could do against a real cluster deploy.

## Not a bug: OpenAI billing

The final blocker chasing what looked like an 8th hang was just `AI_APICallError: You have no
credits remaining` — opencode retries with exponential backoff (8s → 14s → 32s → 64s...) rather
than failing fast, which is what made a billing issue look like an infrastructure hang for several
minutes. Visible only in opencode's own log
(`$HOME/.local/share/opencode/log/opencode.log`), not `a2a-opencode`'s A2A-level log. Nothing to fix
— add credits to the OpenAI account and it works.

## Debugging notes for next time

- **Reproduce the exact pod security context locally before trusting a "works on my machine" result.**
  `docker run --read-only --user 65534:65534 --cap-drop=ALL --security-opt=no-new-privileges
  --cpus=0.5 --memory=512m --tmpfs /dev/shm:size=64m` catches most of what a plain `docker run`
  misses.
- **`a2a-opencode`/`@opencode-ai/sdk` read several env vars as silent config overrides** (`HOSTNAME`,
  `PORT`, `OPENCODE_URL`, `MODEL`, `DIRECTORY`, `AUTO_APPROVE`, `MCP_<NAME>_URL`, ...) — all in
  `config/loader.ts`. Any of these accidentally colliding with a platform convention is a real risk
  for *any* Node-based third-party agent wrapper, not just this one.
- **Check `opencode`'s own log file**, not just the wrapper's, when something looks hung —
  `a2a-opencode`'s A2A-level log doesn't show retries/backoff happening one layer down.
- kubectl access (via a kubeconfig for the cluster's own in-VPC service account) made the back half
  of this investigation dramatically faster than guessing through the REST API alone — `/logs` on
  this platform doesn't reliably surface container stdout for K8s-runtime agents.
- **A sized tmpfs/emptyDir is not automatically writable by a non-root container.** Always test a
  new writable-mount feature with the exact non-root UID the real pods use, not just as root
  locally — `docker run --user 65534:65534 --tmpfs /path:size=Nm` reproduces the permission bug in
  under a second; running as root (the default) hides it completely.
- **A third-party CLI's own internal quirks can consume a size-capped mount just as fast as your
  own code can** (bug #9) — a size limit protects the *node*, not the *agent*; the agent can still
  starve itself. Watch actual disk usage across several real requests, not just one, before
  declaring a size-capped mount "enough."
