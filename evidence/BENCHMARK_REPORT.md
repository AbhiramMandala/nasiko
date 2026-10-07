# Benchmark Report

Reproduce everything (from the repository root — the folder containing `evidence/`):
`python evidence/run_all.py`.

## Executive Summary

The default compact representation reduces serialized tool size by **58.6% on 56 real tools**
(mean of per-tool reductions; 57.6% ratio of totals)
while preserving normalized semantics across the evaluated corpus —
verified by decoding every compact string and comparing
normalized(decoded) against normalized(original).

- **100% semantic preservation** via real encode → decode → compare (55/55 compacted)
- **55/56 successful compaction**, 1 unsupported case safely falls back to native (fail-closed)
- Optional aggressive profile: **74.1%** average reduction, same decode-verified invariants
- Reproducible one-command benchmark; **30/30 evidence tests pass**

## Why this matters

Tool schemas dominate prompt bytes on tool-heavy agent turns. Cutting them by more than
half — deterministically, without changing which calls validate — lowers cost and latency
on every routed request while the fail-closed bypass guarantees no tool is ever silently
redefined. The classifier/evaluation infrastructure makes the routing side reproducible
rather than anecdotal.

## Methodology

- Corpus: `evidence/corpus_tools.json` — 56 tools extracted from
  the repo's `agents/` directory (`extract_corpus.py`; every parseable tool included, no cherry-pick).
  Each Go tool is parsed from its own brace-matched toolDef block (name, description,
  properties, types, required all scoped to that block); anything unparseable is
  skipped loudly, never invented. Rust `json!` blocks are parsed as real JSON.
- Baseline: canonical JSON bytes of the OpenAI-style tool definition
  (`json.dumps`, `sort_keys`, compact separators).
- Compact: renderer following PR #214 grammar — `name(p:ty, q?:ty) - description`,
  `?` = optional, enums `a|b`, arrays `[t]`, nested objects `{...}`.
  Unsupported schemas (`$ref`, broad `oneOf`/`anyOf`, non-date formats, bad names)
  bypass to native instead of being approximated.
- Preservation: `decode_tool` parses each produced compact string back into a tool
  dict; the case passes only if normalized(decoded) equals normalized(original)
  plus an exact tool-description match. `decode_ms` covers only tools where a real
  decode ran (bypassed tools have no compact string).
- Tokens: bytes/chars are exact. `chars/4` appears only as a labeled heuristic —
  never as `o200k_base`. The Rust-side evaluator example
  (`llm-router/examples/compact_tools_eval`) is not present in this checkout
  (only `mint_token.rs` ships here), so no tokenizer command in this repo can
  produce authoritative counts; see Limitations.
- Classifier: family-disjoint train/val/test splits (no template family appears in
  more than one split; asserted in code and tests); thresholds tuned on validation
  only; test evaluated once. Predicted type and route are recorded separately —
  low-confidence fallback routes large without relabeling the prediction. All
  datasets are synthetic (see Classifier Evaluation).

## Results

### Compact — default profile
| Metric | Value |
|---|---|
| Tools | 56 real |
| Baseline → compact | 24,641 → 10,447 bytes |
| Average reduction | **58.6%** mean of per-tool reductions (57.6% ratio of totals) |
| Median / best / worst | 60.3% / 77.1% / 23.1% |
| Compacted | 55/56 (1 fail-closed bypass: `search_food`, space in enum value) |
| Encode / decode | ~0.006ms / ~0.02ms per tool (decode over the 55 decoded tools) |

### Compact — aggressive profile (optional, NOT default)
| Profile | Avg | Median | Best | Worst | Preserved | Fallback |
|---|---|---|---|---|---|---|
| Default | 58.6% (57.6% of totals) | 60.3% | 77.1% | 23.1% | 100% (55/55) | 1/56 |
| Aggressive | 74.1% | 75.5% | 86.0% | 0.0%* | 100% (55/55) | 1/56 |

