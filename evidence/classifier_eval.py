"""Transparent classifier evaluation (stdlib only, reproducible).

Dataset: templated questions across 7 request types, generated from paraphrase
families (one family = one template; its slot phrasings stay together).
Split is FAMILY-DISJOINT and stratified per type with a fixed seed: no family
appears in more than one of train/validation/test, so test templates are
genuinely unseen during training and tuning.

Systems:
- baseline_regex: Python port of PR #240/CATEGORY_PATTERNS heuristics
  (keyword votes, tie -> earlier category wins, default general).
  Labeled as PROXY — authoritative numbers need `cargo test -p nasiko-llm-router`.
- improved: word-overlap scorer trained on TRAIN only (per-type word weights
  + complexity heuristic + confidence), with low-confidence fallback.

Fallback routes to the LARGE tier (strong model): predicted_type is preserved
as the classifier's actual prediction while route records where the request
goes. Cost uses the route, never the predicted class.

Metrics: accuracy, macro precision/recall/F1 (on predicted types), route
accuracy, confusion matrix, fallback rate, routing split (small vs large),
all on TEST (unseen families).

Outputs: evidence/classifier_report.json
"""
import json
import math
import random
import re
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORT = HERE / "classifier_report.json"

TYPES = ["code_generation", "code_understanding", "technical_design",
         "analytical_reasoning", "writing", "factual_lookup", "general"]

# Each family: (type, templates with {X} slots, slot values)
FAMILIES = [
    ("code_generation", ["write a {L} function to {T}", "implement {T} in {L}", "build a {L} script for {T}", "generate {L} code that {T}", "refactor this {L} code to {T}"],
     {"L": ["python", "rust", "typescript", "go", "java"], "T": ["sort a list", "parse json", "handle errors", "fetch an api", "validate input", "retry requests"]}),
    ("code_generation", ["fix this bug in {T}", "add error handling to {T}", "create an api endpoint for {T}"],
     {"T": ["login", "uploads", "payments", "search", "notifications"]}),
    ("code_understanding", ["explain what this {C} does", "what does this {C} do", "walk me through this {C}", "how does this {C} work", "what is this code doing here"],
     {"C": ["function", "script", "class", "code", "module"]}),
    ("technical_design", ["how should i design {S}", "design a {S} for {U}", "{S} design for {U}", "explain the trade-offs of {S}"],
     {"S": ["an api", "a database schema", "a service", "a system"], "U": ["payments", "search", "auth", "uploads"]}),
    ("analytical_reasoning", ["compare {A} vs {B} for {U}", "analyze why {E}", "what are the pros and cons of {A}", "reason about {E} step by step"],
     {"A": ["postgres", "redis"], "B": ["sqlite", "memory cache"], "U": ["caching", "queues"], "E": ["this latency spike", "the retry storm"]}),
    ("writing", ["write a blog post about {T}", "draft an email about {T}", "summarize {T} in plain words", "rewrite {T} more clearly"],
     {"T": ["the release", "onboarding", "the outage", "pricing"]}),
    ("factual_lookup", ["what is the capital of {P}", "when was {E}", "who wrote {B}", "define {W}"],
     {"P": ["france", "japan", "egypt"], "E": ["the release", "v2"], "B": ["this book"], "W": ["throughput", "latency"]}),
    ("general", ["hi there", "thanks for the help", "what can you do", "tell me a joke about {T}", "good morning"],
     {"T": ["robots", "caching"]}),
]

# Regex proxy patterns (port of CATEGORY_PATTERNS precedence)
PATTERNS = [
    ("code_generation", [r"write.*function|implement|refactor|fix (this|the) bug|add error handling|generate.*code|build.*script"]),
    ("code_understanding", [r"explain what|what does.*(function|code|script|class) do|walk me through|what is this code doing|how does.*(function|code).*work"]),
    ("technical_design", [r"how should i design|design a|architecture|trade-?offs?"]),
    ("analytical_reasoning", [r"compare .* vs|pros and cons|analyze why|reason.*step by step"]),
    ("writing", [r"write a blog|draft an email|summarize|rewrite"]),
    ("factual_lookup", [r"what is the capital|when was|who wrote|^define "]),
]
COMPILED = [(t, [re.compile(p, re.I) for p in ps]) for t, ps in PATTERNS]


