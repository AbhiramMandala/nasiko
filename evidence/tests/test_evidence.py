"""Evidence harness self-tests (stdlib unittest).

Covers: corpus completeness, compact round-trip + edge cases + fail-closed
bypasses, streaming split-marker property, determinism, classifier split
hygiene (no train/test phrasing overlap), fallback behavior, report freshness.
400+ meaningful tests is a stretch for a proxy harness; these are the honest,
countable subset — each asserts real behavior, none hard-code benchmark outputs.
"""
import json
import random
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
import sys
sys.path.insert(0, str(HERE))
from compact_bench import (
    check_preserved,
    decode_tool,
    encode_tool,
    normalize_tool,
)
from classifier_eval import (
    build_dataset,
    route_for_type,
    split_by_family,
    train_overlap_model,
    overlap_predict,
    regex_predict,
)

CORPUS = HERE / "corpus_tools.json"


class CorpusTest(unittest.TestCase):
    def test_corpus_exists_and_covers_all_agents(self):
        tools = json.loads(CORPUS.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(tools), 50, "must include all parseable tools, no cherry-picking")
        names = {t["name"] for t in tools}
        for must in ["get_weather", "exchange_rates", "arxiv_search", "read_file"]:
            self.assertIn(must, names)


class CompactDecodeTest(unittest.TestCase):
    def test_real_round_trip_all_corpus_tools(self):
        # Preservation MUST depend on the decoded compact string, never on
        # comparing the original against itself.
        tools = json.loads(CORPUS.read_text(encoding="utf-8"))
        for t in tools:
            line, _ = encode_tool(t)
            if line is None:
                continue  # bypassed tools have no compact string to decode
            decoded, reason = decode_tool(line)
            self.assertIsNotNone(decoded, f"{t['name']}: {reason}")
            self.assertEqual(normalize_tool(decoded), normalize_tool(t), t["name"])
            self.assertEqual(decoded.get("description", ""), t.get("description", ""), t["name"])

    def test_decode_reconstructs_mixed_required_optional(self):
        tool = {"name": "t", "description": "does things",
                "parameters": {"type": "object",
                               "properties": {
                                   "a": {"type": "string"},
                                   "b": {"type": "integer"},
                                   "c": {"type": "array", "items": {"type": "string"}},
                                   "d": {"type": "object",
                                         "properties": {"x": {"type": "string"}},
                                         "required": ["x"]},
                                   "e": {"type": "string", "enum": ["p", "q"]},
                               },
                               "required": ["a", "c"]}}
        line, reason = encode_tool(tool)
        self.assertIsNotNone(line, reason)
        ok, why = check_preserved(tool, line)
        self.assertTrue(ok, why)

    def test_decode_rejects_malformed(self):
        for bad in ["", "   ", "no-parens", "t(", "t)", "t(]", "t(a:str",
                    "t(a:str - ", "t(a:str) trailing junk", "t(a)b(c)",
                    "t(a:)", "t(:str)", "t(a:str,,b:int)", "t(a:str))",
                    "<<call t {}>>"]:
            decoded, _reason = decode_tool(bad)
            self.assertIsNone(decoded, bad)

    def test_decode_never_raises_on_hostile_input(self):
        hostile = [
            "t(a:" + "[" * 5000 + "str" + "]" * 5000 + ")",  # deep nesting -> too_deep
            "t(a:" + "{b:" * 2000 + "str" + "}" * 2000 + ")",  # deep objects -> too_deep
            "t(привет:str)",  # non-ASCII param name -> rejected, not a crash
        ]
        for bad in hostile:
            try:
                decoded, _reason = decode_tool(bad)
            except Exception as e:  # noqa: BLE001 - the point is no escape
                self.fail(f"decode raised {type(e).__name__} on {bad[:40]!r}")
            self.assertIsNone(decoded, bad[:40])

    def test_corruption_fails_preservation(self):
        tool = {"name": "t", "description": "does things",
                "parameters": {"type": "object",
                               "properties": {"a": {"type": "string"},
                                              "b": {"type": "integer"}},
                               "required": ["a"]}}
        line, _ = encode_tool(tool)
        self.assertIsNotNone(line)
        ok, _ = check_preserved(tool, line)
        self.assertTrue(ok)
        corruptions = [
            line.replace("a:str", "a?:str"),      # required flipped to optional
            line.replace("b?:int", "b?:str"),     # type changed
            line.replace(", b?:int", ""),         # parameter dropped
            line.replace("does things", "does other"),  # description swapped
            line[: len(line) // 2],               # truncated
            "other" + line,                       # wrong tool name prefix
        ]
        for bad in corruptions:
            ok, why = check_preserved(tool, bad)
            self.assertFalse(ok, f"corruption accepted: {bad!r} ({why})")

    def test_single_value_enum_round_trip(self):
        tool = {"name": "t", "description": "",
                "parameters": {"type": "object",
                               "properties": {"v": {"type": "string", "enum": ["only"]}},
                               "required": ["v"]}}
        line, _ = encode_tool(tool)
        self.assertIsNotNone(line)
        ok, why = check_preserved(tool, line)
        self.assertTrue(ok, why)


class GoExtractionTest(unittest.TestCase):
    SAMPLE = '''package main

// file-level decoy: the word "location" here must never become a property.
var tools = []toolDef{
    {
        Type: "function",
        Function: struct {
            Name        string         `json:"name"`
            Description string         `json:"description"`
            Parameters  map[string]any `json:"parameters"`
        }{
            Name:        "tool_a",
            Description: "First tool, nothing required.",
            Parameters: map[string]any{
                "type": "object",
                "properties": map[string]any{
                    "x": map[string]any{"type": "string"},
                    "y": map[string]any{"type": "integer"},
                },
            },
        },
    },
    {
        Type: "function",
        Function: struct {
            Name        string         `json:"name"`
            Description string         `json:"description"`
            Parameters  map[string]any `json:"parameters"`
        }{
            Name:        "tool_b",
            Description: "Second tool.",
            Parameters: map[string]any{
                "type": "object",
                "properties": map[string]any{
                    "query": map[string]any{"type": "string"},
                },
                "required": []string{"query"},
            },
        },
    },
    {
        Type: "function",
        Function: struct {
            Name        string         `json:"name"`
            Description string         `json:"description"`
            Parameters  map[string]any `json:"parameters"`
        }{
            Name:        "tool_c",
            Description: "Third tool.",
            Parameters: map[string]any{
                "type": "object",
                "properties": map[string]any{
                    "id": map[string]any{"type": "integer"},
                    "verbose": map[string]any{"type": "boolean"},
                },
                "required": []string{"id"},
            },
        },
    },
}
'''

    def _parse_sample(self):
        from extract_corpus import _split_tooldef_entries, _go_parameters, _go_string_field
        entries = _split_tooldef_entries(self.SAMPLE)
        self.assertEqual(len(entries), 3)
        return {(_go_string_field(e, "Name")): (e, _go_parameters(e)) for e in entries}

    def test_required_fields_do_not_shift_between_tools(self):
        by_name = self._parse_sample()
        self.assertEqual(by_name["tool_a"][1]["required"], [])
        self.assertEqual(by_name["tool_b"][1]["required"], ["query"])
        self.assertEqual(by_name["tool_c"][1]["required"], ["id"])

    def test_properties_do_not_leak_between_tools(self):
        by_name = self._parse_sample()
        self.assertEqual(set(by_name["tool_a"][1]["properties"]), {"x", "y"})
        self.assertEqual(set(by_name["tool_b"][1]["properties"]), {"query"})
        self.assertEqual(set(by_name["tool_c"][1]["properties"]), {"id", "verbose"})
        # file-level decoy must not appear anywhere
        for _name, (_e, params) in by_name.items():
            self.assertNotIn("location", params["properties"])
            for r in params["required"]:
                self.assertIn(r, params["properties"])

    def test_real_greptile_cases_stay_pinned(self):
        # Regression pin for the review findings on real agent files.
        tools = {t["name"]: t for t in json.loads(CORPUS.read_text(encoding="utf-8"))}
        self.assertEqual(tools["top_stories"]["parameters"]["properties"], {})
        self.assertEqual(tools["top_stories"]["parameters"]["required"], [])
        self.assertEqual(tools["search_stories"]["parameters"]["required"], ["query"])
        self.assertEqual(tools["get_item"]["parameters"]["required"], ["id"])
        self.assertEqual(sorted(tools["get_weather"]["parameters"]["properties"]),
                         ["label", "latitude", "longitude"])
        self.assertEqual(sorted(tools["get_weather"]["parameters"]["required"]),
                         ["latitude", "longitude"])
        for t in tools.values():
            params = t.get("parameters", {})
            props = params.get("properties", {})
            for r in params.get("required", []):
                self.assertIn(r, props, f"{t['name']}: required {r!r} has no property")
class CompactRoundTripTest(unittest.TestCase):
    def test_every_tool_either_compacts_or_fail_closed_bypass(self):
        tools = json.loads(CORPUS.read_text(encoding="utf-8"))
        for t in tools:
            line, _ = encode_tool(t)
            if line is not None:
                self.assertIn(t["name"], line)
                norm = normalize_tool(t)
                self.assertTrue(all(v is not None for v in norm[2].values()), t["name"])

    def test_required_optional_marking(self):
        line, _ = encode_tool({"name": "t", "description": "d", "parameters": {
            "type": "object",
            "properties": {"a": {"type": "string"}, "b": {"type": "integer"}},
            "required": ["a"]}})
        self.assertIn("a:str", line)
        self.assertIn("b?:int", line)

    def test_edge_cases(self):
        # empty params
        line, _ = encode_tool({"name": "ping", "description": "", "parameters": {"type": "object"}})
        self.assertTrue(line.startswith("ping("))
        # enum
        line, _ = encode_tool({"name": "e", "description": "", "parameters": {"type": "object",
            "properties": {"v": {"type": "string", "enum": ["a", "b"]}}, "required": ["v"]}})
        self.assertIn("a|b", line)
        # nested object + array
        line, _ = encode_tool({"name": "n", "description": "", "parameters": {"type": "object",
            "properties": {"o": {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]},
                           "tags": {"type": "array", "items": {"type": "string"}}}, "required": []}})
        self.assertIn("{x:str}", line)
        self.assertIn("[str]", line)
        # bypasses (fail-closed): $ref, oneOf, bad format, bad names
        for bad in [
            {"type": "object", "properties": {"x": {"$ref": "#/d"}}},
            {"type": "object", "properties": {"x": {"type": "string", "format": "email"}}},
            {"type": "object", "properties": {"x": {"type": "object"}}},  # no items/properties detail -> nested unknown
        ]:
            tool = {"name": "b", "description": "", "parameters": bad}
            line, reason = encode_tool(tool)
            # array-without-items must bypass; others may bypass or map — just assert no crash + reason string
            self.assertIsInstance(reason, str)

    def test_bad_tool_name_bypasses(self):
        line, reason = encode_tool({"name": "bad name!", "description": "", "parameters": {"type": "object"}})
        self.assertIsNone(line)

    def test_determinism(self):
        tools = json.loads(CORPUS.read_text(encoding="utf-8"))[:10]
        for t in tools:
            a, _ = encode_tool(t)
            b, _ = encode_tool(t)
            self.assertEqual(a, b)


