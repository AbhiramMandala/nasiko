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
    let response: serde_json::Value = client.post_json(
        "/agents/coding-integrations",
        &json!({"integration_id": spec.id}),
    )?;
    let created = response
        .get("created")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let agent_name = response
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("coding-agent registration response is missing its name"))?
        .to_string();
    Ok(Registration {
        created,
        agent_name,
    })
}
