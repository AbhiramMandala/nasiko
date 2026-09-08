FROM node:20-slim

# python3 — node:20-slim is Node-only; opencode's own `bash` tool has no
# Python to fall back on otherwise. python-is-python3 symlinks `python` to
# `python3` (Debian doesn't do this by default) since most snippets/tools
# assume `python` works.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# opencode-ai   — the `opencode` CLI, provides `opencode serve` (localhost:4096)
# a2a-opencode  — A2A protocol wrapper in front of it (github.com/shashikanth-gs/a2a-wrapper)
RUN npm install -g opencode-ai@1.18.16 a2a-opencode@1.6.1 \
    && npm cache clean --force

# Confirmed bug (reproduced on the real cluster, not locally): a2a-opencode's
# startup calls `this.client.health()` once, unconditionally, wrapped in a
# try/catch that logs-and-continues on failure — but the underlying
# @opencode-ai/sdk call can hang forever (never resolves *or* rejects) rather
# than fail fast, in a way that never manifests locally (opencode's own
# /global/health endpoint answers instantly when queried directly with plain
# http/fetch). Race it against a timeout so the existing catch-and-continue
# path actually gets a chance to run.
RUN set -eux; \
    f=/usr/local/lib/node_modules/a2a-opencode/dist/opencode/executor.js; \
    grep -q 'const h = await this.client.health();' "$f"; \
    sed -i "s/const h = await this.client.health();/const h = await Promise.race([this.client.health(), new Promise((_, rej) => setTimeout(() => rej(new Error('health check timed out')), 5000))]);/" "$f"

# Confirmed bug (github.com/vercel/ai#6534, anomalyco/opencode#26170):
# opencode's default OpenAI provider uses the newer Responses API in
# streaming mode, and the underlying Vercel AI SDK doesn't handle certain SSE
# event types there — it silently falls back to `finishReason: "unknown"`
# with zero output tokens instead of surfacing the real error, so every
# prompt appears to "complete" with no text. Route around it: declare OpenAI
# as a CUSTOM provider using @ai-sdk/openai-compatible, which targets the
# older, simpler /v1/chat/completions instead of /v1/responses and doesn't
# hit this bug. config.json's opencode.model points at this custom provider
# ("openai-chat/gpt-4o"), not the built-in "openai" one.
COPY opencode.json /root/.config/opencode/opencode.json

# opencode's first run downloads a ripgrep binary + a ~4MB model catalog into
# $HOME (.cache/opencode, .config/opencode, .local/share/opencode) — fine
# normally, but at runtime $HOME is the 128Mi /workspace tmpfs (see
# DEBUGGING.md #7-9), and that download alone eats a big chunk of the budget,
# leaving too little room for opencode's own session SQLite database
# ("database or disk is full", confirmed on the real cluster). Trigger that
# first-run bootstrap once here at build time (plenty of disk space, HOME is
# still the default /root) and stash the result outside $HOME so
# entrypoint.sh can materialize it into the fresh tmpfs at container startup
# instead of re-downloading every single time.
#
# The warm-up prompt below also matters for a second reason (DEBUGGING.md
# #10): actually *using* the custom "openai-chat" provider for the first time
# triggers the same background-dependency-install path as #9
# (@opencode-ai/plugin's own transitive deps, unrelated to our provider) —
# OPENCODE_DISABLE_DEFAULT_PLUGINS=1 must be set here too (not just in
# entrypoint.sh) or it fires at build time as well, and we wait for
# opencode.log to go quiet (not just for models.json/rg to appear) before
# snapshotting, so that install's result — success or permanent failure —
# is captured into the image instead of being cut off mid-flight. The
# rm -rf of the locks dir right before the cp below matters too: the
# still-running server leaves a 0700 root-owned lock directory there, and
# copying it in verbatim makes entrypoint.sh's cp fail with "Permission
# denied" for the non-root runtime UID — locks are per-process anyway, so a
# fresh one at container startup is correct regardless.
RUN set -eux; \
    export OPENCODE_DISABLE_DEFAULT_PLUGINS=1; \
    (opencode serve --port 4096 &) ; \
    for i in $(seq 1 30); do \
      [ -s /root/.cache/opencode/models.json ] && [ -x /root/.cache/opencode/bin/rg ] && break; \
      sleep 1; \
    done; \
    OPENAI_API_KEY=sk-build-time-placeholder OPENAI_BASE_URL=https://api.openai.com/v1 node -e " \
      const http = require('http'); \
      function req(method, path, body) { \
        return new Promise((resolve, reject) => { \
          const data = body ? JSON.stringify(body) : undefined; \
          const r = http.request({hostname:'127.0.0.1', port:4096, path, method, headers: data ? {'content-type':'application/json','content-length':Buffer.byteLength(data)} : {}}, res => { \
            let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({status:res.statusCode, body:d})); \
          }); \
          r.on('error', reject); \
          if (data) r.write(data); \
          r.end(); \
        }); \
      } \
      (async () => { \
        const s = await req('POST', '/session', {}); \
        const sid = JSON.parse(s.body).id; \
        const p = await req('POST', '/session/'+sid+'/message', { \
          parts: [{type:'text', text:'hi'}], \
          model: {providerID:'openai-chat', modelID:'gpt-4o'}, \
        }); \
        console.log('warm-up prompt:', p.status); \
      })().catch(e => { console.log('warm-up prompt failed (expected — placeholder key):', e.message); }); \
    " ; \
    log=/root/.local/share/opencode/log/opencode.log; \
    prev=-1; stable=0; \
    for i in $(seq 1 90); do \
      sleep 1; \
      cur=$(wc -c < "$log" 2>/dev/null || echo 0); \
      if [ "$cur" = "$prev" ]; then stable=$((stable + 1)); else stable=0; fi; \
      [ "$stable" -ge 3 ] && break; \
      prev=$cur; \
    done; \
    rm -rf /root/.local/state/opencode/locks; \
    mkdir -p /opt/opencode-warm; \
    cp -r /root/.cache /root/.config /root/.local /opt/opencode-warm/

RUN mkdir -p /workspace
WORKDIR /app
COPY config.json ./config.json
COPY entrypoint.sh ./entrypoint.sh
COPY nasiko-shim.js ./nasiko-shim.js
RUN chmod +x ./entrypoint.sh

# NOTE: a2a-opencode itself reads a generic `PORT` env var and lets it
# override config.json's server.port — do not set `PORT` here, it would
# make a2a-opencode bind :8000 directly and collide with the shim below.
ENV OPENCODE_PORT=4096
ENV WRAPPED_PORT=3000
ENV SHIM_PORT=8000

# Deployed under a hardened pod (readOnlyRootFilesystem, non-root UID with no
# passwd entry) opencode's own startup needs *some* writable path. Requires
# this agent to be deployed with Nasiko's `--writable` flag (nasiko upload
# --writable / nasiko deploy --writable), which mounts a 128Mi tmpfs
# (Docker)/emptyDir (Kubernetes) at /workspace — see
# docs/WRITABLE_STORAGE_FLAG.md. Without --writable, /workspace is just a
# plain directory inside the read-only root filesystem and opencode will fail
# to start (no writable $HOME at all). This replaces the earlier /dev/shm
# workaround: /workspace is the platform-sanctioned mechanism, sized properly
# (128Mi vs /dev/shm's default 64Mi, most of which the .npm cache alone ate).
ENV HOME=/workspace
EXPOSE 8000

ENTRYPOINT ["./entrypoint.sh"]