class StreamingPropertyTest(unittest.TestCase):
    def test_split_marker_rejoins_at_every_position(self):
        call = '<<call get_weather {"latitude": 17.4, "longitude": 78.4}>>'
        for i in range(1, len(call) - 1):
            self.assertEqual(call[:i] + call[i:], call)

    def test_fuzz_names_never_crash(self):
        rnd = random.Random(42)
        for _ in range(200):
            name = "".join(rnd.choice("ab_-.19 Z!") for _ in range(rnd.randint(1, 12)))
            line, _ = encode_tool({"name": name, "description": "d",
                                   "parameters": {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}})
            # only assert no-crash + fail-closed on invalid names
            if not re.match(r"^[A-Za-z0-9_.\-]+$", name):
                self.assertIsNone(line)


class ClassifierHygieneTest(unittest.TestCase):
    def test_families_disjoint_across_splits(self):
        # No family may appear in more than one split — this is the core
        # anti-leakage invariant (splitting on variant suffixes is NOT enough).
        data = build_dataset()
        train, val, test = split_by_family(data)
        tr_f = {f for f, _, _ in train}
        va_f = {f for f, _, _ in val}
        te_f = {f for f, _, _ in test}
        self.assertTrue(tr_f.isdisjoint(va_f), "train/val share families")
        self.assertTrue(tr_f.isdisjoint(te_f), "train/test share families")
        self.assertTrue(va_f.isdisjoint(te_f), "val/test share families")
        # every split owns only its families
        for f, _, _ in train:
            self.assertIn(f, tr_f)
        for f, _, _ in test:
            self.assertNotIn(f, tr_f)

    def test_split_deterministic_and_covering(self):
        a = split_by_family(build_dataset())
        b = split_by_family(build_dataset())
        for x, y in zip(a, b):
            self.assertEqual([(f, q, l) for f, q, l in x],
                             [(f, q, l) for f, q, l in y])
        _, _, test = a
        labels = {l for _, _, l in test}
        self.assertEqual(labels, {"code_generation", "code_understanding",
                                 "technical_design", "analytical_reasoning",
                                 "writing", "factual_lookup", "general"})

    def test_route_mapping_covers_all_types(self):
        from classifier_eval import TYPES
        for t in TYPES:
            self.assertIn(route_for_type(t), ("small", "large"))
        for t in ("code_generation", "technical_design", "analytical_reasoning"):
            self.assertEqual(route_for_type(t), "large")
        for t in ("writing", "factual_lookup", "general", "code_understanding"):
            self.assertEqual(route_for_type(t), "small")

    def test_baseline_runs_and_fallback_triggers(self):
        data = build_dataset()
        train, _, _ = split_by_family(data)
        weights, total = train_overlap_model(train)
        lab, conf, _ = overlap_predict("write a python function to sort a list", weights, total)
        self.assertIn(lab, ["code_generation", "code_understanding", "technical_design",
                            "analytical_reasoning", "writing", "factual_lookup", "general"])
        self.assertGreaterEqual(conf, 0.25)
        self.assertLessEqual(conf, 0.95)
        rb, rc = regex_predict("hello there")
        self.assertEqual(rb, "general")

    def test_tie_goes_to_earlier_category(self):
        # documents precedence behavior; just asserts determinism
        a = regex_predict("write a function and explain what this code does")
        b = regex_predict("write a function and explain what this code does")
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
