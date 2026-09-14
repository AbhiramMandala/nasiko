use anyhow::{Result, bail};

const STRATEGIES: &[&str] = &["pacms", "topk", "lastk"];

/// Show the caller's persisted conversation-history context-selection strategy.
pub fn get() -> Result<()> {
    let client = crate::api::Client::from_active_cluster()?;
    let resp: serde_json::Value = client.get_json("/me/context-strategy")?;
    let strategy = resp
        .get("strategy")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    println!("Context strategy: {strategy}");
    Ok(())
}

/// Set the caller's conversation-history context-selection strategy (pacms/topk/lastk).
pub fn set(strategy: &str) -> Result<()> {
    let strategy = strategy.to_lowercase();
    if !STRATEGIES.contains(&strategy.as_str()) {
        bail!("invalid context strategy '{strategy}' — must be one of: pacms, topk, lastk");
    }

    let client = crate::api::Client::from_active_cluster()?;
    let _: serde_json::Value = client.patch_json(
        "/me/context-strategy",
        &serde_json::json!({ "strategy": strategy }),
    )?;
    println!("Context strategy set to: {strategy}");
    Ok(())
}
