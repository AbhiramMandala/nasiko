//! Postgres persistence for `hitl_requests` (migration `0007_hitl.sql` +
//! `0008_hitl_auth_required.sql`).
//!
//! `oss/mcp-gateway` calls `create_pending_auth_required` from
//! `protocol::handle_auth_required` and `create_pending_tool_approval` from
//! `protocol::create_tool_approval_id`. `oss/server/src/router/hitl.rs` (the
//! `/api/hitl/*` resolve API, M5) calls `list_pending_for`,
//! `authorize_hitl_action`, and `resolve` to make a persisted row actionable
//! by a human. `resolve` itself never triggers a retry, a push, or a session
//! grant — it only flips the row's own status; `claim_for_resume`/
//! `finish_resume`/`recover_stuck_resumes` (M6) are the resume dispatcher's
//! own claim/lease primitives, consumed by `crate::dispatcher`.

use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;
use crate::types::{HitlKind, HitlOrigin, HitlRequest, HitlStatus, ResumeStatus};

/// Default validity window for a pending request before it's considered
/// expired — 7 days, per the plan's "Remaining Decisions".
const DEFAULT_EXPIRY_DAYS: i64 = 7;

/// Everything needed to create a pending `kind=auth_required`,
/// `origin=mcp_tool` request. Deliberately silent on *how* `context_id` was
/// resolved (a `session_traces` lookup from the forwarded `traceparent`, in
/// MCP's case, per the HITL blueprint) — the caller resolves it and hands it
/// over; this module only persists it, so it stays agnostic to whichever
/// resume mechanism (the future shared dispatcher) ends up consuming the row.
#[derive(Debug, Clone)]
pub struct NewAuthRequired {
    pub agent_id: Uuid,
    /// The user whose credential is missing/expired — also the sole
    /// authorization principal for this row once an approval/resolve API
    /// exists (owner_user_id is the one rule for every `HitlKind`, per the
    /// plan).
    pub owner_user_id: Uuid,
    /// The connector currently being resolved when the failure was detected.
    /// Part of this row's idempotent-creation identity alongside `agent_id`
    /// and `context_id` — see `uq_hitl_pending_per_connector_auth`.
    pub connector_id: Uuid,
    /// The paused conversation the resume dispatcher will eventually push
    /// "authentication is complete, retry `<tool>`" onto. Required — see
    /// `chk_hitl_mcp_auth_required_identity`.
    pub context_id: String,
    /// Free-form, human/agent-facing payload (connector name, provider,
    /// `auth_url`, the tool name that triggered detection, a message, …).
    /// Deliberately not schema-typed so a later milestone can add fields
    /// without a migration — mirrors how `tool_approval` already treats
    /// `arguments_hash` as audit/display data outside the matching key.
    pub question: Value,
}

/// Create a pending `auth_required`/`mcp_tool` request, or — if one already
/// exists for this exact `(agent_id, connector_id, context_id)` — return that
/// existing row unchanged (only `updated_at` is bumped). Idempotent by
/// construction via `uq_hitl_pending_per_connector_auth`: safe to call once
/// per failed tool call against the same unusable connector without ever
/// creating a duplicate pending row.
pub async fn create_pending_auth_required(
    db: &PgPool,
    req: NewAuthRequired,
) -> Result<HitlRequest> {
    let expires_at = Utc::now() + Duration::days(DEFAULT_EXPIRY_DAYS);
    let row = sqlx::query_as::<_, HitlRequestRow>(
        r#"
        INSERT INTO hitl_requests
            (kind, origin, agent_id, owner_user_id, connector_id, context_id, question, expires_at)
        VALUES
            ('auth_required', 'mcp_tool', $1, $2, $3, $4, $5, $6)
        ON CONFLICT (agent_id, connector_id, context_id)
            WHERE status = 'pending' AND kind = 'auth_required' AND origin = 'mcp_tool'
            DO UPDATE SET updated_at = now()
        RETURNING *
        "#,
    )
    .bind(req.agent_id)
    .bind(req.owner_user_id)
    .bind(req.connector_id)
    .bind(&req.context_id)
    .bind(req.question)
    .bind(expires_at)
    .fetch_one(db)
    .await?;

    row.try_into_domain()
}