*0.0% = the single bypassed tool, sent native in both profiles (correct behavior).
Aggressive trims tool-description hint text only; parameter semantics are identical,
verified through the same decoder (decoded description must equal the trimmed
expectation).

## Semantic Validation

Normalization compares (tool name, required-set, parameter types, enum values) —
the exact contract the decoder enforces. Field *descriptions* are elided by design
(documented in PR #214); tool descriptions are retained (trimmed in aggressive mode).
A case passes only if the decoded compact string round-trips exactly; corrupted
strings (flipped required marks, changed types, dropped parameters, swapped or
truncated text) fail by construction. Malformed markers fail closed; streaming
split-markers rejoin exactly (tested at every split position).

## Classifier Evaluation

### Templated benchmark (1,152; train 648 / val 256 / test 248, family-disjoint)
| System | Accuracy | F1 | Route acc | Fallback |
|---|---|---|---|---|
| baseline_regex (proxy) | 1.0000 | 1.0000 | 1.0000 | 0 |
| improved_overlap | 0.6774 | 0.3853 | 0.7097 | 0.1694 |
Family-disjoint splits removed the old template-memorization leak: the regex proxy
(matches its own template vocabulary) holds at 1.0 while the unigram overlap model
drops to 0.68 type accuracy — but keeps 0.71 route accuracy, since many confusions
stay within the same tier. Optimistic for the regex baseline by construction;
proves plumbing, split hygiene, and fallback mechanics — not generalization.

### Realistic benchmark (synthetic-realistic-v2, 1,197; train 704 / val 246 / test 247)
| System | Accuracy | F1 | Route acc | Fallback | Large% |
|---|---|---|---|---|---|
| baseline_regex (proxy) | 0.9474 | 0.9453 | 0.9474 | 0 | 38.1 |
| overlap_v1 | 0.2955 | 0.1636 | 0.7126 | 0.0202 | 64.0 |
| improved_v2 (bigrams+stems+shape+hybrid, val-tuned) | 0.2753 | 0.1991 | 0.5789 | 0.0364 | 23.9 |
Balanced 171-per-type coverage with 27 adversarial cases in test. The learned
models collapse on unseen families (type accuracy ~0.28–0.30) while the regex
proxy holds — an honest negative result about memorization vs generalization.
Honest negative result on v2 as well: validation-selected regex_weight=2.0 does
not beat v1 on test (route 0.58 vs 0.71). These are NOT generalization numbers.

### Reference result
Winner PR #319 reports ~86% on 154 held-out **human-labeled** examples
(1,806 train, CV + leakage guard). Our datasets are synthetic/constructed, so we
**do NOT claim to beat the reference**. Beating it requires independent human labels.

## End-to-End Router Economics

Cost model (documented placeholders, not billing): small=1 unit/400ms,
large=10 units/1800ms per request + measured classifier ms. Costs use the actual
route (fallback → large), never the predicted class.
Improved router: ~3.15 estimated units/req vs 10.0 always-large (**~68% lower estimated routing cost**
at 0.58 route accuracy on this synthetic set).
Quality is a routing-accuracy proxy (correct tier) — actual LLM answer quality
was NOT measured (no API key available) and is not claimed.

## Reproduction

```powershell
python evidence/run_all.py                  # full benchmark + 30 tests + 6 charts + summary
python evidence/demo.py                     # live measured demo (incl. fallback case)
python -m unittest discover -s evidence/tests
```

Charts: `evidence/charts/` (compact bars, reduction histogram, accuracy,
confusion matrix, aggressive comparison, realistic accuracy).

## Limitations

1. No authoritative `o200k_base` result in this environment (missing Rust/MSVC
   toolchain AND the evaluator example; blocker + unblock steps in
   `evidence/tokenizer_blocker.json`).
2. Human classifier labels still unavailable — reference comparison is methodological only.
3. LLM answer quality was not directly measured.
4. Aggressive profile's hint-text tradeoff remains to be quantified live.
5. Learned-classifier type accuracy on unseen families is poor (~0.28–0.68);
   only the regex proxy and tier-level routing hold up — reported as measured.
