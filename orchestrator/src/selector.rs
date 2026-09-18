use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::guardrails::Guardrails;
use crate::models::*;
use crate::providers::{CompletionResult, LLMProvider, ProviderError};

/// Stage 3: LLM-based final agent selection using structured output.
pub struct AgentSelector {
    provider: LLMProvider,
    model: String,
}

impl AgentSelector {
    pub fn new(provider: LLMProvider, model: String) -> Self {
        Self { provider, model }
    }

    /// Returns the model name used for agent selection.
    pub fn model_name(&self) -> &str {
        &self.model
    }

    /// Select best agent using structured output (response_format json_schema).
    ///
    /// The returned `bool` is `true` when the model named an agent id that
    /// doesn't exist in `agents` and this substituted the first candidate in
    /// its place — the caller's `fallback_used` should follow it, since the
    /// returned `confidence` is the score the model gave the hallucinated
    /// pick, not the substitute.
    pub async fn select_agent(
        &self,
        query: &str,
        conversation_history: &[ConversationMessage],
        agents: &[AgentCardSummary],
        guardrails: &Guardrails,
    ) -> Result<(AgentSelection, CompletionResult, bool), SelectorError> {
        if agents.is_empty() {
            return Err(SelectorError::NoAgentsAvailable);
        }

        let system_prompt = self.build_system_prompt(agents, guardrails);
        let user_prompt = self.build_user_prompt(query, conversation_history);

        let request = ChatCompletionRequest {
            model: self.model.clone(),
            messages: vec![
                ChatMessage {
                    role: "system".to_string(),
                    content: Some(system_prompt),
                },
                ChatMessage {
                    role: "user".to_string(),
                    content: Some(user_prompt),
                },
            ],
            stream: false,
            temperature: Some(0.0),
            max_tokens: Some(500),
            response_format: Some(ResponseFormat::JsonSchema {
                json_schema: JsonSchema {
                    name: "agent_selection".to_string(),
                    strict: Some(true),
                    schema: json!({
                        "type": "object",
                        "properties": {
                            "agent_id":   { "type": "string", "description": "UUID of the selected agent" },
                            "agent_name": { "type": "string", "description": "Name of the selected agent" },
                            "reasoning":  { "type": "string", "description": "Why this agent was selected" },
                            "confidence": {
                                "type": "number",
                                "description": "0-100: how confident you are that THIS agent can complete THIS task, judged from its description and skills. Be honest — a low score is the correct answer when nothing fits."
                            }
                        },
                        "required": ["agent_id", "agent_name", "reasoning", "confidence"],
                        "additionalProperties": false
                    }),
                },
            }),
            stream_options: None,
        };

        let result = self.provider.chat_completion(&request).await?;

        let selection: AgentSelection = serde_json::from_str(&result.content)
            .map_err(|e| SelectorError::ParseError(e.to_string()))?;

        // The confidence bar is checked BEFORE the hallucination fallback below:
        // a selection the model itself rates as a poor match must be refused
        // outright, not quietly redirected to `agents[0]`, which is how a
        // refusal used to turn into an arbitrary pick.
        if selection.confidence < f64::from(guardrails.min_confidence) {
            return Err(SelectorError::BelowConfidenceBar {
                best: selection.confidence,
                required: guardrails.min_confidence,
            });
        }

        // Validate agent UUID exists in the candidate list; fall back to first if hallucinated.
        if !agents.iter().any(|a| a.id == selection.agent_id)
            && let Some(first) = agents.first()
        {
            return Ok((
                AgentSelection {
                    agent_id: first.id,
                    agent_name: first.name.clone(),
                    reasoning: format!(
                        "LLM selected unknown agent '{}', falling back to '{}'",
                        selection.agent_name, first.name
                    ),
                    confidence: selection.confidence,
                },
                result,
                true,
            ));
        }

        Ok((selection, result, false))
    }

    /// Fetch running agents directly from DB — used by the orchestrator path.
    pub async fn fetch_active_agents(db: &PgPool) -> Result<Vec<AgentCardSummary>, sqlx::Error> {
        let rows = sqlx::query_as::<_, AgentCardRow>(
            "SELECT id, name, description, skills, tags FROM agents \
             WHERE status = 'running' AND NOT is_internal \
             ORDER BY name",
        )
        .fetch_all(db)
        .await?;

        Ok(rows
            .into_iter()
            .map(|a| AgentCardSummary {
                id: a.id,
                name: a.name,
                description: a.description.unwrap_or_default(),
                skills: extract_skills(a.skills.0),
                tags: a.tags,
            })
            .collect())
    }

