/**
 * Per-message usage chips: "~1.2k tokens · 3.4s · $0.0021".
 *
 * Fed by the stream's terminal `usage_meta` data part, or by the equivalent
 * columns on a reloaded chat_messages row. Token/cost chips only exist for
 * platform-paid usage; a bring-your-own-key agent reply shows duration alone.
 * `estimated: true` (streamed orchestrator turns) prefixes figures with `~`.
 *
 * The headline count is the **whole** prompt plus the reply — cached tokens
 * included. `input_tokens` carries only the fresh portion, so summing it with
 * output alone made an unchanged turn appear to shrink as the provider cache
 * warmed: the same six prompts replayed two minutes apart read 2,873 tokens
 * and then 957, for prompts that were 5,305 and 5,309. A cache hit should show
 * up as *cheaper* in the cost chip, never as *smaller* in the token chip. The
 * split is in the tooltip, where it explains the price rather than distorting
 * the size.
 */

/** Normalize a chat_messages row into the usage_meta shape. */
export function usageFromMessage(m) {
  if (!m) return null;
  const hasTokens = m.input_tokens != null || m.output_tokens != null;
  if (!hasTokens && m.duration_ms == null) return null;
  const input = m.input_tokens ?? 0;
  const output = m.output_tokens ?? 0;
  // Null on a bring-your-own-key reply, and on rows written before migration 0037.
  const cacheRead = m.cache_read_tokens ?? 0;
  const cacheCreation = m.cache_creation_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    total_tokens: hasTokens ? input + cacheRead + cacheCreation + output : undefined,
    cost_usd: m.cost_usd,
    duration_ms: m.duration_ms,
    model: m.model,
    estimated: m.usage_estimated ?? false,
  };
}

export function usageChipsHtml(u) {
  if (!u) return "";
  const chips = [];
  const approx = u.estimated ? "~" : "";
  const total = u.total_tokens ?? 0;
  if (total > 0) chips.push(`${approx}${formatTokens(total)} tokens`);
  if (u.duration_ms != null) chips.push(formatDuration(u.duration_ms));
  const cost = toNumber(u.cost_usd);
  if (total > 0 && cost != null && cost > 0) chips.push(`${approx}${formatCost(cost)}`);
  if (!chips.length) return "";
  return `<span class="msg-usage" title="${escapeAttr(usageTitle(u))}">${chips.join(" · ")}</span>`;
}

function usageTitle(u) {
  const parts = [];
  if (u.total_tokens > 0) {
    const cached = (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0);
    // Naming the cached share is the difference between "this turn was small" and
    // "this turn was mostly served from cache, so it was cheap".
    parts.push(
      cached > 0
        ? `${u.input_tokens} in (+${cached} cached) / ${u.output_tokens} out`
        : `${u.input_tokens} in / ${u.output_tokens} out`,
    );
  }
  if (u.model) parts.push(u.model);
  if (u.estimated) parts.push("token counts are estimated");
  return parts.join(" · ");
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms) {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatCost(usd) {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function toNumber(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function escapeAttr(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
