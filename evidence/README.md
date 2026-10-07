# Evidence harness — prove it, don't just claim it

Stdlib only. No install. Rust NOT required for this harness (Rust evals documented for CI).

```powershell
python evidence/run_all.py      # full benchmark + tests + charts (one command)
python evidence/demo.py         # live deterministic demo with measured numbers
python -m unittest discover -s evidence/tests -v
```
(run from the repository root — the folder that contains `evidence/`)

## Evidence at a glance

- **58.6% average compact reduction** (mean of per-tool; 57.6% ratio of totals) across 56 real tools
- **100% normalized semantic preservation via real decode**, 55/56 compacted + 1 safe fallback
- **74.1% optional aggressive profile** (same decode-verified invariants; hint-text tradeoff noted)
- **30/30 evidence tests passing**

Full numbers, methodology, and limitations: `BENCHMARK_REPORT.md`.

## What this is / is not

- IS: reproducible measurement on 56 REAL agent tools + 1,152 templated and 1,197
  realistic-synthetic classifier examples (family-disjoint splits), with fail-closed
  bypasses, real decode-verified preservation, latency, confusion matrices, SVG
  charts, and honest limits.
- IS NOT: o200k_base token counts (the Rust evaluator example is absent from
  this checkout — only `mint_token.rs` ships under `llm-router/examples/` —
  and no toolchain exists here; see `tokenizer_blocker.json`),
  nor human-label classifier accuracy (our synthetic 92–100% is explicitly NOT
  compared against the reference's ~86% on human labels).

## Layout

- `extract_corpus.py` → `corpus_tools.json` (56 tools from the repo's `agents/` directory)
- `compact_bench.py` → `compact_report.json` (default profile)
- `compact_aggressive.py` → `compact_aggressive_report.json` (optional profile)
- `classifier_eval.py` → `classifier_report.json` (templated, family-disjoint)
- `build_realistic.py` → `classifier_realistic.jsonl` (realistic v2, quotas + family splits)
- `classifier_realistic_eval.py` → `classifier_realistic_report.json`
- `tokenizer_blocker.py` → `tokenizer_blocker.json` (P1 blocker record)
- `make_charts.py` → `charts/*.svg` (6 charts)
- `demo.py` — live demo (reads reports; no hard-coded numbers)
- `run_all.py` — one-command Overall block (all values generated)
- `tests/` — 30 tests (decode round-trip + corruption, Go scoping, family hygiene, fallback routing)
- `BENCHMARK_REPORT.md` — PR-ready numbers + methodology + gaps
