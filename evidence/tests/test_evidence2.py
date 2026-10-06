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
    def test_realistic_file_labeled_and_split(self):
        lines = (HERE / "classifier_realistic.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertGreaterEqual(len(lines), 1000)
        splits = set()
        for ln in lines[:50]:
            it = json.loads(ln)
            self.assertEqual(it["source"], "synthetic-realistic-v1")
            self.assertIn(it["expected_route"], ("small", "large"))
            splits.add(it["split"])
        self.assertEqual(splits, {"train", "val", "test"})

    def test_test_ids_disjoint_from_train(self):
        tr, te = set(), set()
        for ln in (HERE / "classifier_realistic.jsonl").read_text(encoding="utf-8").splitlines():
            it = json.loads(ln)
            (tr if it["split"] == "train" else te if it["split"] == "test" else set()).add(it["id"])
        self.assertEqual(tr & te, set())

    def test_demo_reads_reports_not_hardcoded(self):
        src = (HERE / "demo.py").read_text(encoding="utf-8")
        self.assertIn("compact_aggressive_report.json", src)
        self.assertIn("classifier_realistic_report.json", src)
        # no headline percentages hard-coded in demo
        self.assertNotIn("57.8%", src)
        self.assertNotIn("73.2%", src)


if __name__ == "__main__":
    unittest.main()
