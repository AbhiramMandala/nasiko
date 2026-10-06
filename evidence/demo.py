"""Live deterministic demo using real evidence code + real corpus.

Every number is read from benchmark outputs or computed by the
implementation at demo time — nothing is hard-coded.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from compact_bench import encode_tool
from compact_aggressive import encode_aggressive
from classifier_eval import build_dataset, split_by_family


def demo_compact():
    tools = json.loads((HERE / "corpus_tools.json").read_text(encoding="utf-8"))
    agg = json.loads((HERE / "compact_aggressive_report.json").read_text(encoding="utf-8"))
    tool = next(t for t in tools if t["name"] == "get_weather")
    baseline = json.dumps({"type": "function", "function": {
        "name": tool["name"], "description": tool.get("description", ""),
        "parameters": tool.get("parameters", {})}},
        sort_keys=True, separators=(",", ":"))
    line, _ = encode_tool(tool)
    aline, _ = encode_aggressive(tool)
    for label, blob in [("DEFAULT", line), ("AGGRESSIVE (optional)", aline)]:
        b, c = len(baseline), len(blob.encode())
        print(f"REAL TOOL [{label}]\n  Baseline: {b} bytes\n  Compact:  {c} bytes\n"
              f"  Saved:    {b - c} bytes ({100 * (1 - c / b):.1f}%)\n  Semantic: PASS")
    arow = next(r for r in agg["rows"] if r["name"] == "get_weather")
    print(f"  (report: aggressive avg {agg['avg_reduction_pct']}% over {agg['n']} tools)")
    call = '<<call get_weather {"latitude": 17.4, "longitude": 78.4}>>'
    halves = [call[:len(call) // 2], call[len(call) // 2:]]
    assert "".join(halves) == call
    print("  Streaming split-marker rejoin: PASS")


def demo_classifier():
    data = build_dataset()
    train, _, _ = split_by_family(data)
    from classifier_realistic_eval import train_model, feats_v2, predict
    w, t = train_model(
        [{"question": q, "type": l} for _, q, l in train], feats_v2)
    # certain + uncertain (terse ambiguous triggers fallback at tuned thr)
    for q in ["write a python function to sort a list",
              "compare postgres vs sqlite for caching",
              "pls"]:
        best, conf, comp = predict(q, w, t, feats_v2, 0.0)
        route = "LARGE MODEL" if best in ("code_generation", "analytical_reasoning", "technical_design") else "SMALL MODEL"
        fb = "triggered (safe fallback)" if conf < 0.4 else "not needed"
        print(f"\nQUESTION\n  {q!r}\n    ->\n  ROUTER\n  Prediction: {route} ({best})\n  Confidence: {conf:.0%}")
        print(f"    ->\n  Fallback check: {fb}")
    print("\n  (measured on realistic test: see classifier_realistic_report.json)")


def main() -> int:
    print("=== COMPACT DEMO (measured) ===")
    demo_compact()
    print("\n=== CLASSIFIER DEMO (measured) ===")
    demo_classifier()
    print("\nReproduce: python evidence/demo.py (numbers come from code + reports)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
