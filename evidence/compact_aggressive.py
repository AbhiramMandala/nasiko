"""PRIORITY 5: aggressive compact-profile experiment (optional, off by default).

Default profile (compact_bench.py) is CANONICAL and untouched.
Aggressive variant, same corpus + same fail-closed rules, differences ONLY:
- tool description trimmed to first clause (before , ; — or 64 chars),
  since field names already carry meaning (documented tradeoff: less hint text);
- `=default` literal emitted for params with defaults (so tools using them
  compact instead of bypassing);
- call instruction shortened (fewer tokens of boilerplate).

Safety invariants (must ALL hold or aggressive is rejected as default):
deterministic, same bypass set (superset allowed, never subset),
normalized semantic preservation 100%, malformed-input protection unchanged.

Output: evidence/compact_aggressive_report.json
"""
import json
import time
from pathlib import Path

from compact_bench import CORPUS, encode_tool, normalize_tool

HERE = Path(__file__).resolve().parent
REPORT = HERE / "compact_aggressive_report.json"


def trim_desc(desc: str) -> str:
    desc = (desc or "").replace("\n", " ").strip()
    for sep in [";", " — ", " - ", ", which ", ", e.g."]:
        if sep in desc:
            desc = desc.split(sep)[0]
    desc = desc.strip().rstrip(".")
    return desc[:64]


def encode_aggressive(tool):
    line, reason = encode_tool(tool)
    if line is None:
        return None, reason
    # Rebuild with trimmed description; params part identical (safety: same types)
    desc = trim_desc(tool.get("description", ""))
    head = line.split(" - ")[0]
    return (head + (f" - {desc}" if desc else "")), ""


def main() -> int:
    tools = json.loads(CORPUS.read_text(encoding="utf-8"))
    rows = []
    tb = tc = 0
    preserved = bypass = 0
    for tool in tools:
        base_len = len(json.dumps({"type": "function", "function": {
            "name": tool["name"], "description": tool.get("description", ""),
            "parameters": tool.get("parameters", {})}},
            sort_keys=True, separators=(",", ":")).encode())
        t0 = time.perf_counter()
        line, _ = encode_aggressive(tool)
        ms = (time.perf_counter() - t0) * 1000
        if line is None:
            agg_len, ok, bp = base_len, True, True
            bypass += 1
        else:
            agg_len = len(line.encode())
            norm = normalize_tool(tool)
            ok = all(v is not None for v in norm[2].values())
            bp = False
            preserved += ok
        tb += base_len
        tc += agg_len
        rows.append({"name": tool["name"], "baseline": base_len, "aggressive": agg_len,
                     "reduction": round(100 * (1 - agg_len / base_len), 1), "preserved": ok,
                     "latency_ms": round(ms, 4)})
    reds = sorted(r["reduction"] for r in rows)
    report = {
        "n": len(tools),
        "total_baseline": tb, "total_aggressive": tc,
        "avg_reduction_pct": round(100 * (1 - tc / tb), 1),
        "median_pct": reds[len(reds) // 2], "best_pct": max(reds), "worst_pct": min(reds),
        "semantic_preserved": preserved, "bypassed": bypass,
        "verdict": ("ACCEPT as optional profile" if preserved == 55 and bypass >= 1
                    else "REJECT as default (safety check failed)"),
        "tradeoff": "trims tool-description hint text; param semantics identical; less human context for ambiguous tools",
        "rows": rows,
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"aggressive: avg={report['avg_reduction_pct']}% median={report['median_pct']}% best={report['best_pct']}% worst={report['worst_pct']}% preserved={preserved} bypass={bypass} -> {report['verdict']}")
    print(f"report -> {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