/// Everything needed to create a pending `kind=tool_approval`,
/// `origin=mcp_tool` request. `arguments_hash` is deliberately not part of
/// this constructor — the finalized matching key for a retried call is tool
/// identity `(agent_id, connector_id, tool_name, context_id)`, never
/// argument content (a retry may regenerate slightly different arguments),
/// so a hash is audit/display data a later milestone can add without
/// changing this signature.
#[derive(Debug, Clone)]
pub struct NewToolApproval {
    pub agent_id: Uuid,
    /// The user whose approval decision is being asked for — the delegating
    /// user, not whoever manages the agent (connector credentials are always
    /// the calling user's own). Also the sole authorization principal for
    /// this row once a resolve API exists.
    pub owner_user_id: Uuid,
    /// The connector the tool belongs to. Part of this row's
    /// idempotent-creation identity — see `uq_hitl_pending_per_tool_call`.
    pub connector_id: Uuid,
    /// The un-namespaced tool name a retried call's own routing would
    /// resolve to (never the `{connector_prefix}__tool` wire form for
    /// generic MCP tools) — part of this row's identity alongside
    /// `agent_id`, `connector_id`, and `context_id`.
    pub tool_name: String,
    /// The paused conversation a future resolve/retry flow is scoped to.
    /// Required — see `chk_hitl_tool_approval_identity`.
    pub context_id: String,
    /// Free-form, human/agent-facing payload (tool name, connector label, a
    /// message, …). Deliberately not schema-typed so a later milestone can
    /// add fields without a migration.
    pub question: Value,
}

