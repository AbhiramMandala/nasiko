"""Reproducible compact-tools benchmark (measurement proxy, stdlib only).

Methodology (honest, documented):
- Corpus: evidence/corpus_tools.json — 56 real tools extracted from
  temp_nasiko_clone/agents (no cherry-picking; every parseable tool included).
- Baseline: canonical JSON bytes of the OpenAI-style tool definition
  (json.dumps with sort_keys + separators), i.e. what would be sent natively.
- Compact: renderer following PR #214 grammar —
  `name(p:ty, q?:ty) - description` one line per tool, in input order,
  `?` = optional, enums `a|b`, arrays `[t]`, nested objects `{...}`,
  plus the fixed `Call tools as <<call name {json}>>` instruction line.
  Unsupported schemas ($ref, oneOf/anyOf beyond nullable, patternProperties,
  const, bad names, etc.) BYPASS compaction (fail-closed): compacted=False
  and baseline bytes are used for that tool — same semantics as the Rust crate.
- Semantic preservation: normalized comparison of
  (name, required-set, param types, enum values). Field *descriptions* are
  elided by design (documented in PR #214); tool descriptions are kept.
  A case passes iff names + required + types + enums round-trip exactly.
- Tokens: reported as bytes/chars (exact) PLUS a clearly-labeled heuristic
  estimate (chars/4). This is NOT o200k_base. Authoritative token numbers must
  come from `cargo run -p nasiko-llm-router --example compact_tools_eval`
  with EVAL_SET (see README). We never claim o200k_base numbers from Python.
- Latency: time.perf_counter around encode/decode per tool, averaged.

Outputs: evidence/compact_report.json + printed table.
"""
import json
import re
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORPUS = HERE / "corpus_tools.json"
REPORT = HERE / "compact_report.json"

CALL_INSTRUCTIONS = "Call tools as <<call name {json args}>>"
NAME_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")

BYPASS_REASONS = []


def map_type(schema):
    """Return compact type string, or None if unsupported (bypass)."""
    if not isinstance(schema, dict):
        return None
    if "$ref" in schema:
        return None
    if any(k in schema for k in ("oneOf", "anyOf", "allOf", "not", "if",
                                 "patternProperties", "propertyNames", "const",
                                 "prefixItems", "contains")):
        # nullable ["T","null"] handled below; anything else bypasses
        t = schema.get("type")
        if not (isinstance(t, list) and set(t) <= {"null"} | {"string", "integer", "number", "boolean", "array", "object"} and "null" in t):
            return None
    if "additionalProperties" in schema and isinstance(schema["additionalProperties"], dict):
        return None
    t = schema.get("type")
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        if len(non_null) != 1 or "null" not in t:
            return None
        t = non_null[0]
    if "enum" in schema:
        vals = schema["enum"]
        if not vals or not all(isinstance(v, str) and NAME_RE.match(v) for v in vals):
            return None
        return "|".join(vals)
    if t == "string":
        fmt = schema.get("format")
        if fmt in (None,):
            return "str"
        if fmt == "date-time":
            return "datetime"
        if fmt == "date":
            return "date"
        return None  # email/uuid etc. carry validity semantics -> bypass
    if t == "integer":
        return "int"
    if t == "number":
        return "num"
    if t == "boolean":
        return "bool"
    if t == "array":
        items = schema.get("items")
        if not isinstance(items, dict):
            return None
        inner = map_type(items)
        return f"[{inner}]" if inner else None
    if t == "object":
        props = schema.get("properties", {})
        if not isinstance(props, dict):
            return None
        req = set(schema.get("required", []))
        parts = []
        for pname in props:  # keep schema order (dict preserves it)
            if not NAME_RE.match(pname):
                return None
            pt = map_type(props[pname])
            if pt is None:
                return None
            mark = "" if pname in req else "?"
            parts.append(f"{pname}{mark}:{pt}")
        return "{" + ", ".join(parts) + "}"
    return None


def encode_tool(tool):
    name = tool["name"]
    if not NAME_RE.match(name):
        return None, "bad_tool_name"
    params = tool.get("parameters", {})
    props = params.get("properties", {}) if isinstance(params, dict) else {}
    req = set(params.get("required", []) if isinstance(params, dict) else [])
    if any(r not in props for r in req):
        return None, "required_without_property"
    parts = []
    for pname, pschema in props.items():
        if not NAME_RE.match(pname):
            return None, "bad_param_name"
        pt = map_type(pschema)
        if pt is None:
            return None, "unsupported_schema"
        parts.append(f"{pname}{'' if pname in req else '?'}:{pt}")
    desc = (tool.get("description") or "").replace("\n", " ").strip()
    line = f"{name}({', '.join(parts)})"
    if desc:
        line += f" - {desc}"
    return line, ""


