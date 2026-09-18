use serde::Serialize;

use crate::a2a::PauseInfo;

/// Events emitted during orchestration, streamed to the caller in real-time.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OrchestratorEvent {
    /// Orchestrator is reasoning about what to do next.
    Thinking { content: String },

    /// About to call an agent tool.
    ToolCall {
        agent: String,
        message: String,
        turn: usize,
        /// The model's own 0-100 judgement that this agent can do this task, as
        /// it passed the confidence gate. Carried so a successful delegation is
        /// as inspectable as a rejected one — without it the score was read,
        /// checked and discarded, and the only way to see a score was to have a
        /// call fail. `None` when no bar is configured (nothing was demanded, so
        /// there is nothing to report).
        confidence: Option<f64>,
    },

    /// Agent returned a result.
    ///
    /// `duration_ms` is wall-clock for the whole A2A call, so the UI can show a
    /// real per-agent timing instead of counting only the total round.
    ToolResult {
        agent: String,
        result: String,
        success: bool,
        turn: usize,
        duration_ms: u64,
    },

    /// A sub-agent's own progress update (e.g. its internal tool activity),
    /// relayed live while it works on a call from the orchestrator.
    ///
    /// This is free-form prose, because it is whatever the sub-agent chose to
    /// put in its WORKING status message. Agents that emit structured A2A data
    /// parts instead (`{type, tool_name, arguments, result}`) reach the UI
    /// directly through the stream's data-part channel and are rendered as
    /// real tool rows; this variant is the fallback for everything else.
    SubStatus { agent: String, message: String },

    /// A chunk of a sub-agent's reply text as it generates, relayed live.
    /// The full reply still arrives as `ToolResult` when the call finishes.
    SubContent { agent: String, content: String },

    /// A structured data part relayed as-is from a called agent that is
    /// itself an orchestrator (e.g. weave's `agent_invoke`/`agent_result`
    /// when it dispatches its own sub-agents). `data` is the nested agent's
    /// original payload, including its own `type` field; `via_agent` records
    /// which agent relayed it, for attribution only — every other field is
    /// exactly what the nested agent sent.
    SubData {
        via_agent: String,
        data: serde_json::Value,
    },

    /// A chunk of the final response text.
    Content { content: String },

    /// Orchestration completed.
    Done {
        turns: usize,
        context_compacted: bool,
    },

    /// A call was blocked before it reached the agent — either the confidence
    /// bar (Settings → Orchestrator) or the flow guard's cascade limits
    /// (cycle, depth, budget, timeout; Settings → Flow limits). `kind` says
    /// which, so a consumer doesn't have to pattern-match `reason`'s prose to
    /// tell them apart — the UI used to do exactly that, which meant a future
    /// wording change to either message could silently misclassify.
    PolicyRejected {
        agent: String,
        reason: String,
        turn: usize,
        kind: PolicyRejectionKind,
    },

    /// Token usage from an LLM call. Non-streaming turns report exact
    /// provider counts; streamed turns report a character-based estimate
    /// (`estimated: true`) because the rig 0.11 stream surfaces no usage
    /// chunk — consumers must label estimated figures as approximate.
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        model: String,
        estimated: bool,
    },

    /// An error occurred during orchestration.
    Error { message: String },

    /// A called agent needs a human before it can continue. Terminal for this turn — no further
    /// event follows for this conversation until a human answers and a new turn is triggered.
    AwaitingHuman {
        agent: String,
        agent_id: String,
        pause: PauseInfo,
    },
}

/// Which gate produced a [`OrchestratorEvent::PolicyRejected`] — see that
/// variant's doc for why this exists as a field rather than being left for a
/// consumer to infer from `reason`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyRejectionKind {
    /// The orchestrator's confidence bar.
    Confidence,
    /// The flow guard's cascade limits.
    FlowGuard,
}
