"""SVG charts (stdlib only, no deps). Reads both report JSONs.

Outputs:
- evidence/charts/compact_bars.svg — baseline vs compact bytes for top-20 tools by saving
- evidence/charts/compact_hist.svg — distribution of % reduction
- evidence/charts/classifier_acc.svg — baseline vs improved accuracy/F1 bars
- evidence/charts/confusion_improved.svg — confusion matrix heatmap (text cells)
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "charts"


def svg_wrap(w, h, body, title=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" font-family="sans-serif"><title>{title}</title><rect width="100%" height="100%" fill="white"/>{body}</svg>'


def bars():
    c = json.loads((HERE / "compact_report.json").read_text(encoding="utf-8"))
    rows = sorted(c["rows"], key=lambda r: r["baseline_bytes"] - r["compact_bytes"], reverse=True)[:20]
    W, H, pad = 900, 40 + 20 * 24, 200
    mx = max(r["baseline_bytes"] for r in rows)
    body = f'<text x="10" y="22" font-size="14" font-weight="bold">Baseline vs compact bytes (top 20 by saving, n={c["n_tools"]})</text>'
    for i, r in enumerate(rows):
        y = 40 + i * 24
        bw = (W - pad - 120) * r["baseline_bytes"] / mx
        cw = (W - pad - 120) * r["compact_bytes"] / mx
        body += f'<text x="10" y="{y + 12}" font-size="10">{r["name"][:26]}</text>'
        body += f'<rect x="{pad}" y="{y}" width="{bw:.0f}" height="9" fill="#c9d6ff"/>'
        body += f'<rect x="{pad}" y="{y + 10}" width="{cw:.0f}" height="9" fill="#2f6fed"/>'
        body += f'<text x="{pad + bw + 6}" y="{y + 14}" font-size="10">{r["reduction_pct"]}%</text>'
    body += f'<text x="10" y="{H - 8}" font-size="10" fill="#555">blue=compact, light=baseline. Bytes exact; tokens need cargo eval.</text>'
    (OUT / "compact_bars.svg").write_text(svg_wrap(W, H, body, "compact bars"), encoding="utf-8")


def hist():
    c = json.loads((HERE / "compact_report.json").read_text(encoding="utf-8"))
    reds = [r["reduction_pct"] for r in c["rows"]]
    W, H = 600, 300
    bins = [0] * 10
    for v in reds:
        bins[min(9, int(v // 10))] += 1
    mx = max(bins)
    body = '<text x="10" y="22" font-size="14" font-weight="bold">Distribution of % byte reduction (all tools)</text>'
    for i, n in enumerate(bins):
        x = 50 + i * 52
        h = 200 * n / mx if mx else 0
        body += f'<rect x="{x}" y="{250 - h}" width="44" height="{h}" fill="#2f6fed"/>'
        body += f'<text x="{x}" y="266" font-size="10">{i * 10}-{i * 10 + 10}%</text>'
        body += f'<text x="{x + 12}" y="{244 - h}" font-size="10">{n}</text>'
    (OUT / "compact_hist.svg").write_text(svg_wrap(W, 290, body, "hist"), encoding="utf-8")


def acc():
    k = json.loads((HERE / "classifier_report.json").read_text(encoding="utf-8"))
    W, H = 600, 260
    body = '<text x="10" y="22" font-size="14" font-weight="bold">Classifier accuracy / F1 on unseen phrasing (test)</text>'
    for i, (name, color) in enumerate([("baseline_regex", "#888"), ("improved_overlap", "#2f6fed")]):
        s = k["systems"][name]
        y = 50 + i * 80
        body += f'<text x="10" y="{y + 12}" font-size="12">{name} (n={s["n_test"]})</text>'
        body += f'<rect x="220" y="{y}" width="{440 * s["accuracy"]}" height="16" fill="{color}"/>'
        body += f'<text x="225" y="{y + 13}" font-size="11" fill="white">acc {s["accuracy"]}</text>'
        body += f'<rect x="220" y="{y + 22}" width="{440 * s["macro_f1"]}" height="16" fill="{color}" opacity="0.55"/>'
        body += f'<text x="225" y="{y + 34}" font-size="11">F1 {s["macro_f1"]} · fallback {s["fallback_rate"]}</text>'
    body += '<text x="10" y="246" font-size="10" fill="#555">templated labels: optimistic for both. Winner 86% on human labels is the real bar.</text>'
    (OUT / "classifier_acc.svg").write_text(svg_wrap(W, H, body, "acc"), encoding="utf-8")


def confusion():
    k = json.loads((HERE / "classifier_report.json").read_text(encoding="utf-8"))
    cm = k["systems"]["improved_overlap"]["confusion_matrix"]
    labels = list(cm.keys())
    n = len(labels)
    cell, pad = 64, 150
    W = pad + n * cell + 20
    H = pad + n * cell + 20
    mx = max(v for row in cm.values() for v in row.values()) or 1
    body = '<text x="10" y="22" font-size="14" font-weight="bold">Confusion matrix — improved_overlap (rows=true, cols=pred)</text>'
    for j, p in enumerate(labels):
        body += f'<text x="{pad + j * cell + 6}" y="{pad - 8}" font-size="9" transform="rotate(-20 {pad + j * cell + 6},{pad - 8})">{p[:12]}</text>'
    for i, t in enumerate(labels):
        body += f'<text x="10" y="{pad + i * cell + 22}" font-size="9">{t[:18]}</text>'
        for j, p in enumerate(labels):
            v = cm[t][p]
            a = 0.15 + 0.85 * v / mx
            fill = f"rgba(47,111,237,{a:.2f})"
            x, y = pad + j * cell, pad + i * cell
            body += f'<rect x="{x}" y="{y}" width="{cell - 2}" height="{cell - 2}" fill="{fill}"/>'
            body += f'<text x="{x + 6}" y="{y + 20}" font-size="11" fill="white">{v}</text>'
    (OUT / "confusion_improved.svg").write_text(svg_wrap(W, H, body, "cm"), encoding="utf-8")


def aggressive_cmp():
    c = json.loads((HERE / "compact_report.json").read_text(encoding="utf-8"))
    try:
        a = json.loads((HERE / "compact_aggressive_report.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    W, H = 600, 220
    body = '<text x="10" y="22" font-size="14" font-weight="bold">Default vs aggressive (avg byte reduction, 56 tools)</text>'
    for i, (label, val, color) in enumerate([
            (f"default {c['avg_reduction_pct']}%", c["avg_reduction_pct"], "#2f6fed"),
            (f"aggressive {a['avg_reduction_pct']}% (optional)", a["avg_reduction_pct"], "#0a9b4a"),
            ("winner ref 46.4% (tokens, other corpus)", 46.4, "#888")]):
        y = 50 + i * 55
        body += f'<text x="10" y="{y + 14}" font-size="11">{label}</text>'
        body += f'<rect x="330" y="{y}" width="{4.4 * val:.0f}" height="20" fill="{color}"/>'
    body += '<text x="10" y="208" font-size="10" fill="#555">bytes vs tokens: related, not identical. o200k_base run still needed.</text>'
    (OUT / "aggressive_cmp.svg").write_text(svg_wrap(W, H, body, "aggr"), encoding="utf-8")


def realistic_acc():
    try:
        k = json.loads((HERE / "classifier_realistic_report.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    W, H = 640, 300
    body = '<text x="10" y="22" font-size="14" font-weight="bold">Realistic set: routing accuracy on locked test (synthetic, NOT human)</text>'
    for i, (name, color) in enumerate([("baseline_regex", "#888"), ("overlap_v1", "#6a8dff")] +
                                      [(n, "#2f6fed") for n in k["systems"] if n.startswith("improved")]):
        s = k["systems"][name]
        y = 50 + i * 60
        body += f'<text x="10" y="{y + 12}" font-size="10">{name[:34]} acc={s["accuracy"]} F1={s["macro_f1"]}</text>'
        body += f'<rect x="330" y="{y}" width="{260 * s["accuracy"]:.0f}" height="18" fill="{color}"/>'
        body += f'<text x="335" y="{y + 13}" font-size="10" fill="white">fb {s["fallback_rate"]} large {s["large_routed_pct"]}%</text>'
    (OUT / "realistic_acc.svg").write_text(svg_wrap(W, H, body, "real"), encoding="utf-8")


def main() -> int:
    OUT.mkdir(exist_ok=True)
    bars()
    hist()
    acc()
    confusion()
    aggressive_cmp()
    realistic_acc()
    print(f"charts -> {OUT} (6 SVGs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