    fn build_system_prompt(&self, agents: &[AgentCardSummary], guardrails: &Guardrails) -> String {
        let list: Vec<String> = agents
            .iter()
            .map(|a| {
                let skills_text = if a.skills.is_empty() {
                    "(none)".to_string()
                } else {
                    a.skills
                        .iter()
                        .map(|s| format!("{}: {}", s.name, s.description))
                        .collect::<Vec<_>>()
                        .join("; ")
                };
                format!(
                    "- {} (ID: {}): {}\n  Skills: {}\n  Tags: {}",
                    a.name,
                    a.id,
                    a.description,
                    skills_text,
                    a.tags.join(", ")
                )
            })
            .collect();

        let rules = guardrails
            .rules_prompt
            .as_deref()
            .map(|r| format!("\n\n{r}"))
            .unwrap_or_default();

        // Naming the cutoff is skipped when it is 0: "a score below 0 means
        // the request is refused" is impossible on a 0-100 scale. This exact
        // incoherent phrasing was already found, on the sibling chat-path
        // prompt, to make a model stop calibrating and always answer 100 —
        // see the identical guard in
        // oss/react-agent/src/react_loop.rs::build_delegation_policy.
        let threshold = if guardrails.min_confidence > 0 {
            format!(
                " — a score below {} means the request is refused, which is the correct outcome \
                 when nothing fits.",
                guardrails.min_confidence
            )
        } else {
            ".".to_string()
        };

        // "choose the closest option" is deliberately gone: paired with a
        // confidence bar it is contradictory advice, and it is the instruction
        // that made this selector always return *something*.
        format!(
            "You are a routing assistant. Select the best agent to handle the user's query.{}\n\n\
             Available agents:\n{}\n\n\
             Select the most specialized agent that can actually do the task, and report your \
             honest confidence from 0 to 100. If no agent genuinely fits, say so with a low \
             confidence rather than picking the closest one{}",
            rules,
            list.join("\n\n"),
            threshold
        )
    }

    fn build_user_prompt(&self, query: &str, history: &[ConversationMessage]) -> String {
        let mut prompt = String::new();

        if !history.is_empty() {
            prompt.push_str("Conversation history:\n");
            for msg in history.iter().rev().take(5).rev() {
                prompt.push_str(&format!("{}: {}\n", msg.role, msg.content));
            }
            prompt.push('\n');
        }

        prompt.push_str(&format!("Current query: {}", query));
        prompt
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
}

#[derive(sqlx::FromRow)]
struct AgentCardRow {
    id: Uuid,
    name: String,
    description: Option<String>,
    skills: sqlx::types::Json<serde_json::Value>,
    tags: Vec<String>,
}

fn extract_skills(skills_json: serde_json::Value) -> Vec<super::models::SkillSummary> {
    let Some(arr) = skills_json.as_array() else {
        return vec![];
    };
    arr.iter()
        .filter_map(|s| {
            let name = s.get("name").and_then(|n| n.as_str())?.to_string();
            let description = s
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or(&name)
                .to_string();
            let examples = s
                .get("examples")
                .and_then(|e| e.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|e| e.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            Some(super::models::SkillSummary {
                name,
                description,
                examples,
            })
        })
        .collect()
}

#[derive(Debug, thiserror::Error)]
pub enum SelectorError {
    #[error("no agents available")]
    NoAgentsAvailable,
    #[error("best candidate scored {best:.0}%, below the required {required}%")]
    BelowConfidenceBar { best: f64, required: u8 },
    #[error("provider error: {0}")]
    Provider(#[from] ProviderError),
    #[error("failed to parse selection: {0}")]
    ParseError(String),
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

#[cfg(test)]
mod skill_extraction_tests {
    use super::extract_skills;

    /// The AgentCard's `examples` are the literal inputs a skill answers to. Dropping them left
    /// the planner inventing its own wording for every delegation — a skill keyed on an exact
    /// phrase ("hitl auth test") then never fired through the orchestrator, only in direct chat.
    #[test]
    fn examples_survive_extraction() {
        let skills = extract_skills(serde_json::json!([
            {
                "id": "hitl-auth-demo",
                "name": "HITL Auth-Required Fixture",
                "description": "Pauses with AUTH_REQUIRED.",
                "examples": ["hitl auth test"],
            },
            { "name": "No examples here", "description": "Still a skill." },
        ]));

        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].examples, vec!["hitl auth test".to_string()]);
        // A skill that documents none is not a parse failure — it just has nothing to relay.
        assert!(skills[1].examples.is_empty());
    }
}

#[cfg(test)]
mod system_prompt_tests {
    use super::*;

    fn selector() -> AgentSelector {
        AgentSelector::new(
            LLMProvider::new(reqwest::Client::new(), String::new(), String::new()),
            "test-model".to_string(),
        )
    }

    fn guardrails(min_confidence: u8) -> Guardrails {
        Guardrails {
            min_confidence,
            rules_prompt: None,
        }
    }

    /// Regression: at a bar of 0, "a score below 0 means the request is
    /// refused" is impossible on a 0-100 scale — the same bug already found
    /// and fixed on the chat path
    /// (`oss/react-agent/src/react_loop.rs::a_zero_bar_emits_no_threshold_language`),
    /// where the incoherent sentence was observed to make the model stop
    /// calibrating and always answer 100.
    #[test]
    fn a_zero_bar_emits_no_threshold_language() {
        let out = selector().build_system_prompt(&[], &guardrails(0));
        assert!(
            !out.contains("below 0"),
            "a zero bar must not produce impossible instructions: {out}"
        );
    }

    /// A real bar is still stated, so the model knows what gets rejected.
    #[test]
    fn a_real_bar_is_still_named() {
        let out = selector().build_system_prompt(&[], &guardrails(80));
        assert!(out.contains("below 80"));
    }
}
