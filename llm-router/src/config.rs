//! Gateway-only configuration.
//!
//! Owned by this crate (not `nasiko-config`) so the LLM router stays decoupled and
//! can be promoted to a standalone binary later without dragging in the platform's
//! full `Config`. Env-var *names* match the platform for deployment consistency.

/// Configuration for the LLM router, read from the environment.
///
/// See `RUST_PLAN_V1.md` §5. All fields have sane defaults so `from_env` never fails;
/// fail-closed behaviour (e.g. an empty `agent_jwt_secret`) is enforced at use sites.
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    /// Shared HS256 secret the orchestrator mints agent-identity JWTs with. Empty ⇒
    /// every request is rejected 401 (fail closed) — never fail open.
    pub agent_jwt_secret: String,
    /// JWT signing algorithm. Default `HS256`.
    pub agent_jwt_algorithm: String,

    /// Backward-compat provider when an agent has no `llm_config`. Default `openai`.
    pub default_provider: String,
    /// Backward-compat model when an agent has no `llm_config`. Default `gpt-4o-mini`.
    pub default_model: String,
    /// Platform-owned OpenAI key, used for the `openai` provider (and as the
    /// backward-compat fallback for unknown providers) when an agent sets no
    /// `api_key_secret_name`. Select via [`GatewayConfig::platform_key_for`].
    pub platform_openai_api_key: String,
    /// Platform-owned Anthropic key, used for the `anthropic` provider.
    pub platform_anthropic_api_key: String,
    /// Platform-owned Gemini key, used for the `gemini` provider.
    pub platform_gemini_api_key: String,

    /// TTL (seconds) for the in-process per-agent `llm_config` cache. Default 30.
    pub llm_config_cache_ttl_secs: u64,

    /// Redis URL for the model-routing decision cache (S3). Empty ⇒ the router uses a
    /// no-op cache (every request re-derives its model). The cache is a latency
    /// optimisation only — an unset/unreachable Redis never breaks routing.
    pub redis_url: String,
    /// TTL (seconds) for a cached `(conv_id, agent_id)` routing decision — the stickiness
    /// window for a conversation. Default 3600 (1h). On expiry, a continuation turn falls
    /// through to the configured model (Level 4), same as a cache miss.
    pub router_decision_ttl_secs: u64,

    /// Max age of a `status='running'` flow for traceparent attribution — bounds
    /// orphaned flows (a direct-chat flow whose completion marking never ran stays
    /// 'running' but ages out of attribution, so its trace id stops authorizing
    /// LLM calls). Default 300 (5 min).
    pub attribution_window_secs: u64,

    /// Interval between provider model-catalog syncs (`GET /models` →
    /// `provider_models`). Default 600 (10 min).
    pub model_catalog_sync_interval_secs: u64,

    /// Interval between Portkey price-book syncs (`model_pricing`). Prices move
    /// slowly — default 86400 (24 h).
    pub pricing_sync_interval_secs: u64,

    /// Provider base URLs (overridable for tests / self-hosted gateways).
    pub openai_api_base: String,
    pub anthropic_api_base: String,
    pub gemini_api_base: String,

    /// Gateway origin (`scheme://host[:port]`) that deployed agents reach this router
    /// at, used by the deploy-time injector (Phase 2). The injector appends `/llm/v1`
    /// (the Pingora `/llm` strip route) when building the agent's `*_BASE_URL`. Empty ⇒
    /// the injector skips LLM wiring (fail closed — no broken base URL without a key).
    pub llm_gateway_base_url: String,

    /// Level 2.5 salience gate: an in-process classifier decides whether a boundary turn
    /// is substantive enough to classify + pin, or is small talk to be served cheaply
    /// without pinning. Enabled by default. When `false`, the router classifies at every
    /// fireable boundary (behaviour before the gate existed).
    pub salience_gate_enabled: bool,
    /// Optional override: path to a trained weights JSON (same schema as the embedded
    /// asset) to load *instead of* the model embedded in the binary. Empty (the
    /// default) ⇒ use the embedded model, which needs no deployment step. Exists so a
    /// candidate model can be trialled without a rebuild; a load failure falls back to
    /// classifying every boundary, never to an outage.
    pub salience_weights_path: String,
    /// Below this probability the classifier confidently judges the turn small talk and
    /// the gate defers. This is the only threshold that changes a routing outcome —
    /// raising it defers more turns. Default 0.20; tune against validation data.
    pub salience_low_threshold: f64,
    /// Above this probability the classifier is confidently substantive. Turns between the
    /// thresholds route too, so this does not change routing on its own — it marks the
    /// uncertain band in the gate's logs so its size can be measured before `low` is
    /// retuned. Default 0.80.
    pub salience_high_threshold: f64,
}