LARGE_TYPES = ("code_generation", "technical_design", "analytical_reasoning")

SPLIT_SEED = 20261007
PER_FAMILY_CAP = 64


def route_for_type(predicted_type):
    """Tier routing: hard/complex types go large, the rest go small."""
    return "large" if predicted_type in LARGE_TYPES else "small"


def build_dataset():
    """One family = one template; all of its phrasings share a family id."""
    examples = []  # (family_id, text, label)
    variants = ["{}", "please {}", "{} please", "can you {}",
                "{} now", "{} thanks", "urgently {}", "{} asap"]
    for fid, (label, tmps, slots) in enumerate(FAMILIES):
        for ti, t in enumerate(tmps):
            fam = f"f{fid}t{ti}"
            keys = re.findall(r"\{(\w+)\}", t)
            combos = _expand_combos(keys, slots)
            n = 0
            for c in combos:
                try:
                    q = t.format(**c)
                except KeyError:
                    continue
                for v in variants:
                    examples.append((fam, v.format(q), label))
                    n += 1
                    if n >= PER_FAMILY_CAP:
                        break
                if n >= PER_FAMILY_CAP:
                    break
    return examples


def _expand_combos(keys, slots):
    combos = []

    def rec(i, cur):
        if i == len(keys):
            combos.append(dict(cur))
            return
        for v in slots.get(keys[i], [""]):
            cur[keys[i]] = v
            rec(i + 1, cur)
    rec(0, {})
    return combos


def split_by_family(examples, seed=SPLIT_SEED):
    """Family-disjoint stratified split: no family in more than one split.

    Families are grouped by type, shuffled with a fixed seed, and divided
    ~70/15/15 per type (minimum one validation and one test family per type
    when the type has enough families). Deterministic across runs.
    """
    fams_by_type = {}
    for f, _q, l in examples:
        fams_by_type.setdefault(l, set()).add(f)
    rnd = random.Random(seed)
    train_f, val_f, test_f = set(), set(), set()
    for label in sorted(fams_by_type):
        fams = sorted(fams_by_type[label])
        rnd.shuffle(fams)
        n = len(fams)
        if n >= 4:
            n_test = max(1, round(n * 0.15))
            n_val = max(1, round(n * 0.15))
        elif n == 3:
            n_test, n_val = 1, 1
        elif n == 2:
            n_test, n_val = 1, 0
        else:
            n_test, n_val = 0, 0
        test_f.update(fams[:n_test])
        val_f.update(fams[n_test:n_test + n_val])
        train_f.update(fams[n_test + n_val:])
    assert train_f.isdisjoint(val_f), "family leak: train/val share families"
    assert train_f.isdisjoint(test_f), "family leak: train/test share families"
    assert val_f.isdisjoint(test_f), "family leak: val/test share families"
    train = [(f, q, l) for f, q, l in examples if f in train_f]
    val = [(f, q, l) for f, q, l in examples if f in val_f]
    test = [(f, q, l) for f, q, l in examples if f in test_f]
    return train, val, test


def regex_predict(q):
    ql = q.lower()
    for label, regs in COMPILED:
        for r in regs:
            if r.search(ql):
                return label, 0.55
    return "general", 0.30


def train_overlap_model(train):
    weights = {t: Counter() for t in TYPES}
    for _, q, l in train:
        for w in re.findall(r"[a-z]+", q.lower()):
            weights[l][w] += 1
    # convert to log-odds-ish scores
    total = {t: sum(weights[t].values()) for t in TYPES}
    return weights, total


