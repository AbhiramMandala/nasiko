//! Control-plane registration for coding-agent integrations.

use anyhow::Result;
use serde_json::json;

use super::agents::Agent;

pub struct Registration {
    pub created: bool,
    pub agent_name: String,
}

pub fn register_agent(agent: Agent) -> Result<Registration> {
    let spec = agent.spec();
    let (_, entry) = crate::config::active_cluster()?;
    let client = crate::api::Client::from_cluster_entry(&entry);
    let username =
        crate::commands::coding_agent_router::authenticated_account_username(&client, &entry)?;
    let agent_name = crate::commands::coding_agent_router::account_scoped_agent_name_for_username(
        &username,
        spec.agent_name,
    )?;
    let created = client.post_json_allow_conflict(
        "/agents",
        &json!({
            "name": agent_name,
            "display_name": format!("{} ({username})", spec.display_name),
            "description": format!("Local {} sessions, reported by the Nasiko CLI", spec.display_name),
            "version": "1.0.0",
            "tags": ["local", "coding-agent"],
            "metadata": {"source": "nasiko-cli-integration", "integration_id": spec.id},
        }),
    )?;
    Ok(Registration {
        created,
        agent_name,
    })
}
