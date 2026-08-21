//! Control-plane registration for coding-agent integrations.

use anyhow::Result;
use serde_json::json;

use super::agents::Agent;

pub fn register_agent(agent: Agent) -> Result<bool> {
    let spec = agent.spec();
    let client = crate::api::Client::from_active_cluster()?;
    client.post_json_allow_conflict(
        "/agents",
        &json!({
            "name": spec.agent_name,
            "display_name": spec.display_name,
            "description": format!("Local {} sessions, reported by the Nasiko CLI", spec.display_name),
            "version": "1.0.0",
            "tags": ["local", "coding-agent"],
            "metadata": {"source": "nasiko-cli-integration", "integration_id": spec.id},
        }),
    )
}
