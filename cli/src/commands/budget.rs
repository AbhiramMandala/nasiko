use anyhow::{Result, bail};

const LEVELS: &[&str] = &["low", "medium", "high"];

/// Show the caller's persisted PACMS conversation-history budget tier.
pub fn get() -> Result<()> {
    let client = crate::api::Client::from_active_cluster()?;
    let resp: serde_json::Value = client.get_json("/me/pacms-budget")?;
    let level = resp
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    println!("PACMS budget: {level}");
    Ok(())
}

/// Set the caller's PACMS conversation-history budget tier (low/medium/high).
pub fn set(level: &str) -> Result<()> {
    let level = level.to_lowercase();
    if !LEVELS.contains(&level.as_str()) {
        bail!("invalid budget level '{level}' — must be one of: low, medium, high");
    }

    let client = crate::api::Client::from_active_cluster()?;
    let _: serde_json::Value =
        client.patch_json("/me/pacms-budget", &serde_json::json!({ "level": level }))?;
    println!("PACMS budget set to: {level}");
    Ok(())
}
