//! Detect local coding agents and report their sessions to Nasiko.
//!
//! `nasiko integrations` answers "what coding agents are on this machine".
//! `nasiko integration install <id>` goes further: it registers that agent in
//! the control plane and installs a hook so every session it runs shows up in
//! `nasiko observe sessions` with tokens, latency and cost — the same views
//! deployed agents get.
//!
//! Nothing here changes the observability read path: spans are emitted under
//! the attribute names that path already reads (see [`otlp`]), so no server
//! change is needed for a local session to appear.

mod agents;
mod catalog;
mod control_plane;
mod launcher;
mod model;
mod otlp;
mod report;
mod state;

use anyhow::{Context, Result, bail};
use std::path::Path;

use agents::Agent;
use catalog::Support;
use state::{AgentState, DEFAULT_OTLP_ENDPOINT, IntegrationState};

/// Options accepted by `nasiko integration install`.
pub struct InstallOptions<'a> {
    pub agent_id: &'a str,
    /// OTLP/HTTP collector to send spans to. Defaults to the local stack.
    pub otlp_endpoint: Option<&'a str>,
    /// Keep prompt and response text out of exported spans.
    pub no_content: bool,
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Print every catalogued agent, whether it is on this machine, and whether
/// session reporting is installed.
pub fn status() -> Result<()> {
    let settings = IntegrationState::load()?;

    println!(
        "{:<10} {:<10} {:<22} CONFIG",
        "AGENT", "DETECTED", "REPORTING"
    );
    println!("{}", "-".repeat(78));
    for agent in Agent::ALL.iter().copied() {
        let spec = agent.spec();
        println!(
            "{:<10} {:<10} {:<22} {}",
            spec.id,
            if detect(agent).is_present() {
                "yes"
            } else {
                "-"
            },
            reporting_status(agent, &settings),
            tildify(&agent.config_path()),
        );
    }

    println!("\nInstall session reporting:  nasiko integration install <agent>");
    Ok(())
}

/// Register a coding agent with the control plane and install its hook.
pub fn install(options: InstallOptions<'_>) -> Result<()> {
    let agent = resolve(options.agent_id)?;
    require_instrumentable(agent)?;
    require_present(agent)?;

    let endpoint = options.otlp_endpoint.unwrap_or(DEFAULT_OTLP_ENDPOINT);
    let spec = agent.spec();
    let created = control_plane::register_agent(agent)?;
    println!(
        "{} agent '{}' in the control plane",
        if created { "Registered" } else { "Found" },
        spec.agent_name
    );

    let artifacts = agent.install()?;
    let (script, registration) = persist_installed_artifacts(
        artifacts,
        || save_agent_state(agent, endpoint, !options.no_content),
        || agent.uninstall(),
    )?;

    println!("Installed hook              {}", tildify(&script));
    println!("Installed integration       {}", tildify(&registration));
    println!("Reporting spans to          {endpoint}");
    println!(
        "\nStart a new {} session, then: nasiko observe sessions",
        spec.display_name
    );
    if agent.restart_required() {
        println!("Restart OpenCode first so it loads the new plugin.");
    }
    Ok(())
}

/// Remove a coding agent's hook. The registered agent and its past traces are
/// left alone — deleting them is a separate, destructive decision.
pub fn uninstall(agent_id: &str) -> Result<()> {
    let agent = resolve(agent_id)?;
    let spec = agent.spec();
    agent.uninstall()?;

    let mut settings = IntegrationState::load()?;
    settings.agents.remove(spec.id);
    settings.save()?;

    println!("Removed the {} hook.", spec.display_name);
    println!(
        "Agent '{}' is still registered; its past sessions remain in observability.",
        spec.agent_name
    );
    Ok(())
}

/// Hook entry point — see [`report`].
pub fn report(agent_id: &str) -> Result<()> {
    report::run(resolve(agent_id)?)
}

// ─── Detection ───────────────────────────────────────────────────────────────

/// What was found on disk for one agent.
struct Detection {
    binary_on_path: bool,
    config_dir_exists: bool,
}

impl Detection {
    /// Either signal is enough: a config directory without the binary means
    /// the agent was used here before, and a binary without a config directory
    /// means it has been installed but not yet run.
    fn is_present(&self) -> bool {
        self.binary_on_path || self.config_dir_exists
    }
}

fn detect(agent: Agent) -> Detection {
    let spec = agent.spec();
    Detection {
        binary_on_path: which::which(spec.binary).is_ok(),
        config_dir_exists: agent.config_path().is_dir(),
    }
}

/// The REPORTING column: what Nasiko is doing for this agent right now.
fn reporting_status(agent: Agent, settings: &IntegrationState) -> String {
    let spec = agent.spec();
    if spec.support == Support::DetectOnly {
        return Support::DetectOnly.label().to_string();
    }
    let expected = agent
        .install_version()
        .expect("instrumented adapter has a version");
    match agent.installed_version() {
        Some(version) if version == expected => match settings.get(spec.id) {
            Some(state) if state.hook_version == expected => format!("active (v{version})"),
            // Script present but no config: the hook would refuse to report.
            Some(_) | None => "needs reinstall".to_string(),
        },
        Some(version) => format!("stale (v{version}; current v{expected})"),
        None => "not installed".to_string(),
    }
}

