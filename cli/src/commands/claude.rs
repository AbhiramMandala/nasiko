//! Connect Claude Code to the Nasiko LLM router and issue on-demand credentials.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::api::Client;
use crate::commands::{agents::resolve_agent_id, llm_config::fetch_config_by_ref};
use crate::config;

const STATE_VERSION: u32 = 1;
const DEFAULT_AGENT_NAME: &str = "claude-code";
const INTEGRATION_SOURCE: &str = "nasiko-cli-claude-router";

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct RoutingToken {
    token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct SavedValue {
    present: bool,
    #[serde(default)]
    value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConnectionState {
    version: u32,
    cluster: String,
    cluster_url: String,
    agent_id: String,
    agent_name: String,
    settings_path: PathBuf,
    helper_command: String,
    original_env_present: bool,
    original_helper: SavedValue,
    original_base_url: SavedValue,
}

/// One-time setup. Claude subsequently invokes the hidden credential helper itself.
pub fn connect(agent: Option<&str>, llm_config: Option<&str>) -> Result<()> {
    which::which("claude").context("Claude Code is not installed or 'claude' is not on PATH")?;
    require_current_login()?;

    let (cluster, entry) = config::active_cluster()?;
    let client = Client::from_cluster_entry(&entry);
    let (agent_id, agent_name) = match agent {
        Some(reference) => (resolve_agent_id(reference)?, reference.to_string()),
        None => ensure_local_agent(&client)?,
    };
    let resolved = configure_agent(&client, &agent_id, llm_config)?;

    if state_path().exists() {
        disconnect_internal(false)?;
    }

    let settings_path = claude_settings_path();
    let mut settings = read_json_object(&settings_path)?;
    let helper_command = helper_command()?;
    let original_env_present = settings.contains_key("env");
    let original_helper = capture(settings.get("apiKeyHelper"));
    let original_base_url = capture(
        settings
            .get("env")
            .and_then(Value::as_object)
            .and_then(|env| env.get("ANTHROPIC_BASE_URL")),
    );
    let env = ensure_env_object(&mut settings)?;
    env.insert(
        "ANTHROPIC_BASE_URL".into(),
        Value::String(entry.url.trim_end_matches('/').to_string()),
    );
    settings.insert("apiKeyHelper".into(), Value::String(helper_command.clone()));

    let state = ConnectionState {
        version: STATE_VERSION,
        cluster: cluster.clone(),
        cluster_url: entry.url.clone(),
        agent_id,
        agent_name,
        settings_path: settings_path.clone(),
        helper_command,
        original_env_present,
        original_helper,
        original_base_url,
    };
    write_json_atomic(&state_path(), &serde_json::to_value(&state)?)?;
    if let Err(error) = write_json_atomic(&settings_path, &Value::Object(settings)) {
        let _ = fs::remove_file(state_path());
        return Err(error);
    }

    let provider = resolved
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("router");
    let model = resolved
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("policy-selected");
    println!("Connected Claude Code to Nasiko ({cluster}, {provider}/{model}).");
    println!("Run `claude` normally. Disconnect with: nasiko disconnect claude");
    Ok(())
}

pub fn disconnect() -> Result<()> {
    disconnect_internal(true)
}

fn disconnect_internal(print: bool) -> Result<()> {
    let Some(state) = load_state()? else {
        if print {
            println!("Claude Code is not connected to Nasiko.");
        }
        return Ok(());
    };
    let mut settings = read_json_object(&state.settings_path)?;
    restore_top_level(
        &mut settings,
        "apiKeyHelper",
        &Value::String(state.helper_command.clone()),
        &state.original_helper,
    );
    restore_env(
        &mut settings,
        "ANTHROPIC_BASE_URL",
        &Value::String(state.cluster_url.trim_end_matches('/').to_string()),
        &state.original_base_url,
        state.original_env_present,
    )?;
    write_json_atomic(&state.settings_path, &Value::Object(settings))?;
    fs::remove_file(state_path()).context("failed to remove Claude connection state")?;
    if print {
        println!("Disconnected Claude Code from Nasiko.");
    }
    Ok(())
}

pub fn status() -> Result<()> {
    let Some(state) = load_state()? else {
        println!("Claude Code is not connected to Nasiko.");
        println!("Connect with: nasiko connect claude");
        return Ok(());
    };
    let settings = read_json_object(&state.settings_path)?;
    let helper_ok = settings.get("apiKeyHelper") == Some(&Value::String(state.helper_command));
    let base_ok = settings
        .get("env")
        .and_then(Value::as_object)
        .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
        == Some(&Value::String(state.cluster_url.clone()));
    let auth = config::load()?
        .clusters
        .get(&state.cluster)
        .and_then(|entry| entry.token.as_deref())
        .map(|token| match config::token_expired(token) {
            Some(true) => "expired",
            Some(false) => "authenticated",
            None => "unknown",
        })
        .unwrap_or("not logged in");
    println!("Claude Code: connected");
    println!("Cluster:     {} ({})", state.cluster, state.cluster_url);
    println!("Agent:       {}", state.agent_name);
    println!("Nasiko auth: {auth}");
    println!(
        "Settings:    {}",
        if helper_ok && base_ok {
            "active"
        } else {
            "changed since connect"
        }
    );
    Ok(())
}

/// Hidden `apiKeyHelper` entry point. Stdout must contain only the credential.
pub fn credential() -> Result<()> {
    let state = load_state()?.ok_or_else(|| {
        anyhow::anyhow!("Claude Code is not connected; run: nasiko connect claude")
    })?;
    let cfg = config::load()?;
    let entry = cfg
        .clusters
        .get(&state.cluster)
        .ok_or_else(|| anyhow::anyhow!("Nasiko cluster '{}' no longer exists", state.cluster))?;
    if entry.url.trim_end_matches('/') != state.cluster_url.trim_end_matches('/') {
        bail!("connected Nasiko cluster URL changed; run: nasiko connect claude");
    }
    let token = entry
        .token
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("not logged in to Nasiko; run: nasiko auth login"))?;
    if config::token_expired(token) == Some(true) {
        bail!("Nasiko session expired; run: nasiko auth login");
    }
    let client = Client::from_cluster_entry(entry);
    let response: Envelope<RoutingToken> =
        client.post_json_quiet(&format!("/agents/{}/llm-token", state.agent_id), &json!({}))?;
    println!("{}", response.data.token);
    Ok(())
}

/// Explicit one-process mode retained for testing and temporary use.
pub fn run(agent: &str, llm_config: Option<&str>, args: &[String]) -> Result<()> {
    let claude = which::which("claude")
        .context("Claude Code is not installed or 'claude' is not on PATH")?;
    let agent_id = resolve_agent_id(agent)?;
    let client = Client::from_active_cluster()?;
    configure_agent(&client, &agent_id, llm_config)?;
    let response: Envelope<RoutingToken> =
        client.post_json(&format!("/agents/{agent_id}/llm-token"), &json!({}))?;
    let status = Command::new(claude)
        .args(args)
        .env(
            "ANTHROPIC_BASE_URL",
            client.base_url().trim_end_matches('/'),
        )
        .env("ANTHROPIC_AUTH_TOKEN", response.data.token)
        .env_remove("ANTHROPIC_API_KEY")
        .status()
        .context("failed to launch Claude Code")?;
    if !status.success() {
        bail!("Claude Code exited with {status}");
    }
    Ok(())
}

fn require_current_login() -> Result<()> {
    let (_, entry) = config::active_cluster()?;
    let token = entry
        .token
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("not logged in to Nasiko; run: nasiko auth login"))?;
    if config::token_expired(token) == Some(true) {
        bail!("Nasiko session expired; run: nasiko auth login");
    }
    Ok(())
}

