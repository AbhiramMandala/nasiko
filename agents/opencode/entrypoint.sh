#!/bin/bash
set -e

: "${OPENCODE_PORT:=4096}"

# Nasiko's LLM router gateway (oss/llm-router) injects OPENAI_BASE_URL +
# OPENAI_API_KEY (a scoped per-agent JWT, not a real OpenAI key) into every
# agent deploy when the gateway is configured — "deploy is authoritative", it
# overwrites any user-supplied secret of the same name
# (oss/server/src/llm_router/wiring.rs). opencode.json's custom "openai-chat"
# provider reads baseURL from this env var (see DEBUGGING.md #11) so it
# transparently routes through the gateway on the real platform. Outside the
# platform — a plain `docker run`/`just run*`, no gateway involved — this env
# var is never set, so default it to real OpenAI, matching how OPENAI_API_KEY
# is expected to be a real key in that case.
: "${OPENAI_BASE_URL:=https://api.openai.com/v1}"
export OPENAI_BASE_URL

# No on-disk opencode.json: a2a-opencode's executor parses config.opencode.model
# and passes it explicitly as `body.model` on every prompt call (see
# a2a-opencode/src/opencode/executor.ts), and the API key is picked up from
# the OPENAI_API_KEY env var directly — neither needs a config file. What
# opencode's own startup does need is a writable $HOME (Dockerfile points it
# at /workspace, mounted writable only when this agent is deployed with
# Nasiko's --writable flag — see docs/WRITABLE_STORAGE_FLAG.md).
mkdir -p "$HOME"

# Materialize the build-time-warmed opencode caches (models.json, ripgrep
# binary) into this fresh mount so opencode doesn't re-download them here —
# at 128Mi total that download alone would eat most of the budget, leaving
# too little room for opencode's own session database ("database or disk is
# full", confirmed on the real cluster back when this lived in /dev/shm's
# 64Mi). See the Dockerfile's /opt/opencode-warm build step.
cp -r /opt/opencode-warm/. "$HOME/"

# Known upstream bug: opencode's "background dependency install" tries to npm
# install @opencode-ai/plugin@local — "local" isn't a valid npm version
# specifier, so it always fails, and it retries every session, not just once.
# Harmless on a real filesystem (just a wasted retry), but on our size-capped
# /workspace it burns through the whole budget on npm cache churn before
# hitting ENOSPC, starving opencode's own session database of room. The
# documented upstream workaround is this env var — we don't use plugins here
# anyway. https://github.com/anomalyco/opencode/issues/30908
export OPENCODE_DISABLE_DEFAULT_PLUGINS=1

opencode serve --hostname 127.0.0.1 --port "${OPENCODE_PORT}" &

# Nasiko's default agent resource limit is 500m CPU / 512Mi memory, shared
# across three JS/Bun runtimes starting concurrently in this container — that
# can take well over 30s under real contention, vs. an unconstrained local
# docker run. 120 tries at 1s gives real headroom.
for i in $(seq 1 120); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${OPENCODE_PORT}") 2>/dev/null; then
    exec 3<&-
    break
  fi
  if [ "$i" = "120" ]; then
    echo "entrypoint: opencode serve never opened port ${OPENCODE_PORT} after 120s" >&2
  fi
  sleep 1
done

# a2a-opencode's config loader (config/loader.ts) reads the standard HOSTNAME
# env var and lets it override config.json's server.hostname outright —
# Docker AND Kubernetes both auto-inject HOSTNAME as the container/pod's own
# hostname, which then resolves via /etc/hosts to the pod's real routable IP,
# never loopback, regardless of what config.json says. Force it to a literal
# IP so Node's net.isIP() short-circuits any hostname resolution entirely —
# a genuine loopback bind, independent of any network environment's quirks.
export HOSTNAME=127.0.0.1

# a2a-opencode auto-registers any env var matching MCP_<NAME>_URL as an MCP
# server config of the shape {url: <value>} — no `type` field. Nasiko injects
# MCP_GATEWAY_URL into every agent for its own MCP gateway feature, which
# collides with that convention by coincidence and crashes mcp-manager.js's
# registerOne (it assumes a `type`-less entry is a local/stdio server and
# tries to build a command array that was never provided). We don't use
# Nasiko's MCP gateway from this agent yet, so drop it before a2a-opencode
# ever sees it.
unset MCP_GATEWAY_URL

# a2a-opencode's config loader (config/loader.ts) also reads the generic
# PORT env var the same way it reads HOSTNAME above, and lets it override
# config.json's server.port outright. Nasiko injects PORT=8000 into every
# agent container by default (oss/server/src/state.rs) — without this, that
# makes a2a-opencode try to bind :8000 directly, colliding with
# nasiko-shim.js (which listens on SHIM_PORT, baked to 8000 in the
# Dockerfile — never on PORT, so it's unaffected by this override). Force it
# back to what config.json already says (3000) so this works with no
# deploy-time secret required, on any Nasiko instance.
export PORT=3000
a2a-opencode --config /app/config.json &

for i in $(seq 1 120); do
  if (exec 3<>"/dev/tcp/127.0.0.1/3000") 2>/dev/null; then
    exec 3<&-
    break
  fi
  if [ "$i" = "120" ]; then
    echo "entrypoint: a2a-opencode never opened port 3000 after 120s" >&2
  fi
  sleep 1
done

exec node /app/nasiko-shim.js
