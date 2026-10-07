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
- Semantic preservation: REAL round-trip per tool —
  encode(original) -> compact string -> decode(compact) -> normalized compare
  against normalized(original), plus an exact tool-description match (the
  encoder keeps descriptions verbatim). Field *descriptions* inside parameters
  are elided by design (documented in PR #214); a corrupted compact string
  fails preservation by construction. Comparing the original against itself
  would prove nothing, so the check MUST depend on the decoded string.
- Tokens: reported as bytes/chars (exact) PLUS a clearly-labeled heuristic
  estimate (chars/4). This is NOT o200k_base, and no Rust tokenizer is run
  here: the Rust-side evaluator (`llm-router/examples/compact_tools_eval`)
  does not exist in this checkout, so exact tokenizer counts cannot be
  produced by this benchmark (see Limitations / tokenizer_blocker.json).
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


class CompactDecodeError(ValueError):
    """A compact line that does not parse (fail-closed: never guess)."""


def _split_top_level(text, sep=","):
    """Split on sep at nesting depth 0 of [...] and {...}."""
    parts, depth, cur = [], 0, []
    for ch in text:
        if ch in "[{":
            depth += 1
            cur.append(ch)
        elif ch in "]}":
            if depth == 0:
                raise CompactDecodeError("unbalanced brackets")
            depth -= 1
            cur.append(ch)
        elif ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if depth != 0:
        raise CompactDecodeError("unbalanced brackets")
    parts.append("".join(cur))
    return parts


def _parse_compact_type(text):
    """Parse one compact type expression; return (schema, rest).

    Raises CompactDecodeError on anything malformed — the decoder never
    guesses, so a corrupted line fails instead of validating wrong calls.
    """
    s = text.strip()
    for lit, schema in (("datetime", {"type": "string", "format": "date-time"}),
                        ("date", {"type": "string", "format": "date"}),
                        ("str", {"type": "string"}),
                        ("int", {"type": "integer"}),
                        ("num", {"type": "number"}),
                        ("bool", {"type": "boolean"})):
        if s == lit or s.startswith(lit + ",") or s.startswith(lit + "}") or s.startswith(lit + "]"):
            return dict(schema), s[len(lit):]
    if s.startswith("["):
        inner, rest = _parse_compact_type(s[1:])
        rest = rest.strip()
        if not rest.startswith("]"):
            raise CompactDecodeError("bad array type")
        return {"type": "array", "items": inner}, rest[1:]
    if s.startswith("{"):
        depth, i = 0, 0
        while i < len(s):
            if s[i] in "[{":
                depth += 1
            elif s[i] in "]}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        if depth != 0 or i >= len(s) or s[i] != "}":
            raise CompactDecodeError("bad object type")
        inner = s[1:i]
        props, req = {}, []
        if inner.strip():
            for part in _split_top_level(inner):
                pname, pschema, reqd = _parse_param(part)
                props[pname] = pschema
                if reqd:
                    req.append(pname)
        return {"type": "object", "properties": props, "required": req}, s[i + 1:]
    # enum: top-level '|' separated values (this function always receives
    # exactly one type expression: bracketed forms are consumed above).
    if "|" in s:
        vals = s.split("|")
        if len(vals) > 1 and all(v and NAME_RE.match(v) for v in vals):
            return {"type": "string", "enum": vals}, ""
        raise CompactDecodeError("bad enum type")
    # Bare word: the encoder renders a single-value enum ["v"] as just "v"
    # (it cannot collide with the fixed type literals, which are matched above).
    if s and NAME_RE.match(s):
        return {"type": "string", "enum": [s]}, ""
    raise CompactDecodeError(f"unknown type in {s!r}")


