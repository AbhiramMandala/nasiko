//! Shared inline HITL (Human-in-the-Loop) prompt/resolve logic, reused by every interactive
//! surface that can hit a pause — `commands::chat` (both the orchestrator and `-a`/agent_proxy
//! paths) and `commands::maf`'s `--wait` poll loop. One shared `HitlPause` + `prompt_and_resolve_hitl`
//! keeps the prompt wording, colors, and `/hitl/{id}/resolve` semantics identical everywhere a
//! pause can surface, rather than each surface reimplementing its own.

use anyhow::Result;
use nasiko_utils::term;

use crate::api::Client;

/// A pause raised mid-turn/mid-step, wherever it was discovered — the
/// `"type":"hitl"` SSE data part for `chat`, or the `hitl[]` entry on a MAF
/// execution response for `maf`. `id` is always the real `hitl_requests.id`
/// to resolve against — even when this pause is an MCP tool-approval
/// mirrored onto another conversation, the substitution already happened
/// server-side (`resolve_display_row`) before either shape was built.
pub struct HitlPause {
    pub id: String,
    pub kind: String,
    pub question: serde_json::Value,
    /// Who's asking, if known — an agent name for `chat`, a step label
    /// (e.g. "step 2") for `maf`. Falls back to a generic "agent" label.
    pub agent: Option<String>,
}

/// Shows the pause inline and blocks on the human's response, then POSTs the
/// resolution to `/api/hitl/{id}/resolve`. A pause someone else already
/// resolved (`already_resolved: true` in a 200 response) is a normal
/// outcome, not an error — printed and treated as done.
pub fn prompt_and_resolve_hitl(pause: &HitlPause) -> Result<()> {
    let who = pause.agent.as_deref().unwrap_or("agent");
    let message = |key: &str| {
        pause
            .question
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
    };

    let body = match pause.kind.as_str() {
        "tool_approval" => {
            let tool = pause.question.get("tool_name").and_then(|v| v.as_str());
            let connector = pause.question.get("connector_id").and_then(|v| v.as_str());
            let msg = message("message");
            let mut panel = format!(
                "{who} wants to run  \x1b[1m{}\x1b[0m",
                tool.unwrap_or("(unknown tool)")
            );
            if let Some(c) = connector {
                panel.push_str(&format!("\nvia connector  {c}"));
            }
            if !msg.is_empty() {
                panel.push_str(&format!("\n{msg}"));
            }
            println!();
            term::print_box(Some("⏸ APPROVAL NEEDED"), &panel, "33");
            // Same three choices the web UI's tool-approval card offers — "session"
            // scope (§5 of the HITL plan) is a real, separately-meaningful option, not
            // just a variant of "once", so it needs its own place in the prompt rather
            // than being folded into a yes/no.
            let options = ["Allow once", "Always allow", "Deny"];
            let choice = dialoguer::Select::new()
                .with_prompt("Approve?")
                .items(&options)
                .default(0)
                .interact()
                // Fail closed on an interrupted/unreadable prompt — never treat "couldn't
                // ask" as permission granted.
                .unwrap_or(2);
            let (decision, scope) = match choice {
                0 => ("approve", "once"),
                1 => ("approve", "session"),
                _ => ("reject", "once"),
            };
            serde_json::json!({ "decision": decision, "scope": scope })
        }
        "auth_required" => {
            let msg = message("message");
            let mut panel = format!(
                "{who} needs authorization: {}",
                if msg.is_empty() {
                    "re-authentication required"
                } else {
                    msg
                }
            );
            let connector_id = pause.question.get("connector_id").and_then(|v| v.as_str());
            if let Some(c) = pause
                .question
                .get("connector")
                .and_then(|v| v.as_str())
                .or(connector_id)
            {
                panel.push_str(&format!("\nconnector  {c}"));
            }
            // Two different shapes carry this, depending on which layer raised the
            // pause: an agent's own token-URL flow nests it under "metadata" (its
            // own event's metadata, forwarded as-is into `question`), while the MCP
            // gateway's connector auth_required puts it top-level on `question`
            // itself (`handle_auth_required` in oss/mcp-gateway/src/protocol.rs).
            if let Some(url) = pause
                .question
                .get("auth_url")
                .or_else(|| pause.question.pointer("/metadata/auth_url"))
                .and_then(|v| v.as_str())
            {
                panel.push_str(&format!("\nopen this to authenticate: {url}"));
            }
            // `connector_id` only appears on a real MCP-gateway-raised pause
            // (`handle_auth_required`) — an agent's own fixture/demo auth_required
            // has no connector to reconnect, so there's no CLI fix to suggest.
            if let Some(id) = connector_id {
                panel.push_str(&format!(
                    "\nor from the CLI: nasiko mcp connect --connector-id {id}\nthen confirm with: nasiko mcp connections"
                ));
            }
            println!();
            term::print_box(Some("⏸ AUTHORIZATION NEEDED"), &panel, "33");
            dialoguer::Input::<String>::new()
                .with_prompt("Once you've finished, press Enter to continue")
                .allow_empty(true)
                .interact_text()
                .ok();
            serde_json::json!({ "auth_action": "confirm" })
        }
        // "input_required" and any forward-compatible unknown kind: a plain question.
        _ => {
            let msg = message("message");
            println!();
            term::print_box(
                Some(&format!("⏸ {who}")),
                if msg.is_empty() {
                    "(needs your input)"
                } else {
                    msg
                },
                "33",
            );
            let answer = dialoguer::Input::<String>::new()
                .with_prompt("\x1b[1;36m❯ you\x1b[0m")
                .allow_empty(true)
                .interact_text()
                .unwrap_or_default();
            serde_json::json!({ "answer": answer })
        }
    };

    let resp: serde_json::Value =
        Client::from_active_cluster()?.post_json(&format!("/hitl/{}/resolve", pause.id), &body)?;

    if resp.get("already_resolved").and_then(|v| v.as_bool()) == Some(true) {
        eprintln!("  \x1b[2m(already resolved by someone else)\x1b[0m");
    } else {
        eprintln!(
            "  \x1b[2m(HITL ID: {} — for reference only)\x1b[0m",
            pause.id
        );
    }
    println!();
    Ok(())
}