/// Create a pending `tool_approval` request, or — if one already exists for
/// this exact `(agent_id, connector_id, tool_name, context_id)` — return
/// that existing row unchanged (only `updated_at` is bumped). Idempotent by
/// construction via `uq_hitl_pending_per_tool_call` (`0007_hitl.sql`): safe
/// to call once per `Stance::Ask` decision without ever creating a duplicate
/// pending row for the same tool/conversation.
pub async fn create_pending_tool_approval(
    db: &PgPool,
    req: NewToolApproval,
) -> Result<HitlRequest> {
    let expires_at = Utc::now() + Duration::days(DEFAULT_EXPIRY_DAYS);
    let row = sqlx::query_as::<_, HitlRequestRow>(
        r#"
        INSERT INTO hitl_requests
            (kind, origin, agent_id, owner_user_id, connector_id, tool_name, context_id, question, expires_at)
        VALUES
            ('tool_approval', 'mcp_tool', $1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (agent_id, connector_id, tool_name, context_id)
            WHERE status = 'pending' AND kind = 'tool_approval'
            DO UPDATE SET updated_at = now()
        RETURNING *
        "#,
    )
    .bind(req.agent_id)
    .bind(req.owner_user_id)
    .bind(req.connector_id)
    .bind(&req.tool_name)
    .bind(&req.context_id)
    .bind(req.question)
    .bind(expires_at)
    .fetch_one(db)
    .await?;

    row.try_into_domain()
}

/// Look up a request by id — read-only, used by the tests below and by
/// whichever future caller (a resolve endpoint, the dispatcher) needs to
/// re-fetch a row it already knows the id of.
pub async fn get_by_id(db: &PgPool, id: Uuid) -> Result<Option<HitlRequest>> {
    let row = sqlx::query_as::<_, HitlRequestRow>("SELECT * FROM hitl_requests WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.map(HitlRequestRow::try_into_domain).transpose()
}

/// The `direct_chat`/`agent_proxy`/`maf`-origin row (if any, still `pending`)
/// mirroring this resolved `mcp_tool`-origin row's own event — an agent that
/// maps MCP's `ask_required`/`auth_required` onto the A2A `AUTH_REQUIRED`
/// task state creates its own separate row for the same pause, tagging it
/// with `question.metadata.hitl_request_id` pointing back at this one
/// (`build_pause_question` in `oss/types/src/a2a.rs` forwards the agent's
/// own status-message metadata verbatim).
///
/// Resolving only the MCP row leaves that mirrored row pending forever — the
/// mirror's own dispatcher only ever acts on rows it owns, and MCP's own
/// dispatcher sends a stateless, task-blind nudge that can never reach the
/// *specific* chat task/MAF step a human is watching (found live: task-aware
/// resume only exists on the `direct_chat`/`agent_proxy`/`maf` side — see
/// docs/MCP_HITL_MERGE_HANDOFF.md's dual-origin writeup). The caller
/// (`router/hitl.rs::resolve`) uses this to auto-resolve the mirrored row in
/// lockstep with the one the human actually clicked, so a single approval
/// action both grants the real permission (this row) and resumes the
/// specific visible task/step the human is looking at (the mirrored row,
/// through its own existing, unmodified dispatcher).
pub async fn find_linked_direct_chat_row(
    db: &PgPool,
    mcp_row_id: Uuid,
) -> Result<Option<HitlRequest>> {
    let row = sqlx::query_as::<_, HitlRequestRow>(
        r#"
        SELECT * FROM hitl_requests
         WHERE origin IN ('direct_chat', 'agent_proxy', 'maf')
           AND status = 'pending'
           AND question->'metadata'->>'hitl_request_id' = $1
         LIMIT 1
        "#,
    )
    .bind(mcp_row_id.to_string())
    .fetch_optional(db)
    .await?;
    row.map(HitlRequestRow::try_into_domain).transpose()
}

/// `owner_user_id` is the sole authorization rule for every [`HitlKind`] — not
/// a two-branch split by kind. A human's personal HITL inbox (`list_pending_for`)
/// already scopes by this via its `WHERE` clause; this function is for a
/// single-row action (resolve/reject) where the row is fetched by id first and
/// the caller must independently confirm the actor may act on it.
pub fn authorize_hitl_action(request: &HitlRequest, acting_user_id: Uuid) -> bool {
    request.owner_user_id == acting_user_id
}

/// All pending requests owned by `owner_user_id`, newest first — a human's
/// personal HITL inbox, regardless of `kind`/`origin`. Deliberately not
/// MCP-specific: this is the generic read side the future shared resume
/// dispatcher's HTTP surface (and the direct-chat/orchestrator/MAF origins)
/// will use identically.
pub async fn list_pending_for(db: &PgPool, owner_user_id: Uuid) -> Result<Vec<HitlRequest>> {
    let rows = sqlx::query_as::<_, HitlRequestRow>(
        "SELECT * FROM hitl_requests WHERE owner_user_id = $1 AND status = 'pending' \
         ORDER BY created_at DESC",
    )
    .bind(owner_user_id)
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(HitlRequestRow::try_into_domain)
        .collect()
}

/// The human's decision on a pending request. Deliberately just these two —
/// "allow once" vs. "allow for this session" is a `tool_approval`-specific
/// distinction that belongs to the future retry-matching/session-grant work
/// (an unbuilt consumer of `Resolved`, not a different terminal status), not
/// to this generic status transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveDecision {
    Approve,
    Reject,
}

impl ResolveDecision {
    fn target_status(self) -> HitlStatus {
        match self {
            Self::Approve => HitlStatus::Resolved,
            Self::Reject => HitlStatus::Rejected,
        }
    }
}

/// Atomically transition a pending request to `resolved`/`rejected`, recording
/// who decided and what they said. Returns `Ok(None)` if the row wasn't
/// `pending` at the moment of the update — either it never existed, or (the
/// case this guards against) it was already resolved/rejected by a concurrent
/// call; the `WHERE status = 'pending'` clause is the only mutual-exclusion
/// mechanism, so at most one caller ever observes `Some`.
///
/// The caller must independently authorize the action (`authorize_hitl_action`)
/// before calling this — this function has no opinion on who `resolved_by` is,
/// only that the transition itself is atomic. Deliberately generic across
/// `HitlKind`: it only flips `status`/`human_response`/`resolved_by`/
/// `resolved_at` — kind-specific consequences (session-grant creation, resume
/// dispatch) belong to later milestones, not this function.
pub async fn resolve(
    db: &PgPool,
    id: Uuid,
    decision: ResolveDecision,
    resolved_by: Uuid,
    human_response: Value,
) -> Result<Option<HitlRequest>> {
    let row = sqlx::query_as::<_, HitlRequestRow>(
        r#"
        UPDATE hitl_requests
           SET status = $2, human_response = $3, resolved_by = $4, resolved_at = now()
         WHERE id = $1 AND status = 'pending'
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(decision.target_status().as_str())
    .bind(human_response)
    .bind(resolved_by)
    .fetch_optional(db)
    .await?;
    row.map(HitlRequestRow::try_into_domain).transpose()
}

/// Auto-resolve every pending `auth_required`/`mcp_tool` row for this
/// `(owner_user_id, connector_id)` pair — the OAuth callback's hook
/// (`oss/mcp-gateway/src/oauth.rs::handle_callback`) once it has confirmed
/// the newly stored credential actually works.
///
/// Deliberately scoped by user+connector, not a single row id: the pending
/// rows are keyed `(agent_id, connector_id, context_id)`
/// (`uq_hitl_pending_per_connector_auth`), so a connector shared across
/// multiple agents/conversations can have several rows waiting on the exact
/// same credential fix. One successful re-auth clears all of them, not just
/// whichever tool call happened to trigger the callback.
///
/// Also auto-resolves each resolved row's linked `direct_chat`/`agent_proxy`
/// mirror, if any (see `find_linked_direct_chat_row`'s doc comment) — a real
/// broken-connector-credential pause reaches this same mirroring as a
/// `tool_approval` pause does, and this bulk path bypasses `router/hitl.rs`'s
/// `resolve()` handler entirely (mcp-gateway calls this directly), so without
/// this the mirror would stay pending until its TTL even after the real fix.
/// Best-effort: the caller (an OAuth/Composio callback) must not fail the
/// whole re-auth flow over a mirror-resolve error — this is only ever
/// resolving a second, redundant row, not the credential fix itself.
pub async fn resolve_pending_auth_required_for_connector(
    db: &PgPool,
    owner_user_id: Uuid,
    connector_id: Uuid,
) -> Result<Vec<HitlRequest>> {
    let human_response = serde_json::json!({"decision": "approve", "auth_outcome": "confirmed"});
    let rows = sqlx::query_as::<_, HitlRequestRow>(
        r#"
        UPDATE hitl_requests
           SET status = 'resolved', human_response = $3, resolved_by = $1, resolved_at = now()
         WHERE owner_user_id = $1 AND connector_id = $2 AND status = 'pending'
           AND kind = 'auth_required' AND origin = 'mcp_tool'
        RETURNING *
        "#,
    )
    .bind(owner_user_id)
    .bind(connector_id)
    .bind(human_response)
    .fetch_all(db)
    .await?;
    let resolved: Vec<HitlRequest> = rows
        .into_iter()
        .map(HitlRequestRow::try_into_domain)
        .collect::<Result<_>>()?;
    for row in &resolved {
        if let Err(e) = resolve_linked_direct_chat_mirror(db, row.id, owner_user_id).await {
            tracing::warn!(mcp_row_id = %row.id, error = %e, "failed to auto-resolve linked direct_chat mirror row");
        }
    }
    Ok(resolved)
}

/// Shared by every place that resolves an `mcp_tool`-origin row outside the
/// single-row `tool_approval` resolve API (`router/hitl.rs`'s own
/// `auto_resolve_linked_direct_chat_row` covers that one) — currently just
/// [`resolve_pending_auth_required_for_connector`]'s bulk OAuth-reconnect
/// path. Finds the linked mirror (if any, if still pending) and resolves it
/// with the same `{"auth_outcome": "confirmed"}` shape the console's own
/// two-click `auth_action: confirm` flow produces.
async fn resolve_linked_direct_chat_mirror(
    db: &PgPool,
    mcp_row_id: Uuid,
    resolved_by: Uuid,
) -> Result<()> {
    let Some(linked) = find_linked_direct_chat_row(db, mcp_row_id).await? else {
        return Ok(());
    };
    resolve(
        db,
        linked.id,
        ResolveDecision::Approve,
        resolved_by,
        serde_json::json!({"auth_outcome": "confirmed"}),
    )
    .await?;
    Ok(())
}

/// Atomically claim the most recently resolved, not-yet-consumed
/// `tool_approval` row matching this exact `(owner_user_id, agent_id,
/// connector_id, tool_name, context_id)` tuple — the M7 retry-matching lookup
/// `protocol::handle_tools_call` performs right after `perms.decide()`
/// returns `Ask`.
///
/// `owner_user_id` is a required predicate, not an afterthought:
/// `context_id` alone is derived from the caller-supplied `traceparent`
/// header (`session::resolve_context_id`), which is unauthenticated and
/// fully controlled by whatever code the agent container runs — it is a
/// trace-correlation id, not an identity boundary. Without also matching the
/// caller's own `user_id` (from their delegation token, the one value here
/// that actually is authenticated), an agent shared across users could
/// replay a `context_id` it observed while serving one user to claim that
/// user's approval decision on behalf of a different one (found in security
/// review — this was exploitable before this parameter existed).
///
/// Deliberately excludes `session`-scoped approvals
/// (`human_response->>'scope' = 'session'`): a session grant's reusability
/// lives in `mcp_session_tool_grants` instead, so its row must never be
/// claimed/consumed here — callers are expected to check
/// [`has_active_session_grant`] first. What remains claimable here is
/// exactly the "single use" set: `once`-scope (or scope-omitted) approvals,
/// and every rejection, each usable for exactly one retry — mirroring
/// `once`'s own one-time semantics from the approval side.
///
/// Concurrency-safe via `FOR UPDATE SKIP LOCKED`, the same pattern as
/// `claim_for_resume`: two concurrent retries of the same approved call can
/// never both proceed.
pub async fn claim_resolved_tool_approval(
    db: &PgPool,
    owner_user_id: Uuid,
    agent_id: Uuid,
    connector_id: Uuid,
    tool_name: &str,
    context_id: &str,
) -> Result<Option<HitlRequest>> {
    // status IN ('resolved', 'rejected'): ResolveDecision::Approve lands on
    // 'resolved', ResolveDecision::Reject lands on 'rejected' (see
    // ResolveDecision::target_status) — both are terminal, single-use
    // outcomes this claim must cover, not just the approved case.
    let row = sqlx::query_as::<_, HitlRequestRow>(
        r#"
        UPDATE hitl_requests
           SET consumed_at = now()
         WHERE id = (
             SELECT id FROM hitl_requests
              WHERE kind = 'tool_approval' AND status IN ('resolved', 'rejected')
                AND consumed_at IS NULL
                AND owner_user_id = $1
                AND agent_id = $2 AND connector_id = $3 AND tool_name = $4 AND context_id = $5
                AND (human_response ->> 'scope') IS DISTINCT FROM 'session'
              ORDER BY resolved_at DESC NULLS LAST, created_at DESC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
         )
        RETURNING *
        "#,
    )
    .bind(owner_user_id)
    .bind(agent_id)
    .bind(connector_id)
    .bind(tool_name)
    .bind(context_id)
    .fetch_optional(db)
    .await?;
    row.map(HitlRequestRow::try_into_domain).transpose()
}

/// Resolve the stable chat-session identity a `tool_approval` session grant
/// should be keyed by — the same `chat_sessions.session_id` direct-chat uses
/// as its own durable conversation identity (`agent_proxy.rs` upserts one row
/// per conversation and it never changes across messages within it).
///
/// This exists because the trace-derived `context_id` every other MCP HITL
/// identity uses (`session::resolve_context_id` in `oss/mcp-gateway`) is a
/// *per-message* value — a fresh distributed trace begins with every user
/// message, so two calls a human would recognize as "the same conversation"
/// can resolve to different context_ids. That's the right identity for a
/// pending row itself (an `once`-scope claim is deliberately per-call, and
/// stays on the old trace-derived context_id — this function changes nothing
/// there), but it silently broke `session`-scope grants: matched by
/// `(agent_id, connector_id, tool_name, context_id)`, a grant created against
/// message 1's trace context could never match message 2's different trace
/// context, so "Allow for Session" behaved almost exactly like "Allow Once."
///
/// `(owner_user_id, agent_id)` is available both when a grant is created
/// (from the resolved row itself) and when it's looked up (from the live
/// call's own identity), so this lookup is what both sides now share.
/// Deliberately "most recent session for this (user, agent) pair," not an
/// exact trace match — a user with two concurrent chats against the same
/// agent is a real but rare edge case, and picking the most recently active
/// one is a safe default (worst case: an unnecessary re-ask, never an
/// over-broad grant) that needs no new protocol field to disambiguate
/// further. Returns `None` when no chat session exists at all (e.g. a raw
/// MCP integration outside any chat) — callers fall back to the existing
/// trace-derived context in that case, so this is a pure addition to what
/// `session` scope can match, never a narrowing.
pub async fn resolve_stable_session_context(
    db: &PgPool,
    owner_user_id: Uuid,
    agent_id: Uuid,
) -> Result<Option<String>> {
    let session_id: Option<String> = sqlx::query_scalar(
        r#"
        SELECT session_id FROM chat_sessions
         WHERE user_id = $1 AND agent_id = $2 AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1
        "#,
    )
    .bind(owner_user_id)
    .bind(agent_id)
    .fetch_optional(db)
    .await?;
    Ok(session_id)
}

/// Default validity window for an "allow for this session" grant — 24 hours,
/// per the blueprint's own starting proposal ("end-of-session or 24h,
/// whichever first") for a product decision still open at TTL granularity;
/// this is the interim, documented choice, not a re-litigation of that open
/// question. `session` scope has no per-call expiry input, unlike `once`
/// (which is single-use by construction and needs none).
pub const DEFAULT_SESSION_GRANT_TTL_HOURS: i64 = 24;

/// Everything needed to record an "allow for this session" grant — created
/// by `POST /api/hitl/{id}/resolve` when a `tool_approval` request is
/// approved with `scope=session`. `expires_at` is computed internally from
/// [`DEFAULT_SESSION_GRANT_TTL_HOURS`], mirroring how
/// `create_pending_auth_required`/`create_pending_tool_approval` compute
/// their own `expires_at` rather than taking it as caller input.
#[derive(Debug, Clone)]
pub struct NewSessionGrant {
    pub agent_id: Uuid,
    pub connector_id: Uuid,
    pub tool_name: String,
    pub context_id: String,
    /// The human who approved the request — always the row's own
    /// `owner_user_id` in practice (the sole authorization principal), but
    /// passed explicitly rather than re-derived so this constructor stays
    /// independent of the caller's own row lookup.
    pub granted_by: Uuid,
    /// The `tool_approval` row this grant originated from — audit trail
    /// only, never consulted by [`has_active_session_grant`].
    pub hitl_request_id: Option<Uuid>,
}

/// Persist a new session grant. Deliberately not idempotent/upserting —
/// unlike the pending-row constructors above, a grant has no natural
/// "already exists" identity to collapse into (a second approval of the same
/// tuple, however unlikely given the retry-matching lookup, simply produces
/// a second grant with its own expiry; [`has_active_session_grant`] only
/// cares whether *any* unexpired row matches).
pub async fn create_session_grant(db: &PgPool, grant: NewSessionGrant) -> Result<()> {
    let expires_at = Utc::now() + Duration::hours(DEFAULT_SESSION_GRANT_TTL_HOURS);
    sqlx::query(
        r#"
        INSERT INTO mcp_session_tool_grants
            (agent_id, connector_id, tool_name, context_id, granted_by, hitl_request_id, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(grant.agent_id)
    .bind(grant.connector_id)
    .bind(&grant.tool_name)
    .bind(&grant.context_id)
    .bind(grant.granted_by)
    .bind(grant.hitl_request_id)
    .bind(expires_at)
    .execute(db)
    .await?;
    Ok(())
}

/// True when an unexpired session grant exists for this exact `(granted_by,
/// agent_id, connector_id, tool_name, context_id)` tuple — the first check
/// `protocol::handle_tools_call`'s retry-matching lookup performs (before
/// [`claim_resolved_tool_approval`]), since a session grant is reusable for
/// the rest of the conversation rather than single-use.
///
/// `granted_by` is a required predicate for the same reason
/// [`claim_resolved_tool_approval`]'s `owner_user_id` is: `context_id` is
/// derived from the unauthenticated, agent-controlled `traceparent` header,
/// not an identity boundary. Without also matching the calling user's own
/// `user_id` against who the grant was actually granted to, one user's
/// "approve for this session" decision on a shared agent could be replayed
/// to skip approval for a completely different user (found in security
/// review).
pub async fn has_active_session_grant(
    db: &PgPool,
    granted_by: Uuid,
    agent_id: Uuid,
    connector_id: Uuid,
    tool_name: &str,
    context_id: &str,
) -> Result<bool> {
    let found: Option<i32> = sqlx::query_scalar(
        r#"
        SELECT 1 FROM mcp_session_tool_grants
         WHERE granted_by = $1
           AND agent_id = $2 AND connector_id = $3 AND tool_name = $4 AND context_id = $5
           AND expires_at > now()
         LIMIT 1
        "#,
    )
    .bind(granted_by)
    .bind(agent_id)
    .bind(connector_id)
    .bind(tool_name)
    .bind(context_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// Default lease/staleness window for a resume-dispatcher claim before it is
/// considered abandoned — 2 minutes, per `0007_hitl.sql`'s own claim-SQL
/// comment. Exposed so callers (the dispatcher's recovery sweep) don't need
/// to hardcode the same number twice.
pub const DEFAULT_RESUME_LEASE_MINUTES: i64 = 2;

/// Atomically claim exactly one row whose resolved decision has never been
/// pushed anywhere yet, for the resume dispatcher (`crate::dispatcher`).
///
/// Deliberately claims only *virgin* rows (`resume_claimed_at IS NULL`) —
/// unlike `build_jobs.picked_at`, an expired lease here is never silently
/// reclaimed for another attempt. A resume push is not naturally idempotent
/// the way a rebuild is: retrying a call whose outcome is unknown risks
/// delivering the same "retry `<tool>`" nudge twice. So once a row is
/// claimed, it is claimed for good — `finish_resume` records its one
/// definitive outcome, and a claim that never reaches `finish_resume` (the
/// dispatcher process died mid-attempt) is later quarantined by
/// `recover_stuck_resumes` as `delivery_outcome_unknown`, not retried.
///
/// Concurrency-safe via `FOR UPDATE SKIP LOCKED` in the inner subquery: two
/// concurrent callers racing this same query can never claim the same row,
/// mirroring `build_worker::claim_next_job`'s own claim pattern.
/// Scoped to `origin = 'mcp_tool'` — this dispatcher's `RuntimeResumeNotifier` sends a
/// standalone nudge message, not a resumed A2A task, so it's only correct for MCP-originated
/// rows. `direct_chat`/`agent_proxy` rows have their own dispatcher
/// (`oss/server/src/hitl/mod.rs`) with a different delivery mechanism (a true A2A task resume,
/// which requires a `task_id` this origin never has) — without this filter, the two dispatchers
/// would race to claim each other's rows and fail whichever they won incorrectly.
pub async fn claim_for_resume(db: &PgPool) -> Result<Option<HitlRequest>> {
    let row = sqlx::query_as::<_, HitlRequestRow>(
        r#"
        UPDATE hitl_requests
           SET resume_claimed_at = now()
         WHERE id = (
             SELECT id FROM hitl_requests
              -- `rejected` included alongside `resolved`: `build_resume_message`'s
              -- `ToolApproval` branch has a dedicated "denied" message for exactly this case
              -- (found dead — never reachable — until this was widened; a human's reject
              -- decision must still reach the paused agent, just with "do not retry" instead
              -- of "you may retry").
              WHERE status IN ('resolved', 'rejected') AND resume_status = 'not_started'
                AND resume_claimed_at IS NULL
                AND origin = 'mcp_tool'
              ORDER BY created_at
              FOR UPDATE SKIP LOCKED
              LIMIT 1
         )
        RETURNING *
        "#,
    )
    .fetch_optional(db)
    .await?;
    row.map(HitlRequestRow::try_into_domain).transpose()
}

/// Record the definitive outcome of a claimed row's resume attempt(s) —
/// called exactly once per claim, after the dispatcher's own in-process retry
/// loop (see `crate::dispatcher::dispatch_one`) either confirms delivery or
/// exhausts its retries. `attempts` is the total number of outbound pushes
/// actually made for this claim, recorded for observability even though the
/// claim itself only ever happens once.
///
/// The `WHERE resume_status = 'not_started'` guard means a row already
/// quarantined by `recover_stuck_resumes` (because its lease looked
/// abandoned) can never be clobbered back to `completed`/`failed` by a
/// late-finishing zombie attempt — the quarantine wins. Returns `Ok(None)`
/// in that case, not an error.
pub async fn finish_resume(
    db: &PgPool,
    id: Uuid,
    resume_status: ResumeStatus,
    attempts: i32,
    last_error: Option<&str>,
) -> Result<Option<HitlRequest>> {
    let row = sqlx::query_as::<_, HitlRequestRow>(
        r#"
        UPDATE hitl_requests
           SET resume_status = $2, resume_dispatch_attempts = $3, resume_last_error = $4
         WHERE id = $1 AND resume_status = 'not_started' AND resume_claimed_at IS NOT NULL
        RETURNING *
        "#,
    )
    .bind(id)
    .bind(resume_status.as_str())
    .bind(attempts)
    .bind(last_error)
    .fetch_optional(db)
    .await?;
    row.map(HitlRequestRow::try_into_domain).transpose()
}

/// Quarantine claims whose lease looks abandoned: claimed
/// (`resume_claimed_at` set) more than `lease_minutes` ago, but still
/// `resume_status = 'not_started'` — meaning `finish_resume` was never
/// called, most likely because the dispatcher process that claimed it died
/// mid-attempt. Transitions those rows to `delivery_outcome_unknown`, which
/// `claim_for_resume` can never select (it only claims `not_started` rows)
/// and which a human must investigate — per `ResumeStatus`'s own doc
/// comment, this state is "never auto-retried". Returns the number of rows
/// quarantined, for the dispatcher's own logging.
pub async fn recover_stuck_resumes(db: &PgPool, lease_minutes: i64) -> Result<u64> {
    let result = sqlx::query(
        r#"
        UPDATE hitl_requests
           SET resume_status = 'delivery_outcome_unknown'
         WHERE status = 'resolved' AND resume_status = 'not_started'
           AND resume_claimed_at IS NOT NULL
           AND resume_claimed_at < now() - make_interval(mins => $1::int)
        "#,
    )
    .bind(lease_minutes as i32)
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

/// Raw `hitl_requests` row shape for `sqlx::FromRow` — `kind`/`origin`/
/// `status`/`resume_status` are plain `TEXT` columns (backed by CHECK
/// constraints, not a native Postgres enum type), so they decode as `String`
/// here and get parsed into their domain enums in [`try_into_domain`].
#[derive(sqlx::FromRow)]
struct HitlRequestRow {
    id: Uuid,
    kind: String,
    origin: String,
    status: String,
    resume_status: String,
    agent_id: Uuid,
    owner_user_id: Uuid,
    resolved_by: Option<Uuid>,
    task_id: Option<String>,
    context_id: Option<String>,
    chat_session_id: Option<String>,
    maf_execution_id: Option<Uuid>,
    maf_step_index: Option<i32>,
    connector_id: Option<Uuid>,
    tool_name: Option<String>,
    arguments_hash: Option<String>,
    consumed_at: Option<DateTime<Utc>>,
    question: Value,
    human_response: Option<Value>,
    resume_state: Value,
    resume_claimed_at: Option<DateTime<Utc>>,
    resume_dispatch_attempts: i32,
    resume_last_error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    resolved_at: Option<DateTime<Utc>>,
}

impl HitlRequestRow {
    fn try_into_domain(self) -> Result<HitlRequest> {
        Ok(HitlRequest {
            id: self.id,
            kind: self.kind.parse::<HitlKind>()?,
            origin: self.origin.parse::<HitlOrigin>()?,
            status: self.status.parse::<HitlStatus>()?,
            resume_status: self.resume_status.parse::<ResumeStatus>()?,
            agent_id: self.agent_id,
            owner_user_id: self.owner_user_id,
            resolved_by: self.resolved_by,
            task_id: self.task_id,
            context_id: self.context_id,
            chat_session_id: self.chat_session_id,
            maf_execution_id: self.maf_execution_id,
            maf_step_index: self.maf_step_index,
            connector_id: self.connector_id,
            tool_name: self.tool_name,
            arguments_hash: self.arguments_hash,
            consumed_at: self.consumed_at,
            question: self.question,
            human_response: self.human_response,
            resume_state: self.resume_state,
            resume_claimed_at: self.resume_claimed_at,
            resume_dispatch_attempts: self.resume_dispatch_attempts,
            resume_last_error: self.resume_last_error,
            created_at: self.created_at,
            updated_at: self.updated_at,
            expires_at: self.expires_at,
            resolved_at: self.resolved_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_row() -> HitlRequestRow {
        let now = Utc::now();
        HitlRequestRow {
            id: Uuid::new_v4(),
            kind: "auth_required".to_string(),
            origin: "mcp_tool".to_string(),
            status: "pending".to_string(),
            resume_status: "not_started".to_string(),
            agent_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            resolved_by: None,
            task_id: None,
            context_id: Some("ctx-1".to_string()),
            chat_session_id: None,
            maf_execution_id: None,
            maf_step_index: None,
            connector_id: Some(Uuid::new_v4()),
            tool_name: None,
            arguments_hash: None,
            consumed_at: None,
            question: serde_json::json!({"connector": "github"}),
            human_response: None,
            resume_state: serde_json::json!({}),
            resume_claimed_at: None,
            resume_dispatch_attempts: 0,
            resume_last_error: None,
            created_at: now,
            updated_at: now,
            expires_at: Some(now + Duration::days(7)),
            resolved_at: None,
        }
    }

    fn valid_tool_approval_row() -> HitlRequestRow {
        let mut row = valid_row();
        row.kind = "tool_approval".to_string();
        row.tool_name = Some("GITHUB_CREATE_ISSUE".to_string());
        row
    }

    #[test]
    fn valid_tool_approval_row_hydrates_into_domain_type() {
        let row = valid_tool_approval_row();
        let hitl = row.try_into_domain().expect("valid row must hydrate");
        assert_eq!(hitl.kind, HitlKind::ToolApproval);
        assert_eq!(hitl.origin, HitlOrigin::McpTool);
        assert_eq!(hitl.tool_name.as_deref(), Some("GITHUB_CREATE_ISSUE"));
        assert!(hitl.connector_id.is_some());
        assert_eq!(hitl.context_id.as_deref(), Some("ctx-1"));
    }

    #[test]
    fn valid_row_hydrates_into_domain_type() {
        let row = valid_row();
        let id = row.id;
        let hitl = row.try_into_domain().expect("valid row must hydrate");
        assert_eq!(hitl.id, id);
        assert_eq!(hitl.kind, HitlKind::AuthRequired);
        assert_eq!(hitl.origin, HitlOrigin::McpTool);
        assert_eq!(hitl.status, HitlStatus::Pending);
        assert_eq!(hitl.resume_status, ResumeStatus::NotStarted);
        assert_eq!(hitl.context_id.as_deref(), Some("ctx-1"));
    }

    #[test]
    fn unknown_kind_string_is_an_error_not_a_panic() {
        let mut row = valid_row();
        row.kind = "not_a_real_kind".to_string();
        let err = row.try_into_domain().unwrap_err();
        assert!(matches!(err, crate::error::HitlError::InvalidRow(_)));
    }

    #[test]
    fn unknown_status_string_is_an_error_not_a_panic() {
        let mut row = valid_row();
        row.status = "not_a_real_status".to_string();
        let err = row.try_into_domain().unwrap_err();
        assert!(matches!(err, crate::error::HitlError::InvalidRow(_)));
    }

    fn valid_request() -> HitlRequest {
        valid_row()
            .try_into_domain()
            .expect("valid row must hydrate")
    }

    #[test]
    fn authorize_hitl_action_allows_only_the_owner() {
        let request = valid_request();
        assert!(authorize_hitl_action(&request, request.owner_user_id));
        assert!(!authorize_hitl_action(&request, Uuid::new_v4()));
    }

    #[test]
    fn resolve_decision_maps_to_the_expected_terminal_status() {
        assert_eq!(
            ResolveDecision::Approve.target_status(),
            HitlStatus::Resolved
        );
        assert_eq!(
            ResolveDecision::Reject.target_status(),
            HitlStatus::Rejected
        );
    }
}
