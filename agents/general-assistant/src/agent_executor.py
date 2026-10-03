"""Generic HITL-capable Nasiko assistant.

Unlike oss/agents/github-hitl-agent (deterministic, no LLM — a fixture proving
the platform's HITL wiring against known-good inputs), this agent exercises
the SAME A2A InputRequired/AuthRequired contract on a real, general-purpose
LLM+MCP agent: any task, not a hand-coded one.

Two ways it reaches TASK_STATE_INPUT_REQUIRED / TASK_STATE_AUTH_REQUIRED:

1. Generic task loop (`run_conversation`): the LLM is given two synthetic
   tools — `ask_human` and `finish_task` — alongside whatever real MCP tools
   the gateway exposes, and `tool_choice="required"` so a bare, tool-free text
   reply is never a valid response at all: every turn must explicitly call
   *something*. This removes a real failure mode found in practice — with
   `tool_choice="auto"`, models frequently phrase a clarifying question as
   ordinary chat text instead of calling `ask_human`, which this agent can't
   tell apart from a normal finished answer (and heuristics that try, e.g.
   "ends in a question mark", false-positive on ordinary conversational
   replies like "Hello! How can I help you today?"). Forcing every turn
   through `ask_human` / `finish_task` / a real tool makes "paused" vs "done"
   a hard, structural distinction instead of a text-classification problem.
   If the model decides it's missing information required to complete the
   user's request, it calls `ask_human(question=...)` instead of guessing ->
   INPUT_REQUIRED. If a real MCP tool call comes back TOOL_ASK (the gateway's
   "ask" permission stance — reachable but not yet approved), that's mapped to
   AUTH_REQUIRED: a deliberate design choice (the same ambiguity
   docs/HITL_ARCHITECTURE_INVESTIGATION.md §8 flags as unresolved for NAS-164,
   and the reading oss/agents/github-hitl-agent also takes) — "the human needs
   to grant access" is the closest fit to AuthRequired's meaning here, and on
   resume this agent retries the identical tool call rather than asking the
   LLM to reinterpret anything.
2. Four fixed, dependency-free triggers ("hitl input test" / "hitl auth test" /
   "hitl options test" / "hitl multiselect test") so the platform's HITL
   wiring — including the selectable-options extension — can be smoke-tested
   without OPENAI_API_KEY or a live MCP gateway.

Selectable options (single-select and multi-select, optionally with free-text
custom input) are an additive extension of `ask_human`/InputRequired, not a
new pause kind: `ask_human` gained optional `options`/`header`/`multi_select`/
`allow_custom_input` parameters the LLM can supply whenever the valid answers
form a fixed set, threaded straight into `TaskUpdater.update_status(...,
metadata=...)` exactly like a plain `question` already is. The platform
(`oss/types/src/a2a.rs::hoist_structured_options`) validates and hoists these
onto `hitl_requests.question`; nothing here duplicates that validation — a
malformed value is simply not offered to the human, same as if `ask_human`
had never been called with options at all. On resume the human's answer
still arrives as a single plain-text tool result (flattened by the platform's
`answer_text()` — labels newline-joined for multi-select, never comma-joined)
exactly like any other `ask_human` reply, so no LLM-side parsing changed.

No local demo tools compete with the MCP gateway's own tools for the LLM's
attention — `ask_human`/`finish_task` are the only non-MCP tools offered, so
any real-world task (including GitHub ones) is expected to route through a
real MCP tool call, not a hand-coded local stand-in.

Resuming a paused task carries the in-progress LLM conversation forward via
Task.metadata (merged by the SDK per TaskManager.save_task_event — the same
primitive github-hitl-agent uses for its own resume) rather than any new
protocol.
"""

import json
import os
from contextvars import ContextVar

import httpx
from a2a.helpers import new_task_from_user_message, new_text_part
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import TaskState
from google.protobuf.json_format import MessageToDict
from openai import AsyncOpenAI

from mcp_client import McpError, call_tool, list_tools
from telemetry import request_otel_context

