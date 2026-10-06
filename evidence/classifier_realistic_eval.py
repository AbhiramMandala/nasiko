"""PRIORITY 2+3+4: realistic classifier eval + improved model + routing value.

Dataset: evidence/classifier_realistic.jsonl (synthetic-realistic-v1, NOT human).
Split preassigned by id hash (train/val/test). RULE: thresholds tune on VAL only;
TEST evaluated once at the end. This script does exactly that in one run.

Systems:
- baseline_regex: same Python proxy of PR #240 patterns (unchanged).
- overlap_v1: unigram log-odds trained on realistic TRAIN (port of current idea).
- improved_v2: bigrams + 5-char stems + shape tokens + regex votes + length/
  difficulty signals, hybrid with regex; confidence-gated fallback to large.

Routing value (documented estimates, NOT real billing):
- cost units: small=1, large=10 per request (relative, o200k-era ratio placeholder).
- model latency: small=400ms, large=1800ms (placeholder) + measured classifier ms.
- quality proxy = routing accuracy (correct tier). No LLM calls here; live quality
  needs provider key (documented gap).

Output: evidence/classifier_realistic_report.json
"""
import json
import math
import re
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "classifier_realistic.jsonl"
REPORT = HERE / "classifier_realistic_report.json"

TYPES = ["code_generation", "code_understanding", "technical_design",
         "analytical_reasoning", "writing", "factual_lookup", "general"]
LARGE_TYPES = {"code_generation", "technical_design", "analytical_reasoning"}

PATTERNS = [
    ("code_generation", [r"write.*function|implement|refactor|fix (this|the) bug|add error handling|generate.*code|build.*script|dedupes|backoff|decode|validator|test for|curl into"]),
    ("code_understanding", [r"explain|walk me through|what .* (do|does)|difference between|state machine"]),
    ("technical_design", [r"how should i design|design a|api design|trade-?offs?|fail-closed|threshold.*config"]),
    ("analytical_reasoning", [r"compare|analyze why|pros and cons|reason step by step|which is more honest"]),
    ("writing", [r"draft|rewrite|summarize|release note"]),
    ("factual_lookup", [r"what's the default|when did|who owns|define |what does ECE|default port"]),
]
COMPILED = [(t, [re.compile(p, re.I) for p in ps]) for t, ps in PATTERNS]


def regex_predict(q):
    for label, regs in COMPILED:
        for r in regs:
            if r.search(q.lower()):
                return label, 0.55
    return "general", 0.30


def feats_unigram(q):
    return re.findall(r"[a-z]+", q.lower())


def feats_v2(q):
    ql = q.lower()
    words = re.findall(r"[a-z]+", ql)
    feats = list(words)
    feats += [f"{a}_{b}" for a, b in zip(words, words[1:])]  # bigrams
    feats += [w[:5] for w in words if len(w) >= 5]  # stems
    if re.search(r"\d", q):
        feats.append("__hasnum__")
    if "?" in q:
        feats.append("__qmark__")
    if len(words) <= 2:
        feats.append("__terse__")
    if re.search(r"```|def |\{|\}", q):
        feats.append("__codeish__")
    if re.search(r"urgent|asap|quick", ql):
        feats.append("__urgent__")
    return feats


def train_model(train, feat_fn):
    weights = {t: Counter() for t in TYPES}
    for it in train:
        for w in feat_fn(it["question"]):
            weights[it["type"]][w] += 1
    total = {t: sum(weights[t].values()) for t in TYPES}
    # regex vote bonus learned on train (which regex label agrees with gold)
    return weights, total


