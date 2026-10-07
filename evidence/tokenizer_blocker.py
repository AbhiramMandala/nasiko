"""PRIORITY 1 artifact: authoritative tokenizer benchmark blocker.

Checked 2026-10-06 on this Windows machine:
- No cargo/rustc/rustup installed.
- No MSVC link.exe / cl.exe, no Visual Studio Build Tools.
- Workspace uses edition = "2024" (needs Rust 1.85+ stable) plus native
  deps (ring/OpenSSL via reqwest/sqlx) that require MSVC linkers on Windows.
- Evaluator contract: EVAL_SET + OUT env, `cargo run --release -p
  nasiko-llm-router --example compact_tools_eval` (offline deterministic;
  live mode needs PROVIDER_BASE_URL + MODEL + key).
  NOTE: that example file is NOT in this checkout (verified 2026-10-07:
  llm-router/examples/ contains only mint_token.rs; the compact evaluator
  lives with the Rust-side compact-tools work). Adding a Rust evaluator plus
  a tokenizer dependency to this Python-only evidence harness is out of scope
  here — and unverifiable without a toolchain — so this benchmark documents
  the gap instead of pointing at a runnable local command.
- Private EVAL_SET URL IS reachable (HTTP 200), but without a toolchain and
  without the full pr-214 checkout (tool-compact/, llm-router/ sparse-missing)
  the run cannot be performed here.

Conclusion: authoritative o200k_base measurement BLOCKED on this machine.
Byte benchmark (exact, reproducible) stands as the verified result.
To unblock: install Rust 1.85+ via rustup + VS Build Tools (C++ workload),
checkout pr-214 fully, fetch EVAL_SET, run the offline evaluator, then the
live mode with a provider key. No numbers are fabricated in the meantime.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _standing_result():
    # Read the verified numbers from the generated benchmark — never hard-code
    # them here, so this record cannot drift from the evidence.
    try:
        rep = json.loads((HERE / "compact_report.json").read_text(encoding="utf-8"))
        return (f"{rep['avg_reduction_pct']}% avg byte reduction on "
                f"{rep['n_tools']} real tools "
                f"(exact, reproducible via python evidence/run_all.py)")
    except (OSError, KeyError, json.JSONDecodeError):
        return "compact benchmark not yet run (python evidence/run_all.py)"


BLOCKER = {
    "status": "BLOCKED",
    "date": "2026-10-06",
    "machine": "Windows, no cargo/rustc/rustup, no MSVC link.exe/cl.exe, no VS Build Tools",
    "workspace_requirement": 'edition = "2024" (Rust 1.85+), native deps need MSVC linkers on Windows',
    "evaluator": "cargo run --release -p nasiko-llm-router --example compact_tools_eval (EVAL_SET + OUT env) — example absent from this checkout (llm-router/examples/ holds only mint_token.rs)",
    "eval_set_reachable": True,
    "missing": ["rust-toolchain", "msvc-linkers", "the evaluator example itself (not in this checkout)"],
    "unblock_steps": [
        "winget install Rustlang.Rustup + VS Build Tools C++ workload",
        "git sparse-checkout add llm-router tool-compact && git checkout pr-214 -- llm-router tool-compact",
        "curl -fsSL https://registry.nasiko.dev/r/nasiko/compact-tools-eval -o /tmp/compact-tools-eval.json",
        "EVAL_SET=/tmp/compact-tools-eval.json OUT=/tmp/out.jsonl cargo run --release -p nasiko-llm-router --example compact_tools_eval",
    ],
    "standing_result": _standing_result(),
}

if __name__ == "__main__":
    out = Path(__file__).resolve().parent / "tokenizer_blocker.json"
    out.write_text(json.dumps(BLOCKER, indent=2), encoding="utf-8")
    print(f"blocker recorded -> {out}")
