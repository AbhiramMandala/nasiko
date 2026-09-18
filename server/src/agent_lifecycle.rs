//! Generic hook fired when an agent is deleted, for enterprise-only cleanup of agent-keyed state
//! that OSS has no knowledge of. Deliberately generic-named — no enterprise-specific naming —
//! same pattern as `prompt_context`: OSS defines the shape and ships a no-op default, EE
//! composition roots override it.

use async_trait::async_trait;
use uuid::Uuid;

#[async_trait]
pub trait AgentDeletionHook: Send + Sync {
    /// Called once, best-effort, right after `agents.deleted_at` has been set for `agent_id` —
    /// a chance for enterprise-only, agent-keyed state that OSS's schema has no FK for (so a soft
    /// delete can't cascade to it) to clean itself up. Must never fail or block the delete
    /// request: implementations should log and swallow their own errors, the same way the MCP
    /// gateway token revoke right above this call site does.
    async fn on_agent_deleted(&self, agent_id: Uuid);
}

/// OSS default — nothing enterprise-only is wired up, so there is nothing to clean up.
pub struct NoopAgentDeletionHook;

#[async_trait]
impl AgentDeletionHook for NoopAgentDeletionHook {
    async fn on_agent_deleted(&self, _agent_id: Uuid) {}
}
