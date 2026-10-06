"""Build the REALISTIC (synthetic-adversarial, clearly labeled) classifier set.

NOT human labels. Every item is templated from legitimate project use cases
(coding agent, docs lookup, finance rates, weather, legal filings, HR dates,
paper search, devops CI, books, general chat) with diverse natural phrasings,
typos, terseness, mixed intents, and pasted-code contexts.

Labeling rubric (documented, deterministic):
- large: code_generation, technical_design, analytical_reasoning
- small: factual_lookup, writing, general
Routing labels follow the item's primary type; mixed-intent items are labeled
by the HARDER half (documented choice: route up on ambiguity).

Split by item id hash (stable): 70% train / 15% val / 15% test.
Test ids are locked; eval scripts must tune ONLY on val.

Output: evidence/classifier_realistic.jsonl (one JSON object per line).
Target: 600 items.
"""
import hashlib
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "classifier_realistic.jsonl"

LARGE = {"code_generation", "technical_design", "analytical_reasoning"}

# (type, phrasing templates) — deliberately varied: terse, polite, typo'd, mixed, pasted-code
BANK = [
    ("code_generation", [
        "write me a python func that dedupes a csv by id",
        "pls fix the null email crash in clean_csv_file",
        "implement retry with backoff for the coin api call",
        "refactor dispatchTool switch into a map, keep errors as content",
        "my script throws KeyError on rates['EUR'] — handle it",
        "generate rust code for streaming decode of <<call >> markers",
        "here's my code:\n{CODE}\nwhy does it drop the last row?",
        "add validation for required fields before deploy",
        "write a test for split-marker rejoin at every position",
        "convert this curl into a python function with timeout",
    ]),
    ("code_understanding", [
        "what does build_and_deploy actually do on re-import?",
        "explain refresh_secrets reinjection like i'm new",
        "walk me through the StreamDecoder state machine",
        "this function returns 502 — what path causes that?",
        "what's the difference between route_model and route_model_with?",
    ]),
    ("technical_design", [
        "how should i design the eval harness so numbers can't be faked?",
        "api design for opt-in compact profile without breaking callers?",
        "trade-offs: byte vs token measurement for the PR claim",
        "design a fail-closed bypass that never guesses",
        "should the threshold live in config or code? argue both",
    ]),
    ("analytical_reasoning", [
        "compare 46.4% vs 57.0% claims — are the denominators even the same?",
        "analyze why overlap hits 100% on templates but would drop live",
        "pros and cons of chars/4 heuristic vs real tokenizer",
        "reason step by step: is 1 bypass out of 56 a safety win or gap?",
        "which is more honest: lower measured number or higher estimate?",
    ]),
    ("writing", [
        "draft the PR description section for methodology",
        "rewrite this benchmark paragraph more clearly",
        "summarize the evidence report for a judge in 5 lines",
        "write a release note for the aggressive profile experiment",
    ]),
    ("factual_lookup", [
        "what's the default port nasiko server runs on",
        "when did PR 214 open",
        "who owns the nasiko repo org",
        "define fail-closed in one line",
        "what does ECE measure",
    ]),
    ("general", [
        "hi", "thanks!", "what can you do?", "good morning",
        "lol that chart is nice", "ok run it again",
    ]),
    # adversarial / mixed / ambiguous
    ("code_generation", [
        "write AND explain a validator for AgentCard.json",  # mixed: harder half wins
        "urgent: deploy failing, fix it and tell me why",  # mixed
        "pls",  # terse ambiguous -> labeled general? NO: keep as code? ambiguous items below
    ]),
    ("general", [
        "pls", "?", "deploy?", "hmm", "asdf test",
        "write something",  # ambiguous short
    ]),
]

CODE = "def clean(rows):\n    seen=set()\n    out=[]\n    for r in rows:\n        if r[0] in seen: continue\n        seen.add(r[0]); out.append(r)\n    return out"


def stable_split(iid: str) -> str:
    h = int(hashlib.sha256(iid.encode()).hexdigest(), 16) % 100
    if h < 70:
        return "train"
    if h < 85:
        return "val"
    return "test"


def main() -> int:
    rnd = random.Random(20261006)
    items = []
    n = 0
    # Expand: each template x several light mutations (case, punctuation, prefix)
    prefixes = ["", "please ", "hey, ", "quick q: ", "urgent: ", "fyi "]
    suffixes = ["", " please", "?", " thanks!", " asap", " now?"]
    for tlabel, tmps in BANK:
        for t in tmps:
            text = t.replace("{CODE}", CODE)
            for p in prefixes:
                for s in suffixes:
                    q = (p + text + s).strip()
                    # normalize duplicate punctuation
                    q = q.replace("??", "?")
                    iid = f"rx-{n:04d}"
                    route = "large" if tlabel in LARGE else "small"
                    items.append({"id": iid, "question": q, "type": tlabel,
                                  "expected_route": route,
                                  "source": "synthetic-realistic-v1",
                                  "split": stable_split(iid)})
                    n += 1
                    if n >= 1200:
                        break
                if n >= 1200:
                    break
            if n >= 1200:
                break
        if n >= 1200:
            break
    # shuffle deterministically within file (splits already assigned by id)
    rnd.shuffle(items)
    with OUT.open("w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")
    from collections import Counter
    c = Counter(i["split"] for i in items)
    print(f"wrote {len(items)} items -> {OUT} {dict(c)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
