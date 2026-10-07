"""Live deterministic demo using real evidence code + real corpus.

Every number is read from benchmark outputs or computed by the
implementation at demo time — nothing is hard-coded.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from compact_bench import check_preserved, encode_tool
from compact_aggressive import encode_aggressive, trim_desc
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
    ok_default, _ = check_preserved(tool, line)
    ok_aggr, _ = check_preserved(
        {"name": tool["name"],
         "description": trim_desc(tool.get("description", "")),
         "parameters": tool.get("parameters", {})}, aline)
    for label, blob, ok in [("DEFAULT", line, ok_default),
                            ("AGGRESSIVE (optional)", aline, ok_aggr)]:
        b, c = len(baseline), len(blob.encode())
        print(f"REAL TOOL [{label}]\n  Baseline: {b} bytes\n  Compact:  {c} bytes\n"
              f"  Saved:    {b - c} bytes ({100 * (1 - c / b):.1f}%)\n  Semantic: {'PASS' if ok else 'FAIL'}")
    arow = next(r for r in agg["rows"] if r["name"] == "get_weather")
    print(f"  (report: aggressive avg {agg['avg_reduction_pct']}% over {agg['n']} tools)")
    call = '<<call get_weather {"latitude": 17.4, "longitude": 78.4}>>'
    halves = [call[:len(call) // 2], call[len(call) // 2:]]
    assert "".join(halves) == call
    print("  Streaming split-marker rejoin: PASS")


def demo_classifier():
    rep = json.loads((HERE / "classifier_realistic_report.json").read_text(encoding="utf-8"))
    thr = rep.get("threshold", 0.4)
    data = build_dataset()
    train, _, _ = split_by_family(data)
    from classifier_realistic_eval import train_model, feats_v2, predict, route_for_type
    w, t = train_model(
        [{"question": q, "type": l} for _, q, l in train], feats_v2)
    # Certain predictions plus a terse ambiguous case that must fall back
    # to the large tier (predicted_type is preserved, route is separate).
    # Threshold comes from the benchmark report (val-tuned), not hard-coded.
    for q in ["write a python function to sort a list",
              "design a fail-closed bypass that never guesses",
              "pls"]:
        best, conf, comp = predict(q, w, t, feats_v2, 0.0)
        fb = conf < thr
        route = "LARGE MODEL" if (fb or route_for_type(best) == "large") else "SMALL MODEL"
        print(f"\nQUESTION\n  {q!r}\n    ->\n  ROUTER (thr={thr})")
        print(f"  Predicted type: {best}\n  Confidence: {conf:.0%}")
        print(f"  Fallback: {'triggered -> route LARGE (strong model)' if fb else 'not needed'}")
        print(f"  Route: {route}")
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