fn ensure_local_agent(client: &Client) -> Result<(String, String)> {
    let owner = client
        .current_user_id()
        .ok_or_else(|| anyhow::anyhow!("invalid Nasiko login; run: nasiko auth login"))?;
    let agents: Vec<Value> = client.get_json("/agents?limit=100")?;
    if let Some(agent) = agents.iter().find(|agent| {
        agent.get("owner_id").and_then(Value::as_str) == Some(owner.as_str())
            && (agent
                .get("metadata")
                .and_then(|metadata| metadata.get("source"))
                .and_then(Value::as_str)
                == Some(INTEGRATION_SOURCE)
                || agent
                    .get("metadata")
                    .and_then(|metadata| metadata.get("integration_id"))
                    .and_then(Value::as_str)
                    == Some("claude"))
    }) {
        let id = agent
            .get("id")
            .and_then(Value::as_str)
            .context("Claude routing agent is missing an id")?;
        let name = agent
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_AGENT_NAME);
        return Ok((id.to_string(), name.to_string()));
    }

    let suffix: String = owner.chars().filter(|c| *c != '-').take(8).collect();
    let name = format!("{DEFAULT_AGENT_NAME}-{suffix}");
    if let Some(agent) = client.get_agent(&name)?
        && agent.get("owner_id").and_then(Value::as_str) == Some(owner.as_str())
    {
        let id = agent
            .get("id")
            .and_then(Value::as_str)
            .context("Claude routing agent is missing an id")?;
        return Ok((id.to_string(), name));
    }
    let agent: Value = client.post_json(
        "/agents",
        &json!({
            "name": name,
            "display_name": "Claude Code",
            "description": "Local Claude Code traffic routed through Nasiko",
            "version": "1.0.0",
            "tags": ["local", "coding-agent", "llm-router"],
            "metadata": {"source": INTEGRATION_SOURCE},
        }),
    )?;
    let id = agent
        .get("id")
        .and_then(Value::as_str)
        .context("created Claude routing agent is missing an id")?;
    Ok((id.to_string(), name))
}

