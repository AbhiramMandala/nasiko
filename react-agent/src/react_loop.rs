use std::sync::Arc;

use futures::StreamExt;
use rig::completion::message::{ToolCall, ToolFunction};
use rig::completion::{AssistantContent, CompletionModel as _, Message, ToolDefinition};
use rig::providers::openai;
use rig::streaming::StreamingChoice;
use rig::tool::{ToolDyn, ToolError, ToolSet, ToolSetError};
use tokio::sync::mpsc;

use crate::a2a::{A2aClient, PauseInfo};
use crate::context::{ContextConfig, ContextManager};
use crate::error::OrchestratorError;
use crate::events::OrchestratorEvent;
use crate::guard::CallGuard;
use crate::registry::{AgentInfo, AgentRegistry, RegistrySource};
use crate::tool::{A2aTool, A2aToolError};

/// The outcome of one `toolset.call()`, with a real pause recovered from `rig`'s type-erased
/// `Result<String, ToolSetError>` instead of being indistinguishable from an ordinary failure.
/// Pure — no side effects, no channel sends — so every `toolset.call()` site (`Orchestrator::run()`
/// and both of `run_stream_inner()`'s) can classify identically by calling the same function,
/// rather than each independently deciding what counts as a pause.
///
/// Deliberately not `Success(String)`/`Failure(String)` variants carrying the `Ok`/`Err` payload:
/// every call site already has its own existing, unchanged handling for the non-pause case
/// (`match result { Ok(..) => .., Err(..) => .. }`, untouched by this classification) — a
/// `NotAwaitingHuman` outcome that duplicated that payload would just be dead weight nothing
/// reads, which is exactly what the compiler's `dead_code` lint caught on the first version of
/// this enum.
enum ToolOutcome {
    AwaitingHuman {
        agent: String,
        agent_id: String,
        pause: PauseInfo,
    },
    NotAwaitingHuman,
}

/// Recovers `A2aToolError::AwaitingHuman` through `rig-core`'s type erasure: `ToolSetError`
/// wraps `ToolError::ToolCallError(Box<dyn std::error::Error + Send + Sync>)`, built by `rig`'s
/// own blanket `ToolDyn` impl from the tool's real `A2aToolError`. `downcast_ref` recovers the
/// concrete type from that box — proven against the actual pinned `rig-core` dependency in
/// `tool.rs`'s `awaiting_human_survives_rig_toolset_erasure` test, not assumed here.
fn classify_tool_result(result: &Result<String, ToolSetError>) -> ToolOutcome {
    if let Err(ToolSetError::ToolCallError(ToolError::ToolCallError(boxed))) = result
        && let Some(A2aToolError::AwaitingHuman {
            agent,
            agent_id,
            pause,
        }) = boxed.downcast_ref::<A2aToolError>()
    {
        return ToolOutcome::AwaitingHuman {
            agent: agent.clone(),
            agent_id: agent_id.clone(),
            pause: pause.clone(),
        };
    }
    ToolOutcome::NotAwaitingHuman
}

/// Attribute one completion's total token cost evenly across the tool calls
/// it produced — the API gives one usage figure per completion, not per tool
/// call, so this is the best available granularity for `CallGuard::after_call`.
/// `None` (no usage reported) or zero tool calls both yield 0.
fn tokens_per_tool_call(completion_tokens: Option<u64>, num_tool_calls: usize) -> u64 {
    completion_tokens
        .map(|t| t / num_tool_calls.max(1) as u64)
        .unwrap_or(0)
}

