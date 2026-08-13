//! Workspace instruction discovery and injection.
//!
//! At session start the coding agent probes the sandbox for well-known instruction files
//! (NASIKO.md, CLAUDE.md, .nasiko/instructions.md) and injects the stripped (comment-free)
//! content as a dynamic preamble before the hardcoded system prompt. This gives workspace
//! owners declarative control over agent behavior without modifying the agent image.

use crate::prompt_comments::{self, AnnotatedInstruction, Outcome};
use crate::sandbox::Sandbox;

/// Well-known instruction file paths, checked in priority order.
/// The first one found wins (avoids conflicting instructions from multiple files).
const INSTRUCTION_FILES: &[&str] = &[
    "NASIKO.md",
    ".nasiko/instructions.md",
    "CLAUDE.md",
    ".claude/instructions.md",
];

/// Result of discovering and loading workspace instructions.
#[derive(Debug, Clone)]
pub struct WorkspaceInstructions {
    /// The file path that was found (relative to workspace root).
    pub source_file: String,
    /// The raw file content (with prompt comments).
    pub raw: String,
    /// The clean instruction text (comments stripped, revoked instructions removed).
    pub clean: String,
}

/// Probe the sandbox for an instruction file and return its stripped content.
/// Returns `None` if no instruction file is found (the agent runs with defaults).
pub async fn discover(sandbox: &dyn Sandbox) -> Option<WorkspaceInstructions> {
    for path in INSTRUCTION_FILES {
        if let Ok(raw) = sandbox.read_file_raw(path).await {
            if raw.trim().is_empty() {
                continue;
            }
            let clean = prompt_comments::strip_comments(&raw);
            return Some(WorkspaceInstructions {
                source_file: path.to_string(),
                raw,
                clean,
            });
        }
    }
    None
}

/// Build the full system prompt by prepending workspace instructions to the base prompt.
/// If no workspace instructions exist, returns the base prompt unchanged.
pub fn build_system_prompt(base_prompt: &str, workspace_instructions: Option<&WorkspaceInstructions>) -> String {
    match workspace_instructions {
        Some(wi) if !wi.clean.trim().is_empty() => {
            format!(
                "## Workspace Instructions (from {})\n\n{}\n\n---\n\n{}",
                wi.source_file, wi.clean, base_prompt
            )
        }
        _ => base_prompt.to_string(),
    }
}

/// Generate the content for a new instruction entry (instruction text + prompt comment)
/// to be appended to the workspace instruction file.
pub fn format_new_instruction(instruction: &str, trigger: &str, hypothesis: &str) -> String {
    let comment = prompt_comments::generate_comment(trigger, hypothesis);
    format!("{comment}\n{instruction}\n")
}

/// Append a new annotated instruction to the workspace instruction file.
/// If no instruction file exists, creates NASIKO.md with a header.
pub async fn add_instruction(
    sandbox: &dyn Sandbox,
    current: Option<&WorkspaceInstructions>,
    instruction: &str,
    trigger: &str,
    hypothesis: &str,
) -> Result<String, String> {
    let entry = format_new_instruction(instruction, trigger, hypothesis);

    let (path, new_content) = match current {
        Some(wi) => {
            let mut content = wi.raw.clone();
            if !content.ends_with('\n') {
                content.push('\n');
            }
            content.push('\n');
            content.push_str(&entry);
            (wi.source_file.clone(), content)
        }
        None => {
            let header = "# Workspace Instructions\n\n";
            let content = format!("{header}{entry}");
            (INSTRUCTION_FILES[0].to_string(), content)
        }
    };

    sandbox.write_file(&path, &new_content).await?;
    Ok(path)
}

/// Mark an existing instruction's outcome as confirmed or revoked.
#[allow(dead_code)]
pub async fn update_outcome(
    sandbox: &dyn Sandbox,
    instructions_path: &str,
    instruction_substring: &str,
    new_outcome: &str,
) -> Result<(), String> {
    let raw = sandbox.read_file_raw(instructions_path).await?;
    let mut parsed = prompt_comments::parse(&raw);

    let target = parsed.iter_mut().find(|inst| inst.text.contains(instruction_substring));
    match target {
        Some(inst) => {
            if let Some(ref mut comment) = inst.comment {
                comment.outcome = match new_outcome {
                    "confirmed" => prompt_comments::Outcome::Confirmed,
                    "revoked" => prompt_comments::Outcome::Revoked,
                    _ => prompt_comments::Outcome::Pending,
                };
            } else {
                return Err("instruction has no prompt comment to update".into());
            }
        }
        None => return Err(format!("no instruction matching '{instruction_substring}' found")),
    }

    let rendered = prompt_comments::render(&parsed);
    sandbox.write_file(instructions_path, &rendered).await?;
    Ok(())
}

