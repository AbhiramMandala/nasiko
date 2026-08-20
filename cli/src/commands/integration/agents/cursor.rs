use std::path::PathBuf;

use super::super::catalog::{self, AgentSpec, Support};

pub const SPEC: AgentSpec = AgentSpec {
    id: "cursor",
    display_name: "Cursor CLI",
    binary: "cursor-agent",
    agent_name: "cursor",
    support: Support::DetectOnly,
};

pub fn config_path() -> PathBuf {
    catalog::home().join(".cursor")
}