def overlap_predict(q, weights, total):
    words = re.findall(r"[a-z]+", q.lower())
    scores = {}
    for t in TYPES:
        s = 0.0
        for w in words:
            s += math.log(1 + weights[t].get(w, 0)) - math.log(1 + total[t] / 1000)
        scores[t] = s
    best = max(scores, key=scores.get)
    second = sorted(scores.values())[-2]
    margin = scores[best] - second
    conf = min(0.95, max(0.25, 0.5 + margin * 0.15))
    # complexity heuristic: longer + code words -> higher
    comp = 1 + min(4, len(words) // 6 + (1 if re.search(r"code|api|design|error|trade", q.lower()) else 0))
    return best, conf, comp


def prf(y_true, y_pred):
    labels = TYPES
    tp = {l: 0 for l in labels}
    fp = {l: 0 for l in labels}
    fn = {l: 0 for l in labels}
    for t, p in zip(y_true, y_pred):
        if t == p:
            tp[t] += 1
        else:
            fp[p] += 1
            fn[t] += 1
    ps, rs, f1s = [], [], []
    for l in labels:
        p = tp[l] / max(1, tp[l] + fp[l])
        r = tp[l] / max(1, tp[l] + fn[l])
        f = 2 * p * r / max(1e-9, p + r)
        ps.append(p)
        rs.append(r)
        f1s.append(f)
    acc = sum(1 for t, p in zip(y_true, y_pred) if t == p) / max(1, len(y_true))
    return acc, sum(ps) / len(ps), sum(rs) / len(rs), sum(f1s) / len(f1s)


def main() -> int:
    data = build_dataset()
    train, val, test = split_by_family(data)
    weights, total = train_overlap_model(train)
    # Tune the fallback threshold on VAL (never test): maximize route
    # accuracy (fallback routes large), tie-break toward less fallback.
    # The threshold cannot change predicted types — only routes.
    best_thr, best_key = 0.5, None
    for thr in [0.4, 0.5, 0.6, 0.7]:
        ok, fb = 0, 0
        for _, q, l in val:
            lab, conf, _ = overlap_predict(q, weights, total)
            route = "large" if conf < thr else route_for_type(lab)
            ok += route == route_for_type(l)
            fb += conf < thr
        key = (ok / max(1, len(val)), -fb / max(1, len(val)))
        if best_key is None or key > best_key:
            best_key, best_thr = key, thr
    # evaluate on TEST. predicted_type is the classifier's actual output
    # (used for accuracy/F1); route is where the request goes — fallback
    # ALWAYS routes large, never relabels the request as general.
    results = {}
    for name in ["baseline_regex", "improved_overlap"]:
        y_true, y_pred, routes, routes_ok, confs, fallbacks = [], [], [], [], [], 0
        t0 = time.perf_counter()
        for _, q, l in test:
            if name == "baseline_regex":
                p, c = regex_predict(q)
                fb = False
            else:
                p, c, _ = overlap_predict(q, weights, total)
                fb = c < best_thr
            route = "large" if fb else route_for_type(p)
            y_true.append(l)
            y_pred.append(p)
            routes.append(route)
            routes_ok.append(route == route_for_type(l))
            confs.append(c)
            fallbacks += fb
        ms = (time.perf_counter() - t0) * 1000 / max(1, len(test))
        acc, mp, mr, mf = prf(y_true, y_pred)
        cm = {t: {p: 0 for p in TYPES} for t in TYPES}
        for t, p in zip(y_true, y_pred):
            cm[t][p] += 1
        large = sum(1 for r in routes if r == "large")
        results[name] = {
            "n_test": len(test),
            "accuracy": round(acc, 4),
            "macro_precision": round(mp, 4),
            "macro_recall": round(mr, 4),
            "macro_f1": round(mf, 4),
            "route_accuracy": round(sum(routes_ok) / max(1, len(routes_ok)), 4),
            "fallback_rate": round(fallbacks / max(1, len(test)), 4),
            "large_routed_pct": round(100 * large / max(1, len(test)), 1),
            "avg_latency_ms": round(ms, 4),
            "confusion_matrix": cm,
        }
    report = {
        "method": "transparent templated dataset, family-separated split; regex is a Python PROXY of PR #240 patterns (authoritative: cargo test)",
        "n_total": len(data),
        "n_train": len(train),
        "n_val": len(val),
        "n_test": len(test),
        "fallback_threshold_tuned_on_val": best_thr,
        "honesty_note": "Labels derive from templates, so regex-proxy accuracy is optimistic. Independent human labels (like winner's 1806 with CV + leakage guard) are still required for a claim of beating 86%.",
        "systems": results,
        "reference_winner": {"accuracy": 0.864, "n": 1806, "note": "PR #319 reported held-out 154; do not claim to beat without independent labels"},
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    for k, v in results.items():
        print(f"{k}: acc={v['accuracy']} F1={v['macro_f1']} fallback={v['fallback_rate']} large%={v['large_routed_pct']} latency={v['avg_latency_ms']}ms (n={v['n_test']})")
    print(f"train={len(train)} val={len(val)} test={len(test)} thr={best_thr}")
    print(f"report -> {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