fn configure_agent(client: &Client, agent_id: &str, llm_config: Option<&str>) -> Result<Value> {
    let path = format!("/agents/{agent_id}/llm-config");
    let response: Value = if let Some(reference) = llm_config {
        let config = fetch_config_by_ref(client, reference)?;
        let config_id = config
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("LLM config is missing an id"))?;
        client.patch_json(
            &path,
            &json!({"llm_config_id": config_id}),
        )?
    } else {
        client.get_json(&path)?
    };
    let resolved = response
        .get("data")
        .and_then(|data| data.get("llm_config"))
        .filter(|value| !value.is_null())
        .cloned()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no Nasiko LLM config is available; create a default config or pass --config <name>"
            )
        })?;
    Ok(resolved)
}

fn state_path() -> PathBuf {
    home_dir()
        .join(".nasiko")
        .join("integrations")
        .join("claude.json")
}

fn claude_settings_path() -> PathBuf {
    home_dir().join(".claude").join("settings.json")
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn helper_command() -> Result<String> {
    let executable = std::env::current_exe().context("cannot locate the nasiko executable")?;
    Ok(format!("{} __claude-token", shell_quote(&executable)))
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn load_state() -> Result<Option<ConnectionState>> {
    let path = state_path();
    if !path.exists() {
        return Ok(None);
    }
    let content =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let state: ConnectionState = serde_json::from_str(&content)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    if state.version != STATE_VERSION {
        bail!(
            "unsupported Claude connection state version {}",
            state.version
        );
    }
    Ok(Some(state))
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>> {
    if !path.exists() {
        return Ok(Map::new());
    }
    if path.is_symlink() {
        bail!(
            "refusing to replace symlinked settings file {}",
            path.display()
        );
    }
    let content =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(Map::new());
    }
    serde_json::from_str::<Value>(&content)?
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("{} must contain a JSON object", path.display()))
}

fn ensure_env_object(settings: &mut Map<String, Value>) -> Result<&mut Map<String, Value>> {
    if !settings.contains_key("env") {
        settings.insert("env".into(), Value::Object(Map::new()));
    }
    settings
        .get_mut("env")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| anyhow::anyhow!("Claude setting 'env' must be a JSON object"))
}

fn capture(value: Option<&Value>) -> SavedValue {
    SavedValue {
        present: value.is_some(),
        value: value.cloned().unwrap_or(Value::Null),
    }
}

fn restore_top_level(
    settings: &mut Map<String, Value>,
    key: &str,
    installed: &Value,
    original: &SavedValue,
) {
    if settings.get(key) != Some(installed) {
        eprintln!("warning: Claude setting '{key}' changed since connect; leaving it unchanged");
        return;
    }
    if original.present {
        settings.insert(key.into(), original.value.clone());
    } else {
        settings.remove(key);
    }
}

fn restore_env(
    settings: &mut Map<String, Value>,
    key: &str,
    installed: &Value,
    original: &SavedValue,
    original_env_present: bool,
) -> Result<()> {
    let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) else {
        eprintln!(
            "warning: Claude setting 'env.{key}' changed since connect; leaving it unchanged"
        );
        return Ok(());
    };
    if env.get(key) != Some(installed) {
        eprintln!(
            "warning: Claude setting 'env.{key}' changed since connect; leaving it unchanged"
        );
        return Ok(());
    }
    if original.present {
        env.insert(key.into(), original.value.clone());
    } else {
        env.remove(key);
    }
    if env.is_empty() && !original_env_present {
        settings.remove("env");
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = parent.join(format!(".nasiko-{}-{nonce}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&temp)?;
        file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.with_context(|| format!("failed to write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_token_response_deserializes() {
        let response: Envelope<RoutingToken> =
            serde_json::from_value(json!({"data": {"token": "jwt"}})).unwrap();
        assert_eq!(response.data.token, "jwt");
    }

    #[test]
    fn restore_preserves_unrelated_settings() {
        let mut settings = json!({
            "theme": "dark",
            "apiKeyHelper": "nasiko helper",
            "env": {"OTHER": "keep", "ANTHROPIC_BASE_URL": "https://nasiko"}
        })
        .as_object()
        .unwrap()
        .clone();
        restore_top_level(
            &mut settings,
            "apiKeyHelper",
            &json!("nasiko helper"),
            &SavedValue {
                present: false,
                value: Value::Null,
            },
        );
        restore_env(
            &mut settings,
            "ANTHROPIC_BASE_URL",
            &json!("https://nasiko"),
            &SavedValue {
                present: false,
                value: Value::Null,
            },
            true,
        )
        .unwrap();
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["env"]["OTHER"], "keep");
        assert!(!settings.contains_key("apiKeyHelper"));
        assert!(settings["env"].get("ANTHROPIC_BASE_URL").is_none());
    }

    #[test]
    fn restore_keeps_user_changes() {
        let mut settings = json!({"apiKeyHelper": "user replacement"})
            .as_object()
            .unwrap()
            .clone();
        restore_top_level(
            &mut settings,
            "apiKeyHelper",
            &json!("nasiko helper"),
            &SavedValue {
                present: false,
                value: Value::Null,
            },
        );
        assert_eq!(settings["apiKeyHelper"], "user replacement");
    }

    #[test]
    fn shell_quotes_apostrophes() {
        assert_eq!(shell_quote(Path::new("/tmp/a'b")), "'/tmp/a'\\''b'");
    }
}
