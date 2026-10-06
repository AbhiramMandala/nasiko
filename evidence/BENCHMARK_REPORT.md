# Benchmark Report

Reproduce everything (from the repository root — the folder containing `evidence/`):
`python evidence/run_all.py`.

## Executive Summary

The default compact representation reduces serialized tool size by **57.0% on 56 real tools**
(mean of per-tool reductions; 56.3% ratio of totals)
while preserving normalized semantics across the evaluated corpus.

- **100% semantic preservation** (names + required + types + enums, 55/55 compacted)
- **55/56 successful compaction**, 1 unsupported case safely falls back to native (fail-closed)
- Optional aggressive profile: **73.2%** average reduction, same safety invariants
- Reproducible one-command benchmark; **17/17 evidence tests pass**

## Why this matters

Tool schemas dominate prompt bytes on tool-heavy agent turns. Cutting them by more than
half — deterministically, without changing which calls validate — lowers cost and latency
on every routed request while the fail-closed bypass guarantees no tool is ever silently
redefined. The classifier/evaluation infrastructure makes the routing side reproducible
rather than anecdotal.

## Methodology

- Corpus: `evidence/corpus_tools.json` — 56 tools extracted from
  the repo's `agents/` directory (`extract_corpus.py`; every parseable tool included, no cherry-pick).
- Baseline: canonical JSON bytes of the OpenAI-style tool definition
  (`json.dumps`, `sort_keys`, compact separators).
- Compact: renderer following PR #214 grammar — `name(p:ty, q?:ty) - description`,
  `?` = optional, enums `a|b`, arrays `[t]`, nested objects `{...}`.
  Unsupported schemas (`$ref`, broad `oneOf`/`anyOf`, non-date formats, bad names)
  bypass to native instead of being approximated.
- Tokens: bytes/chars are exact. `chars/4` appears only as a labeled heuristic —
  never as `o200k_base`. Authoritative tokens require
  `cargo run --release -p nasiko-llm-router --example compact_tools_eval` (blocked here; see Limitations).
- Classifier: strict train/val/test separation; thresholds tuned on validation only;
  test evaluated once. Both datasets are synthetic (see Classifier Evaluation).

## Results

### Compact — default profile
| Metric | Value |
|---|---|
| Tools | 56 real |
| Baseline → compact | 24,060 → 10,521 bytes |
| Average reduction | **57.0%** mean of per-tool reductions (56.3% ratio of totals) |
| Median / best / worst | 59.1% / 71.7% / 23.1% |
| Compacted | 55/56 (1 fail-closed bypass) |
| Encode / decode | ~0.006ms / ~0.007ms per tool |

### Compact — aggressive profile (optional, NOT default)
| Profile | Avg | Median | Best | Worst | Preserved | Fallback |
|---|---|---|---|---|---|---|
| Default | 57.0% (56.3% of totals) | 59.1% | 71.7% | 23.1% | 100% (55/55) | 1/56 |
| Aggressive | 73.2% | 74.6% | 86.0% | 0.0%* | 100% (55/55) | 1/56 |

*0.0% = the single bypassed tool, sent native in both profiles (correct behavior).
Aggressive trims tool-description hint text only; parameter semantics are identical.

## Semantic Validation

Normalization compares (tool name, required-set, parameter types, enum values) —
the exact contract the decoder enforces. Field *descriptions* are elided by design
(documented in PR #214); tool descriptions are retained (trimmed in aggressive mode).
A case passes only if the normalized form round-trips exactly. Malformed markers,
unknown tools, and type violations fail closed; streaming split-markers rejoin
exactly (tested at every split position).

## Classifier Evaluation

### Templated benchmark (1,808; train 1356 / val 226 / test 226)
| System | Accuracy | F1 | Fallback |
|---|---|---|---|
| baseline_regex (proxy) | 0.9248 | 0.8993 | 0 |
| improved_overlap | 1.0000 | 1.0000 | 0.0088 |
Optimistic by construction (shared template vocabulary). Proves plumbing only.

### Realistic benchmark (synthetic-realistic-v1, 1,200; train 845 / val 169 / test 186)
| System | Accuracy | F1 | Fallback | Large% |
|---|---|---|---|---|
| baseline_regex (proxy) | 0.7957 | 0.7121 | 0 | 58.6 |
| overlap_v1 | 1.0000 | 0.8571 | 0 | 59.7 |
| improved_v2 (bigrams+stems+shape+hybrid, val-tuned) | 1.0000 | 0.8571 | 0 | 59.7 |
Honest negative result: v2 did not improve over v1 here (validation selected
regex_weight=0.0). Both learned models still benefit from shared template
vocabulary — these are NOT generalization numbers.

### Reference result
Winner PR #319 reports ~86% on 154 held-out **human-labeled** examples
(1,806 train, CV + leakage guard). Our datasets are synthetic/constructed, so we
**do NOT claim to beat the reference**. Beating it requires independent human labels.

## End-to-End Router Economics

Cost model (documented placeholders, not billing): small=1 unit/400ms,
large=10 units/1800ms per request + measured classifier ms.
Improved router: ~6.37 estimated units/req vs 10.0 always-large (**~36% lower estimated routing cost**).
Quality is a routing-accuracy proxy (correct tier) — actual LLM answer quality
was NOT measured (no API key available) and is not claimed.

## Reproduction

```powershell
python evidence/run_all.py                  # full benchmark + 17 tests + 6 charts + summary
python evidence/demo.py                     # live measured demo (incl. fallback case)
python -m unittest discover -s evidence/tests
```

Charts: `evidence/charts/` (compact bars, reduction histogram, accuracy,
confusion matrix, aggressive comparison, realistic accuracy).

## Limitations

1. No authoritative `o200k_base` result in this environment (missing Rust/MSVC
   toolchain; blocker + unblock steps in `evidence/tokenizer_blocker.json`).
2. Human classifier labels still unavailable — reference comparison is methodological only.
3. LLM answer quality was not directly measured.
4. Aggressive profile's hint-text tradeoff remains to be quantified live.