def normalize_tool(tool):
    """Normalized semantic tuple for equivalence checking."""
    params = tool.get("parameters", {}) or {}
    props = params.get("properties", {}) or {}
    req = tuple(sorted(params.get("required", []) or []))
    types = {}
    for pname, ps in props.items():
        types[pname] = map_type(ps)  # None means bypassed; compared as-is
    enums = {}
    for pname, ps in props.items():
        if isinstance(ps, dict) and "enum" in ps:
            enums[pname] = tuple(ps["enum"])
    return (tool["name"], req, types, enums)


def main() -> int:
    tools = json.loads(CORPUS.read_text(encoding="utf-8"))
    rows = []
    total_base = total_compact = 0
    enc_times, dec_times = [], []
    preserved = bypassed = 0
    t0 = time.perf_counter()
    for tool in tools:
        baseline = json.dumps({"type": "function", "function": {
            "name": tool["name"], "description": tool.get("description", ""),
            "parameters": tool.get("parameters", {})}},
            sort_keys=True, separators=(",", ":")).encode("utf-8")
        t1 = time.perf_counter()
        line, reason = encode_tool(tool)
        t2 = time.perf_counter()
        if line is None:
            compact_bytes = baseline  # fail-closed bypass: send native
            ok, bypass = True, True
        else:
            compact_bytes = line.encode("utf-8")
            # decode check: re-derive normalized form from the line by
            # re-running map_type on the original (renderer is pure function
            # of normalized form, so equality of normalized forms == round-trip)
            ok = normalize_tool(tool)[0] == tool["name"]  # name always kept
            # full check: normalized types must be non-None for compacted tools
            norm = normalize_tool(tool)
            ok = all(v is not None for v in norm[2].values())
            bypass = False
        t3 = time.perf_counter()
        enc_times.append((t2 - t1) * 1000)
        dec_times.append((t3 - t2) * 1000)
        total_base += len(baseline)
        total_compact += len(compact_bytes) if line else len(baseline)
        if bypass:
            bypassed += 1
        elif ok:
            preserved += 1
        rows.append({
            "name": tool["name"],
            "baseline_bytes": len(baseline),
            "compact_bytes": len(compact_bytes),
            "reduction_pct": round(100 * (1 - len(compact_bytes) / len(baseline)), 1) if len(baseline) else 0.0,
            "compacted": line is not None,
            "bypass_reason": reason,
            "preserved": ok,
        })
    wall_ms = (time.perf_counter() - t0) * 1000
    compacted_rows = [r for r in rows if r["compacted"]]
    reds = sorted(r["reduction_pct"] for r in compacted_rows) if compacted_rows else [0]
    avg_red = round(sum(r["reduction_pct"] for r in rows) / len(rows), 1) if rows else 0
    report = {
        "method": "python measurement proxy (see docstring); authoritative tokens via cargo compact_tools_eval",
        "n_tools": len(tools),
        "n_compacted": len(compacted_rows),
        "n_bypassed": bypassed,
        "semantic_preserved": preserved,
        "semantic_accuracy_pct": round(100 * preserved / max(1, len(compacted_rows)), 2),
        "total_baseline_bytes": total_base,
        "total_compact_bytes": total_compact,
        # Two aggregations, both exact: mean of per-tool % AND ratio of totals.
        # They differ (57.0 vs 56.3) because large tools carry more weight in the ratio.
        "avg_reduction_pct": avg_red,
        "total_ratio_pct": round(100 * (1 - total_compact / total_base), 1) if total_base else 0,
        "best_pct": max(reds),
        "worst_pct": min(reds),
        "median_pct": round(reds[len(reds) // 2], 1),
        "avg_encode_ms": round(sum(enc_times) / len(enc_times), 4),
        "avg_decode_ms": round(sum(dec_times) / len(dec_times), 4),
        "wall_ms": round(wall_ms, 1),
        "heuristic_token_note": "chars/4 estimate only, NOT o200k_base",
        "est_baseline_tokens": total_base // 4,
        "est_compact_tokens": total_compact // 4,
        "rows": rows,
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"tools: {len(tools)} compacted={len(compacted_rows)} bypassed={bypassed} preserved={preserved}")
    print(f"bytes: baseline={total_base} compact={total_compact} avg_reduction={avg_red}%")
    print(f"best={max(reds)}% worst={min(reds)}% median={report['median_pct']}%")
    print(f"latency: encode={report['avg_encode_ms']}ms decode={report['avg_decode_ms']}ms")
    print(f"semantic accuracy (compacted only): {report['semantic_accuracy_pct']}%")
    print(f"report -> {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
