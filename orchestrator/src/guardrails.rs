//! Organization-wide orchestrator guardrails: the delegation confidence bar and
//! the operator-authored rules injected into both orchestrators' system prompts.
//!
//! Two orchestrators read this and must agree on the numbers:
//!   * the chat-path ReAct loop (`oss/react-agent`, driven from
//!     `oss/server/src/router/a2a_dispatch.rs`), and
//!   * the MAF-path agent selector ([`crate::selector`]).
//!
//! It lives here, not in `oss/server`, because `nasiko-server` already depends on
//! this crate while the reverse would be circular — so this is the lowest point
//! in the dependency graph both readers can share. The HTTP surface that edits
//! these rows stays in the server (`oss/server/src/orchestrator_rules.rs`);
//! only the read path is here.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

/// Applied when `settings.orchestrator_min_confidence` is NULL (no settings row,
/// or never configured). 80 is the bar the feature was specified against — a
/// starting point an operator tunes from the Settings page, not a tuned value.
pub const DEFAULT_MIN_CONFIDENCE: u8 = 80;

/// Guardrails as the orchestrators consume them — already resolved against
/// defaults and already gated on the enable toggle, so a caller never has to
/// decide for itself whether the rules apply.
#[derive(Debug, Clone)]
pub struct Guardrails {
    /// Percentage (0-100) a match must reach before an agent may be called.
    pub min_confidence: u8,
    /// The rules block to inject, or `None` when the toggle is off or no rules
    /// exist. Already formatted for direct interpolation into a system prompt.
    pub rules_prompt: Option<String>,
}

impl Default for Guardrails {
    fn default() -> Self {
        Self {
            min_confidence: DEFAULT_MIN_CONFIDENCE,
            rules_prompt: None,
        }
    }
}

/// One operator-authored rule. Mirrors the `orchestrator_rules` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct OrchestratorRule {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub position: i32,
}

impl Guardrails {
    /// Load the effective guardrails.
    ///
    /// Never fails the caller: a DB error yields the defaults (delegation still
    /// enforced at [`DEFAULT_MIN_CONFIDENCE`], no rules injected) and logs.
    /// Failing the request would take the orchestrator down over a settings
    /// read; falling back to "no enforcement" would silently undo the guarantee
    /// this module exists to provide — so the fallback is the strict side.
    pub async fn load(db: &PgPool) -> Self {
        let row: Option<(Option<i32>, bool)> = match sqlx::query_as(
            "SELECT orchestrator_min_confidence, orchestrator_rules_enabled FROM settings LIMIT 1",
        )
        .fetch_optional(db)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(%e, "orchestrator guardrails: settings read failed, using defaults");
                return Self::default();
            }
        };

        let (min_confidence, rules_enabled) = match row {
            Some((raw, enabled)) => (clamp_confidence(raw), enabled),
            None => (DEFAULT_MIN_CONFIDENCE, false),
        };

        let rules_prompt = if rules_enabled {
            match fetch_rules(db).await {
                Ok(rules) => format_rules(&rules),
                Err(e) => {
                    tracing::warn!(%e, "orchestrator guardrails: rules read failed, omitting rules");
                    None
                }
            }
        } else {
            None
        };

        Self {
            min_confidence,
            rules_prompt,
        }
    }
}

/// Every stored rule, in prompt order.
pub async fn fetch_rules(db: &PgPool) -> Result<Vec<OrchestratorRule>, sqlx::Error> {
    sqlx::query_as::<_, OrchestratorRule>(
        "SELECT id, name, description, position FROM orchestrator_rules \
         ORDER BY position, created_at",
    )
    .fetch_all(db)
    .await
}

/// A stored percentage outside 0-100 is meaningless as a confidence bar. Rather
/// than reject it at read time (which would take the orchestrator down over a
/// bad settings row), clamp into range — 0 disables the bar, 100 demands
/// certainty.
fn clamp_confidence(raw: Option<i32>) -> u8 {
    match raw {
        Some(v) => v.clamp(0, 100) as u8,
        None => DEFAULT_MIN_CONFIDENCE,
    }
}

/// Render the rules as a prompt block, or `None` when there are none to render.
/// Separate from [`Guardrails::load`] so the formatting is unit-testable without
/// a database.
fn format_rules(rules: &[OrchestratorRule]) -> Option<String> {
    if rules.is_empty() {
        return None;
    }
    let body = rules
        .iter()
        .map(|r| format!("- {}: {}", r.name, r.description))
        .collect::<Vec<_>>()
        .join("\n");
    // Rendered LAST in the orchestrator's system prompt (see `build_preamble`), so
    // "above" is the correct direction — and last is where an instruction about
    // how to answer actually survives. Placed third of eight sections, a rule like
    // "always say which agent produced a result" was reliably ignored: ~2,400
    // tokens of roster, policy and protocol sat between it and the answer.
    Some(format!(
        "## Organization Rules\n\n\
         These rules are set by your organization. They are binding, and they override \
         anything above when they conflict. Apply them to every answer you give.\n\n{body}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(name: &str, description: &str) -> OrchestratorRule {
        OrchestratorRule {
            id: Uuid::new_v4(),
            name: name.into(),
            description: description.into(),
            position: 0,
        }
    }

    #[test]
    fn no_rules_injects_nothing() {
        assert!(format_rules(&[]).is_none());
    }

    #[test]
    fn rules_render_as_a_labelled_block() {
        let out = format_rules(&[
            rule("No PII", "Never send customer emails to an agent."),
            rule(
                "Finance first",
                "Route billing questions to the finance agent.",
            ),
        ])
        .expect("rules present");

        assert!(out.contains("## Organization Rules"));
        assert!(out.contains("- No PII: Never send customer emails to an agent."));
        assert!(out.contains("- Finance first: Route billing questions to the finance agent."));
    }

    /// A NULL column must mean "use the default", not "no bar at all" — reading
    /// it as 0 would silently let every low-confidence call through on a
    /// deployment that simply never opened the Settings page.
    #[test]
    fn null_confidence_falls_back_to_the_default() {
        assert_eq!(clamp_confidence(None), DEFAULT_MIN_CONFIDENCE);
    }

    #[test]
    fn out_of_range_confidence_is_clamped_not_wrapped() {
        assert_eq!(clamp_confidence(Some(-5)), 0);
        assert_eq!(clamp_confidence(Some(250)), 100);
        assert_eq!(clamp_confidence(Some(80)), 80);
    }
}