/// Read the `confidence` argument off a tool call.
///
/// Accepts a JSON number or a numeric string: the argument is declared as a
/// number in the tool schema, but models routinely emit `"85"` for numeric
/// parameters, and rejecting a well-formed intent over its JSON type would block
/// a legitimate call for a reason the model cannot see or correct.
fn confidence_of(arguments: &serde_json::Value) -> Option<f64> {
    let raw = arguments.get("confidence")?;
    raw.as_f64()
        .or_else(|| raw.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
}

/// Gate one tool call on the configured confidence bar.
///
/// `Err(reason)` is both the `PolicyRejected` event's reason and the text fed
/// back into the model's context, so it states the number it gave and the number
/// it needed — a bare "blocked" teaches the model nothing and it simply retries
/// the same call.
///
/// A missing `confidence` is a rejection, not a pass: the argument is required
/// by the schema, and treating its absence as "allowed" would let a model opt
/// out of the entire policy by omitting one field.
fn check_confidence(
    arguments: &serde_json::Value,
    min_confidence: Option<u8>,
) -> Result<(), String> {
    let Some(min) = min_confidence else {
        return Ok(());
    };
    match confidence_of(arguments) {
        Some(c) if c >= f64::from(min) => Ok(()),
        Some(c) => Err(format!(
            "confidence {c:.0}% is below the {min}% required to delegate to this agent"
        )),
        None => Err(format!(
            "no confidence score was provided; every agent call must include a `confidence` \
             argument of at least {min}"
        )),
    }
}

/// The orchestrator's system prompt. One builder for both loops — `run()` and
/// `run_stream_inner()` previously carried byte-identical copies of this text,
/// so a change to the policy had to be made twice to take effect.
fn build_preamble(config: &OrchestratorConfig, agents: &[AgentInfo]) -> String {
    let custom = config.preamble.as_deref().unwrap_or("");

    let agent_list: String = agents
        .iter()
        .map(|a| {
            let skills = a
                .skills
                .iter()
                .map(|s| {
                    // The skill's own documented inputs. Without them the model invents wording
                    // for a skill that may only answer to an exact phrase — and the agent then
                    // answers a question the user never asked.
                    let examples = if s.examples.is_empty() {
                        String::new()
                    } else {
                        format!(
                            "\n      send exactly: {}",
                            s.examples
                                .iter()
                                .map(|e| format!("\"{e}\""))
                                .collect::<Vec<_>>()
                                .join(" | ")
                        )
                    };
                    format!("    - {}: {}{}", s.name, s.description, examples)
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "  • {} (tool: `{}`)\n    {}\n{}",
                a.name,
                A2aTool::tool_name(&a.name),
                a.description,
                skills
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let org_rules = config.org_rules.as_deref().unwrap_or("");
    let delegation_policy = build_delegation_policy(config);

    format!(
        r#"You are a ReAct orchestrator. Fulfill user requests by reasoning and delegating to specialized agents.

{custom}

## Available Agents

{agent_list}

{delegation_policy}

## Protocol

1. Analyze the user's request. Determine which agent(s) can help.
2. Call the appropriate agent tool with a clear, specific message.
3. If the task requires multiple agents, call them sequentially — use earlier results to inform later calls.
4. Once you have enough information, respond with a complete answer as plain text (no tool call).
5. If an agent fails, reason about alternatives or inform the user.

## Rules

- Only relay facts from agent responses. Never fabricate.
- Prefer the most specific agent for each sub-task.
- Pass the user's own wording through when the request is itself the thing to relay — an exact
  phrase, a quoted string, a command, an identifier, a fixed test input. Paraphrasing it loses
  information the agent matches on, and the agent then answers a question the user never asked.
- If no agent fits, tell the user directly.

{org_rules}"#
    )
}

/// Output cap for a turn that has not delegated yet, while the policy is on.
///
/// Such a turn has only short legitimate outputs: a tool call (~40 tokens of
/// arguments), or one of the sentinels — `NO_AGENT_MATCH` (~4 tokens),
/// `CAPABILITIES`, `GREETING:` (capped at 200 chars), `NEED_INPUT:` (a question).
/// Prose longer than this is an answer the guard is about to discard, so the
/// provider is billed for generating text nobody will ever read — observed at
/// 434 output tokens for one refused question.
///
/// Sized for the tool-call case, not the sentinel case: ~10 parallel calls fit,
/// well past the fan-out a single completion realistically emits. Truncating a
/// tool call mid-arguments would break the turn, so the headroom matters more
/// than the last few tokens of savings.
///
/// Caps output only. The input (the agent roster and policy, ~2,400 tokens) is
/// re-sent every turn regardless and dominates the bill — this trims the smaller
/// half.
const UNDELEGATED_TURN_MAX_TOKENS: u64 = 400;

// Enforced at compile time rather than in a test: this is a fixed relationship
// between two constants, so it can never be false at runtime without being false
// at build time. ~40 tokens per tool call (name + short message + confidence) —
// the cap must clear a realistic parallel fan-out, because truncating a call
// mid-arguments breaks the turn, while over-sizing only forgoes a few tokens of
// savings on text that gets discarded anyway.
const _: () = assert!(UNDELEGATED_TURN_MAX_TOKENS >= 40 * 8);
// A greeting is capped at MAX_GREETING_CHARS (~50 tokens) and must fit too.
const _: () = assert!(UNDELEGATED_TURN_MAX_TOKENS as usize > MAX_GREETING_CHARS / 4);

/// Is this text one of the refusals this module produces?
///
/// Callers persist refusals differently from real answers (they are kept out of
/// the next turn's reasoning context — see `SessionHistory::fetch`), so they need
/// to recognise one. Exported rather than left to an equality check at the call
/// site: `a2a_dispatch.rs` compared against `NO_AGENT_MATCH_MESSAGE` exactly, and
/// the moment `refusal_with_roster` began appending the agent list that check
/// silently stopped matching — refusals were no longer tagged, went back into
/// history, and the session taught itself to keep refusing. Recognition lives
/// beside construction so they cannot drift apart again.
pub fn is_refusal_message(text: &str) -> bool {
    text.starts_with(NO_AGENT_MATCH_MESSAGE)
}

/// One line per agent: its name and what it does, straight from the agent cards.
/// Purely mechanical — no model-authored text — which is what lets it be shown
/// under a policy that forbids the orchestrator writing answers itself.
fn render_roster(agents: &[AgentInfo]) -> String {
    agents
        .iter()
        .map(|a| format!("- **{}** — {}", a.name, a.description.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The last gate before a final answer reaches the user: under
/// `require_delegation`, an answer the orchestrator produced without a single
/// successful agent call is replaced with [`NO_AGENT_MATCH_MESSAGE`].
///
/// Returns the text to actually send, so callers cannot forget to use the result.
///
/// This is the enforcement half of the policy. The system prompt asks the model
/// to refuse; this guarantees it, because a prompt instruction is advisory and a
/// model that ignores it would otherwise answer from its own knowledge — the
/// precise failure the policy exists to prevent.
///
/// Two ways to arrive here legitimately:
///   * the model emitted [`NO_AGENT_MATCH_SENTINEL`] — a deliberate refusal,
///   * the model answered anyway — a policy violation, logged at `warn`.
///
/// Both produce the same user-visible text; only the second is a bug worth
/// alerting on, which is why they are distinguished rather than collapsed.
fn enforce_delegation(
    final_text: &str,
    config: &OrchestratorConfig,
    agents: &[AgentInfo],
    delegated: bool,
    turn_idx: usize,
) -> String {
    // "What can you do for me?" is about the fleet, not a task for it, so there is
    // nothing to delegate and the guard used to answer it with "no available agent
    // can handle this request" — the worst possible reply to the most common
    // opening message. Answered from the roster, which is platform data.
    if !delegated && final_text.trim() == CAPABILITIES_SENTINEL && !agents.is_empty() {
        tracing::info!(
            turns = turn_idx + 1,
            "orchestrator answered a capability question from the agent roster"
        );
        return format!(
            "I work by delegating to the agents deployed here. These are available:\n\n{}\n\n\
             Ask me anything in those areas and I'll route it to the right one.",
            render_roster(agents)
        );
    }

    // A bare sentinel must never reach a human, whatever the policy state. This
    // runs even with `require_delegation` off because the two are configured
    // independently: the HITL resume disables enforcement but still sets a
    // confidence bar, so its prompt still teaches the token — and without this
    // branch a resumed turn that declined would render the literal string
    // "NO_AGENT_MATCH" in the chat.
    //
    // Exact match, not `contains`: the token quoted inside a real sentence is
    // the model talking *about* the policy, not invoking it, and replacing a
    // whole answer on a substring hit would discard agent-grounded content.
    if !delegated && final_text.trim() == NO_AGENT_MATCH_SENTINEL {
        tracing::info!(
            turns = turn_idx + 1,
            "orchestrator declined: no agent met the confidence bar"
        );
        // Same roster as the suppressed-answer path below. This is the *more*
        // common refusal (a well-behaved model reaches it deliberately), so
        // returning the bare message here left the usual dead end less helpful
        // than the policy-violation one — backwards.
        return refusal_with_roster(agents);
    }

    // A greeting is answered, not delegated and not refused. Length-capped so the
    // prefix cannot be used to smuggle a real answer past the guard.
    if !delegated && let Some(greeting) = final_text.trim().strip_prefix(GREETING_SENTINEL) {
        let greeting = greeting.trim();
        if !greeting.is_empty() && greeting.chars().count() <= MAX_GREETING_CHARS {
            tracing::info!(turns = turn_idx + 1, "orchestrator answered a greeting");
            return greeting.to_string();
        }
    }

    // A clarifying question is the one legitimate way to end a turn without
    // calling an agent: the model is not answering from its own knowledge, it is
    // asking for something it needs before it can delegate at all. Checked before
    // the guard below, and allowed through with the prefix stripped.
    if let Some(question) = final_text.trim().strip_prefix(NEED_INPUT_SENTINEL) {
        let question = question.trim();
        if !question.is_empty() {
            tracing::info!(
                turns = turn_idx + 1,
                "orchestrator asked the user for a missing detail before delegating"
            );
            return question.to_string();
        }
    }

    if !config.require_delegation || delegated {
        // A model that emits the sentinel *after* a successful call is describing
        // a gap in what the agents could do, not refusing to delegate — leave its
        // own wording alone rather than overwriting a real, agent-grounded answer.
        return final_text.to_string();
    }

    if final_text.trim().contains(NO_AGENT_MATCH_SENTINEL) {
        tracing::info!(
            turns = turn_idx + 1,
            "orchestrator declined: no agent met the confidence bar"
        );
    } else {
        // The suppressed text is logged (truncated) because without it this branch
        // is undiagnosable: an operator sees "no available agent can handle this
        // request" in the chat and has no way to learn what the model actually
        // wrote, or whether the substitution was even the right call. That is
        // exactly how a suppressed clarifying question stayed hidden.
        let preview: String = final_text.trim().chars().take(200).collect();
        tracing::warn!(
            turns = turn_idx + 1,
            answer_chars = final_text.len(),
            suppressed = %preview,
            "orchestrator answered without delegating despite require_delegation; \
             substituting the refusal message"
        );
    }

    refusal_with_roster(agents)
}

/// The refusal, plus what the fleet *can* do.
///
/// The bare message told the user only that they had failed, leaving no way to
/// tell "nothing covers this" apart from "something is broken", and no hint at
/// what to ask instead. The roster is mechanical, so this adds information
/// without the orchestrator authoring any of it. Falls back to the bare message
/// when there is no roster to show (an empty fleet never reaches here in
/// practice — dispatch rejects it earlier with a 503 — so this is defensive).
fn refusal_with_roster(agents: &[AgentInfo]) -> String {
    if agents.is_empty() {
        return NO_AGENT_MATCH_MESSAGE.to_string();
    }
    format!(
        "{NO_AGENT_MATCH_MESSAGE}\n\nHere is what the deployed agents can do:\n\n{}",
        render_roster(agents)
    )
}

/// The mandatory-delegation section, empty when the policy is off so an
/// unconfigured deployment's prompt is byte-identical to what it was before.
fn build_delegation_policy(config: &OrchestratorConfig) -> String {
    if !config.require_delegation && config.min_confidence.is_none() {
        return String::new();
    }

    let mut out = String::from("## Delegation Policy (MANDATORY)\n\n");

    if config.require_delegation {
        // Deliberately leads with "delegating is the expected outcome". The first
        // version of this section led with the prohibition ("you have no knowledge
        // of your own") and then described the refusal path in detail — which a
        // small model (gpt-4o-mini, the default OPENAI_MODEL) read as an invitation
        // to decline. Observed live: "route this to the HR assistant agent and ask
        // what the holidays are", with an `hr-agent` deployed whose description
        // literally reads "Public holidays, working day calculations, ...", refused
        // in one turn and 4 output tokens — the model never attempted a tool call.
        // Prohibition still comes, but after the instruction to delegate.
        out.push_str(
            "Delegating is the normal, expected outcome of almost every request. Read the agent \
             list above and call the agent whose description or skills cover the user's topic. If \
             the user names an agent, call that agent.\n\n\
             Your answers must be grounded in what the agents return — never answer from your own \
             training, even a question you could answer yourself. Relay and combine agent results; \
             do not substitute your own knowledge for them.\n\n",
        );
    }

    if let Some(min) = config.min_confidence {
        // States what a passing score looks like, not just the cutoff. Naming only
        // the cutoff gave the model a hurdle with no sense of where a normal match
        // sits, and it defaulted to assuming it fell short.
        out.push_str(
            "On every call pass a `confidence` argument from 0 to 100: your honest judgement that \
             this agent can complete this task, based on its description and skills — not on \
             whether you personally know the answer. Use the whole scale:\n\
             - 90-100: one of the agent's listed skills names this exact task\n\
             - 70-89: the task falls squarely in the agent's described domain\n\
             - 40-69: related to its domain, but not something it clearly does\n\
             - 0-39: outside this agent's domain\n\
             Score each agent on its own merits. Do not default to 100.\n\n\
             An agent described as general-purpose, or as able to use whatever tools it is given, \
             genuinely covers tasks that no specialist lists — that IS its domain, so score it \
             70-89 rather than marking it down for not naming the task. Prefer a specialist when \
             one fits; otherwise fall back to a general-purpose agent instead of refusing.\n\n",
        );
        // Naming the cutoff is skipped when it is 0. The old text said "score it
        // {min} or above" and "reserve scores below {min}" — at min = 0 that reads
        // as "score it 0 or above" (every possible value) and "reserve scores
        // below 0" (impossible), collapsing the whole paragraph into noise, which
        // is one reason every call came back at 100. It also anchored the model on
        // the threshold at any value, which is why the scale above replaces it.
        if min > 0 {
            out.push_str(&format!(
                "Calls scoring below {min} are rejected automatically and never reach the agent.\n\n",
            ));
        }
    }

    // The refusal token is taught ONLY when delegation is actually enforced.
    // Teaching it to a turn that is allowed to answer on its own (the HITL
    // resume, which sets a bar but no enforcement) invites the model to refuse a
    // turn whose answer is already agent-grounded — its own prompt tells it not
    // to call anyone again, which under a refusal instruction reads as "nothing
    // qualifies, so decline".
    //
    // Phrased as a last resort and kept to one line on purpose: the more room this
    // path gets, the more readily a small model takes it (see the note above).
    if config.require_delegation {
        // An underspecified request must not become a refusal. The agent itself is
        // usually the right place for a missing detail to surface (agents can pause
        // and ask a human), so calling with what the user gave is preferred; the
        // clarify path exists for when no sensible call can be formed at all.
        out.push_str(&format!(
            "If the request is missing a detail an agent's example suggests it wants (a country, a \
             date, a name), prefer calling the agent anyway with what the user gave you — the \
             agent can ask for the rest itself. Only when you cannot form any sensible call, ask \
             the user for the missing detail by replying `{NEED_INPUT}: <your question>` — for \
             example `{NEED_INPUT}: which country and year should I look up?`. Do NOT use this to \
             avoid delegating a request you could act on.\n\n",
            NEED_INPUT = NEED_INPUT_SENTINEL.trim_end_matches(':'),
        ));
        out.push_str(&format!(
            "If the user is only greeting you or making small talk (\"hi\", \"thanks\", \"good \
             afternoon\"), reply `{GREETING}: <a short friendly reply>` — one sentence, and never \
             use it to answer a question.\n\n",
            GREETING = GREETING_SENTINEL.trim_end_matches(':'),
        ));
        out.push_str(&format!(
            "If the user asks what you can do, what agents exist, how you can help, what a \
             PARTICULAR agent does, or which agent handles some topic — any question about this \
             platform rather than a task for it — reply with exactly this token and nothing else: \
             {CAPABILITIES_SENTINEL}\n\n",
        ));
        out.push_str(&format!(
            "Last resort only — if NO agent in the list covers the request at all, reply with \
             exactly this token and nothing else: {NO_AGENT_MATCH_SENTINEL}\n",
        ));
    }

    out
}

/// What the orchestrator says when no agent clears the confidence bar. Surfaced
/// verbatim to the user in place of a model-authored answer, so it must read as
/// a finished reply rather than an error code.
pub const NO_AGENT_MATCH_MESSAGE: &str = "No available agent can handle this request. I only answer by delegating to the agents \
     deployed on this platform, and none of them is a confident match for what you asked.";

/// The token the system prompt tells the model to emit when it judges that no
/// agent qualifies. Detecting it lets a deliberate refusal be reported as such
/// rather than being caught by the delegation guard as a stray direct answer —
/// both end in `NO_AGENT_MATCH_MESSAGE`, but only one of them is a policy
/// violation worth logging.
pub const NO_AGENT_MATCH_SENTINEL: &str = "NO_AGENT_MATCH";

/// Prefix the model uses to ask the user for a missing detail instead of
/// answering or refusing: `NEED_INPUT: which country and year?`.
///
/// Mandatory delegation had no room for the one legitimate reason to finish a
/// turn without calling an agent — needing something from the human first.
/// Observed live: "ask the HR agent what the holidays are", against an `hr-agent`
/// whose Public Holidays skill advertises `"What are the public holidays in
/// Germany for 2025?"`, produced a ~25-token reply (not the 4-token sentinel),
/// which the guard then replaced with "no available agent can handle this
/// request". The model was almost certainly asking which country and year; the
/// user was told no agent existed. A clarifying question is not the model
/// answering from its own knowledge, so it must survive the guard.
pub const NEED_INPUT_SENTINEL: &str = "NEED_INPUT:";

/// The token the model emits for a question about what this platform can do
/// ("what can you do for me?", "which agents do you have?").
///
/// Such a question has no agent to delegate to — it is about the fleet, not a
/// task for it — so mandatory delegation answered the single most common opening
/// message with "no available agent can handle this request". The answer is
/// assembled from the agent roster the server already holds, so producing it is
/// the platform reporting its own configuration, NOT the orchestrator answering
/// from its own knowledge: the exemption is sound, not a loophole.
pub const CAPABILITIES_SENTINEL: &str = "CAPABILITIES";

/// Prefix for a reply to a greeting or pleasantry: `GREETING: Hi! What can I
/// help you with?`.
///
/// "hi" and "good afternoon" are neither a task to delegate nor a question about
/// the fleet, so they fell through to the guard and were answered with "no
/// available agent can handle this request". A greeting makes no factual claim,
/// so letting the model word it asserts nothing the user could be misled by —
/// the same reasoning that already allows a model-authored clarifying question.
pub const GREETING_SENTINEL: &str = "GREETING:";

/// Longest reply the greeting exemption will pass through.
///
/// This is the one exemption whose text is both model-authored and unconstrained
/// in topic, so it is the one an answer could hide behind ("GREETING: Hi! The
/// capital of France is Paris."). A greeting is a sentence; anything longer is an
/// answer wearing a greeting's prefix, and falls through to the guard. A cap is
/// crude, but it is checkable, and the alternative is trusting the prefix alone.
const MAX_GREETING_CHARS: usize = 200;

/// Configuration for the orchestrator.
#[derive(Debug, Clone)]
pub struct OrchestratorConfig {
    pub max_turns: usize,
    pub model: String,
    pub preamble: Option<String>,
    pub context: ContextConfig,
    pub temperature: Option<f64>,
    /// OpenAI-compatible base URL. If None, uses OPENAI_BASE_URL env var.
    pub base_url: Option<String>,
    /// API key. If None, uses OPENAI_API_KEY env var.
    pub api_key: Option<String>,
    /// Organization-wide rules injected into the system prompt, already
    /// formatted by the caller (`oss/server/src/orchestrator_rules.rs`). `None`
    /// when the operator's rules toggle is off or no rules are defined.
    ///
    /// Separate from `preamble` on purpose: `preamble` is the caller's own
    /// framing of what this orchestrator is for, while these are operator
    /// policy that outlives any one caller.
    pub org_rules: Option<String>,
    /// Percentage (0-100) a tool call's self-reported `confidence` must reach
    /// before the call is allowed through. `None` disables the check entirely.
    pub min_confidence: Option<u8>,
    /// Refuse to answer from the model's own knowledge: a turn that ends
    /// without a successful agent call yields `NO_AGENT_MATCH_MESSAGE` instead
    /// of whatever the model wrote.
    ///
    /// Callers that feed an already-delegated result back in (the HITL resume in
    /// `oss/server/src/hitl/mod.rs`) must set this `false` — that turn is
    /// *supposed* to answer without calling anyone, because the agent call it is
    /// reporting on already happened in an earlier turn.
    pub require_delegation: bool,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_turns: 15,
            model: "gpt-5.5".to_string(),
            preamble: None,
            context: ContextConfig::default(),
            temperature: Some(0.2),
            base_url: None,
            api_key: None,
            org_rules: None,
            min_confidence: None,
            require_delegation: false,
        }
    }
}

/// Trace of a single ReAct turn for observability.
#[derive(Debug, Clone)]
pub struct TurnTrace {
    pub turn: usize,
    pub tool_calls: Vec<ToolCallTrace>,
    pub text_response: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ToolCallTrace {
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub result: Result<String, String>,
}

/// Result returned from a completed orchestration.
#[derive(Debug, Clone)]
pub struct OrchestrationResult {
    pub response: String,
    pub turns: Vec<TurnTrace>,
    pub context_compacted: bool,
}

/// The ReAct orchestrator. Holds the registry, context, and LLM config.
pub struct Orchestrator {
    config: OrchestratorConfig,
    registry: AgentRegistry,
    a2a_client: Arc<A2aClient>,
    context: ContextManager,
    guard: Option<Arc<dyn CallGuard>>,
}

impl Orchestrator {
    pub fn new(config: OrchestratorConfig, registry_source: RegistrySource) -> Self {
        let a2a_client = Arc::new(A2aClient::new());
        let registry = AgentRegistry::new(registry_source);
        let context = ContextManager::new(config.context.clone());
        Self {
            config,
            registry,
            a2a_client,
            context,
            guard: None,
        }
    }

    pub fn with_a2a_client(mut self, client: A2aClient) -> Self {
        self.a2a_client = Arc::new(client);
        self
    }

    pub fn with_guard(mut self, guard: Arc<dyn CallGuard>) -> Self {
        self.guard = Some(guard);
        self
    }

    /// Discover agents from the registry. Call before `run()`.
    pub async fn init(&self) -> Result<Vec<AgentInfo>, OrchestratorError> {
        let agents = self
            .registry
            .discover()
            .await
            .map_err(|e| OrchestratorError::Registry(e.to_string()))?;

        tracing::info!(count = agents.len(), "agents discovered");
        for a in &agents {
            tracing::debug!(name = %a.name, endpoint = %a.endpoint, "registered agent");
        }
        Ok(agents)
    }

    /// Run the ReAct loop for a user query.
    pub async fn run(
        &mut self,
        user_query: &str,
    ) -> Result<OrchestrationResult, OrchestratorError> {
        self.context.push_user(user_query);

        if self.context.needs_compaction() {
            self.context.compact_simple();
            tracing::info!(
                tokens = self.context.estimated_tokens(),
                "context compacted"
            );
        }

        let agents = self.registry.agents().await;
        if agents.is_empty() {
            return Err(OrchestratorError::NoAgents);
        }

        let model = self.build_model()?;
        let (toolset, tool_defs) = self.build_tools(&agents).await;
        let preamble = build_preamble(&self.config, &agents);

        let mut turns = Vec::new();
        let mut context_compacted = false;
        let mut delegated = false;

        // Preamble is STABLE across turns — provider can cache this prefix.
        // All dynamic context goes into user messages instead.
        for turn_idx in 0..self.config.max_turns {
            let window = self.context.window();

            // Build the user prompt with context embedded (changes each turn)
            let user_prompt = if turn_idx == 0 && window.summary.is_none() {
                user_query.to_string()
            } else {
                let ctx = window.format_for_prompt();
                format!(
                    "{ctx}\n\nCurrent request: {user_query}\n\n\
                     Based on the above context and tool results, continue. \
                     If you have enough information, respond with your final answer (no tool call)."
                )
            };

            let mut req = model
                .completion_request(Message::user(&user_prompt))
                .preamble(preamble.clone())
                .tools(tool_defs.clone());

            if self.config.require_delegation && !delegated {
                req = req.max_tokens(UNDELEGATED_TURN_MAX_TOKENS);
            }

            if let Some(temp) = self.config.temperature {
                req = req.temperature(temp);
            }

            let response = req
                .send()
                .await
                .map_err(|e| OrchestratorError::Completion(e.to_string()))?;

            // This completion's total token cost, attributed evenly across
            // however many tool calls it produced (best available granularity
            // — the API gives one usage figure per completion, not per tool
            // call). Without this, `after_call` always received a literal 0
            // and `FlowGuard::record_tokens`/`TokenBudgetExhausted` could
            // never fire.
            let completion_tokens = response
                .raw_response
                .usage
                .as_ref()
                .map(|u| u.total_tokens as u64);

            // Partition the response into text and tool calls
            let mut text_parts = Vec::new();
            let mut tool_calls = Vec::new();

            for content in response.choice.iter() {
                match content {
                    AssistantContent::Text(t) => text_parts.push(t.text.clone()),
                    AssistantContent::ToolCall(tc) => tool_calls.push(tc.clone()),
                }
            }

            // If there are tool calls, execute them all
            if !tool_calls.is_empty() {
                let tokens_per_call = tokens_per_tool_call(completion_tokens, tool_calls.len());
                let mut trace = TurnTrace {
                    turn: turn_idx + 1,
                    tool_calls: Vec::new(),
                    text_response: if text_parts.is_empty() {
                        None
                    } else {
                        Some(text_parts.join("\n"))
                    },
                };

                let mut results_for_context = Vec::new();

                for tc in &tool_calls {
                    let name = &tc.function.name;
                    let args_str = tc.function.arguments.to_string();

                    let agent_display = name
                        .strip_prefix("call_agent_")
                        .unwrap_or(name)
                        .replace('_', "-");

                    // Confidence bar first — see the streaming path's own note.
                    if let Err(reason) =
                        check_confidence(&tc.function.arguments, self.config.min_confidence)
                    {
                        tracing::warn!(tool = %name, %reason, "confidence gate blocked");
                        trace.tool_calls.push(ToolCallTrace {
                            tool_name: name.clone(),
                            arguments: tc.function.arguments.clone(),
                            result: Err(reason.clone()),
                        });
                        results_for_context.push(format!("[{}] Blocked: {}", name, reason));
                        continue;
                    }

                    // Enforce call guard
                    if let Some(g) = &self.guard
                        && let Err(reason) = g.before_call(&agent_display).await
                    {
                        tracing::warn!(tool = %name, %reason, "call guard blocked");
                        trace.tool_calls.push(ToolCallTrace {
                            tool_name: name.clone(),
                            arguments: tc.function.arguments.clone(),
                            result: Err(format!("blocked: {}", reason)),
                        });
                        results_for_context.push(format!("[{}] Blocked: {}", name, reason));
                        continue;
                    }

                    tracing::info!(turn = turn_idx + 1, tool = %name, "executing tool");

                    let result = toolset.call(name, args_str).await;

                    // A pause is not a tool outcome to trace or reason over — stop the whole run
                    // immediately, before it's recorded as just another failed/successful call.
                    if let ToolOutcome::AwaitingHuman {
                        agent,
                        agent_id,
                        pause,
                    } = classify_tool_result(&result)
                    {
                        if let Some(g) = &self.guard {
                            g.after_call(&agent_display, tokens_per_call).await;
                        }
                        // Preserve any earlier calls in this same batch that already completed
                        // before this one paused — without this, they're silently discarded here,
                        // since the push_tool_result call below (which normally records the whole
                        // batch) is never reached once we return. `results_for_context.len()` is
                        // exactly the count of `tool_calls` processed so far: every earlier
                        // iteration either pushed a result/error/block entry or hit this same
                        // pause check itself, so the slice lines up with what's actually recorded.
                        if !results_for_context.is_empty() {
                            let completed_names = tool_calls[..results_for_context.len()]
                                .iter()
                                .map(|tc| tc.function.name.as_str())
                                .collect::<Vec<_>>()
                                .join("+");
                            self.context.push_tool_result(
                                &completed_names,
                                &results_for_context.join("\n\n"),
                            );
                        }
                        return Err(OrchestratorError::AwaitingHuman {
                            agent,
                            agent_id,
                            pause: Box::new(pause),
                        });
                    }

                    let call_trace = ToolCallTrace {
                        tool_name: name.clone(),
                        arguments: tc.function.arguments.clone(),
                        result: result
                            .as_ref()
                            .map(|s| s.clone())
                            .map_err(|e| e.to_string()),
                    };
                    trace.tool_calls.push(call_trace);

                    match result {
                        Ok(output) => {
                            if let Some(g) = &self.guard {
                                g.after_call(&agent_display, tokens_per_call).await;
                            }
                            results_for_context.push(format!("[{}] Result: {}", name, output));
                            delegated = true;
                        }
                        Err(e) => {
                            // Balance the before_call() depth increment even on
                            // failure — otherwise a failed tool call permanently
                            // leaks flow-depth and later legitimate calls in the
                            // same flow get falsely rejected with MaxDepthExceeded.
                            if let Some(g) = &self.guard {
                                g.after_call(&agent_display, tokens_per_call).await;
                            }
                            tracing::warn!(tool = %name, error = %e, "tool failed");
                            results_for_context.push(format!("[{}] Error: {}", name, e));
                        }
                    }
                }

                // Push combined tool results as a single observation
                let combined = results_for_context.join("\n\n");
                self.context.push_tool_result(
                    &tool_calls
                        .iter()
                        .map(|tc| tc.function.name.as_str())
                        .collect::<Vec<_>>()
                        .join("+"),
                    &combined,
                );

                turns.push(trace);
            } else {
                // No tool calls — this is the final text response
                let final_text = enforce_delegation(
                    &text_parts.join("\n"),
                    &self.config,
                    &agents,
                    delegated,
                    turn_idx,
                );
                self.context.push_assistant(&final_text);

                turns.push(TurnTrace {
                    turn: turn_idx + 1,
                    tool_calls: Vec::new(),
                    text_response: Some(final_text.clone()),
                });

                return Ok(OrchestrationResult {
                    response: final_text,
                    turns,
                    context_compacted,
                });
            }

            // Mid-loop compaction check
            if self.context.needs_compaction() {
                self.context.compact_simple();
                context_compacted = true;
                tracing::info!(
                    tokens = self.context.estimated_tokens(),
                    "mid-loop compaction"
                );
            }
        }

        Err(OrchestratorError::MaxTurnsExceeded(self.config.max_turns))
    }

    /// Run the ReAct loop, streaming events to the caller via a channel.
    /// Returns a receiver; the orchestration runs in the background.
    /// `file_parts` are pre-serialized A2A Part JSON values from the user's
    /// upload — forwarded to whichever agent the orchestrator selects.
    ///
    /// The in-memory context this streams against is write-only from the caller's perspective:
    /// `context` below is a clone handed to the spawned task, and every `push_tool_result`/
    /// `push_assistant` inside `run_stream_inner` mutates that clone, which is simply dropped when
    /// the task ends — `self.context` on this `Orchestrator` is never updated by a streaming turn,
    /// including the record that a sub-agent paused awaiting a human (found in review). This is
    /// currently safe only because the one caller that resumes after a streaming pause
    /// (`trigger_new_orchestrator_turn`, `oss/server/src/hitl/mod.rs`) rebuilds its own context
    /// from `SessionHistory::fetch` rather than trusting this `Orchestrator`'s in-memory state — do
    /// not add a caller that relies on `self.context` reflecting a prior `run_stream` call's
    /// effects without first making this shared (e.g. `Arc<Mutex<ContextManager>>`) rather than
    /// cloned.
    pub fn run_stream(
        &mut self,
        user_query: &str,
        file_parts: Vec<nasiko_types::a2a::Part>,
    ) -> mpsc::Receiver<OrchestratorEvent> {
        let (tx, rx) = mpsc::channel(64);
        let query = user_query.to_string();

        // Pre-serialize file parts to JSON once; the A2aTool will include them
        // in every agent call's message.parts alongside the text part.
        let file_parts_json: Vec<serde_json::Value> = file_parts
            .iter()
            .filter_map(|p| serde_json::to_value(p).ok())
            .collect();

        // Clone what we need for the spawned task
        let config = self.config.clone();
        let registry = self.registry.clone();
        let agents_ctx = AgentCallContext {
            a2a_client: self.a2a_client.clone(),
        };
        let mut context = self.context.clone();
        let guard = self.guard.clone();

        tokio::spawn(async move {
            let _ = run_stream_inner(
                &config,
                &registry,
                &agents_ctx,
                &mut context,
                &query,
                &tx,
                guard.as_deref(),
                &file_parts_json,
            )
            .await;
        });

        rx
    }

    /// Reset the context for a new conversation.
    pub fn reset_context(&mut self) {
        self.context = ContextManager::new(self.config.context.clone());
    }

    fn build_model(&self) -> Result<openai::CompletionModel, OrchestratorError> {
        let api_key = self
            .config
            .api_key
            .clone()
            .or_else(|| std::env::var("OPENAI_API_KEY").ok())
            .ok_or_else(|| OrchestratorError::LlmConfig("OPENAI_API_KEY not set".into()))?;

        let base_url = self
            .config
            .base_url
            .clone()
            .or_else(|| std::env::var("OPENAI_BASE_URL").ok());

        let client = if let Some(url) = base_url {
            openai::Client::from_url(&api_key, &url)
        } else {
            openai::Client::new(&api_key)
        };

        Ok(client.completion_model(&self.config.model))
    }

    async fn build_tools(&self, agents: &[AgentInfo]) -> (ToolSet, Vec<ToolDefinition>) {
        let mut builder = ToolSet::builder();
        let mut defs = Vec::new();

        for agent in agents {
            let tool = A2aTool::new(agent.clone(), self.a2a_client.clone());
            defs.push(ToolDyn::definition(&tool, String::new()).await);
            builder = builder.static_tool(tool);
        }

        (builder.build(), defs)
    }
}

/// What's needed to actually reach an agent — the shared HTTP client. (Agents
/// carry their own MCP gateway credential; no per-call user token exists.)
struct AgentCallContext {
    a2a_client: Arc<A2aClient>,
}

/// Inner streaming implementation. Sends events to the channel as orchestration progresses.
#[allow(clippy::too_many_arguments)]
async fn run_stream_inner(
    config: &OrchestratorConfig,
    registry: &AgentRegistry,
    agents_ctx: &AgentCallContext,
    context: &mut ContextManager,
    user_query: &str,
    tx: &mpsc::Sender<OrchestratorEvent>,
    guard: Option<&dyn CallGuard>,
    file_parts: &[serde_json::Value],
) -> Result<(), OrchestratorError> {
    context.push_user(user_query);

    if context.needs_compaction() {
        context.compact_simple();
    }

    let agents = registry.agents().await;
    if agents.is_empty() {
        let _ = tx
            .send(OrchestratorEvent::Error {
                message: "no agents available".into(),
            })
            .await;
        return Err(OrchestratorError::NoAgents);
    }

    let api_key = match config
        .api_key
        .clone()
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
    {
        Some(k) => k,
        None => {
            let message = "OPENAI_API_KEY not set".to_string();
            let _ = tx
                .send(OrchestratorEvent::Error {
                    message: message.clone(),
                })
                .await;
            return Err(OrchestratorError::LlmConfig(message));
        }
    };

    let base_url = config
        .base_url
        .clone()
        .or_else(|| std::env::var("OPENAI_BASE_URL").ok());

    let client = if let Some(url) = base_url {
        openai::Client::from_url(&api_key, &url)
    } else {
        openai::Client::new(&api_key)
    };
    let model = client.completion_model(&config.model);

    // Build tools from agents. This is the streaming loop, so each agent call
    // relays the sub-agent's live progress into the event stream.
    let mut builder = ToolSet::builder();
    let mut tool_defs = Vec::new();
    for agent in &agents {
        // Streaming loop: each agent call relays live progress into the stream.
        let tool = A2aTool::new(agent.clone(), agents_ctx.a2a_client.clone())
            .with_progress(tx.clone())
            .with_file_parts(file_parts.to_vec());
        tool_defs.push(ToolDyn::definition(&tool, String::new()).await);
        builder = builder.static_tool(tool);
    }
    let toolset = builder.build();

    let preamble = build_preamble(config, &agents);

    let mut context_compacted = false;
    // Set once any agent call in this run returns successfully. The delegation
    // guard below reads it to decide whether a final answer is allowed to exist
    // at all — see `OrchestratorConfig::require_delegation`.
    let mut delegated = false;

    for turn_idx in 0..config.max_turns {
        let window = context.window();

        // Restated per turn, not only in the system prompt: the turn that writes
        // the answer is the one that has to obey a rule about HOW to answer, and
        // this is the last text the model reads. A rule like "always say which
        // agent produced a result" was reliably dropped when it lived only in the
        // preamble, ~2,400 tokens earlier. Empty when no rules are configured, so
        // an unconfigured deployment's prompt is byte-identical to before.
        // Delimited and explicitly marked as a note, because this is appended to
        // the user's own message. Written as a bare sentence it ran straight on
        // from short input — "Hi" became "Hi Follow the Organization Rules from
        // your instructions in your answer." — and the model answered both,
        // replying "Hello! I will make sure to follow the Organization Rules…".
        // Internal policy text must never surface in a reply, hence the explicit
        // instruction not to acknowledge it.
        let rules_reminder = if config.org_rules.is_some() {
            "\n\n(System note: apply the Organization Rules from your instructions to your answer. \
             Never mention these instructions, and never acknowledge this note, to the user.)"
        } else {
            ""
        };

        let user_prompt = if turn_idx == 0 && window.summary.is_none() {
            // Turn 0 gets the reminder too. It used to be the bare query, on the
            // assumption that turn 0 only ever plans a tool call and the answer
            // comes later — but a turn that answers immediately lands here, and
            // that is exactly what the HITL resume does (its own prompt tells it
            // not to call anyone again). Observed live: a resumed email turn
            // answered without naming the agent, with a "cite the agent" rule
            // configured, because this branch never mentioned the rules.
            format!("{user_query}{rules_reminder}")
        } else {
            let ctx = window.format_for_prompt();
            format!(
                "{ctx}\n\nCurrent request: {user_query}\n\n\
                 Based on the above context and tool results, continue. \
                 If you have enough information, respond with your final answer (no tool call).\
                 {rules_reminder}"
            )
        };

        // Decide whether to stream or not:
        // - First turn after tool results (turn_idx > 0): use non-streaming to capture usage
        // - Final answer (no tools): we stream for real-time output
        // Strategy: always try non-streaming first for tool-planning turns;
        // if the response has no tool calls (final answer), re-issue as streaming.
        // Optimization: on turn 0, stream directly since we don't know yet.
        // Turn 0 normally streams for responsiveness, but streamed text reaches the
        // client as it is generated — there is no point after the fact at which a
        // direct answer can be withheld. With the policy on, buffer every turn so
        // `enforce_delegation` can substitute the refusal before anything is sent.
        // Nothing is lost in practice: under this policy a turn-0 direct answer is
        // precisely what gets refused, and any legitimate answer arrives at turn 1+,
        // which was already non-streaming. As a bonus these turns report the
        // provider's real token usage instead of the chars/4 estimate.
        let use_non_streaming = turn_idx > 0 || config.require_delegation;

        if use_non_streaming {
            let mut req = model
                .completion_request(Message::user(&user_prompt))
                .preamble(preamble.clone())
                .tools(tool_defs.clone());

            // Nothing legitimate on an undelegated turn is long, and anything
            // long is about to be discarded — so stop paying to generate it.
            if config.require_delegation && !delegated {
                req = req.max_tokens(UNDELEGATED_TURN_MAX_TOKENS);
            }

            if let Some(temp) = config.temperature {
                req = req.temperature(temp);
            }

            let response = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    let _ = tx
                        .send(OrchestratorEvent::Error {
                            message: e.to_string(),
                        })
                        .await;
                    return Err(OrchestratorError::Completion(e.to_string()));
                }
            };

            // Extract usage from raw response
            let mut completion_tokens = None;
            if let Some(ref usage) = response.raw_response.usage {
                let input = usage.prompt_tokens as u64;
                let total = usage.total_tokens as u64;
                let output = total.saturating_sub(input);
                completion_tokens = Some(total);
                let _ = tx
                    .send(OrchestratorEvent::Usage {
                        input_tokens: input,
                        output_tokens: output,
                        model: config.model.clone(),
                        estimated: false,
                    })
                    .await;
            }

            // Partition the response
            let mut text_parts = Vec::new();
            let mut tool_calls = Vec::new();

            for content in response.choice.iter() {
                match content {
                    AssistantContent::Text(t) => text_parts.push(t.text.clone()),
                    AssistantContent::ToolCall(tc) => tool_calls.push(tc.clone()),
                }
            }

            if !tool_calls.is_empty() {
                if !text_parts.is_empty() {
                    let _ = tx
                        .send(OrchestratorEvent::Thinking {
                            content: text_parts.join(""),
                        })
                        .await;
                }

                // This completion's total token cost, attributed evenly across
                // however many tool calls it produced — see `run`'s identical
                // comment for why `after_call` previously always got a literal 0.
                let tokens_per_call = tokens_per_tool_call(completion_tokens, tool_calls.len());

                let mut results_for_context = Vec::new();

                for tc in &tool_calls {
                    let name = &tc.function.name;
                    let args_str = tc.function.arguments.to_string();

                    let msg = tc
                        .function
                        .arguments
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    let agent_display = name
                        .strip_prefix("call_agent_")
                        .unwrap_or(name)
                        .replace('_', "-");

                    // Confidence bar first, before the flow guard: a call the model
                    // itself rates as a poor match should never consume fan-out or
                    // depth budget, and `before_call` increments both.
                    if let Err(reason) =
                        check_confidence(&tc.function.arguments, config.min_confidence)
                    {
                        let _ = tx
                            .send(OrchestratorEvent::PolicyRejected {
                                agent: agent_display.clone(),
                                reason: reason.clone(),
                                turn: turn_idx + 1,
                            })
                            .await;
                        results_for_context.push(format!(
                            "[{}] BLOCKED: {}. Do NOT retry this agent with a different score \
                             unless you have a concrete reason to rate it higher.",
                            name, reason
                        ));
                        continue;
                    }

                    if let Some(g) = guard
                        && let Err(reason) = g.before_call(&agent_display).await
                    {
                        let _ = tx
                            .send(OrchestratorEvent::PolicyRejected {
                                agent: agent_display.clone(),
                                reason: reason.clone(),
                                turn: turn_idx + 1,
                            })
                            .await;
                        results_for_context.push(format!(
                            "[{}] BLOCKED by policy: {}. Do NOT retry this agent.",
                            name, reason
                        ));
                        continue;
                    }

                    let confidence = confidence_of(&tc.function.arguments);
                    tracing::info!(
                        target: "nasiko::orchestrator",
                        agent = %agent_display,
                        confidence = confidence.unwrap_or(-1.0),
                        required = config.min_confidence.unwrap_or(0),
                        turn = turn_idx + 1,
                        "delegation allowed: agent cleared the confidence bar"
                    );
                    let _ = tx
                        .send(OrchestratorEvent::ToolCall {
                            agent: agent_display.clone(),
                            message: msg,
                            turn: turn_idx + 1,
                            confidence,
                        })
                        .await;

                    let started = std::time::Instant::now();
                    let result = toolset.call(name, args_str).await;
                    let duration_ms = started.elapsed().as_millis() as u64;

                    // A pause is not a tool outcome to relay as ToolResult or reason over — stop
                    // this run immediately, before the LLM ever sees it as a completed call.
                    //
                    // Do NOT also send OrchestratorEvent::AwaitingHuman here: this A2aTool was
                    // built `.with_progress(tx.clone())` (same `tx` this function itself uses),
                    // so `call_streaming`'s own forwarder task already relayed the identical
                    // event on this same channel, live, before `toolset.call()` even returned —
                    // sending it again here would deliver it twice to a2a_dispatch.rs.
                    if let ToolOutcome::AwaitingHuman { .. } = classify_tool_result(&result) {
                        if let Some(g) = guard {
                            g.after_call(&agent_display, tokens_per_call).await;
                        }
                        // Preserve any earlier calls in this same batch that already completed
                        // before this one paused — without this, they're silently discarded here,
                        // since the push_tool_result call below (which normally records the whole
                        // batch) is never reached once we return. `results_for_context.len()` is
                        // exactly the count of `tool_calls` processed so far: every earlier
                        // iteration either pushed a result/error/block entry or hit this same
                        // pause check itself, so the slice lines up with what's actually recorded.
                        if !results_for_context.is_empty() {
                            let completed_names = tool_calls[..results_for_context.len()]
                                .iter()
                                .map(|tc| tc.function.name.as_str())
                                .collect::<Vec<_>>()
                                .join("+");
                            context.push_tool_result(
                                &completed_names,
                                &results_for_context.join("\n\n"),
                            );
                        }
                        return Ok(());
                    }

                    match &result {
                        Ok(output) => {
                            if let Some(g) = guard {
                                g.after_call(&agent_display, tokens_per_call).await;
                            }
                            let _ = tx
                                .send(OrchestratorEvent::ToolResult {
                                    agent: agent_display,
                                    result: output.clone(),
                                    success: true,
                                    turn: turn_idx + 1,
                                    duration_ms,
                                })
                                .await;
                            results_for_context.push(format!("[{}] Result: {}", name, output));
                            delegated = true;
                        }
                        Err(e) => {
                            // Balance the before_call() depth increment even on
                            // failure — otherwise a failed tool call permanently
                            // leaks flow-depth and later legitimate calls in the
                            // same flow get falsely rejected with MaxDepthExceeded.
                            if let Some(g) = guard {
                                g.after_call(&agent_display, tokens_per_call).await;
                            }
                            let err_str = e.to_string();
                            let _ = tx
                                .send(OrchestratorEvent::ToolResult {
                                    agent: agent_display,
                                    result: err_str.clone(),
                                    success: false,
                                    turn: turn_idx + 1,
                                    duration_ms,
                                })
                                .await;
                            results_for_context.push(format!("[{}] Error: {}", name, err_str));
                        }
                    }
                }

                let combined = results_for_context.join("\n\n");
                context.push_tool_result(
                    &tool_calls
                        .iter()
                        .map(|tc| tc.function.name.as_str())
                        .collect::<Vec<_>>()
                        .join("+"),
                    &combined,
                );
            } else {
                // Final answer from non-streaming — emit as Content chunks
                let final_text = enforce_delegation(
                    &text_parts.join("\n"),
                    config,
                    &agents,
                    delegated,
                    turn_idx,
                );
                for chunk in final_text.chars().collect::<Vec<_>>().chunks(200) {
                    let s: String = chunk.iter().collect();
                    let _ = tx.send(OrchestratorEvent::Content { content: s }).await;
                }
                context.push_assistant(&final_text);

                let _ = tx
                    .send(OrchestratorEvent::Done {
                        turns: turn_idx + 1,
                        context_compacted,
                    })
                    .await;

                return Ok(());
            }
        } else {
            // Streaming path (turn 0 or when we want real-time output)
            let mut req = model
                .completion_request(Message::user(&user_prompt))
                .preamble(preamble.clone())
                .tools(tool_defs.clone());

            // Nothing legitimate on an undelegated turn is long, and anything
            // long is about to be discarded — so stop paying to generate it.
            if config.require_delegation && !delegated {
                req = req.max_tokens(UNDELEGATED_TURN_MAX_TOKENS);
            }

            if let Some(temp) = config.temperature {
                req = req.temperature(temp);
            }

            let mut stream = match req.stream().await {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx
                        .send(OrchestratorEvent::Error {
                            message: e.to_string(),
                        })
                        .await;
                    return Err(OrchestratorError::Completion(e.to_string()));
                }
            };

            let mut text_parts = Vec::new();
            let mut tool_calls = Vec::new();

            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(StreamingChoice::Message(text)) => {
                        text_parts.push(text.clone());
                        let _ = tx.send(OrchestratorEvent::Content { content: text }).await;
                    }
                    Ok(StreamingChoice::ToolCall(name, id, params)) => {
                        tool_calls.push(ToolCall {
                            id,
                            function: ToolFunction {
                                name,
                                arguments: params,
                            },
                        });
                    }
                    Err(e) => {
                        let _ = tx
                            .send(OrchestratorEvent::Error {
                                message: e.to_string(),
                            })
                            .await;
                        return Err(OrchestratorError::Completion(e.to_string()));
                    }
                }
            }

            // rig 0.11's stream surfaces no usage chunk, so streamed turns would
            // otherwise report nothing at all. Emit a character-based estimate,
            // flagged so consumers label it approximate rather than exact.
            {
                let output_chars: usize = text_parts.iter().map(|t| t.len()).sum::<usize>()
                    + tool_calls
                        .iter()
                        .map(|tc| tc.function.arguments.to_string().len())
                        .sum::<usize>();
                let input_chars = preamble.len() + user_prompt.len();
                let _ = tx
                    .send(OrchestratorEvent::Usage {
                        input_tokens: estimate_tokens_from_chars(input_chars),
                        output_tokens: estimate_tokens_from_chars(output_chars),
                        model: config.model.clone(),
                        estimated: true,
                    })
                    .await;
            }

            if !tool_calls.is_empty() {
                // Note: unlike the non-streaming branch below, no `Thinking`
                // event is sent here — any pre-tool-call text was already
                // delivered live via `Content` as it streamed above, so
                // re-sending it as `Thinking` would just print it twice.

                // The estimated Usage above is for display/attribution only; no
                // exact figure exists to feed `after_call`, so token-budget
                // accounting stays 0 for streamed turns only. Budget enforcement
                // is still real for every turn after the first (turn_idx > 0
                // always takes the non-streaming path).
                let mut results_for_context = Vec::new();

                for tc in &tool_calls {
                    let name = &tc.function.name;
                    let args_str = tc.function.arguments.to_string();

                    let msg = tc
                        .function
                        .arguments
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    let agent_display = name
                        .strip_prefix("call_agent_")
                        .unwrap_or(name)
                        .replace('_', "-");

                    // Confidence bar first, before the flow guard: a call the model
                    // itself rates as a poor match should never consume fan-out or
                    // depth budget, and `before_call` increments both.
                    if let Err(reason) =
                        check_confidence(&tc.function.arguments, config.min_confidence)
                    {
                        let _ = tx
                            .send(OrchestratorEvent::PolicyRejected {
                                agent: agent_display.clone(),
                                reason: reason.clone(),
                                turn: turn_idx + 1,
                            })
                            .await;
                        results_for_context.push(format!(
                            "[{}] BLOCKED: {}. Do NOT retry this agent with a different score \
                             unless you have a concrete reason to rate it higher.",
                            name, reason
                        ));
                        continue;
                    }

                    if let Some(g) = guard
                        && let Err(reason) = g.before_call(&agent_display).await
                    {
                        let _ = tx
                            .send(OrchestratorEvent::PolicyRejected {
                                agent: agent_display.clone(),
                                reason: reason.clone(),
                                turn: turn_idx + 1,
                            })
                            .await;
                        results_for_context.push(format!(
                            "[{}] BLOCKED by policy: {}. Do NOT retry this agent.",
                            name, reason
                        ));
                        continue;
                    }

                    let confidence = confidence_of(&tc.function.arguments);
                    tracing::info!(
                        target: "nasiko::orchestrator",
                        agent = %agent_display,
                        confidence = confidence.unwrap_or(-1.0),
                        required = config.min_confidence.unwrap_or(0),
                        turn = turn_idx + 1,
                        "delegation allowed: agent cleared the confidence bar"
                    );
                    let _ = tx
                        .send(OrchestratorEvent::ToolCall {
                            agent: agent_display.clone(),
                            message: msg,
                            turn: turn_idx + 1,
                            confidence,
                        })
                        .await;

                    let started = std::time::Instant::now();
                    let result = toolset.call(name, args_str).await;
                    let duration_ms = started.elapsed().as_millis() as u64;

                    // A pause is not a tool outcome to relay as ToolResult or reason over — stop
                    // this run immediately, before the LLM ever sees it as a completed call.
                    //
                    // Do NOT also send OrchestratorEvent::AwaitingHuman here: this A2aTool was
                    // built `.with_progress(tx.clone())` (same `tx` this function itself uses),
                    // so `call_streaming`'s own forwarder task already relayed the identical
                    // event on this same channel, live, before `toolset.call()` even returned —
                    // sending it again here would deliver it twice to a2a_dispatch.rs.
                    if let ToolOutcome::AwaitingHuman { .. } = classify_tool_result(&result) {
                        if let Some(g) = guard {
                            g.after_call(&agent_display, 0).await;
                        }
                        // Preserve any earlier calls in this same batch that already completed
                        // before this one paused — without this, they're silently discarded here,
                        // since the push_tool_result call below (which normally records the whole
                        // batch) is never reached once we return. `results_for_context.len()` is
                        // exactly the count of `tool_calls` processed so far: every earlier
                        // iteration either pushed a result/error/block entry or hit this same
                        // pause check itself, so the slice lines up with what's actually recorded.
                        if !results_for_context.is_empty() {
                            let completed_names = tool_calls[..results_for_context.len()]
                                .iter()
                                .map(|tc| tc.function.name.as_str())
                                .collect::<Vec<_>>()
                                .join("+");
                            context.push_tool_result(
                                &completed_names,
                                &results_for_context.join("\n\n"),
                            );
                        }
                        return Ok(());
                    }

                    match &result {
                        Ok(output) => {
                            if let Some(g) = guard {
                                g.after_call(&agent_display, 0).await;
                            }
                            let _ = tx
                                .send(OrchestratorEvent::ToolResult {
                                    agent: agent_display,
                                    result: output.clone(),
                                    success: true,
                                    turn: turn_idx + 1,
                                    duration_ms,
                                })
                                .await;
                            results_for_context.push(format!("[{}] Result: {}", name, output));
                            delegated = true;
                        }
                        Err(e) => {
                            // Balance the before_call() depth increment even on
                            // failure — otherwise a failed tool call permanently
                            // leaks flow-depth and later legitimate calls in the
                            // same flow get falsely rejected with MaxDepthExceeded.
                            if let Some(g) = guard {
                                g.after_call(&agent_display, 0).await;
                            }
                            let err_str = e.to_string();
                            let _ = tx
                                .send(OrchestratorEvent::ToolResult {
                                    agent: agent_display,
                                    result: err_str.clone(),
                                    success: false,
                                    turn: turn_idx + 1,
                                    duration_ms,
                                })
                                .await;
                            results_for_context.push(format!("[{}] Error: {}", name, err_str));
                        }
                    }
                }

                let combined = results_for_context.join("\n\n");
                context.push_tool_result(
                    &tool_calls
                        .iter()
                        .map(|tc| tc.function.name.as_str())
                        .collect::<Vec<_>>()
                        .join("+"),
                    &combined,
                );
            } else {
                // Final answer — already streamed token-by-token via Content events.
                //
                // No delegation guard here, and none is needed: whenever the policy
                // is on, `use_non_streaming` is forced true for every turn, so this
                // branch is unreachable under it. That is exactly why the policy
                // forces it — text emitted here has already reached the client
                // chunk-by-chunk and cannot be recalled.
                let final_text = text_parts.join("");
                context.push_assistant(&final_text);

                let _ = tx
                    .send(OrchestratorEvent::Done {
                        turns: turn_idx + 1,
                        context_compacted,
                    })
                    .await;

                return Ok(());
            }
        } // end streaming else branch

        if context.needs_compaction() {
            context.compact_simple();
            context_compacted = true;
        }
    }

    let _ = tx
        .send(OrchestratorEvent::Error {
            message: format!("max turns ({}) exceeded", config.max_turns),
        })
        .await;
    Err(OrchestratorError::MaxTurnsExceeded(config.max_turns))
}

/// Rough chars→tokens estimate (~4 chars/token for English-ish text) for
/// streamed turns where the provider reports no usage. Never returns 0 for
/// non-empty text so estimated usage is distinguishable from "no data".
fn estimate_tokens_from_chars(chars: usize) -> u64 {
    (chars as u64).div_ceil(4)
}

#[cfg(test)]
mod tokens_per_tool_call_tests {
    use super::tokens_per_tool_call;

    #[test]
    fn splits_total_evenly_across_tool_calls() {
        assert_eq!(tokens_per_tool_call(Some(300), 3), 100);
    }

    #[test]
    fn no_usage_reported_yields_zero() {
        assert_eq!(tokens_per_tool_call(None, 3), 0);
    }

    #[test]
    fn zero_tool_calls_does_not_divide_by_zero() {
        assert_eq!(tokens_per_tool_call(Some(300), 0), 300);
    }

    #[test]
    fn single_tool_call_gets_the_full_amount() {
        assert_eq!(tokens_per_tool_call(Some(150), 1), 150);
    }
}

#[cfg(test)]
mod awaiting_human_tests {
    use super::*;
    use crate::a2a::A2aClient;
    use crate::registry::{AgentInfo, RegistrySource};
    use crate::tool::A2aToolError;

    fn input_required_response_body() -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": "1",
            "result": {"task": {
                "id": "task-321",
                "contextId": "ctx-654",
                "status": {
                    "state": "TASK_STATE_INPUT_REQUIRED",
                    "message": {"parts": [{"text": "Which repository?"}]}
                }
            }}
        })
        .to_string()
    }

    /// Pure classification, exercised twice with identical input — the property that makes the
    /// "both loops call the same function" claim actually checkable rather than asserted by
    /// inspection: if this function's output ever depended on anything but its argument, the two
    /// calls below could disagree.
    #[test]
    fn classify_tool_result_is_deterministic_and_recovers_awaiting_human_through_rig_erasure() {
        // Built the same way `ToolSet::call()` really builds it (see
        // tool::tests::awaiting_human_survives_rig_toolset_erasure for the full round trip
        // through a real ToolSet; this test targets classify_tool_result directly).
        let inner: Box<dyn std::error::Error + Send + Sync> =
            Box::new(A2aToolError::AwaitingHuman {
                agent: "test-agent".into(),
                agent_id: "agent-under-test".into(),
                pause: PauseInfo {
                    kind: nasiko_types::a2a::AwaitingHumanKind::InputRequired,
                    message: "Which repository?".into(),
                    task_id: "task-321".into(),
                    context_id: "ctx-654".into(),
                    metadata: serde_json::Value::Null,
                },
            });
        let result: Result<String, ToolSetError> =
            Err(ToolSetError::ToolCallError(ToolError::ToolCallError(inner)));

        for _ in 0..2 {
            match classify_tool_result(&result) {
                ToolOutcome::AwaitingHuman {
                    agent, agent_id, ..
                } => {
                    assert_eq!(agent, "test-agent");
                    assert_eq!(agent_id, "agent-under-test");
                }
                ToolOutcome::NotAwaitingHuman => panic!("expected AwaitingHuman"),
            }
        }
    }

    #[test]
    fn classify_tool_result_leaves_ordinary_outcomes_alone() {
        assert!(matches!(
            classify_tool_result(&Ok("fine".to_string())),
            ToolOutcome::NotAwaitingHuman
        ));
        assert!(matches!(
            classify_tool_result(&Err(ToolSetError::ToolNotFoundError("x".into()))),
            ToolOutcome::NotAwaitingHuman
        ));
    }

    fn test_agent(endpoint: &str) -> AgentInfo {
        AgentInfo {
            id: "agent-under-test".into(),
            name: "test-agent".into(),
            description: "for tests".into(),
            endpoint: endpoint.into(),
            skills: vec![],
        }
    }

    fn mock_tool_call_completion() -> String {
        serde_json::json!({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1,
            "model": "gpt-4o-mini",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "call_agent_test_agent",
                            "arguments": "{\"message\":\"hi\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        })
        .to_string()
    }

    /// The real, end-to-end proof this whole step exists for: a full `Orchestrator::run()`
    /// against a mocked LLM (one tool-call completion) and a mocked sub-agent (pauses) —
    /// verifies the loop stops after exactly one LLM call, never asks the LLM what to do next
    /// with the pause, and returns the pause faithfully.
    #[tokio::test]
    async fn run_stops_after_one_llm_call_when_the_tool_call_pauses() {
        let mut llm_server = mockito::Server::new_async().await;
        let llm_mock = llm_server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(mock_tool_call_completion())
            .expect(1)
            .create_async()
            .await;

        let mut agent_server = mockito::Server::new_async().await;
        let agent_mock = agent_server
            .mock("POST", "/")
            .with_status(200)
            .with_body(input_required_response_body())
            .expect(1)
            .create_async()
            .await;

        let config = OrchestratorConfig {
            base_url: Some(llm_server.url()),
            api_key: Some("test-key".into()),
            ..Default::default()
        };
        let mut orchestrator = Orchestrator::new(
            config,
            RegistrySource::Static(vec![test_agent(&agent_server.url())]),
        )
        .with_a2a_client(A2aClient::new());
        // AgentRegistry::agents() only reads its cache — init() is what populates it, even for a
        // Static source. Every real caller (e.g. a2a_dispatch.rs) calls this before run()/
        // run_stream(); omitting it here isn't "a smaller test," it's testing a call sequence
        // that doesn't happen in production and getting Err(NoAgents) for the wrong reason.
        orchestrator
            .init()
            .await
            .expect("registry init must succeed for a Static source");

        let result = orchestrator.run("please help").await;

        llm_mock.assert_async().await;
        agent_mock.assert_async().await;
        match result {
            Err(OrchestratorError::AwaitingHuman {
                agent,
                agent_id,
                pause,
            }) => {
                assert_eq!(agent, "test-agent");
                assert_eq!(agent_id, "agent-under-test");
                assert_eq!(pause.message, "Which repository?");
            }
            other => panic!("expected Err(AwaitingHuman), got {other:?}"),
        }
    }
}

#[cfg(test)]
mod delegation_policy_tests {
    use super::*;
    use serde_json::json;

    fn policy(min: Option<u8>, require: bool) -> OrchestratorConfig {
        OrchestratorConfig {
            min_confidence: min,
            require_delegation: require,
            ..Default::default()
        }
    }

    // ── check_confidence ─────────────────────────────────────────────────

    #[test]
    fn no_bar_configured_lets_everything_through() {
        assert!(check_confidence(&json!({}), None).is_ok());
    }

    #[test]
    fn a_score_at_the_bar_passes() {
        assert!(check_confidence(&json!({"confidence": 80}), Some(80)).is_ok());
    }

    #[test]
    fn a_score_below_the_bar_is_rejected_with_both_numbers() {
        let err =
            check_confidence(&json!({"confidence": 42}), Some(80)).expect_err("42 is below 80");
        assert!(err.contains("42"), "reason should name the score: {err}");
        assert!(err.contains("80"), "reason should name the bar: {err}");
    }

    /// The whole policy would be opt-out if omitting one field meant "allowed".
    #[test]
    fn a_missing_score_is_a_rejection_not_a_pass() {
        assert!(check_confidence(&json!({"message": "hi"}), Some(80)).is_err());
    }

    /// Models routinely emit numeric parameters as strings; refusing those would
    /// block a legitimate call for a reason the model cannot see or correct.
    #[test]
    fn a_numeric_string_score_is_accepted() {
        assert!(check_confidence(&json!({"confidence": "95"}), Some(80)).is_ok());
        assert!(check_confidence(&json!({"confidence": "12"}), Some(80)).is_err());
    }

    #[test]
    fn a_non_numeric_score_is_rejected() {
        assert!(check_confidence(&json!({"confidence": "very sure"}), Some(80)).is_err());
    }

    /// A successful delegation must be as inspectable as a rejected one: the
    /// score that cleared the bar rides the `ToolCall` event so it reaches the
    /// SSE stream and the UI step row. It used to be read, checked and dropped,
    /// leaving no way to see what the picked agent actually scored.
    #[test]
    fn a_passing_score_is_carried_on_the_event_not_discarded() {
        let args = json!({ "message": "check the logs", "confidence": 93 });
        assert!(check_confidence(&args, Some(80)).is_ok());
        assert_eq!(confidence_of(&args), Some(93.0));
    }

    /// With no bar configured nothing was demanded, so there is nothing to report.
    #[test]
    fn no_score_present_reads_as_none() {
        assert_eq!(confidence_of(&json!({ "message": "hi" })), None);
    }

    // ── enforce_delegation ───────────────────────────────────────────────

    #[test]
    fn policy_off_returns_the_model_answer_untouched() {
        let out = enforce_delegation(
            "Paris is the capital of France.",
            &policy(None, false),
            &[],
            false,
            0,
        );
        assert_eq!(out, "Paris is the capital of France.");
    }

    /// The core guarantee: with the policy on and nothing delegated, the model's
    /// own answer never reaches the user.
    #[test]
    fn an_undelegated_answer_is_replaced_with_the_refusal() {
        let out = enforce_delegation(
            "Paris is the capital of France.",
            &policy(Some(80), true),
            &[],
            false,
            0,
        );
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    #[test]
    fn a_deliberate_sentinel_refusal_also_yields_the_refusal_message() {
        let out = enforce_delegation(
            NO_AGENT_MATCH_SENTINEL,
            &policy(Some(80), true),
            &[],
            false,
            0,
        );
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    /// Synthesis after a successful agent call is the normal, wanted path — the
    /// guard must not eat a real agent-grounded answer.
    #[test]
    fn an_answer_after_a_successful_call_is_preserved() {
        let out = enforce_delegation(
            "The log agent found 3 OOMKills.",
            &policy(Some(80), true),
            &[],
            true,
            1,
        );
        assert_eq!(out, "The log agent found 3 OOMKills.");
    }

    /// A sentinel emitted *after* a successful call describes a gap in what the
    /// agents could do, not a refusal to delegate — leave the model's wording be.
    #[test]
    fn a_sentinel_after_a_successful_call_is_not_rewritten() {
        let text = format!("{NO_AGENT_MATCH_SENTINEL} for the second half of the request");
        let out = enforce_delegation(&text, &policy(Some(80), true), &[], true, 1);
        assert_eq!(out, text);
    }

    // ── preamble ─────────────────────────────────────────────────────────

    /// An unconfigured deployment must see the prompt exactly as it was before
    /// this feature existed — no stray policy heading, no behaviour change.
    #[test]
    fn an_unconfigured_deployment_gets_no_policy_section() {
        assert_eq!(build_delegation_policy(&policy(None, false)), "");
    }

    /// Regression: the first version of this section led with the prohibition and
    /// gave the refusal path a paragraph of its own. gpt-4o-mini read that as an
    /// invitation to decline — "route this to the HR assistant agent and ask what
    /// the holidays are", against a running `hr-agent` whose description reads
    /// "Public holidays, working day calculations, ...", was refused in a single
    /// turn and 4 output tokens, with no tool call attempted. The section must
    /// state that delegating is the expected outcome BEFORE it mentions refusing.
    #[test]
    fn the_policy_leads_with_delegating_not_refusing() {
        let out = build_delegation_policy(&policy(Some(80), true));

        let delegate_at = out
            .find("Delegating is the normal")
            .expect("the section must say delegating is the normal outcome");
        let refuse_at = out
            .find(NO_AGENT_MATCH_SENTINEL)
            .expect("the refusal token is still taught");
        assert!(
            delegate_at < refuse_at,
            "the instruction to delegate must come before the refusal path:\n{out}"
        );
        assert!(
            out.contains("Last resort only"),
            "the refusal must be framed as a last resort: {out}"
        );
    }

    /// The bar alone is a hurdle with no sense of where a normal match sits, which
    /// is what let the model assume it fell short. The section must also say what
    /// a PASSING score looks like.
    /// Regression: the instruction used to read "score it {min} or above" and
    /// "reserve scores below {min}". At a bar of 0 that is "score it 0 or above"
    /// (every value) and "reserve scores below 0" (impossible) — incoherent
    /// guidance, and every call came back at 100.
    #[test]
    fn a_zero_bar_emits_no_threshold_language() {
        let out = build_delegation_policy(&policy(Some(0), true));
        assert!(
            !out.contains("below 0"),
            "a zero bar must not produce impossible instructions: {out}"
        );
        assert!(
            !out.contains("rejected automatically"),
            "nothing is rejected at a zero bar, so do not claim it is: {out}"
        );
        assert!(
            out.contains("90-100"),
            "the calibration scale still applies at a zero bar: {out}"
        );
    }

    /// A real bar is still stated, so the model knows what gets rejected.
    #[test]
    fn a_real_bar_is_still_named() {
        let out = build_delegation_policy(&policy(Some(80), true));
        assert!(out.contains("below 80 are rejected"), "{out}");
    }

    /// Regression: the scale rewarded agents whose listed skills name the exact
    /// task, which systematically penalised general-purpose agents — they list no
    /// specific task by design, so the better one is at being general the lower it
    /// scored. Observed live: "send an email to …" refused repeatedly against a
    /// running MCP agent described as completing "arbitrary tasks", which had
    /// successfully sent that same email minutes earlier.
    #[test]
    fn a_general_purpose_agent_is_not_penalised_for_being_general() {
        let out = build_delegation_policy(&policy(Some(80), true));
        assert!(
            out.contains("general-purpose"),
            "the scale must account for general-purpose agents: {out}"
        );
        assert!(
            out.contains("instead of refusing"),
            "falling back to a general agent must beat refusing: {out}"
        );
    }

    /// Anchoring the model on the cutoff produced a cluster at the top of the
    /// range. The scale gives it somewhere else to land.
    #[test]
    fn the_scale_discourages_defaulting_to_one_hundred() {
        let out = build_delegation_policy(&policy(Some(80), true));
        assert!(out.contains("Do not default to 100"), "{out}");
        assert!(
            out.contains("0-39"),
            "the low end must be described too: {out}"
        );
    }

    /// The bar alone is a hurdle with no sense of where a normal match sits. The
    /// section must describe what each band of the scale means — originally a
    /// single "score it {min} or above" sentence, which anchored everything at the
    /// top of the range.
    #[test]
    fn the_policy_says_what_a_passing_score_looks_like() {
        let out = build_delegation_policy(&policy(Some(80), true));
        assert!(
            out.contains("names this exact task"),
            "the top band must be described: {out}"
        );
        assert!(
            out.contains("squarely in the agent's described domain"),
            "the ordinary-match band must be described: {out}"
        );
    }

    #[test]
    fn the_policy_section_states_the_bar_and_the_sentinel() {
        let out = build_delegation_policy(&policy(Some(80), true));
        assert!(out.contains("80"), "the bar must be stated: {out}");
        assert!(out.contains(NO_AGENT_MATCH_SENTINEL));
        assert!(out.contains("MANDATORY"));
    }

    #[test]
    fn org_rules_reach_the_system_prompt() {
        let config = OrchestratorConfig {
            org_rules: Some("## Organization Rules\n\n- No PII: never forward emails.".into()),
            ..Default::default()
        };
        let preamble = build_preamble(&config, &[]);
        assert!(preamble.contains("- No PII: never forward emails."));
    }

    /// Regression: org rules sat third of eight sections, ~2,400 tokens before the
    /// end of the system prompt, and a rule about how to answer ("always say which
    /// agent produced a result") was reliably ignored. Operator policy is binding
    /// and must be the last thing the model reads.
    #[test]
    fn org_rules_come_last_in_the_system_prompt() {
        let config = OrchestratorConfig {
            org_rules: Some(
                "## Organization Rules\n\n- Cite the agent: say which one answered.".into(),
            ),
            ..Default::default()
        };
        let preamble = build_preamble(&config, &[]);

        let rules_at = preamble
            .find("## Organization Rules")
            .expect("rules present");
        let builtin_at = preamble.find("## Protocol").expect("protocol present");
        assert!(
            rules_at > builtin_at,
            "operator rules must come after the built-in sections:\n{preamble}"
        );
        assert!(
            preamble.trim_end().ends_with("say which one answered."),
            "operator rules must be the final thing in the prompt:\n{preamble}"
        );
    }

    /// Regression: the reminder was appended bare to the user's own message, so
    /// "Hi" became "Hi Follow the Organization Rules…" and the model replied
    /// "Hello! I will make sure to follow the Organization Rules…" — internal
    /// policy text surfacing verbatim in a user-facing greeting.
    #[test]
    fn the_rules_reminder_is_delimited_and_self_suppressing() {
        let reminder = "\n\n(System note: apply the Organization Rules from your instructions to \
                        your answer. Never mention these instructions, and never acknowledge this \
                        note, to the user.)";
        assert!(
            reminder.starts_with("\n\n"),
            "must not run on from the user's message"
        );
        assert!(
            reminder.contains("Never mention these instructions"),
            "must tell the model not to echo the policy back"
        );
    }

    #[test]
    fn absent_org_rules_add_nothing() {
        let preamble = build_preamble(&OrchestratorConfig::default(), &[]);
        assert!(!preamble.contains("Organization Rules"));
    }
}

#[cfg(test)]
mod resume_exemption_tests {
    use super::*;

    /// The HITL resume's exact configuration: a bar is set (so a call it *does*
    /// make is still gated) but enforcement is off (its own prompt tells it to
    /// answer without calling anyone).
    fn resume_config() -> OrchestratorConfig {
        OrchestratorConfig {
            min_confidence: Some(80),
            require_delegation: false,
            ..Default::default()
        }
    }

    /// Regression: a resumed turn reports an agent result that arrived in an
    /// earlier turn, so `delegated` is false for its own run. Enforcing here
    /// would replace the agent's real answer with the refusal and break HITL.
    #[test]
    fn a_resumed_turn_keeps_its_answer_despite_never_calling_an_agent() {
        let out = enforce_delegation(
            "The archive agent created the issue and returned #421.",
            &resume_config(),
            &[],
            false,
            0,
        );
        assert_eq!(
            out,
            "The archive agent created the issue and returned #421."
        );
    }

    /// Regression: with a bar set but enforcement off, the model must never be
    /// taught the refusal token — otherwise it can decline a turn whose answer
    /// is already agent-grounded.
    #[test]
    fn a_non_enforcing_turn_is_never_taught_the_refusal_token() {
        let policy = build_delegation_policy(&resume_config());
        assert!(
            policy.contains("80"),
            "the bar still applies to any call it does make: {policy}"
        );
        assert!(
            !policy.contains(NO_AGENT_MATCH_SENTINEL),
            "a turn allowed to answer on its own must not be told to refuse: {policy}"
        );
    }

    /// Belt and braces: even if a sentinel escapes anyway, a human must never
    /// see the raw token.
    #[test]
    fn a_raw_sentinel_never_reaches_the_user_even_unenforced() {
        let out = enforce_delegation(NO_AGENT_MATCH_SENTINEL, &resume_config(), &[], false, 0);
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    /// The token quoted inside a real sentence is the model talking about the
    /// policy, not invoking it — replacing on a substring hit would discard
    /// agent-grounded content.
    #[test]
    fn the_token_mentioned_inside_prose_is_not_treated_as_a_refusal() {
        let text = format!("The agent replied with the string {NO_AGENT_MATCH_SENTINEL} verbatim.");
        let out = enforce_delegation(&text, &resume_config(), &[], false, 0);
        assert_eq!(out, text);
    }
}

#[cfg(test)]
mod clarifying_question_tests {
    use super::*;

    fn strict() -> OrchestratorConfig {
        OrchestratorConfig {
            min_confidence: Some(80),
            require_delegation: true,
            ..Default::default()
        }
    }

    /// Regression: mandatory delegation left no room for the model to ask for a
    /// missing detail, so an underspecified request ("what are the holidays?"
    /// with no country) came back as "no available agent can handle this
    /// request" — telling the user the agent did not exist when it did.
    #[test]
    fn a_clarifying_question_survives_the_guard() {
        let out = enforce_delegation(
            "NEED_INPUT: which country and year should I look up?",
            &strict(),
            &[],
            false,
            0,
        );
        assert_eq!(out, "which country and year should I look up?");
    }

    /// The prefix must not leak into the chat bubble.
    #[test]
    fn the_prefix_is_stripped_not_shown() {
        let out = enforce_delegation("NEED_INPUT:   which country?  ", &strict(), &[], false, 0);
        assert_eq!(out, "which country?");
        assert!(!out.contains(NEED_INPUT_SENTINEL));
    }

    /// The prefix is not an escape hatch for answering: with no question after
    /// it there is nothing to ask, so the guard still applies.
    #[test]
    fn a_bare_prefix_with_no_question_still_refuses() {
        let out = enforce_delegation("NEED_INPUT:", &strict(), &[], false, 0);
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    /// A direct answer is still suppressed — the clarify path must not weaken the
    /// core guarantee.
    #[test]
    fn a_direct_answer_is_still_suppressed() {
        let out = enforce_delegation("Paris is the capital of France.", &strict(), &[], false, 0);
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    /// The model has to be told the clarify path exists, or it will never use it.
    #[test]
    fn the_policy_teaches_the_clarify_path() {
        let policy = build_delegation_policy(&strict());
        assert!(
            policy.contains("NEED_INPUT"),
            "clarify path missing: {policy}"
        );
        assert!(
            policy.contains("prefer calling the agent anyway"),
            "calling the agent must remain the preferred route: {policy}"
        );
    }
}

#[cfg(test)]
mod capability_question_tests {
    use super::*;

    fn strict() -> OrchestratorConfig {
        OrchestratorConfig {
            min_confidence: Some(80),
            require_delegation: true,
            ..Default::default()
        }
    }

    fn fleet() -> Vec<AgentInfo> {
        vec![
            AgentInfo {
                id: "1".into(),
                name: "hr-agent".into(),
                description: "Public holidays, working day calculations, world clock".into(),
                endpoint: "http://localhost:1".into(),
                skills: vec![],
            },
            AgentInfo {
                id: "2".into(),
                name: "finance-agent".into(),
                description: "Exchange rates and crypto prices".into(),
                endpoint: "http://localhost:2".into(),
                skills: vec![],
            },
        ]
    }

    /// Regression: "what can you do for me?" is about the fleet, not a task for
    /// it, so nothing could be delegated and mandatory delegation answered the
    /// most common opening message with "no available agent can handle this
    /// request". It must answer from the roster instead.
    #[test]
    fn a_capability_question_is_answered_from_the_roster() {
        let out = enforce_delegation(CAPABILITIES_SENTINEL, &strict(), &fleet(), false, 0);

        assert!(out.contains("hr-agent"), "roster missing agents: {out}");
        assert!(out.contains("finance-agent"), "roster incomplete: {out}");
        assert!(
            out.contains("Public holidays"),
            "each agent's own description must carry through: {out}"
        );
        assert!(
            !out.contains(NO_AGENT_MATCH_MESSAGE),
            "a capability question is not a refusal: {out}"
        );
    }

    /// The token itself must never reach the chat bubble.
    #[test]
    fn the_capabilities_token_is_not_shown_verbatim() {
        let out = enforce_delegation(CAPABILITIES_SENTINEL, &strict(), &fleet(), false, 0);
        assert!(!out.contains(CAPABILITIES_SENTINEL));
    }

    /// A genuine refusal should name what the fleet *can* do, so a dead end
    /// becomes a menu rather than just "you failed".
    /// Both refusal paths must produce the same thing: a deliberate decline (the
    /// model emits the token) used to return the bare message while a suppressed
    /// answer got the roster, which made the ordinary dead end the less helpful
    /// of the two.
    #[test]
    fn both_refusal_paths_list_the_agents() {
        let deliberate = enforce_delegation(NO_AGENT_MATCH_SENTINEL, &strict(), &fleet(), false, 0);
        let suppressed = enforce_delegation("Here is a long essay…", &strict(), &fleet(), false, 0);
        assert_eq!(deliberate, suppressed);
        assert!(
            deliberate.contains("hr-agent"),
            "roster missing: {deliberate}"
        );
    }

    #[test]
    fn a_refusal_lists_the_available_agents() {
        let out = enforce_delegation("Here is a long essay…", &strict(), &fleet(), false, 0);

        assert!(
            out.starts_with(NO_AGENT_MATCH_MESSAGE),
            "refusal first: {out}"
        );
        assert!(
            out.contains("hr-agent"),
            "refusal should name agents: {out}"
        );
    }

    /// With no roster to show there is nothing to add, and the bare message is
    /// still correct.
    #[test]
    fn an_empty_fleet_falls_back_to_the_bare_message() {
        let out = enforce_delegation("Here is a long essay…", &strict(), &[], false, 0);
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    /// The capability exemption must not become a way to answer a real question:
    /// only the exact token qualifies.
    #[test]
    fn the_exemption_requires_the_exact_token() {
        let out = enforce_delegation(
            "CAPABILITIES include knowing that Paris is the capital of France.",
            &strict(),
            &fleet(),
            false,
            0,
        );
        assert!(out.starts_with(NO_AGENT_MATCH_MESSAGE));
    }

    /// Regression: the caller recognised a refusal by comparing against
    /// `NO_AGENT_MATCH_MESSAGE` exactly. Appending the roster broke that silently
    /// — refusals stopped being tagged, re-entered the next turn's context, and
    /// the session taught itself to keep refusing (observed live: one successful
    /// email send, then five identical refusals in a row).
    ///
    /// Asserts against what the guard ACTUALLY returns, not against the constant,
    /// which is the only form of this test that would have caught it.
    #[test]
    fn every_refusal_the_guard_produces_is_recognised_as_one() {
        let with_roster = enforce_delegation("an essay", &strict(), &fleet(), false, 0);
        let deliberate = enforce_delegation(NO_AGENT_MATCH_SENTINEL, &strict(), &fleet(), false, 0);
        let bare = enforce_delegation("an essay", &strict(), &[], false, 0);

        for refusal in [&with_roster, &deliberate, &bare] {
            assert!(
                is_refusal_message(refusal),
                "guard produced a refusal the caller cannot recognise: {refusal}"
            );
        }
    }

    /// A real agent-grounded answer must never be mistaken for a refusal, or it
    /// would be dropped from the session's history.
    #[test]
    fn a_real_answer_is_not_mistaken_for_a_refusal() {
        assert!(!is_refusal_message(
            "Here are the public holidays in Germany."
        ));
        assert!(!is_refusal_message(""));
    }

    /// Regression: "What does the devops agent do?" and "Which agent handles
    /// Kubernetes?" were refused, though the roster answers both outright. The
    /// token covered "what agents exist" but not "what does agent X do".
    #[test]
    fn per_agent_questions_route_to_the_capability_answer() {
        let policy = build_delegation_policy(&strict());
        assert!(
            policy.contains("PARTICULAR agent does"),
            "asking about one agent must reach the roster: {policy}"
        );
        assert!(
            policy.contains("which agent handles"),
            "asking who handles a topic must reach the roster: {policy}"
        );
    }

    #[test]
    fn the_policy_teaches_the_capabilities_token() {
        let policy = build_delegation_policy(&strict());
        assert!(
            policy.contains(CAPABILITIES_SENTINEL),
            "the model must be told the token exists: {policy}"
        );
    }
}

#[cfg(test)]
mod greeting_tests {
    use super::*;

    fn strict() -> OrchestratorConfig {
        OrchestratorConfig {
            min_confidence: Some(70),
            require_delegation: true,
            ..Default::default()
        }
    }

    /// Regression: "hi" and "good afternoon" are neither a task nor a question
    /// about the fleet, so they fell through to the guard and were answered with
    /// "no available agent can handle this request".
    #[test]
    fn a_greeting_is_answered_not_refused() {
        let out = enforce_delegation(
            "GREETING: Hi! What can I help you with?",
            &strict(),
            &[],
            false,
            0,
        );
        assert_eq!(out, "Hi! What can I help you with?");
    }

    #[test]
    fn the_greeting_prefix_is_never_shown() {
        let out = enforce_delegation("GREETING:   Hello!  ", &strict(), &[], false, 0);
        assert_eq!(out, "Hello!");
        assert!(!out.contains(GREETING_SENTINEL));
    }

    /// The one exemption whose text is model-authored AND unconstrained in topic,
    /// so it is the one an answer could hide behind. Over the cap it is treated as
    /// an answer, not a greeting.
    #[test]
    fn an_answer_hiding_behind_the_greeting_prefix_is_still_suppressed() {
        let smuggled = format!(
            "GREETING: Hi! {}",
            "The capital of France is Paris. ".repeat(12)
        );
        assert!(smuggled.chars().count() > MAX_GREETING_CHARS);

        let out = enforce_delegation(&smuggled, &strict(), &[], false, 0);
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    /// An empty greeting is not a greeting.
    #[test]
    fn a_bare_prefix_falls_through_to_the_guard() {
        let out = enforce_delegation("GREETING:", &strict(), &[], false, 0);
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    /// A plain direct answer is still suppressed — the exemption must not widen
    /// the hole it sits next to.
    #[test]
    fn a_direct_answer_is_still_suppressed() {
        let out = enforce_delegation("Paris is the capital of France.", &strict(), &[], false, 0);
        assert_eq!(out, NO_AGENT_MATCH_MESSAGE);
    }

    #[test]
    fn the_policy_teaches_the_greeting_token() {
        let policy = build_delegation_policy(&strict());
        assert!(
            policy.contains("GREETING"),
            "greeting path missing: {policy}"
        );
        assert!(
            policy.contains("never \n             use it to answer a question")
                || policy.contains("never use it to answer a question"),
            "the model must be told not to answer with it: {policy}"
        );
    }
}
