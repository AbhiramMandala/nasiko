"""PRIORITY 1 artifact: authoritative tokenizer benchmark blocker.

Checked 2026-10-06 on this Windows machine:
- No cargo/rustc/rustup installed.
- No MSVC link.exe / cl.exe, no Visual Studio Build Tools.
- Workspace uses edition = "2024" (needs Rust 1.85+ stable) plus native
  deps (ring/OpenSSL via reqwest/sqlx) that require MSVC linkers on Windows.
- Evaluator contract: EVAL_SET + OUT env, `cargo run --release -p
  nasiko-llm-router --example compact_tools_eval` (offline deterministic;
  live mode needs PROVIDER_BASE_URL + MODEL + key).
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

BLOCKER = {
    "status": "BLOCKED",
    "date": "2026-10-06",
    "machine": "Windows, no cargo/rustc/rustup, no MSVC link.exe/cl.exe, no VS Build Tools",
    "workspace_requirement": 'edition = "2024" (Rust 1.85+), native deps need MSVC linkers on Windows',
    "evaluator": "cargo run --release -p nasiko-llm-router --example compact_tools_eval (EVAL_SET + OUT env)",
    "eval_set_reachable": True,
    "missing": ["rust-toolchain", "msvc-linkers", "full pr-214 checkout (tool-compact/, llm-router/)"],
    "unblock_steps": [
        "winget install Rustlang.Rustup + VS Build Tools C++ workload",
        "git sparse-checkout add llm-router tool-compact && git checkout pr-214 -- llm-router tool-compact",
        "curl -fsSL https://registry.nasiko.dev/r/nasiko/compact-tools-eval -o /tmp/compact-tools-eval.json",
        "EVAL_SET=/tmp/compact-tools-eval.json OUT=/tmp/out.jsonl cargo run --release -p nasiko-llm-router --example compact_tools_eval",
    ],
    "standing_result": "57.0% avg byte reduction on 56 real tools (exact, reproducible via python evidence/run_all.py)",
}

if __name__ == "__main__":
    out = Path(__file__).resolve().parent / "tokenizer_blocker.json"
    out.write_text(json.dumps(BLOCKER, indent=2), encoding="utf-8")
    print(f"blocker recorded -> {out}")
