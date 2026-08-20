-- Pricing for the Claude 5 model family.
--
-- Without these rows, `claude-opus-5` and `claude-sonnet-5` match no entry in
-- the static fallback table (oss/observability/src/pricing.rs) except the
-- catch-all ('claude', 3.00/15.00) — so Opus traffic was costed at Sonnet
-- rates. Local coding-agent sessions reported by `nasiko integration install`
-- run on these models, which is what surfaced the gap.
--
-- Prices are carried forward from the equivalent Claude 4 tier and are
-- UNVERIFIED against Anthropic's current list rates. Confirm them before
-- relying on the cost figures in FinOps.

INSERT INTO model_pricing
    (provider, model, input_price_per_1m, output_price_per_1m, cache_creation_price_per_1m, cache_read_price_per_1m, notes)
VALUES
    ('anthropic', 'claude-opus-5',   15.00, 75.00, 18.75, 1.50, 'Claude Opus 5 — rate carried forward from Opus 4, verify'),
    ('anthropic', 'claude-sonnet-5',  3.00, 15.00,  3.75, 0.30, 'Claude Sonnet 5 — rate carried forward from Sonnet 4, verify')
ON CONFLICT DO NOTHING;