impl Default for GatewayConfig {
    /// The canonical defaults (also the values `from_env` falls back to per key).
    fn default() -> Self {
        Self {
            agent_jwt_secret: String::new(),
            agent_jwt_algorithm: "HS256".into(),
            default_provider: "openai".into(),
            default_model: "gpt-4o-mini".into(),
            platform_openai_api_key: String::new(),
            platform_anthropic_api_key: String::new(),
            platform_gemini_api_key: String::new(),
            llm_config_cache_ttl_secs: 30,
            redis_url: String::new(),
            router_decision_ttl_secs: 3600,
            attribution_window_secs: 300,
            model_catalog_sync_interval_secs: 600,
            pricing_sync_interval_secs: 86_400,
            openai_api_base: "https://api.openai.com/v1".into(),
            anthropic_api_base: "https://api.anthropic.com/v1".into(),
            gemini_api_base: "https://generativelanguage.googleapis.com/v1beta".into(),
            llm_gateway_base_url: String::new(),
            salience_gate_enabled: true,
            salience_weights_path: String::new(),
            salience_low_threshold: 0.20,
            salience_high_threshold: 0.80,
        }
    }
}

impl GatewayConfig {
    /// Load configuration from the process environment, falling back to [`Default`]
    /// per key.
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            agent_jwt_secret: env_or("AGENT_JWT_SECRET", &d.agent_jwt_secret),
            agent_jwt_algorithm: env_or("AGENT_JWT_ALGORITHM", &d.agent_jwt_algorithm),
            default_provider: env_or("DEFAULT_PROVIDER", &d.default_provider),
            default_model: env_or("DEFAULT_MODEL", &d.default_model),
            // Per-provider platform keys. Prefer the explicit `PLATFORM_*` name, then
            // fall back to the generic provider key env var (which agents/orchestrator
            // already set), so a single provider key "just works" without duplication.
            platform_openai_api_key: env_first(
                &["PLATFORM_OPENAI_API_KEY", "OPENAI_API_KEY"],
                &d.platform_openai_api_key,
            ),
            platform_anthropic_api_key: env_first(
                &["PLATFORM_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
                &d.platform_anthropic_api_key,
            ),
            platform_gemini_api_key: env_first(
                &["PLATFORM_GEMINI_API_KEY", "GEMINI_API_KEY"],
                &d.platform_gemini_api_key,
            ),
            llm_config_cache_ttl_secs: std::env::var("LLM_CONFIG_CACHE_TTL")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.llm_config_cache_ttl_secs),
            redis_url: env_or("REDIS_URL", &d.redis_url),
            router_decision_ttl_secs: std::env::var("ROUTER_DECISION_TTL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.router_decision_ttl_secs),
            attribution_window_secs: std::env::var("LLM_ATTRIBUTION_WINDOW_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.attribution_window_secs),
            model_catalog_sync_interval_secs: std::env::var("MODEL_CATALOG_SYNC_INTERVAL_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.model_catalog_sync_interval_secs),
            pricing_sync_interval_secs: env_parse_first(
                &[
                    "PRICING_SYNC_INTERVAL_SECS",
                    "MODEL_PRICING_SYNC_INTERVAL_SECS",
                ],
                d.pricing_sync_interval_secs,
            ),
            openai_api_base: env_or("OPENAI_API_BASE", &d.openai_api_base),
            anthropic_api_base: env_or("ANTHROPIC_API_BASE", &d.anthropic_api_base),
            gemini_api_base: env_or("GEMINI_API_BASE", &d.gemini_api_base),
            llm_gateway_base_url: env_or("LLM_GATEWAY_BASE_URL", &d.llm_gateway_base_url),
            salience_gate_enabled: std::env::var("SALIENCE_GATE_ENABLED")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.salience_gate_enabled),
            salience_weights_path: env_or("SALIENCE_WEIGHTS_PATH", &d.salience_weights_path),
            salience_low_threshold: std::env::var("SALIENCE_LOW_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.salience_low_threshold),
            salience_high_threshold: std::env::var("SALIENCE_HIGH_THRESHOLD")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(d.salience_high_threshold),
        }
    }

    /// The platform-owned fallback key for `provider`, used when an agent sets no
    /// per-user `api_key_secret_name`. Unknown providers fall back to the OpenAI key
    /// for backward compatibility.
    pub fn platform_key_for(&self, provider: &str) -> &str {
        match provider {
            "anthropic" => &self.platform_anthropic_api_key,
            "gemini" => &self.platform_gemini_api_key,
            _ => &self.platform_openai_api_key,
        }
    }
}

/// First parseable env var among `keys`, else `default`. Used where a setting
/// has been renamed: the current key wins, the legacy key still works. Without
/// this, dropping the old name would silently revert a deliberately tuned
/// operator value back to the built-in default.
fn env_parse_first<T: std::str::FromStr>(keys: &[&str], default: T) -> T {
    for key in keys {
        if let Ok(val) = std::env::var(key)
            && let Ok(parsed) = val.parse()
        {
            return parsed;
        }
    }
    default
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// First non-empty env var among `keys`, else `default`. Lets a `PLATFORM_*` key take
/// precedence over the generic provider key env var while treating an empty value as unset.
fn env_first(keys: &[&str], default: &str) -> String {
    for key in keys {
        if let Ok(val) = std::env::var(key)
            && !val.is_empty()
        {
            return val;
        }
    }
    default.to_string()
}