/// Default threshold for triggering a pruning pass.
const DEFAULT_PRUNE_THRESHOLD: usize = 200;

/// Pruning mode, controlled by `<!-- @pruning auto|manual|<N> -->` directive in the
/// instruction file. `auto` uses the default threshold, `manual` disables automatic
/// pruning entirely, and a bare number sets a custom threshold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PruneMode {
    Auto,
    Manual,
    Threshold(usize),
}

/// Parse the `<!-- @pruning ... -->` directive from the raw instruction file.
/// Defaults to `Manual` if no directive is present (opt-in behavior).
pub fn parse_prune_mode(raw: &str) -> PruneMode {
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("<!-- @pruning") {
            let value = rest.trim_end_matches("-->").trim();
            return match value {
                "auto" => PruneMode::Auto,
                "manual" => PruneMode::Manual,
                other => other
                    .parse::<usize>()
                    .map(PruneMode::Threshold)
                    .unwrap_or(PruneMode::Manual),
            };
        }
    }
    PruneMode::Manual
}

/// Check whether the instruction list should be pruned based on the user's configured mode.
pub fn needs_pruning(instructions: &WorkspaceInstructions) -> bool {
    let mode = parse_prune_mode(&instructions.raw);
    let threshold = match mode {
        PruneMode::Manual => return false,
        PruneMode::Auto => DEFAULT_PRUNE_THRESHOLD,
        PruneMode::Threshold(n) => n,
    };
    let parsed = prompt_comments::parse(&instructions.raw);
    let annotated_count = parsed.iter().filter(|i| i.comment.is_some()).count();
    annotated_count > threshold
}

/// Build the pruning prompt sent to the LLM. Lists each instruction with its rationale
/// and asks the model to return a JSON array of indices to revoke.
pub fn build_prune_prompt(instructions: &WorkspaceInstructions) -> (String, Vec<AnnotatedInstruction>) {
    let parsed = prompt_comments::parse(&instructions.raw);
    let annotated: Vec<AnnotatedInstruction> = parsed
        .into_iter()
        .filter(|i| i.comment.is_some() && i.comment.as_ref().unwrap().outcome != Outcome::Revoked)
        .collect();

    let mut listing = String::new();
    for (i, inst) in annotated.iter().enumerate() {
        let c = inst.comment.as_ref().unwrap();
        listing.push_str(&format!(
            "[{}] instruction: {}\n    trigger: {}\n    hypothesis: {}\n    outcome: {}\n\n",
            i,
            inst.text.trim(),
            c.trigger,
            c.hypothesis,
            if c.outcome == Outcome::Confirmed { "confirmed" } else { "pending" },
        ));
    }

    let prompt = format!(
        "You are reviewing a workspace instruction file for staleness. Below are the current \
instructions with their rationale.\n\n\
{listing}\
Review each instruction. An instruction should be REVOKED if:\n\
- Its trigger is no longer relevant (the underlying issue was fixed structurally)\n\
- Its hypothesis was wrong (it doesn't actually help)\n\
- It conflicts with or is superseded by another instruction\n\
- It is too vague to be actionable\n\n\
Return ONLY a JSON array of indices to revoke, e.g. [2, 5, 7]. \
If nothing should be revoked, return []. No explanation needed."
    );

    (prompt, annotated)
}

/// Apply pruning decisions: mark the specified instructions as revoked and rewrite the file.
pub async fn apply_pruning(
    sandbox: &dyn Sandbox,
    instructions: &WorkspaceInstructions,
    revoke_indices: &[usize],
    annotated: &[AnnotatedInstruction],
) -> Result<usize, String> {
    if revoke_indices.is_empty() {
        return Ok(0);
    }

    let texts_to_revoke: Vec<&str> = revoke_indices
        .iter()
        .filter_map(|&i| annotated.get(i).map(|a| a.text.as_str()))
        .collect();

    let raw = sandbox.read_file_raw(&instructions.source_file).await?;
    let mut parsed = prompt_comments::parse(&raw);
    let mut count = 0;

    for inst in &mut parsed {
        if let Some(ref mut comment) = inst.comment {
            if texts_to_revoke.iter().any(|t| inst.text.contains(t)) {
                comment.outcome = Outcome::Revoked;
                count += 1;
            }
        }
    }

    let rendered = prompt_comments::render(&parsed);
    sandbox.write_file(&instructions.source_file, &rendered).await?;
    Ok(count)
}

