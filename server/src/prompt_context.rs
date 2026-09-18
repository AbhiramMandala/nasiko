//! Generic hook for enterprise-only supplemental context added to an agent's prompt, keyed by
//! agent id. Deliberately generic-named — no enterprise or memory-specific naming — matching the
//! `FinopsUserScope` precedent (`oss/server/src/observability/handler.rs`): OSS defines the
//! shape and ships a no-op default, EE composition roots override it, same as `routing_engine` /
//! `resource_stats` (see `AppState`'s own doc comments for those).
//!
//! Unlike `FinopsUserScope` (a per-request `Extension` populated by prior middleware), this is
//! an `AppState` field: the candidate-agent list this needs to react to (`orchestrator_stream`'s
//! agent selection) isn't known until partway through the handler, so there's no point before
//! the handler runs where per-request middleware could precompute anything — the handler calls
//! this service inline once it has that data, the same way it already calls `state.auth` inline.

use std::collections::HashMap;

use async_trait::async_trait;
use uuid::Uuid;

#[async_trait]
pub trait PromptContextProvider: Send + Sync {
    /// Supplemental text for each of the given candidate agents, before any one of them has been
    /// chosen (e.g. the ReAct planner's "Available Agents" list, built before the LLM decides
    /// anything) — ranked against `query` in addition to any pinned content, exactly like
    /// `context_for_agent` does for a single already-chosen agent. Agents with nothing relevant
    /// to add are simply absent from the returned map.
    async fn context_for_agents(&self, agent_ids: &[Uuid], query: &str) -> HashMap<Uuid, String>;

    /// Supplemental text for one already-chosen agent, given the actual query text so
    /// query-relevant content can be ranked in addition to any pinned content. `None` when
    /// there's nothing to add.
    async fn context_for_agent(&self, agent_id: Uuid, query: &str) -> Option<String>;
}

/// OSS default — no enterprise context source is wired up, so every call is a no-op.
pub struct NoopPromptContextProvider;

#[async_trait]
impl PromptContextProvider for NoopPromptContextProvider {
    async fn context_for_agents(&self, _agent_ids: &[Uuid], _query: &str) -> HashMap<Uuid, String> {
        HashMap::new()
    }

    async fn context_for_agent(&self, _agent_id: Uuid, _query: &str) -> Option<String> {
        None
    }
}