// ─── Install steps ───────────────────────────────────────────────────────────

fn resolve(agent_id: &str) -> Result<Agent> {
    catalog::find(agent_id).ok_or_else(|| {
        anyhow::anyhow!(
            "unknown agent '{agent_id}' — known agents: {}",
            catalog::known_ids()
        )
    })
}

fn require_instrumentable(agent: Agent) -> Result<()> {
    let spec = agent.spec();
    if !agent.is_instrumented() {
        bail!(
            "{} can be detected but not yet instrumented — \
             session reporting is implemented for: {}",
            spec.display_name,
            instrumentable_ids()
        );
    }
    Ok(())
}

fn require_present(agent: Agent) -> Result<()> {
    let spec = agent.spec();
    if detect(agent).is_present() {
        return Ok(());
    }
    bail!(
        "{} was not found on this machine (no '{}' on PATH, no {})",
        spec.display_name,
        spec.binary,
        tildify(&agent.config_path())
    )
}

fn save_agent_state(agent: Agent, endpoint: &str, capture_content: bool) -> Result<()> {
    let spec = agent.spec();
    let mut settings = IntegrationState::load()?;
    settings.agents.insert(
        spec.id.to_string(),
        AgentState {
            agent_name: spec.agent_name.to_string(),
            otlp_endpoint: endpoint.to_string(),
            capture_content,
            hook_version: agent.install_version().expect("instrumented adapter"),
        },
    );
    settings.save()
}

fn persist_installed_artifacts<T>(
    artifacts: T,
    persist: impl FnOnce() -> Result<()>,
    rollback: impl FnOnce() -> Result<()>,
) -> Result<T> {
    if let Err(error) = persist() {
        rollback().context("failed to roll back integration artifacts")?;
        return Err(error.context("failed to save integration state; installation rolled back"));
    }
    Ok(artifacts)
}

fn instrumentable_ids() -> String {
    Agent::ALL
        .iter()
        .filter(|agent| agent.is_instrumented())
        .map(|agent| agent.spec().id)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Shorten a path under `$HOME` to `~/...` for display.
fn tildify(path: &Path) -> String {
    let home = catalog::home();
    match path.strip_prefix(&home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn claude() -> Agent {
        catalog::find("claude").unwrap()
    }

    #[test]
    fn rejects_an_unknown_agent_id_with_the_known_ones() {
        let error = resolve("emacs").unwrap_err().to_string();

        assert!(error.contains("unknown agent 'emacs'"));
        assert!(error.contains("claude"));
    }

    #[test]
    fn refuses_to_install_a_detect_only_agent() {
        let error = require_instrumentable(catalog::find("codex").unwrap())
            .unwrap_err()
            .to_string();

        assert!(error.contains("not yet instrumented"));
        assert!(error.contains("claude"));
    }

    #[test]
    fn allows_installing_an_instrumented_agent() {
        assert!(require_instrumentable(claude()).is_ok());
    }

    #[test]
    fn reports_detect_only_agents_as_such() {
        let settings = IntegrationState::default();

        let status = reporting_status(catalog::find("codex").unwrap(), &settings);

        assert_eq!(status, "detect-only");
    }

    #[test]
    fn treats_a_missing_binary_and_missing_config_dir_as_absent() {
        let detection = Detection {
            binary_on_path: false,
            config_dir_exists: false,
        };

        assert!(!detection.is_present());
    }

    #[test]
    fn treats_a_config_dir_alone_as_present() {
        let detection = Detection {
            binary_on_path: false,
            config_dir_exists: true,
        };

        assert!(detection.is_present());
    }

    #[test]
    fn shortens_a_home_path_for_display() {
        let path = catalog::home().join(".claude").join("settings.json");

        assert_eq!(tildify(&path), "~/.claude/settings.json");
    }

    #[test]
    fn leaves_a_path_outside_home_alone() {
        assert_eq!(tildify(Path::new("/etc/hosts")), "/etc/hosts");
    }

    #[test]
    fn failed_state_save_rolls_back_installed_artifacts() {
        let rolled_back = Cell::new(false);
        let result = persist_installed_artifacts(
            "artifacts",
            || Err(anyhow::anyhow!("disk full")),
            || {
                rolled_back.set(true);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(rolled_back.get());
    }

    #[test]
    fn active_status_requires_matching_state_version() {
        let expected = claude().install_version().unwrap();
        let state = AgentState {
            agent_name: "claude-code".into(),
            otlp_endpoint: DEFAULT_OTLP_ENDPOINT.into(),
            capture_content: true,
            hook_version: expected.saturating_sub(1),
        };
        assert_ne!(state.hook_version, expected);
    }
}