/// Parse the LLM's pruning response into a list of indices.
pub fn parse_prune_response(response: &str) -> Vec<usize> {
    let trimmed = response.trim();
    let json_str = if let Some(start) = trimmed.find('[') {
        if let Some(end) = trimmed.rfind(']') {
            &trimmed[start..=end]
        } else {
            return Vec::new();
        }
    } else {
        return Vec::new();
    };

    serde_json::from_str::<Vec<usize>>(json_str).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::LocalSandbox;
    use std::path::PathBuf;

    fn temp_root(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("coding-agent-instr-{tag}"));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::canonicalize(&base).unwrap()
    }

    #[tokio::test]
    async fn discover_finds_nasiko_md() {
        let root = temp_root("discover");
        let sb = LocalSandbox::new(root.to_str().unwrap()).unwrap();
        sb.write_file("NASIKO.md", "- Use tabs not spaces.\n")
            .await
            .unwrap();

        let result = discover(&sb).await;
        assert!(result.is_some());
        let wi = result.unwrap();
        assert_eq!(wi.source_file, "NASIKO.md");
        assert!(wi.clean.contains("Use tabs not spaces"));
    }

    #[tokio::test]
    async fn discover_returns_none_when_no_file() {
        let root = temp_root("discover-none");
        let sb = LocalSandbox::new(root.to_str().unwrap()).unwrap();
        assert!(discover(&sb).await.is_none());
    }

    #[tokio::test]
    async fn build_system_prompt_prepends() {
        let wi = WorkspaceInstructions {
            source_file: "NASIKO.md".into(),
            raw: "- Be concise.\n".into(),
            clean: "- Be concise.\n".into(),
        };
        let full = build_system_prompt("You are a coding agent.", Some(&wi));
        assert!(full.starts_with("## Workspace Instructions"));
        assert!(full.contains("Be concise"));
        assert!(full.contains("You are a coding agent."));
    }

    #[tokio::test]
    async fn add_instruction_creates_file() {
        let root = temp_root("add-new");
        let sb = LocalSandbox::new(root.to_str().unwrap()).unwrap();

        let path = add_instruction(
            &sb,
            None,
            "- Always run tests before committing.",
            "broken CI from untested commits",
            "local test pass prevents CI failures",
        )
        .await
        .unwrap();

        assert_eq!(path, "NASIKO.md");
        let content = sb.read_file_raw("NASIKO.md").await.unwrap();
        assert!(content.contains("@prompt-comment"));
        assert!(content.contains("Always run tests"));
        assert!(content.contains("broken CI from untested commits"));
    }

    #[tokio::test]
    async fn update_outcome_marks_revoked() {
        let root = temp_root("update-outcome");
        let sb = LocalSandbox::new(root.to_str().unwrap()).unwrap();

        let initial = "<!-- @prompt-comment\n  added: 2026-08-13\n  trigger: test\n  hypothesis: test\n  outcome: pending\n-->\n- Do the thing.\n";
        sb.write_file("NASIKO.md", initial).await.unwrap();

        update_outcome(&sb, "NASIKO.md", "Do the thing", "revoked")
            .await
            .unwrap();

        let updated = sb.read_file_raw("NASIKO.md").await.unwrap();
        assert!(updated.contains("outcome: revoked"));
    }

    #[test]
    fn parse_prune_mode_auto() {
        let raw = "<!-- @pruning auto -->\n- Some rule.\n";
        assert_eq!(parse_prune_mode(raw), PruneMode::Auto);
    }

    #[test]
    fn parse_prune_mode_manual() {
        let raw = "<!-- @pruning manual -->\n- Some rule.\n";
        assert_eq!(parse_prune_mode(raw), PruneMode::Manual);
    }

    #[test]
    fn parse_prune_mode_custom_threshold() {
        let raw = "<!-- @pruning 50 -->\n- Some rule.\n";
        assert_eq!(parse_prune_mode(raw), PruneMode::Threshold(50));
    }

    #[test]
    fn parse_prune_mode_defaults_to_manual() {
        let raw = "- Some rule with no directive.\n";
        assert_eq!(parse_prune_mode(raw), PruneMode::Manual);
    }
}
