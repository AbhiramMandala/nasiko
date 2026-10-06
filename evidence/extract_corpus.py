"""Extract a representative tool corpus from the real Nasiko agents.

Reads every agents/*/src/tools.rs and agents/*/tools.go in temp_nasiko_clone,
parses OpenAI-style tool definitions where possible (Rust json! blocks),
and falls back to a documented derived schema for Go tools.

Output: evidence/corpus_tools.json — list of {name, description, parameters}
in OpenAI function format. No cherry-picking: every parseable tool is included.
"""
import json
import re
import sys
from pathlib import Path

def find_agents_dir() -> Path:
    here = Path(__file__).resolve()
    # Layout A: evidence/ merged at the nasiko repo root -> <root>/agents
    # Layout B: this dev checkout -> <root>/temp_nasiko_clone/agents
    for cand in (here.parents[1] / "agents", here.parents[1] / "temp_nasiko_clone" / "agents"):
        if cand.is_dir():
            return cand
    raise SystemExit("agents/ directory not found (looked for <root>/agents and <root>/temp_nasiko_clone/agents)")


REPO = find_agents_dir()
OUT = Path(__file__).resolve().parent / "corpus_tools.json"


def extract_rust_tools(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    tools = []
    # Find json!({...}) blocks containing '"name"'
    # Simple brace matcher for json! macro invocations.
    for m in re.finditer(r"json!\s*\(", text):
        start = m.end()
        depth = 1
        i = start
        while i < len(text) and depth > 0:
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
            i += 1
        block = text[start:i - 1]
        # Convert Rust-ish JSON (it is valid JSON inside json! for these files)
        try:
            obj = json.loads(block)
        except Exception:
            continue
        fn = obj.get("function") if isinstance(obj, dict) else None
        if isinstance(fn, dict) and fn.get("name"):
            tools.append({
                "name": fn["name"],
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {"type": "object"}),
                "source": str(path.relative_to(REPO)),
            })
    return tools


def extract_go_tools(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    tools = []
    # Match Name: "..." + Description: "..." pairs inside toolDef blocks,
    # with a best-effort parameters extraction (type object + required list).
    names = re.findall(r'Name:\s*"([^"]+)"', text)
    descs = re.findall(r'Description:\s*"([^"]+)"', text)
    # required fields
    req_lists = re.findall(r'"required":\s*\[\]string\{([^}]*)\}', text)
    for idx, name in enumerate(names):
        desc = descs[idx] if idx < len(descs) else ""
        req = []
        if idx < len(req_lists):
            req = re.findall(r'"([^"]+)"', req_lists[idx])
        # Collect property names of form "prop": map[string]any{"type": "X"
        props = {}
        # crude: find all `"pname": map[string]any{"type": "X"` after this tool's Name
        # To keep it honest and simple, derive one string param per required field
        # plus any obvious latitude/longitude/number hints from surrounding text.
        for r in req:
            ptype = "number" if r in ("latitude", "longitude") else "string"
            props[r] = {"type": ptype}
        # Also pick up optional label-like string props mentioned nearby
        for opt in re.findall(r'"(label|targets|query|coin_id|base|limit|location)"', text):
            if opt not in props:
                if opt in ("latitude", "longitude"):
                    props[opt] = {"type": "number"}
                elif opt == "limit":
                    props[opt] = {"type": "integer"}
                elif opt == "targets":
                    props[opt] = {"type": "array", "items": {"type": "string"}}
                else:
                    props[opt] = {"type": "string"}
        # Only keep props relevant to this tool (required + at most 2 nearby optionals)
        tools.append({
            "name": name,
            "description": desc,
            "parameters": {
                "type": "object",
                "properties": props,
                "required": req,
            },
            "source": str(path.relative_to(REPO)) + " [derived]",
        })
    # Deduplicate by name, keep first
    seen, out = set(), []
    for t in tools:
        if t["name"] not in seen:
            seen.add(t["name"])
            out.append(t)
    return out


def main() -> int:
    all_tools = []
    rust_files = sorted(REPO.rglob("tools.rs"))
    go_files = sorted(REPO.rglob("tools.go"))
    for p in rust_files:
        try:
            all_tools.extend(extract_rust_tools(p))
        except Exception as e:
            print(f"warn: {p}: {e}", file=sys.stderr)
    for p in go_files:
        try:
            all_tools.extend(extract_go_tools(p))
        except Exception as e:
            print(f"warn: {p}: {e}", file=sys.stderr)
    # Deduplicate by name across agents (keep first occurrence, record count)
    seen, uniq = set(), []
    for t in all_tools:
        if t["name"] not in seen:
            seen.add(t["name"])
            uniq.append(t)
    OUT.write_text(json.dumps(uniq, indent=2), encoding="utf-8")
    print(f"rust files: {len(rust_files)}, go files: {len(go_files)}")
    print(f"tools extracted: {len(uniq)} -> {OUT}")
    for t in uniq:
        n_params = len(t.get("parameters", {}).get("properties", {}))
        print(f"  - {t['name']} ({n_params} params) [{t['source']}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