# Set per-request by `InboundContextASGIMiddleware` (main.py) from an inbound
# `x-nasiko-agent-token` header, read by `_extract_token` below. The platform
# stopped sending that header once per-request delegation tokens were replaced
# by the static per-agent `MCP_GATEWAY_TOKEN` (docs/MCP_GATEWAY_AGENT_AUTH.md),
# so in current deployments this stays unset and `_extract_token` falls through
# to `self.mcp_gateway_token` — kept only for a caller that still sets one of
# the fallbacks (`metadata.agent_token`, this header) explicitly.
agent_token_ctx: ContextVar[str | None] = ContextVar("agent_token_ctx", default=None)


MAX_TOOL_ITERATIONS = 6
ASK_HUMAN_TOOL = "ask_human"
FINISH_TASK_TOOL = "finish_task"

FIXED_INPUT_QUESTION = (
    "This is a deterministic HITL smoke-test trigger with no real task behind it — "
    "reply anything on this same task to prove the InputRequired -> resume path works."
)
FIXED_AUTH_MESSAGE = (
    "This demo action requires GitHub authorization. Open the link to authorize, then "
    "confirm on this same task once you've granted access."
)
# Carried in Task.metadata (`update_status(..., metadata=...)`) so the platform's
# `build_pause_question` (oss/server/src/router/a2a_dispatch.rs) hoists `provider`/`auth_url`
# onto `hitl_requests.question` itself (§4 of docs/HITL_IMPLEMENTATION_PLAN.md) — this is what
# lets a HITL client render a real "Authorize with GitHub" link instead of just a text message.
# The URL itself is a fixture, not a live OAuth App — this trigger never calls GitHub.
FIXED_AUTH_METADATA = {
    "pending": "fixture",
    "provider": "github",
    "auth_url": "https://github.com/login/oauth/authorize?client_id=demo&scope=repo",
}

# Selectable-options fixtures ("hitl options test" / "hitl multiselect test") — same
# `pending: "fixture"` marker as FIXED_AUTH_METADATA/the plain input fixture above, so the
# existing `metadata.get("pending") == "fixture"` continuation branch in `_decide` already
# handles the resume echo with no changes needed there: whatever plain text the platform's
# `answer_text()` flattened the human's structured answer into is echoed back verbatim, which
# is exactly what you want to see when smoke-testing this end to end.
FIXED_OPTIONS_QUESTION = "How should I format the output?"
FIXED_OPTIONS_METADATA = {
    "pending": "fixture",
    "header": "Format",
    "options": [
        {"label": "Summary", "description": "Brief overview of key points"},
        {"label": "Detailed", "description": "Full explanation with examples"},
        {"label": "Technical", "description": "Implementation-level detail"},
    ],
    "multi_select": False,
    "allow_custom_input": True,
}
FIXED_MULTISELECT_QUESTION = "Which sections should I include?"
FIXED_MULTISELECT_METADATA = {
    "pending": "fixture",
    "header": "Sections",
    "options": [
        {"label": "Introduction"},
        {"label": "Architecture"},
        {"label": "Security"},
        {"label": "Conclusion"},
    ],
    "multi_select": True,
    "allow_custom_input": True,
}

SYSTEM_PROMPT = (
    "You are Nasiko's general-purpose assistant agent. You can be asked to do any kind of task "
    "(book something, schedule something, look something up, manage an account, etc.) using "
    "whatever tools are available to you.\n\n"
    "You must ALWAYS respond by calling exactly one of the available tools — plain text replies "
    "are not possible. There is no other way to talk to the user:\n"
    "- To ask the user something, call `ask_human`.\n"
    "- To give the user your final answer/result and end the turn, call `finish_task`.\n"
    "- Otherwise, call whichever real tool moves the task forward.\n\n"
    "Rules:\n"
    "1. NEVER invent, assume, or default a value that identifies a specific real-world thing the "
    "user should control — a name (repo name, event title, recipient, contact), a date/time, an "
    "amount, a location, a message body, or anything similar. This is true even when a plausible-"
    "looking default exists (e.g. you could technically make up a repo name) — if the user didn't "
    "give it and it isn't something generic/structural you're free to choose (like an internal ID), "
    "you must still ask. It is always better to ask an unnecessary question than to take an action "
    "using a guessed value.\n"
    "2. Whenever a tool call needs such a value and the user hasn't given it, call `ask_human` with "
    "one clear, specific question instead of calling that tool with a guess. Ask for everything "
    "you're missing in one question if possible, rather than one question at a time. If the valid "
    "answers form a fixed, enumerable set, pass `options` (and `multi_select`/`allow_custom_input` "
    "as appropriate) so the user gets clickable choices instead of a free-text box.\n"
    "3. Once the human answers (their answer arrives as the result of your ask_human call), "
    "continue the task using that answer — do not ask the same question again.\n"
    "4. Use the other tools available to you to actually carry out the task once you have enough "
    "information.\n"
    "5. When you're done (including for a simple reply that needs no tool, like a greeting), call "
    "`finish_task` with a message that clearly tells the user what you did — or, if you couldn't "
    "complete it, why."
)

