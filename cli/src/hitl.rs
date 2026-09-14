//! Shared inline HITL (Human-in-the-Loop) prompt/resolve logic, reused by every interactive
//! surface that can hit a pause — `commands::chat` (both the orchestrator and `-a`/agent_proxy
//! paths) and `commands::maf`'s `--wait` poll loop. One shared `HitlPause` + `prompt_and_resolve_hitl`
//! keeps the prompt wording, colors, and `/hitl/{id}/resolve` semantics identical everywhere a
//! pause can surface, rather than each surface reimplementing its own.

use anyhow::Result;
use dialoguer::theme::ColorfulTheme;
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
        // "input_required" and any forward-compatible unknown kind: a plain question, or —
        // when the agent's `ask_human` attached the selectable-options extension — a
        // single/multi-select question with optional free-text custom input (mirrors
        // `hitl-card.js`'s rendering; `StructuredOptions::parse`/`resolve_structured_answer`
        // in `router/hitl.rs` are the shared source of truth this must stay wire-compatible
        // with).
        _ => {
            let msg = message("message");
            println!();
            let panel_body = match (pause.question.get("header").and_then(|v| v.as_str()), msg) {
                (Some(h), "") => h.to_string(),
                (Some(h), m) => format!("{h}\n{m}"),
                (None, "") => "(needs your input)".to_string(),
                (None, m) => m.to_string(),
            };
            term::print_box(Some(&format!("⏸ {who}")), &panel_body, "33");

            match StructuredOptions::parse(&pause.question) {
                Some(opts) if opts.multi_select => prompt_multi_select(&opts),
                Some(opts) => prompt_single_select(&opts),
                None => {
                    let answer = dialoguer::Input::<String>::new()
                        .with_prompt("\x1b[1;36m❯ you\x1b[0m")
                        .allow_empty(true)
                        .interact_text()
                        .unwrap_or_default();
                    serde_json::json!({ "answer": answer })
                }
            }
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

/// A `question`'s selectable-options extension, parsed the same way
/// `router/hitl.rs::StructuredOptions::parse` does server-side — `None` means this is a plain
/// `input_required` question (every pre-extension row, and any row whose agent never set
/// `options`), which must fall back to the bare free-text prompt exactly as before this
/// extension existed.
struct StructuredOptions {
    labels: Vec<String>,
    multi_select: bool,
    allow_custom_input: bool,
}

impl StructuredOptions {
    fn parse(question: &serde_json::Value) -> Option<Self> {
        let options = question.get("options")?.as_array()?;
        let labels: Vec<String> = options
            .iter()
            .filter_map(|o| o.get("label")?.as_str().map(str::to_string))
            .collect();
        if labels.is_empty() {
            return None;
        }
        Some(Self {
            labels,
            multi_select: question
                .get("multi_select")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            allow_custom_input: question
                .get("allow_custom_input")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        })
    }
}

/// Single-select: the offered labels, plus a trailing "Something else" choice when custom input
/// is allowed. Unlike a plain list, landing the cursor on that trailing row opens its free-text
/// field immediately (no separate confirm-then-prompt step) via [`select_with_inline_custom`];
/// the answer sent (not the literal "Something else" string) matches `resolve_structured_answer`'s
/// "a bare `answer` string, custom or predefined — membership in `opts.labels` is what
/// distinguishes the two" contract either way.
fn prompt_single_select(opts: &StructuredOptions) -> serde_json::Value {
    let answer = if opts.allow_custom_input {
        select_with_inline_custom(&opts.labels)
    } else {
        let choice = dialoguer::Select::with_theme(&ColorfulTheme::default())
            .with_prompt("Choose one")
            .items(&opts.labels)
            .default(0)
            .interact()
            .unwrap_or(0);
        opts.labels[choice].clone()
    };
    eprintln!("  \x1b[32m✓\x1b[0m {answer}");
    serde_json::json!({ "answer": answer })
}

/// Combo select+inline-text prompt used only when the question allows custom input. A plain
/// `dialoguer::Select` blocks on Enter before any custom-text step can start, forcing a visible
/// select-then-separate-prompt handoff; this instead opens the free-text field the instant the
/// cursor reaches the trailing row, so picking "Something else" and typing it feel like one
/// motion. Hand-rolled over `crossterm` (already a CLI dependency for the TUI, so no new crate)
/// since dialoguer has no combo-box primitive. Falls back to the first label on an unreadable
/// terminal/interrupted read, mirroring the plain-list path's `.unwrap_or(0)` fail-forward.
fn select_with_inline_custom(labels: &[String]) -> String {
    println!(
        "\x1b[1m? Choose one\x1b[0m \x1b[2m(\u{2191}/\u{2193} to move, enter to confirm)\x1b[0m"
    );
    run_select_with_inline_custom(labels)
        .unwrap_or_else(|_| labels.first().cloned().unwrap_or_default())
}

/// RAII guard so raw mode is always turned back off — on a normal return, an error, or a panic —
/// rather than leaving the user's shell in a broken (no-echo, no-line-buffering) state.
struct RawMode;

impl RawMode {
    fn enable() -> Result<Self> {
        crossterm::terminal::enable_raw_mode()?;
        Ok(Self)
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

fn run_select_with_inline_custom(labels: &[String]) -> Result<String> {
    use crossterm::cursor::{MoveToColumn, MoveUp};
    use crossterm::event::{Event, KeyCode, KeyEventKind, read};
    use crossterm::execute;
    use crossterm::terminal::{Clear, ClearType};
    use std::io::{Write, stdout};

    let custom_idx = labels.len();
    let row_count = labels.len() + 1;
    let mut cursor_idx = 0usize;
    let mut buffer = String::new();
    let mut out = stdout();

    let _raw = RawMode::enable()?;
    let mut first_render = true;
    loop {
        if !first_render {
            execute!(out, MoveUp(row_count as u16))?;
        }
        first_render = false;
        for (i, label) in labels.iter().enumerate() {
            execute!(out, MoveToColumn(0), Clear(ClearType::CurrentLine))?;
            if i == cursor_idx {
                write!(out, "\x1b[36m❯ {label}\x1b[0m")?;
            } else {
                write!(out, "  {label}")?;
            }
            write!(out, "\r\n")?;
        }
        execute!(out, MoveToColumn(0), Clear(ClearType::CurrentLine))?;
        if cursor_idx == custom_idx {
            write!(out, "\x1b[36m❯ Something else: {buffer}\x1b[0m▏")?;
        } else {
            write!(out, "  Something else…")?;
        }
        write!(out, "\r\n")?;
        out.flush()?;

        let Event::Key(key) = read()? else { continue };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Up => cursor_idx = cursor_idx.checked_sub(1).unwrap_or(row_count - 1),
            KeyCode::Down => cursor_idx = (cursor_idx + 1) % row_count,
            KeyCode::Enter => {
                return Ok(if cursor_idx == custom_idx {
                    buffer
                } else {
                    labels[cursor_idx].clone()
                });
            }
            KeyCode::Backspace if cursor_idx == custom_idx => {
                buffer.pop();
            }
            KeyCode::Char(c) if cursor_idx == custom_idx => buffer.push(c),
            KeyCode::Esc => return Ok(labels.first().cloned().unwrap_or_default()),
            _ => {}
        }
    }
}

/// Multi-select: checkboxes for the offered labels, plus — when custom input is allowed — a
/// trailing "Other" checkbox whose free-text field opens the instant it's checked (via
/// [`multi_select_with_inline_custom`]) rather than as a separate step after confirming the whole
/// list. "Other" itself is never included in the submitted `answer` labels, since
/// `resolve_structured_answer` rejects any ticked item not in `opts.labels` outright.
fn prompt_multi_select(opts: &StructuredOptions) -> serde_json::Value {
    let (selected, custom) = if opts.allow_custom_input {
        multi_select_with_inline_custom(&opts.labels)
    } else {
        let chosen = dialoguer::MultiSelect::with_theme(&ColorfulTheme::default())
            .with_prompt("Select all that apply (space to toggle, enter to confirm)")
            .items(&opts.labels)
            .interact()
            .unwrap_or_default();
        let selected = chosen.into_iter().map(|i| opts.labels[i].clone()).collect();
        (selected, None)
    };

    let summary = match (selected.is_empty(), &custom) {
        (true, None) => "(none)".to_string(),
        (true, Some(c)) => c.clone(),
        (false, None) => selected.join(", "),
        (false, Some(c)) => format!("{}, {c}", selected.join(", ")),
    };
    eprintln!("  \x1b[32m✓\x1b[0m {summary}");

    match custom {
        Some(custom) => serde_json::json!({ "answer": selected, "custom_answer": custom }),
        None => serde_json::json!({ "answer": selected }),
    }
}

/// Combo multi-select+inline-text prompt used only when the question allows custom input.
/// Checking the trailing "Other" row opens its free-text field immediately — type right away, no
/// separate confirm-then-prompt step — mirroring [`select_with_inline_custom`]'s single-select
/// behavior. Backspacing past an empty field unchecks "Other" again, so there's no dead field
/// left checked with nothing in it.
fn multi_select_with_inline_custom(labels: &[String]) -> (Vec<String>, Option<String>) {
    println!(
        "\x1b[1m? Select all that apply\x1b[0m \x1b[2m(space to toggle, \u{2191}/\u{2193} to move, enter to confirm)\x1b[0m"
    );
    run_multi_select_with_inline_custom(labels).unwrap_or_else(|_| (Vec::new(), None))
}

fn run_multi_select_with_inline_custom(labels: &[String]) -> Result<(Vec<String>, Option<String>)> {
    use crossterm::cursor::{MoveToColumn, MoveUp};
    use crossterm::event::{Event, KeyCode, KeyEventKind, read};
    use crossterm::execute;
    use crossterm::terminal::{Clear, ClearType};
    use std::io::{Write, stdout};

    let other_idx = labels.len();
    let row_count = labels.len() + 1;
    let mut checked = vec![false; labels.len()];
    let mut other_checked = false;
    let mut cursor_idx = 0usize;
    let mut buffer = String::new();
    let mut out = stdout();

    let _raw = RawMode::enable()?;
    let mut first_render = true;
    loop {
        if !first_render {
            execute!(out, MoveUp(row_count as u16))?;
        }
        first_render = false;
        // Matches dialoguer's own `ColorfulTheme` checkbox styling exactly (green ✔ / magenta
        // ⬚, cyan label when focused, no arrow) so this combo widget looks identical to the
        // plain `MultiSelect` path just above it.
        for (i, label) in labels.iter().enumerate() {
            execute!(out, MoveToColumn(0), Clear(ClearType::CurrentLine))?;
            let glyph = if checked[i] {
                "\x1b[32m✔\x1b[0m"
            } else {
                "\x1b[35m⬚\x1b[0m"
            };
            if i == cursor_idx {
                write!(out, "{glyph} \x1b[36m{label}\x1b[0m")?;
            } else {
                write!(out, "{glyph} {label}")?;
            }
            write!(out, "\r\n")?;
        }
        execute!(out, MoveToColumn(0), Clear(ClearType::CurrentLine))?;
        let other_glyph = if other_checked {
            "\x1b[32m✔\x1b[0m"
        } else {
            "\x1b[35m⬚\x1b[0m"
        };
        if cursor_idx == other_idx {
            write!(out, "{other_glyph} \x1b[36mOther\x1b[0m")?;
        } else {
            write!(out, "{other_glyph} Other")?;
        }
        if other_checked {
            write!(out, "\x1b[36m: {buffer}\x1b[0m▏")?;
        }
        write!(out, "\r\n")?;
        out.flush()?;

        let Event::Key(key) = read()? else { continue };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        match key.code {
            KeyCode::Up => cursor_idx = cursor_idx.checked_sub(1).unwrap_or(row_count - 1),
            KeyCode::Down => cursor_idx = (cursor_idx + 1) % row_count,
            KeyCode::Enter => {
                let selected = labels
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| checked[*i])
                    .map(|(_, label)| label.clone())
                    .collect();
                let custom = (other_checked && !buffer.trim().is_empty()).then_some(buffer);
                return Ok((selected, custom));
            }
            KeyCode::Char(' ') => {
                if cursor_idx == other_idx {
                    if other_checked {
                        buffer.push(' ');
                    } else {
                        other_checked = true;
                    }
                } else {
                    checked[cursor_idx] = !checked[cursor_idx];
                }
            }
            KeyCode::Backspace if cursor_idx == other_idx && other_checked => {
                if buffer.pop().is_none() {
                    other_checked = false;
                }
            }
            KeyCode::Char(c) if cursor_idx == other_idx && other_checked => buffer.push(c),
            KeyCode::Esc => return Ok((Vec::new(), None)),
            _ => {}
        }
    }
}

#[cfg(test)]
mod structured_options_tests {
    use super::StructuredOptions;

    #[test]
    fn parse_reads_labels_multi_select_and_allow_custom_input() {
        let question = serde_json::json!({
            "message": "Which sections?",
            "options": [{"label": "Intro"}, {"label": "Conclusion"}],
            "multi_select": true,
            "allow_custom_input": true,
        });
        let opts = StructuredOptions::parse(&question).unwrap();
        assert_eq!(opts.labels, vec!["Intro", "Conclusion"]);
        assert!(opts.multi_select);
        assert!(opts.allow_custom_input);
    }

    #[test]
    fn parse_defaults_multi_select_and_allow_custom_input_to_false() {
        let question = serde_json::json!({
            "message": "Pick one",
            "options": [{"label": "A"}],
        });
        let opts = StructuredOptions::parse(&question).unwrap();
        assert!(!opts.multi_select);
        assert!(!opts.allow_custom_input);
    }

    /// A plain (pre-extension) `input_required` row has no `options` at all — must fall back
    /// to the bare free-text prompt, not a zero-item select.
    #[test]
    fn parse_is_none_for_a_plain_question() {
        let question = serde_json::json!({ "message": "What's your name?" });
        assert!(StructuredOptions::parse(&question).is_none());
    }

    /// Mirrors `hoist_structured_options`'s own "drop the whole block rather than render a
    /// broken prompt" rule — an empty `options` array reaching this far (e.g. a future
    /// server bug) must not surface as a selectable question with nothing to select.
    #[test]
    fn parse_is_none_for_an_empty_options_array() {
        let question = serde_json::json!({ "message": "Pick one", "options": [] });
        assert!(StructuredOptions::parse(&question).is_none());
    }
}