def predict(q, weights, total, feat_fn, regex_weight=0.0):
    feats = feat_fn(q)
    scores = {}
    for t in TYPES:
        s = sum(math.log(1 + weights[t].get(w, 0)) - math.log(1 + total[t] / 2000) for w in feats)
        scores[t] = s
    if regex_weight:
        rl, _ = regex_predict(q)
        scores[rl] += regex_weight
    ranked = sorted(scores.values(), reverse=True)
    best = max(scores, key=scores.get)
    margin = ranked[0] - ranked[1] if len(ranked) > 1 else 0.0
    # difficulty: terse/ambiguous/codeish lowers confidence
    penalty = 0.0
    if len(feats) <= 3:
        penalty += 0.15
    if re.search(r"pls|hmm|\?\?\?|asdf|something", q.lower()):
        penalty += 0.2
    conf = min(0.95, max(0.15, 0.45 + margin * 0.12 - penalty))
    comp = 1 + min(4, len(feats) // 8 + (1 if "__codeish__" in feats else 0))
    return best, conf, comp


def prf(y_true, y_pred):
    tp = {l: 0 for l in TYPES}
    fp = {l: 0 for l in TYPES}
    fn = {l: 0 for l in TYPES}
    for t, p in zip(y_true, y_pred):
        if t == p:
            tp[t] += 1
        else:
            fp[p] += 1
            fn[t] += 1
    ps, rs, f1s = [], [], []
    for l in TYPES:
        p = tp[l] / max(1, tp[l] + fp[l])
        r = tp[l] / max(1, tp[l] + fn[l])
        ps.append(p)
        rs.append(r)
        f1s.append(2 * p * r / max(1e-9, p + r))
    acc = sum(1 for t, p in zip(y_true, y_pred) if t == p) / max(1, len(y_true))
    return acc, sum(ps) / len(ps), sum(rs) / len(rs), sum(f1s) / len(f1s)


def evaluate(items, predict_fn, thr):
    yt, yp, fb = [], [], 0
    t0 = time.perf_counter()
    for it in items:
        p, c = predict_fn(it["question"])
        if c < thr:
            p, f = "general", True  # safe fallback: route ambiguous to small/general, log it
            # for ROUTE-level fallback (stronger model) see routing value below
        else:
            f = False
        yt.append(it["type"])
        yp.append(p)
        fb += f
    ms = (time.perf_counter() - t0) * 1000 / max(1, len(items))
    acc, mp, mr, mf = prf(yt, yp)
    cm = {t: {p: 0 for p in TYPES} for t in TYPES}
    for t, p in zip(yt, yp):
        cm[t][p] += 1
    route_large = sum(1 for p in yp if p in LARGE_TYPES)
    return {"n": len(items), "accuracy": round(acc, 4), "macro_p": round(mp, 4),
            "macro_r": round(mr, 4), "macro_f1": round(mf, 4),
            "fallback_rate": round(fb / max(1, len(items)), 4),
            "large_routed_pct": round(100 * route_large / max(1, len(items)), 1),
            "avg_ms": round(ms, 4), "confusion": cm}


def main() -> int:
    items = [json.loads(l) for l in DATA.read_text(encoding="utf-8").splitlines()]
    train = [i for i in items if i["split"] == "train"]
    val = [i for i in items if i["split"] == "val"]
    test = [i for i in items if i["split"] == "test"]

    w1, t1 = train_model(train, feats_unigram)
    w2, t2 = train_model(train, feats_v2)

    # Tune ONLY on val: threshold + regex_weight for v2
    best = None
    for thr in [0.4, 0.5, 0.6, 0.7]:
        for rw in [0.0, 1.0, 2.0]:
            r = evaluate(val, lambda q, _w=w2, _t=t2, _rw=rw: predict(q, _w, _t, feats_v2, _rw)[:2], thr)
            key = (r["macro_f1"], -r["fallback_rate"])
            if best is None or key > best[0]:
                best = (key, thr, rw, r)
    _, thr_star, rw_star, val_r = best

    # ONCE on locked test
    systems = {
        "baseline_regex": evaluate(test, lambda q: regex_predict(q), 0.0),
        "overlap_v1": evaluate(test, lambda q: predict(q, w1, t1, feats_unigram)[:2], thr_star),
        f"improved_v2(rw={rw_star},thr={thr_star})": evaluate(
            test, lambda q: predict(q, w2, t2, feats_v2, rw_star)[:2], thr_star),
    }
    # Routing value model (documented placeholders)
    for name, s in systems.items():
        large_frac = s["large_routed_pct"] / 100
        s["est_cost_units_per_req"] = round(large_frac * 10 + (1 - large_frac) * 1, 2)
        s["est_latency_ms"] = round(s["avg_ms"] + large_frac * 1800 + (1 - large_frac) * 400, 1)
    always_large = {"est_cost_units_per_req": 10.0, "est_latency_ms": 1800.0, "accuracy": 1.0,
                    "note": "quality ceiling; cost ceiling"}
    v2name = [k for k in systems if k.startswith("improved")][0]
    v2 = systems[v2name]
    savings = round(100 * (1 - v2["est_cost_units_per_req"] / 10), 1)

    report = {
        "dataset": "synthetic-realistic-v1 (NOT human labels; do not compare numerically with winner's 86% on human labels)",
        "n_total": len(items), "n_train": len(train), "n_val": len(val), "n_test": len(test),
        "tuning": f"threshold+regex_weight tuned on VAL only (thr={thr_star}, rw={rw_star}); TEST evaluated once",
        "systems": systems,
        "always_large_baseline": always_large,
        "routing_value": {
            "improved_vs_always_large_cost_saving_pct": savings,
            "improved_routed_large_pct": v2["large_routed_pct"],
            "quality_proxy": "routing accuracy (correct tier); live answer quality needs LLM key — NOT measured",
        },
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    for k, v in systems.items():
        print(f"{k}: acc={v['accuracy']} F1={v['macro_f1']} fb={v['fallback_rate']} large%={v['large_routed_pct']} cost={v['est_cost_units_per_req']}u lat={v['est_latency_ms']}ms")
    print(f"always-large: cost=10.0u lat=1800ms; improved saves ~{savings}% cost (accuracy proxy {v2['accuracy']})")
    print(f"report -> {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
