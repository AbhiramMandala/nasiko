//! Shared "minimal-code" decision-ladder policy for coding-style agents
//! (docs/CODING_AGENT_MINIMALISM.md).
//!
//! The ladder text ([`minimal_code_addendum`]) is injected by the control
//! plane directly into the outgoing task message at A2A dispatch time
//! (`oss/server/src/router/a2a_dispatch.rs`), not built into any agent's own
//! system prompt — that's what lets it apply to any coding-type agent
//! (skills containing "code"), including a third party's, without that agent
//! needing to know this crate exists. A dependent agent only needs the two
//! functions below: read [`minimal_code_enabled`]/[`self_review_enabled`]
//! once at boot, and before returning a final answer, check
//! [`wants_self_review`] — if true, push [`SELF_REVIEW_PROMPT`] as one more
//! turn and use that response instead. Self-review stays agent-side (unlike
//! the ladder) because it needs the agent's own visibility into whether it
//! actually wrote or edited a file, which the control plane can't see from
//! the outside.
//!
//! This is the canonical source. A dependent agent keeps its own committed
//! copy under `vendor/coding-policy/` (`docker build` only ever sees that
//! agent's own directory, so a `../` path dependency can't resolve inside the
//! container) — re-run `sync-vendor.sh <agent-dir>` after editing this file to
//! update every vendored copy.

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

/// Full ladder: this session already has prior turns, so there's a real
/// workspace to check before writing more into it.
const MINIMAL_CODE_ADDENDUM_CONTINUING: &str = "\n\
- Before writing new code, check first whether something equivalent already exists in this \
workspace (search_code / list_directory / read_file), in the language's standard library, or as \
a feature of an already-installed dependency. Only write new code once those are ruled out.
- If the request is for example or reference code (\"give me code for X\", \"write a function \
that does Y\") rather than an explicit ask to add or change something in this workspace, just \
write the code directly in your response. Do not create a file, set up a Cargo project, or run \
tests for a standalone example — the person asking has no access to your sandbox and wants \
something to read or copy, not a file left behind where they can't reach it.
- This does not apply to trust-boundary checks, error handling for real failure modes, \
security, or data-loss prevention — those are never skipped for brevity.";

/// Fresh-start ladder: this is the first message in the session, so there is
/// nothing in the workspace yet to search for — skips the search-first step
/// entirely, since on a genuinely empty workspace it only spends tokens
/// finding nothing, with zero payoff. Confirmed empirically (chat 2026-09-22):
/// on a from-scratch task, minimal-code mode cost noticeably more tokens per
/// turn than not having it on at all, driven by exactly this kind of
/// search-with-nothing-to-find overhead. Still keeps the stdlib/dependency
/// nudge, since that costs nothing extra — it doesn't require searching
/// anything, just recalling what's already installed.
const MINIMAL_CODE_ADDENDUM_FRESH_START: &str = "\n\
- This is the first request in this session — there is nothing in the workspace yet to search \
for or reuse, so don't spend a turn searching an empty workspace before writing. Do still prefer \
the language's standard library or an already-installed dependency over writing something from \
scratch when one obviously already covers the need.
- If the request is for example or reference code (\"give me code for X\", \"write a function \
that does Y\") rather than an explicit ask to add or change something in this workspace, just \
write the code directly in your response. Do not create a file, set up a Cargo project, or run \
tests for a standalone example — the person asking has no access to your sandbox and wants \
something to read or copy, not a file left behind where they can't reach it.
- This does not apply to trust-boundary checks, error handling for real failure modes, \
security, or data-loss prevention — those are never skipped for brevity.";

/// Which ladder text to inject, given whether this session already has prior
/// turns. Callers pass `!history.is_empty()` — the control plane already has
/// this for free (`SessionHistory`, fetched once per dispatch for the
/// conversation-context merge), no extra query needed.
pub fn minimal_code_addendum(has_prior_context: bool) -> &'static str {
    if has_prior_context {
        MINIMAL_CODE_ADDENDUM_CONTINUING
    } else {
        MINIMAL_CODE_ADDENDUM_FRESH_START
    }
}

/// One forced self-review turn before the final answer, only when the ladder is
/// on and the session actually wrote or edited a file — see [`wants_self_review`].
pub const SELF_REVIEW_PROMPT: &str = "\
Before finishing: look back at the edits you made. Is there anything you wrote that duplicates \
existing code, reimplements a stdlib/dependency feature, or wasn't needed to satisfy the original \
request? If so, say what you'd remove and why, then stop — do not make further edits unless asked. \
Otherwise, confirm your changes are minimal and give your summary.";

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
    fn fresh_start_skips_search_first_but_keeps_stdlib_nudge() {
        let addendum = minimal_code_addendum(false);
        assert!(addendum.contains("nothing in the workspace yet to search for"));
        assert!(addendum.contains("standard library"));
        assert!(!addendum.contains("search_code"));
    }

    #[test]
    fn continuing_session_keeps_search_first() {
        let addendum = minimal_code_addendum(true);
        assert!(addendum.contains("search_code"));
        assert!(!addendum.contains("nothing in the workspace yet"));
    }

    #[test]
    fn both_variants_keep_the_safety_exemption_and_example_carve_out() {
        for addendum in [minimal_code_addendum(false), minimal_code_addendum(true)] {
            assert!(addendum.contains("never skipped for brevity"));
            assert!(addendum.contains("give me code for X"));
        }
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
