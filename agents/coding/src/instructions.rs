//! Workspace instruction discovery and injection.
//!
//! At session start the coding agent probes the sandbox for well-known instruction files
//! (NASIKO.md, CLAUDE.md, .nasiko/instructions.md) and injects the stripped (comment-free)
//! content as a dynamic preamble before the hardcoded system prompt. This gives workspace
//! owners declarative control over agent behavior without modifying the agent image.

use crate::prompt_comments;
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
}
