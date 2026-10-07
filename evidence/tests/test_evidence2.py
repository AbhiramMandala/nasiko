"""Second harness test module: aggressive profile + realistic eval hygiene."""
import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
import sys
sys.path.insert(0, str(HERE))
from compact_bench import encode_tool
from compact_aggressive import encode_aggressive, trim_desc

CORPUS = HERE / "corpus_tools.json"
REALISTIC_SOURCE = "synthetic-realistic-v2"


class AggressiveTest(unittest.TestCase):
    def test_aggressive_never_longer_than_default(self):
        tools = json.loads(CORPUS.read_text(encoding="utf-8"))
        for t in tools:
            d, _ = encode_tool(t)
            a, _ = encode_aggressive(t)
            if d is not None and a is not None:
                self.assertLessEqual(len(a.encode()), len(d.encode()), t["name"])

    def test_aggressive_same_bypass_set_or_superset(self):
        tools = json.loads(CORPUS.read_text(encoding="utf-8"))
        for t in tools:
            d, _ = encode_tool(t)
            a, _ = encode_aggressive(t)
            if d is None:
                self.assertIsNone(a, t["name"])  # never compact what default bypasses

    def test_trim_is_deterministic_and_bounded(self):
        self.assertEqual(trim_desc("a; b"), trim_desc("a; b"))
        self.assertLessEqual(len(trim_desc("x" * 500).encode()), 64 + 20)


class RealisticHygieneTest(unittest.TestCase):
    def _load(self):
        return [json.loads(ln) for ln in
                (HERE / "classifier_realistic.jsonl").read_text(encoding="utf-8").splitlines()]

    def test_realistic_file_labeled_and_split(self):
        items = self._load()
        self.assertGreaterEqual(len(items), 1000)
        by_type = {}
        for it in items:
            self.assertEqual(it["source"], REALISTIC_SOURCE)
            self.assertIn(it["expected_route"], ("small", "large"))
            by_type.setdefault(it["type"], set()).add(it["split"])
        # every type represented in every split (quotas, not source ordering)
        for t, splits in by_type.items():
            self.assertEqual(splits, {"train", "val", "test"}, t)
        self.assertGreaterEqual(
            sum(1 for i in items if i["type"] == "general"), 100)

    def test_families_disjoint_across_splits(self):
        fams = {}
        for it in self._load():
            fams.setdefault(it["family"], set()).add(it["split"])
        for fam, splits in fams.items():
            self.assertEqual(len(splits), 1, f"family {fam} spans splits")

    def test_adversarial_present_in_test(self):
        items = self._load()
        adv_test = [i for i in items if i["split"] == "test" and i["adversarial"]]
        self.assertGreaterEqual(len(adv_test), 10,
                                "fallback path unevaluated: no adversarial test cases")
        gens = [i for i in items if i["split"] == "test" and i["type"] == "general"]
        self.assertGreater(len(gens), 0, "no general cases in test")

    def test_demo_reads_reports_not_hardcoded(self):
        src = (HERE / "demo.py").read_text(encoding="utf-8")
        self.assertIn("compact_aggressive_report.json", src)
        self.assertIn("classifier_realistic_report.json", src)
        # no headline percentages hard-coded in demo
        self.assertNotIn("57.8%", src)
        self.assertNotIn("73.2%", src)


class FallbackRoutingTest(unittest.TestCase):
    """Low confidence must route large WITHOUT relabeling the prediction."""

    def _run(self, stub, items, thr=0.4):
        from classifier_realistic_eval import evaluate
        return evaluate(items, stub, thr)

    def _items(self):
        return [
            {"question": "q1", "type": "writing", "expected_route": "small"},
            {"question": "q2", "type": "writing", "expected_route": "small"},
            {"question": "q3", "type": "code_generation", "expected_route": "large"},
            {"question": "q4", "type": "code_generation", "expected_route": "large"},
        ]

    def test_low_confidence_fallback_routes_large(self):
        # Stub always predicts writing with low confidence: every request
        # must fall back to the large tier while the prediction stays writing.
        res = self._run(lambda q: ("writing", 0.1), self._items())
        self.assertEqual(res["fallback_rate"], 1.0)
        self.assertEqual(res["large_routed_pct"], 100.0)
        # accuracy is computed on the PRESERVED prediction (2/4 writing)
        self.assertEqual(res["accuracy"], 0.5)
        # route accuracy: the 2 code_generation items route correctly via
        # fallback, the 2 writing items do not
        self.assertEqual(res["route_accuracy"], 0.5)

    def test_genuine_general_is_not_fallback(self):
        # High-confidence general prediction: no fallback, routes small.
        res = self._run(lambda q: ("general", 0.9), self._items())
        self.assertEqual(res["fallback_rate"], 0.0)
        self.assertEqual(res["large_routed_pct"], 0.0)
        self.assertEqual(res["route_accuracy"], 0.5)  # only the 2 small items


if __name__ == "__main__":
    unittest.main()
