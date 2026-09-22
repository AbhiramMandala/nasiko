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
        let preamble = self.build_preamble(&agents);

        let mut turns = Vec::new();
        let mut context_compacted = false;

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
                let final_text = text_parts.join("\n");
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

    /// `{custom}` (the caller-supplied preamble, e.g. L1A supplemental context in
    /// `oss/server/src/router/a2a_dispatch.rs`) goes last, after the roster/protocol/rules —
    /// those never change between turns, so keeping them as the prefix lets OpenAI's
    /// prefix-based prompt caching hit across turns even when `{custom}` itself varies (a
    /// query-ranked top-k slice does; see `MemoryConfig::l1a_inject_all_max_facts`, which keeps
    /// the common small-domain case stable too).
    fn build_preamble(&self, agents: &[AgentInfo]) -> String {
        let custom = self.config.preamble.as_deref().unwrap_or("");

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

        format!(
            r#"You are a ReAct orchestrator. Fulfill user requests by reasoning and delegating to specialized agents.

## Available Agents

{agent_list}

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
- When calling an agent tool, call it directly — do not first restate its message as your own chat reply. If that agent pauses to ask the user something, your own words would otherwise repeat the same question twice.

{custom}"#
        )
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

    // Build preamble
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

    // `{custom}` goes last — see `build_preamble`'s doc comment on why (prompt-cache prefix
    // stability).
    let preamble = format!(
        r#"You are a ReAct orchestrator. Fulfill user requests by reasoning and delegating to specialized agents.

## Available Agents

{agent_list}

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
- When calling an agent tool, call it directly — do not first restate its message as your own chat reply. If that agent pauses to ask the user something, your own words would otherwise repeat the same question twice.

{custom}"#
    );

    let mut context_compacted = false;

    for turn_idx in 0..config.max_turns {
        let window = context.window();

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

        // Decide whether to stream or not:
        // - First turn after tool results (turn_idx > 0): use non-streaming to capture usage
        // - Final answer (no tools): we stream for real-time output
        // Strategy: always try non-streaming first for tool-planning turns;
        // if the response has no tool calls (final answer), re-issue as streaming.
        // Optimization: on turn 0, stream directly since we don't know yet.
        let use_non_streaming = turn_idx > 0;

        if use_non_streaming {
            let mut req = model
                .completion_request(Message::user(&user_prompt))
                .preamble(preamble.clone())
                .tools(tool_defs.clone());

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

                    let _ = tx
                        .send(OrchestratorEvent::ToolCall {
                            agent: agent_display.clone(),
                            message: msg,
                            turn: turn_idx + 1,
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
                let final_text = text_parts.join("\n");
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

                    let _ = tx
                        .send(OrchestratorEvent::ToolCall {
                            agent: agent_display.clone(),
                            message: msg,
                            turn: turn_idx + 1,
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
                // Final answer — already streamed token-by-token via Content events
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

    /// The stable roster/protocol/rules block must stay the prefix and `{custom}` (e.g. L1A
    /// supplemental context, which can be query-variable for large domains) must come last, so
    /// OpenAI's prefix-based prompt caching hits on the stable part across turns even when
    /// `{custom}` itself changes. See `build_preamble`'s doc comment.
    #[test]
    fn build_preamble_places_custom_content_after_the_stable_roster_and_rules() {
        let config = OrchestratorConfig {
            preamble: Some("## Known facts about specific agents\n\ntest-agent:\n- a fact".into()),
            ..Default::default()
        };
        let agents = vec![test_agent("http://unused")];
        let orchestrator = Orchestrator::new(config, RegistrySource::Static(agents.clone()));

        let preamble = orchestrator.build_preamble(&agents);

        let agents_pos = preamble
            .find("## Available Agents")
            .expect("roster header present");
        let rules_pos = preamble.find("## Rules").expect("rules header present");
        let custom_pos = preamble
            .find("Known facts about specific agents")
            .expect("custom preamble content present");

        assert!(
            agents_pos < rules_pos,
            "roster must precede rules in the stable prefix"
        );
        assert!(
            rules_pos < custom_pos,
            "custom content must come after the stable roster/protocol/rules block"
        );
    }
}
