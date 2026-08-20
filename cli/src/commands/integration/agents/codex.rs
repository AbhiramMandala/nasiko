use std::path::PathBuf;

use super::super::catalog::{self, AgentSpec, Support};

pub const SPEC: AgentSpec = AgentSpec {
    id: "codex",
    display_name: "Codex",
    binary: "codex",
    agent_name: "codex",
    support: Support::DetectOnly,
};

pub fn config_path() -> PathBuf {
    catalog::home().join(".codex")
}