ASK_HUMAN_TOOL_DEF = {
    "type": "function",
    "function": {
        "name": ASK_HUMAN_TOOL,
        "description": (
            "Ask the human user a clarifying question whenever a value you need identifies a "
            "specific real-world thing (a name, date/time, amount, recipient, location, message "
            "body, etc.) that the user hasn't given you. Always use this instead of guessing, "
            "defaulting, or making up such a value — even one that looks like a reasonable "
            "placeholder.\n\n"
            "Whenever the valid answers form a fixed, enumerable set (e.g. 'which format', 'which "
            "environment', 'which of these repos'), pass `options` so the platform shows the user "
            "clickable choices instead of a free-text box — prefer this over a bare free-text "
            "question whenever it applies. You will receive back exactly the `label` string of "
            "whichever option the user picked (or their typed text, if they used the custom-input "
            "option), so match on that value going forward, not on a rephrased version of it."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The exact question to show the user."},
                "header": {
                    "type": "string",
                    "description": "Optional short title shown above the options (e.g. 'Format'). Omit for a plain question.",
                },
                "options": {
                    "type": "array",
                    "description": (
                        "Optional list of selectable choices. Omit entirely for a plain free-text "
                        "question — only include this when the valid answers are a fixed, known set."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {
                                "type": "string",
                                "description": "The exact text of this choice — this is what you'll receive back verbatim if the user picks it. Must be unique among the options in this call.",
                            },
                            "description": {
                                "type": "string",
                                "description": "Optional short context shown under the label — never part of the answer you get back.",
                            },
                        },
                        "required": ["label"],
                    },
                },
                "multi_select": {
                    "type": "boolean",
                    "description": "true if the user may pick more than one option at once. Defaults to false (single choice). Ignored if `options` is omitted.",
                },
                "allow_custom_input": {
                    "type": "boolean",
                    "description": "true to also let the user type a free-text answer instead of (or, for multi_select, alongside) picking option(s). Defaults to false. Ignored if `options` is omitted.",
                },
            },
            "required": ["question"],
        },
    },
}

FINISH_TASK_TOOL_DEF = {
    "type": "function",
    "function": {
        "name": FINISH_TASK_TOOL,
        "description": (
            "Give the user your final message and end this turn — use this for any reply that "
            "doesn't need ask_human or a real tool, including a simple greeting or an answer you "
            "already have enough information to give."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "The final message to show the user."},
            },
            "required": ["message"],
        },
    },
}

# Both direct-chat paths that carry session history (`oss/server/src/agent_proxy.rs:568`,
# `oss/server/src/router/a2a_dispatch.rs:190`) send the message text as
# "{role}: {content}\n...\n\nCurrent message: {actual text}" once a session has prior
# turns (`oss/orchestrator/src/session_history.rs::with_current_query`) — the raw text
# only arrives unwrapped on a session's first turn. Without stripping this, a fixed
# trigger like "hitl input test" (or the LLM's own tool-calling behavior) could
# misfire on text echoed back from the agent's own prior reply.
_CURRENT_MESSAGE_MARKER = "\n\nCurrent message: "

_PAUSED_STATES = (TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED)


def extract_current_message(text: str) -> str:
    idx = text.rfind(_CURRENT_MESSAGE_MARKER)
    if idx == -1:
        return text
    return text[idx + len(_CURRENT_MESSAGE_MARKER) :]


def _tool_def_from_mcp(tool: dict) -> dict | None:
    name = tool.get("name", "")
    if not name:
        return None
    schema = tool.get("inputSchema") or {"type": "object", "properties": {}}
    schema.setdefault("type", "object")
    schema.setdefault("properties", {})
    return {
        "type": "function",
        "function": {"name": name, "description": tool.get("description", ""), "parameters": schema},
    }


