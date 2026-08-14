-- provider_models — the live model catalog per provider, synced from each provider's
-- GET /models endpoint by the LLM router's catalog-sync loop (see
-- oss/llm-router/src/routing/catalog.rs). This replaces hardcoded model lists: the
-- smart router derives tier→model mappings from what the configured endpoint actually
-- serves (ranked by price as the strength signal), so a custom OpenAI-compatible
-- upstream (DeepSeek, vLLM, Ollama, …) is routed among *its own* models automatically.
--
-- Rows are catalog-owned: the sync upserts what the provider lists and deletes rows
-- the provider no longer lists. Operator tier overrides belong in model_registry
-- (PUT /api/model-registry), which always wins over the derived mapping.
CREATE TABLE provider_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, model)
);
CREATE INDEX idx_provider_models_provider ON provider_models(provider);

-- Pricing for the second DeepSeek V4 model (v4-flash was seeded in 0006).
-- Best-effort list rate — VERIFY against current provider pricing.
INSERT INTO model_pricing
    (provider, model, input_price_per_1m, output_price_per_1m, cache_creation_price_per_1m, cache_read_price_per_1m, notes)
VALUES
    ('deepseek', 'deepseek-v4-pro', 0.55, 2.19, NULL, NULL, 'DeepSeek V4 Pro (best-effort; verify)')
ON CONFLICT DO NOTHING;

-- calculate_token_cost: fall back to a model-only pricing match when the exact
-- (provider, model) pair has no row. The router labels every OpenAI-compatible
-- upstream 'openai' regardless of who actually serves the model (e.g. DeepSeek behind
-- OPENAI_API_BASE), while pricing is seeded under the upstream's own provider name —
-- without this fallback, gateway-metered usage on such deployments never gets a cost.
CREATE OR REPLACE FUNCTION calculate_token_cost(
    p_provider TEXT, p_model TEXT,
    p_input_tokens INTEGER, p_output_tokens INTEGER,
    p_cache_creation_tokens INTEGER, p_cache_read_tokens INTEGER,
    p_timestamp TIMESTAMPTZ
) RETURNS DECIMAL(10, 8) AS $$
DECLARE v_pricing RECORD; v_cost DECIMAL(10, 8);
BEGIN
    SELECT * INTO v_pricing FROM model_pricing
    WHERE provider = p_provider AND model = p_model
      AND effective_from <= p_timestamp
      AND (effective_until IS NULL OR effective_until > p_timestamp)
    ORDER BY effective_from DESC LIMIT 1;
    IF NOT FOUND THEN
        -- Model-only fallback: provider labels are routing-surface labels, not
        -- upstream identities; model names are near-unique across providers.
        SELECT * INTO v_pricing FROM model_pricing
        WHERE model = p_model
          AND effective_from <= p_timestamp
          AND (effective_until IS NULL OR effective_until > p_timestamp)
        ORDER BY effective_from DESC LIMIT 1;
    END IF;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_cost := (p_input_tokens::DECIMAL / 1000000.0) * v_pricing.input_price_per_1m
            + (p_output_tokens::DECIMAL / 1000000.0) * v_pricing.output_price_per_1m;
    IF v_pricing.cache_creation_price_per_1m IS NOT NULL THEN
        v_cost := v_cost
            + (COALESCE(p_cache_creation_tokens, 0)::DECIMAL / 1000000.0) * v_pricing.cache_creation_price_per_1m
            + (COALESCE(p_cache_read_tokens, 0)::DECIMAL / 1000000.0) * v_pricing.cache_read_price_per_1m;
    END IF;
    RETURN v_cost;
END;
$$ LANGUAGE plpgsql STABLE;

-- Backfill rows that were left uncosted because of the provider-label mismatch above.
UPDATE token_usage
SET cost_usd = calculate_token_cost(provider, model, input_tokens, output_tokens,
                                    cache_creation_input_tokens, cache_read_input_tokens, created_at)
WHERE cost_usd IS NULL;
