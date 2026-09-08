# Issue: no way for an agent to request a writable filesystem

Found while integrating the `opencode` agent (see [DEBUGGING.md](DEBUGGING.md)).

## Problem

Every agent pod on the EE Kubernetes runtime is deployed with `readOnlyRootFilesystem: true`
(`ee/k8s-runtime/src/lib.rs:1053`), unconditionally, with no override anywhere in the stack:

- `oss/runtime/src/types.rs`'s `DeploymentSpec` has no writability field
- The upload form (`oss/server/src/agents/upload.rs:78-88`, `UploadAndDeployForm`) has no such field
- The CLI's `Upload` command (`oss/cli/src/lib.rs`) has no such flag
- `resources: None` is similarly hardcoded everywhere agents get deployed (a related, separate gap
  — no per-agent CPU/memory override either)

`/dev/shm` (a separate tmpfs, unaffected by `readOnlyRootFilesystem`, provided unconditionally by
Docker/Kubernetes) is the only writable path available to any agent, and it's small by default
(64Mi) with no way to size it up per-agent either.

## Impact

Any agent that needs to persist real file changes — a coding agent editing a workspace, anything
wanting local caching/scratch space beyond a few tens of MB — has nowhere to write. This is the
same underlying gap the built-in `coding` agent's own README documents as its unfinished "Phase 2"
(`RemoteSandbox` / CP-deployment mode, currently a stub that returns "not implemented"). opencode's
own session SQLite database was made to fit inside `/dev/shm`'s 64Mi as a workaround (see
DEBUGGING.md #7), but that's a workaround for chat/session state, not a real workspace — `opencode`
still can't durably edit a project's files when deployed this way.

## Proposed fix (not implemented — scoped only)

Thread a `writable: bool` (or richer: a size/medium choice) through:

1. `oss/cli`'s `Upload` command — e.g. `nasiko upload --writable`
2. The upload form (`UploadAndDeployForm`) and its server-side handling
3. `DeploymentSpec` (`oss/runtime/src/types.rs`)
4. `ee/k8s-runtime`'s `deployment_manifest` — conditionally `readOnlyRootFilesystem: false` and/or
   mount a sized `emptyDir` at an agreed path (e.g. `/workspace`) for that agent's pod only

Security note: this lowers a security default per-agent, not globally — scope review needed before
implementing. Worth bundling with the resource-limits gap (`resources: None` hardcoded) since both
are "per-agent deploy-time override missing" instances of the same underlying pattern.

## Status

Not implemented. Documented here as a known gap; revisit if/when an agent genuinely needs durable
writable storage beyond what `/dev/shm` can hold.
