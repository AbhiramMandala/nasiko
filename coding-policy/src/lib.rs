//! Shared "minimal-code" decision-ladder policy for coding-style example agents
//! (docs/CODING_AGENT_MINIMALISM.md). Extracted out of `oss/agents/coding` so a
//! second coding agent can adopt the same toggle-driven behavior — the prompt
//! text and self-review trigger, not the ReAct loop itself, which stays
//! agent-specific (each agent has its own tools, model client, and message
//! shape).
//!
//! This is the canonical source. A dependent agent keeps its own committed
//! copy under `vendor/coding-policy/` (`docker build` only ever sees that
//! agent's own directory, so a `../` path dependency can't resolve inside the
//! container) — re-run `sync-vendor.sh <agent-dir>` after editing this file to
//! update every vendored copy.
//!
//! A dependent agent is expected to:
//! 1. Read [`minimal_code_enabled`] once at startup and store it.
//! 2. Build its system prompt with [`build_system_prompt`] instead of using its
//!    base prompt string directly.
//! 3. Advertise `code-edit`/`code-test`/`code-refactor` skills in its
//!    `AgentCard.json` — that's what the platform UI's Settings-tab toggle
//!    actually keys off (see `ui/common/pages/agent-card-page.js`'s
//!    `#isCodingAgentExample`), independent of this crate.
//! 4. Track whether the session wrote/edited a file, and before returning a
//!    final answer, check [`wants_self_review`] — if true, push
//!    [`SELF_REVIEW_PROMPT`] as one more turn and use that response instead.

/// Read `CODING_AGENT_MINIMAL_CODE` from the environment. Off by default so the
/// ladder's effect can be A/B'd per deployment rather than assumed.
pub fn minimal_code_enabled() -> bool {
    std::env::var("CODING_AGENT_MINIMAL_CODE")
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// Read `CODING_AGENT_SELF_REVIEW` from the environment. On by default —
/// meant as a temporary testing knob (isolate the ladder's effect on
/// generation itself from Phase 2's extra review turn), not a permanent
/// removal of Phase 2. Independent of [`minimal_code_enabled`]: Phase 2 only
/// ever fires when the ladder is also on (see [`wants_self_review`]), so this
/// only has any effect on a `minimal_code=true` deployment.
pub fn self_review_enabled() -> bool {
    std::env::var("CODING_AGENT_SELF_REVIEW")
        .map(|v| v != "false")
        .unwrap_or(true)
}

/// Appended to a coding agent's base prompt unconditionally — independent of
/// [`minimal_code_enabled`], both toggle states need it equally. The person on
/// the other end of the chat can't see into the agent's sandbox on their own;
/// without this, a "summary only" answer leaves them nothing to read or copy.
pub const SHOW_CODE_INSTRUCTION: &str = "\n\
When you create or change a file, include its actual current content (in a code block) in your \
response, not just a description of the change — read it back and show it. For a large file, the \
relevant changed section is enough; you don't need to repaste an unchanged file in full.";

/// Appended to a coding agent's base system prompt when minimal-code mode is on.
pub const MINIMAL_CODE_ADDENDUM: &str = "\n\
- Before writing new code, check in order: does this need to exist at all? is it already \
in this codebase (search_code first)? is it in the language's standard library? is it a \
feature of an already-installed dependency? Only write new code once those are ruled out.
- If the request is for example or reference code (\"give me code for X\", \"write a function \
that does Y\") rather than an explicit ask to add or change something in this workspace, just \
write the code directly in your response. Do not create a file, set up a Cargo project, or run \
tests for a standalone example — the person asking has no access to your sandbox and wants \
something to read or copy, not a file left behind where they can't reach it.
- When a request DOES call for creating or changing a file, check first whether one relevant to \
it already exists (search_code / list_directory / read_file) and edit that instead of creating a \
new one from scratch.
- This does not apply to trust-boundary checks, error handling for real failure modes, \
security, or data-loss prevention — those are never skipped for brevity.";

/// One forced self-review turn before the final answer, only when the ladder is
/// on and the session actually wrote or edited a file — see [`wants_self_review`].
pub const SELF_REVIEW_PROMPT: &str = "\
Before finishing: look back at the edits you made. Is there anything you wrote that duplicates \
existing code, reimplements a stdlib/dependency feature, or wasn't needed to satisfy the original \
request? If so, say what you'd remove and why, then stop — do not make further edits unless asked. \
Otherwise, confirm your changes are minimal and give your summary.";

/// `base` (the agent's own system prompt), plus [`SHOW_CODE_INSTRUCTION`]
/// (always) and [`MINIMAL_CODE_ADDENDUM`] (only when `minimal_code` is set).
pub fn build_system_prompt(base: &str, minimal_code: bool) -> String {
    let mut prompt = format!("{base}{SHOW_CODE_INSTRUCTION}");
    if minimal_code {
        prompt.push_str(MINIMAL_CODE_ADDENDUM);
    }
    prompt
}

/// Whether the self-review turn ([`SELF_REVIEW_PROMPT`]) should run: only when
/// the ladder is on, the session wrote/edited a file, and there's a real answer
/// to review. Triggered, not universal — a read-only session, or the ladder
/// being off, never sees this extra turn.
pub fn wants_self_review(minimal_code: bool, wrote_code: bool, final_text: &str) -> bool {
    minimal_code && wrote_code && !final_text.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_code_off_still_includes_show_code_instruction() {
        let prompt = build_system_prompt("base", false);
        assert!(prompt.starts_with("base"));
        assert!(prompt.contains("include its actual current content"));
        assert!(!prompt.contains("does this need to exist at all"));
    }

    #[test]
    fn minimal_code_on_appends_ladder_after_show_code_instruction() {
        let prompt = build_system_prompt("base", true);
        assert!(prompt.starts_with("base"));
        assert!(prompt.contains("include its actual current content"));
        assert!(prompt.contains("does this need to exist at all"));
        assert!(prompt.contains("never skipped for brevity"));
    }

    #[test]
    fn self_review_requires_ladder_on() {
        assert!(!wants_self_review(false, true, "did something"));
    }

    #[test]
    fn self_review_requires_wrote_code() {
        assert!(!wants_self_review(true, false, "did something"));
    }

    #[test]
    fn self_review_requires_nonempty_answer() {
        assert!(!wants_self_review(true, true, ""));
    }

    #[test]
    fn self_review_fires_when_all_conditions_met() {
        assert!(wants_self_review(true, true, "did something"));
    }
}
