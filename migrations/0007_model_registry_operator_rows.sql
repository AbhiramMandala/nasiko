-- model_registry: keep only operator-set rows; drop the mirrored built-in seeds.
--
-- 0005 seeded model_registry with the same first-party tier→model pairs that
-- StaticTierRegistry carries (gpt-*, claude-*). Those rows are actively wrong for
-- deployments whose provider endpoint is a custom OpenAI-compatible host (e.g.
-- OPENAI_API_BASE=https://api.deepseek.com/v1): the smart router would override the
-- request's model with names the upstream rejects (400 "unsupported model").
--
-- From here on the built-in defaults live solely in StaticTierRegistry, which
-- PgTierRegistry serves only while the provider's base URL is the canonical
-- first-party endpoint; model_registry carries operator intent only (written via
-- PUT /api/model-registry).
--
-- The DELETE matches the built-in seed triples exactly, so rows an operator has
-- already repurposed (any provider/tier whose model differs from the seed, and all
-- rows for other providers) are preserved.
DELETE FROM model_registry
WHERE (provider, tier, model) IN (
    ('anthropic', 1, 'claude-opus-4-8'),
    ('anthropic', 2, 'claude-sonnet-4-6'),
    ('anthropic', 3, 'claude-haiku-4-5'),
    ('openai', 1, 'gpt-5.5'),
    ('openai', 2, 'gpt-5.4'),
    ('openai', 3, 'gpt-4o-mini')
);