async def run_conversation(
    agent: "AssistanceAgentExecutor", token: str | None, traceparent: str | None, messages: list[dict]
) -> dict:
    """Runs the LLM tool-calling loop starting from `messages` (which may
    already contain a completed ask_human/tool exchange from a resume). Always
    returns one of: {"kind": "complete", "text", "messages"},
    {"kind": "input_required", "question", "messages", "pending_tool_call_id"} or
    {"kind": "auth_required", "message", "messages", "pending_tool_call"} (MCP ask-stance retry).

    tool_choice="required" means `choice.tool_calls` is always populated —
    there is no bare-text branch to handle here.
    """
    tool_defs, mcp_tool_names = await agent.available_tools(token, traceparent)

    for _ in range(MAX_TOOL_ITERATIONS):
        choice = await agent.call_llm(messages, tool_defs)
        messages.append(choice.model_dump(exclude_none=True))

        paused_outcome = None
        finished_text = None
        for call in choice.tool_calls:
            if paused_outcome is not None:
                # A prior tool_call in this same batch already paused the task —
                # every tool_call in an assistant turn needs a response before the
                # next LLM call, so the rest get a placeholder, not a real answer.
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps({"status": "skipped", "reason": "task paused earlier in this turn"}),
                })
                continue

            args = json.loads(call.function.arguments or "{}")

            if call.function.name == ASK_HUMAN_TOOL:
                question = args.get("question") or "Could you provide more details?"
                options = args.get("options") or None
                print(
                    f"[demo] ask_human: {question}"
                    + (f" (options={[o.get('label') for o in options]})" if options else ""),
                    flush=True,
                )
                paused_outcome = {
                    "kind": "input_required",
                    "question": question,
                    "pending_tool_call_id": call.id,
                    # Selectable-options extension (additive) — all `None` for a plain question;
                    # `_to_outcome` only attaches these to `metadata` when `options` is truthy, so
                    # an LLM that never uses this stays byte-identical to before this was added.
                    "header": args.get("header"),
                    "options": options,
                    "multi_select": args.get("multi_select"),
                    "allow_custom_input": args.get("allow_custom_input"),
                }
                continue

            if call.function.name == FINISH_TASK_TOOL:
                finished_text = args.get("message") or "Done."
                print(f"[demo] finish_task: {finished_text}", flush=True)
                messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps({"status": "completed"})})
                continue

            if call.function.name in mcp_tool_names:
                outcome = await agent.call_mcp_tool(token, traceparent, call.function.name, args)
                if outcome["kind"] == "ask_required":
                    paused_outcome = {
                        "kind": "auth_required",
                        "message": outcome["message"],
                        "pending_tool_call": {"id": call.id, "name": call.function.name, "arguments": args},
                        "auth_kind": "mcp_tool_approval",
                        "hitl_request_id": outcome.get("hitl_request_id"),
                    }
                    continue
                if outcome["kind"] == "auth_required":
                    # The connector's own credential is broken — genuinely
                    # distinct from `ask_required` (a permission gate on an
                    # otherwise-healthy connector). Same pause mechanics
                    # (retry the identical call once resumed), but a message
                    # that actually tells the user what's wrong instead of a
                    # generic tool failure — codes::AUTH_REQUIRED exists
                    # precisely so an agent can make this distinction.
                    print(
                        f"[demo] mcp tool '{call.function.name}' needs re-authentication "
                        f"(hitl_request_id={outcome.get('hitl_request_id')})",
                        flush=True,
                    )
                    paused_outcome = {
                        "kind": "auth_required",
                        "message": outcome["message"],
                        "pending_tool_call": {"id": call.id, "name": call.function.name, "arguments": args},
                        "auth_kind": "mcp_connector",
                        "hitl_request_id": outcome.get("hitl_request_id"),
                    }
                    continue
                messages.append({"role": "tool", "tool_call_id": call.id, "content": outcome["content"]})
            else:
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps({"error": f"unknown tool {call.function.name}"}),
                })

        if paused_outcome is not None:
            # A pause always wins over a finish signal in the same batch — the
            # model shouldn't call both, but if it does, waiting on the human
            # is the safer outcome to act on.
            paused_outcome["messages"] = messages
            return paused_outcome

        if finished_text is not None:
            return {"kind": "complete", "text": finished_text, "messages": messages}

    return {
        "kind": "complete",
        "text": "Reached the max number of tool-call steps without finishing — try rephrasing your request.",
        "messages": messages,
    }


