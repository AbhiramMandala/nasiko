-- Orchestrator delegation guardrails.
--
-- The orchestrator (both the chat-path ReAct loop in `oss/react-agent` and the
-- MAF-path selector in `oss/orchestrator`) previously had no way to refuse a
-- query: with no suitable agent it simply answered from the routing model's own
-- knowledge. These settings make delegation mandatory and give the refusal a
-- tunable bar.
--
-- `orchestrator_min_confidence` is the percentage (0-100) an agent match must
-- reach before the orchestrator is allowed to call it. NULL means "use the
-- built-in default" (DEFAULT_MIN_CONFIDENCE in oss/server/src/orchestrator_rules.rs),
-- matching how every other nullable column on this singleton row behaves.
ALTER TABLE settings ADD COLUMN orchestrator_min_confidence INT;

-- Master switch for the rules below. Off by default: an upgrade must not start
-- injecting instructions into the orchestrator's system prompt on its own.
ALTER TABLE settings ADD COLUMN orchestrator_rules_enabled BOOLEAN NOT NULL DEFAULT false;

-- Organization-wide orchestrator rules, injected verbatim into the system
-- prompt of both orchestrators when `settings.orchestrator_rules_enabled` is
-- true. Deliberately NOT per-user and NOT per-agent: these are the operator's
-- house rules for how delegation happens at all.
--
-- There is no per-row enabled flag by design — one toggle governs the whole
-- set. To stop a single rule from being sent, delete it.
CREATE TABLE orchestrator_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    -- Render order in the prompt; ties broken by created_at so the list is
    -- always deterministic (an LLM prompt that reshuffles between requests
    -- defeats provider-side prefix caching for no benefit).
    position    INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orchestrator_rules_order ON orchestrator_rules (position, created_at);
