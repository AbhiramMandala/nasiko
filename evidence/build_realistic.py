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

Coverage (enforced, not ordered): per-type quotas guarantee every type —
especially general/ambiguous — is represented. Terse/ambiguous templates are
tagged adversarial=True.

Family = one template. Splits are assigned per family (stratified per type,
seeded) so no template's phrasings straddle train/val/test. Test ids are
locked; eval scripts must tune ONLY on val.

Output: evidence/classifier_realistic.jsonl (one JSON object per line).
"""

import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "classifier_realistic.jsonl"

SOURCE = "synthetic-realistic-v2"
SPLIT_SEED = 20261007
TOTAL_TARGET = 1200
MIN_GENERAL = 150
MIN_ADVERSARIAL_IN_TEST = 10

LARGE = {"code_generation", "technical_design", "analytical_reasoning"}

# (type, template, adversarial). Adversarial = terse/ambiguous/mixed items
# that exercise the fallback path.
BANK = [
    ("code_generation", "write me a python func that dedupes a csv by id", False),
    ("code_generation", "pls fix the null email crash in clean_csv_file", False),
    ("code_generation", "implement retry with backoff for the coin api call", False),
    ("code_generation", "refactor dispatchTool switch into a map, keep errors as content", False),
    ("code_generation", "my script throws KeyError on rates['EUR'] — handle it", False),
    ("code_generation", "generate rust code for streaming decode of <<call >> markers", False),
    ("code_generation", "here's my code:\n{CODE}\nwhy does it drop the last row?", False),
    ("code_generation", "add validation for required fields before deploy", False),
    ("code_generation", "write a test for split-marker rejoin at every position", False),
    ("code_generation", "convert this curl into a python function with timeout", False),
    ("code_understanding", "what does build_and_deploy actually do on re-import?", False),
    ("code_understanding", "explain refresh_secrets reinjection like i'm new", False),
    ("code_understanding", "walk me through the StreamDecoder state machine", False),
    ("code_understanding", "this function returns 502 — what path causes that?", False),
    ("code_understanding", "what's the difference between route_model and route_model_with?", False),
    ("technical_design", "how should i design the eval harness so numbers can't be faked?", False),
    ("technical_design", "api design for opt-in compact profile without breaking callers?", False),
    ("technical_design", "trade-offs: byte vs token measurement for the PR claim", False),
    ("technical_design", "design a fail-closed bypass that never guesses", False),
    ("technical_design", "should the threshold live in config or code? argue both", False),
    ("analytical_reasoning", "compare 46.4% vs 57.0% claims — are the denominators even the same?", False),
    ("analytical_reasoning", "analyze why overlap hits 100% on templates but would drop live", False),
    ("analytical_reasoning", "pros and cons of chars/4 heuristic vs real tokenizer", False),
    ("analytical_reasoning", "reason step by step: is 1 bypass out of 56 a safety win or gap?", False),
    ("analytical_reasoning", "which is more honest: lower measured number or higher estimate?", False),
    ("writing", "draft the PR description section for methodology", False),
    ("writing", "rewrite this benchmark paragraph more clearly", False),
    ("writing", "summarize the evidence report for a judge in 5 lines", False),
    ("writing", "write a release note for the aggressive profile experiment", False),
    ("factual_lookup", "what's the default port nasiko server runs on", False),
    ("factual_lookup", "when did PR 214 open", False),
    ("factual_lookup", "who owns the nasiko repo org", False),
    ("factual_lookup", "define fail-closed in one line", False),
    ("factual_lookup", "what does ECE measure", False),
    ("general", "hi", False),
    ("general", "thanks for the help", False),
    ("general", "what can you do?", False),
    ("general", "good morning", False),
    ("general", "lol that chart is nice", False),
    ("general", "ok run it again", False),
    ("code_generation", "write AND explain a validator for AgentCard.json", True),
    ("code_generation", "urgent: deploy failing, fix it and tell me why", True),
    ("code_generation", "pls", True),
    ("general", "pls", True),
    ("general", "?", True),
    ("general", "deploy?", True),
    ("general", "hmm", True),
    ("general", "asdf test", True),
    ("general", "write something", True),
]

CODE = "def clean(rows):\n    seen=set()\n    out=[]\n    for r in rows:\n        if r[0] in seen: continue\n        seen.add(r[0]); out.append(r)\n    return out"

PREFIXES = ["", "please ", "hey, ", "quick q: ", "urgent: ", "fyi "]
SUFFIXES = ["", " please", "?", " thanks!", " asap", " now?"]


def family_of(idx):
    return f"rx-t{idx:03d}"


def assign_splits():
    """Family -> split, stratified per type with a fixed seed.

    Every type keeps representation in train/val/test; no family appears in
    more than one split. Deterministic across runs.
    """
    by_type = {}
    for idx, (tlabel, _t, _a) in enumerate(BANK):
        by_type.setdefault(tlabel, []).append(idx)
    rnd = random.Random(SPLIT_SEED)
    fam_split = {}
    for tlabel in sorted(by_type):
        idxs = sorted(by_type[tlabel])
        rnd.shuffle(idxs)
        n = len(idxs)
        n_test = max(1, round(n * 0.2)) if n >= 3 else (1 if n == 2 else 0)
        n_val = max(1, round(n * 0.2)) if n >= 4 else (1 if n == 3 else 0)
        for i in idxs[:n_test]:
            fam_split[family_of(i)] = "test"
        for i in idxs[n_test:n_test + n_val]:
            fam_split[family_of(i)] = "val"
        for i in idxs[n_test + n_val:]:
            fam_split[family_of(i)] = "train"
    return fam_split


def main() -> int:
    fam_split = assign_splits()
    # Per-type quotas: total target spread evenly; general gets its floor.
    types = sorted({t for t, _t, _a in BANK})
    quota = {t: TOTAL_TARGET // len(types) for t in types}
    quota["general"] = max(quota["general"], MIN_GENERAL)
    counts = {t: 0 for t in types}
    # Round-robin over templates so no ordering of BANK can starve a category.
    order = sorted(range(len(BANK)), key=lambda i: (BANK[i][0], i))
    items = []
    n = 0
    progress = True
    while progress:
        progress = False
        for idx in order:
            tlabel, t, adv = BANK[idx]
            if counts[tlabel] >= quota[tlabel]:
                continue
            text = t.replace("{CODE}", CODE)
            p = PREFIXES[(n // len(SUFFIXES)) % len(PREFIXES)]
            s = SUFFIXES[n % len(SUFFIXES)]
            q = (p + text + s).strip().replace("??", "?")
            iid = f"rx-{n:04d}"
            items.append({"id": iid, "family": family_of(idx), "question": q,
                          "type": tlabel,
                          "expected_route": "large" if tlabel in LARGE else "small",
                          "adversarial": adv,
                          "source": SOURCE,
                          "split": fam_split[family_of(idx)]})
            counts[tlabel] += 1
            n += 1
            progress = True
            if sum(counts.values()) >= sum(quota.values()):
                break
        if sum(counts.values()) >= sum(quota.values()):
            break
    # Deterministic file order (splits already assigned by family).
    rnd = random.Random(SPLIT_SEED)
    rnd.shuffle(items)
    with OUT.open("w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")
    # Coverage contract: fail loudly instead of shipping a skewed dataset.
    from collections import Counter
    by_type_split = Counter((i["type"], i["split"]) for i in items)
    for t in types:
        assert sum(by_type_split[(t, s)] for s in ("train", "val", "test")) >= min(quota[t], 50), \
            f"category {t} under quota"
        assert by_type_split[(t, "test")] > 0, f"category {t} missing from test"
    assert counts["general"] >= MIN_GENERAL, "general coverage floor missed"
    adv_test = sum(1 for i in items if i["split"] == "test" and i["adversarial"])
    assert adv_test >= MIN_ADVERSARIAL_IN_TEST, \
        f"only {adv_test} adversarial items in test; fallback unevaluated"
    # Family disjointness across splits.
    fams = {}
    for i in items:
        fams.setdefault(i["family"], set()).add(i["split"])
    assert all(len(v) == 1 for v in fams.values()), "family spans splits"
    print(f"wrote {len(items)} items -> {OUT} {dict(Counter(i['split'] for i in items))}")
    print(f"per-type: {dict(Counter(i['type'] for i in items))}; adversarial in test: {adv_test}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