def _parse_param(part):
    """Parse `name[?]:type`; return (name, schema, required)."""
    part = part.strip()
    m = re.match(r"^([A-Za-z0-9_.\-]+)(\?)?:(.*)$", part, re.DOTALL)
    if not m:
        raise CompactDecodeError(f"bad parameter {part!r}")
    schema, rest = _parse_compact_type(m.group(3))
    if rest.strip():
        raise CompactDecodeError(f"trailing text in {part!r}")
    return m.group(1), schema, m.group(2) is None


def decode_tool(line):
    """Parse a compact tool line back into a tool dict.

    Returns (tool, "") on success, (None, reason) on malformed input.
    The preservation check MUST go through this function: comparing the
    original against itself proves nothing.
    """
    if not isinstance(line, str) or not line.strip():
        return None, "empty_line"
    try:
        return _decode_tool_inner(line)
    except RecursionError:
        return None, "too_deep"
    except CompactDecodeError as e:
        return None, f"bad_line: {e}"


def _decode_tool_inner(line):
    m = re.match(r"^([A-Za-z0-9_.\-]+)\(", line)
    if not m:
        return None, "bad_tool_name"
    name = m.group(1)
    # find the matching close paren for the params list
    depth, i = 0, m.end() - 1
    while i < len(line):
        if line[i] == "(":
            depth += 1
        elif line[i] == ")":
            depth -= 1
            if depth == 0:
                break
        i += 1
    if depth != 0 or i >= len(line):
        return None, "unbalanced_params"
    params_text, rest = line[m.end():i], line[i + 1:]
    if rest and not rest.startswith(" - "):
        return None, "bad_description_separator"
    desc = rest[3:] if rest else ""
    props, req = {}, []
    if params_text.strip():
        try:
            parts = _split_top_level(params_text)
        except CompactDecodeError as e:
            return None, f"bad_params: {e}"
        for part in parts:
            try:
                pname, pschema, reqd = _parse_param(part)
            except CompactDecodeError as e:
                return None, f"bad_params: {e}"
            if pname in props:
                return None, "duplicate_param"
            props[pname] = pschema
            if reqd:
                req.append(pname)
    return {"name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": req}}, ""


def check_preserved(original, line):
    """True iff decode(encode(original)) is semantically identical.

    Compares normalize_tool(decoded) against normalize_tool(original) plus an
    exact description match (the encoder keeps tool descriptions verbatim).
    A corrupted compact string fails here by construction.
    """
    decoded, reason = decode_tool(line)
    if decoded is None:
        return False, f"decode_failed: {reason}"
    if normalize_tool(decoded) != normalize_tool(original):
        return False, "schema_mismatch"
    if decoded.get("description", "") != (original.get("description") or ""):
        return False, "description_mismatch"
    return True, ""


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
            # Fail-closed bypass: the tool is sent natively, so there is no
            # compact string to decode and no decode timing to report.
            compact_bytes = baseline
            ok, bypass, decode_ran = True, True, False
            reason = f"bypass: {reason}"
        else:
            compact_bytes = line.encode("utf-8")
            # REAL round-trip: decode the compact string we just produced and
            # compare normalized(decoded) against normalized(original).
            # Comparing the original against itself would prove nothing.
            t3 = time.perf_counter()
            ok, preserve_reason = check_preserved(tool, line)
            t4 = time.perf_counter()
            dec_times.append((t4 - t3) * 1000)
            decode_ran = True
            if not ok:
                reason = f"not_preserved: {preserve_reason}"
            bypass = False
        enc_times.append((t2 - t1) * 1000)
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
    # decode_ms averages ONLY tools where a real decode ran. Bypassed tools
    # have no compact string, so they contribute no decode timing.
    # compact_aggressive.py uses the same decode path, so both profiles prove
    # preservation instead of asserting it.
    report = {
        "method": "encode -> decode -> normalize-compare per tool; decode_ms covers decoded tools only (see decode_measured_n). Authoritative tokens via the Rust-side evaluator (not in this checkout; see Limitations).",
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
        "avg_decode_ms": round(sum(dec_times) / len(dec_times), 4) if dec_times else 0,
        "decode_measured_n": len(dec_times),
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
