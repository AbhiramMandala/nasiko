# Unused stub. This agent is Node.js (see Dockerfile/entrypoint.sh) — the
# platform's upload validator (oss/server/src/agents/upload.rs) requires a
# Python entrypoint file to exist regardless of the agent's actual language;
# it only checks for the file's presence, never runs it.