class AssistanceAgentExecutor(AgentExecutor):
    def __init__(self):
        # AsyncOpenAI raises eagerly at construction if no key is resolvable from
        # anywhere (env, workload identity, ...) — falling back to a placeholder
        # keeps this agent startable with no OPENAI_API_KEY set at all, which is
        # required for the two fixed "hitl ... test" triggers below to work
        # standalone (they never call the LLM).
        self.llm = AsyncOpenAI(
            api_key=os.environ.get("OPENAI_API_KEY") or "unset",
            base_url=os.environ.get("OPENAI_BASE_URL") or None,
        )
        self.model = os.environ.get("MODEL", os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))
        self.mcp_gateway_url = os.environ.get("MCP_GATEWAY_URL") or None
        self.mcp_gateway_token = os.environ.get("MCP_GATEWAY_TOKEN") or None
        self.http = httpx.AsyncClient(timeout=30.0)

    def _extract_token(self, context: RequestContext) -> str | None:
        """The agent's own deploy-time `MCP_GATEWAY_TOKEN` (docs/MCP_GATEWAY_AGENT_AUTH.md) —
        static per-agent credential, minted once at deploy and injected into the container
        env, not a per-request value. The platform no longer sends a per-request delegation
        token on A2A dispatch (that scheme was replaced by this static credential plus the
        gateway's flow_participants check), so `agent_token_ctx`/`metadata.agent_token`/the
        inbound `x-nasiko-agent-token` header below are dead paths kept only for a caller
        that still sets one of them explicitly (e.g. a test harness) — every real dispatch
        falls through to `self.mcp_gateway_token`."""
        ctx_token = agent_token_ctx.get()
        if ctx_token:
            return ctx_token
        metadata_token = (context.metadata or {}).get("agent_token")
        if metadata_token:
            return metadata_token
        call_context = getattr(context, "call_context", None)
        state = getattr(call_context, "state", None) if call_context is not None else None
        if isinstance(state, dict):
            headers = state.get("headers")
            if isinstance(headers, dict) and headers.get("x-nasiko-agent-token"):
                return headers["x-nasiko-agent-token"]
        return self.mcp_gateway_token

    @staticmethod
    def _extract_traceparent(context: RequestContext) -> str | None:
        """The CURRENT request's `traceparent`, read off `context.call_context.state`
        (the a2a-sdk's per-invocation dict of the real inbound headers).

        Deliberately not a ContextVar: the SDK resumes a paused task through a
        persistent per-task worker coroutine created at the ORIGINAL dispatch, so
        a ContextVar set by the ASGI layer handling the *resume* request never
        reaches it — every retried tool call would carry the first dispatch's
        stale trace id and be rejected as not resolving to a live flow. `context`
        is passed as a plain argument to `execute()` on every invocation, so it
        always reflects the request actually being served.
        """
        call_context = getattr(context, "call_context", None)
        state = getattr(call_context, "state", None) if call_context is not None else None
        if isinstance(state, dict):
            headers = state.get("headers")
            if isinstance(headers, dict) and headers.get("traceparent"):
                return headers["traceparent"]

        # Fallback: rebuild from the inbound OTel context TraceparentMiddleware captured.
        from opentelemetry import trace
        ctx = request_otel_context.get()
        if ctx is not None:
            span_context = trace.get_current_span(ctx).get_span_context()
            if span_context.is_valid:
                return (
                    f"00-{trace.format_trace_id(span_context.trace_id)}"
                    f"-{trace.format_span_id(span_context.span_id)}"
                    f"-{span_context.trace_flags:02x}"
                )
        return None

    async def available_tools(self, token: str | None, traceparent: str | None) -> tuple[list[dict], set[str]]:
        tools = [ASK_HUMAN_TOOL_DEF, FINISH_TASK_TOOL_DEF]
        names: set[str] = set()
        if self.mcp_gateway_url and token:
            try:
                mcp_tools = await list_tools(self.http, self.mcp_gateway_url, token, traceparent)
            except McpError:
                mcp_tools = []
            for tool in mcp_tools:
                tool_def = _tool_def_from_mcp(tool)
                if tool_def is None:
                    continue
                tools.append(tool_def)
                names.add(tool_def["function"]["name"])
        return tools, names

    async def call_llm(self, messages: list[dict], tools: list[dict]):
        # tool_choice="required" is the actual fix for models that phrase a
        # clarifying question as chat text instead of calling ask_human — it
        # makes a tool call the only valid kind of response, every turn.
        resp = await self.llm.chat.completions.create(
            model=self.model, messages=messages, tools=tools, tool_choice="required",
        )
        return resp.choices[0].message

    @staticmethod
    def _hitl_request_id(data: dict) -> str | None:
        """`COMPOSIO_MULTI_EXECUTE_TOOL` (what a Composio-backed connector's tools always go
        through — this agent never calls a bare `GITHUB_*`-named tool directly, only the
        meta-tools `tools/list` actually exposes) returns `data.hitl_request_ids` (plural —
        one row per slug in the batch, oss/mcp-gateway/src/protocol.rs's M8 batch path); a
        single-tool call or the connector-level AuthRequired path returns
        `data.hitl_request_id` (singular) instead. Reading only the singular key here (the
        original bug) silently returned None for every real Composio tool call, which is
        why the platform's dual-origin mirror fix never had anything to link against."""
        ids = data.get("hitl_request_ids")
        if isinstance(ids, list) and ids:
            return ids[0]
        return data.get("hitl_request_id")

    async def call_mcp_tool(self, token: str | None, traceparent: str | None, name: str, arguments: dict) -> dict:
        if not self.mcp_gateway_url:
            return {"kind": "ok", "content": json.dumps({"error": "MCP_GATEWAY_URL is not configured for this agent"})}
        try:
            result = await call_tool(self.http, self.mcp_gateway_url, token or "", name, arguments, traceparent)
            return {"kind": "ok", "content": json.dumps(result)}
        except McpError as e:
            if e.kind == "ask_required":
                return {"kind": "ask_required", "message": e.message, "hitl_request_id": self._hitl_request_id(e.data)}
            if e.kind == "auth_required":
                return {"kind": "auth_required", "message": e.message, "hitl_request_id": self._hitl_request_id(e.data)}
            return {"kind": "ok", "content": json.dumps({"error": f"{e.kind}: {e.message}"})}

    def _to_outcome(self, result: dict) -> dict:
        if result["kind"] == "complete":
            return {"kind": "complete", "text": result["text"]}
        if result["kind"] == "input_required":
            metadata = {
                "messages": result["messages"],
                "pending_tool_call_id": result["pending_tool_call_id"],
            }
            # Selectable-options extension (additive to input_required) — only attached when the
            # LLM actually supplied `options` via ask_human. The platform
            # (`hoist_structured_options`, oss/types/src/a2a.rs) validates this independently and
            # drops anything malformed back to a plain question, so nothing is re-validated here —
            # this agent just passes through whatever the LLM decided.
            if result.get("options"):
                metadata["options"] = result["options"]
                if result.get("header"):
                    metadata["header"] = result["header"]
                if result.get("multi_select") is not None:
                    metadata["multi_select"] = result["multi_select"]
                if result.get("allow_custom_input") is not None:
                    metadata["allow_custom_input"] = result["allow_custom_input"]
            return {
                "kind": "input_required",
                "question": result["question"],
                "metadata": metadata,
            }
        # MCP ask-stance retry (`auth_kind: mcp_tool_approval`) or a broken connector
        # credential (`auth_kind: mcp_connector`) — same retry shape either way,
        # `run_conversation` already tagged which one this is. `hitl_request_id` is the
        # real MCP-origin `hitl_requests.id` this A2A pause mirrors — the platform's own
        # discovery surfaces (`resolve_display_row`) read it back out of this same
        # metadata to show the real row instead of this mirror's generic message; without
        # it, a human approving this pause never actually touches the real MCP permission.
        metadata = {
            "messages": result["messages"],
            "pending_tool_call": result["pending_tool_call"],
            "auth_kind": result.get("auth_kind", "mcp_tool_approval"),
            "hitl_request_id": result.get("hitl_request_id"),
        }
        return {"kind": "auth_required", "message": result["message"], "metadata": metadata}

    async def _decide(
        self, token: str | None, traceparent: str | None, user_text: str, stored_task, stored_state
    ) -> dict:
        if stored_state not in _PAUSED_STATES:
            trimmed = user_text.strip().lower()
            if trimmed == "hitl input test":
                return {"kind": "input_required", "question": FIXED_INPUT_QUESTION, "metadata": {"pending": "fixture"}}
            if trimmed == "hitl auth test":
                return {"kind": "auth_required", "message": FIXED_AUTH_MESSAGE, "metadata": FIXED_AUTH_METADATA}
            if trimmed == "hitl options test":
                return {
                    "kind": "input_required",
                    "question": FIXED_OPTIONS_QUESTION,
                    "metadata": FIXED_OPTIONS_METADATA,
                }
            if trimmed == "hitl multiselect test":
                return {
                    "kind": "input_required",
                    "question": FIXED_MULTISELECT_QUESTION,
                    "metadata": FIXED_MULTISELECT_METADATA,
                }

            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_text},
            ]
            result = await run_conversation(self, token, traceparent, messages)
            return self._to_outcome(result)

        # stored_task.metadata round-trips through the SDK's protobuf Struct/ListValue
        # wire representation, not plain Python dicts/lists — MessageToDict recursively
        # converts it back before it's reused as OpenAI chat history below.
        metadata = MessageToDict(stored_task.metadata) if stored_task.metadata else {}
        if metadata.get("pending") == "fixture":
            return {
                "kind": "complete",
                "text": f'Received your input: "{user_text.strip()}". (Fixture trigger — no follow-on task.)',
            }

        messages = metadata.get("messages") or []

        if stored_state == TaskState.TASK_STATE_INPUT_REQUIRED:
            tool_call_id = metadata.get("pending_tool_call_id")
            messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": user_text.strip()})
        else:  # AUTH_REQUIRED via MCP ask-stance — retry the exact tool call the human just authorized
            pending_call = metadata.get("pending_tool_call") or {}
            mcp_outcome = await self.call_mcp_tool(
                token, traceparent, pending_call.get("name"), pending_call.get("arguments") or {}
            )
            if mcp_outcome["kind"] == "ask_required":
                return {
                    "kind": "auth_required",
                    "message": mcp_outcome["message"],
                    "metadata": {
                        "messages": messages,
                        "pending_tool_call": pending_call,
                        "auth_kind": "mcp_tool_approval",
                        "hitl_request_id": mcp_outcome.get("hitl_request_id"),
                    },
                }
            messages.append({"role": "tool", "tool_call_id": pending_call.get("id"), "content": mcp_outcome["content"]})

        result = await run_conversation(self, token, traceparent, messages)
        return self._to_outcome(result)

    async def _apply_outcome(self, updater: TaskUpdater, outcome: dict) -> None:
        kind = outcome["kind"]
        if kind == "complete":
            await updater.add_artifact([new_text_part(outcome["text"])])
            await updater.complete()
        elif kind == "input_required":
            await updater.update_status(
                TaskState.TASK_STATE_INPUT_REQUIRED,
                message=updater.new_agent_message([new_text_part(outcome["question"])]),
                metadata=outcome.get("metadata") or None,
            )
        elif kind == "auth_required":
            await updater.update_status(
                TaskState.TASK_STATE_AUTH_REQUIRED,
                message=updater.new_agent_message([new_text_part(outcome["message"])]),
                metadata=outcome.get("metadata") or None,
            )

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        user_text = extract_current_message(context.get_user_input())
        stored_task = context.current_task

        task = stored_task or new_task_from_user_message(context.message)
        if stored_task is None:
            await event_queue.enqueue_event(task)

        updater = TaskUpdater(event_queue, task.id, task.context_id)
        await updater.start_work()

        token = self._extract_token(context)
        traceparent = self._extract_traceparent(context)
        stored_state = stored_task.status.state if stored_task is not None else None

        try:
            outcome = await self._decide(token, traceparent, user_text, stored_task, stored_state)
        except Exception as e:
            await updater.failed(updater.new_agent_message([new_text_part(f"Error: {e}")]))
            return

        await self._apply_outcome(updater, outcome)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        task = context.current_task
        if task is not None:
            updater = TaskUpdater(event_queue, task.id, task.context_id)
            await updater.cancel()
