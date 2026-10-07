"""Extract a representative tool corpus from the real Nasiko agents.

Reads every agents/*/src/tools.rs and agents/*/tools.go, parsing each tool
definition as an independent block: name, description, properties, types and
required fields are ALWAYS taken from the same tool definition — never matched
by position across independent regex result lists, never scanned file-wide.

- Rust json! blocks are parsed as real JSON (exact).
- Go toolDef entries are split into per-tool brace-matched blocks first; the
  Parameters/properties/required of each tool are parsed from within its own
  block only.
- Anything that cannot be parsed reliably is SKIPPED with an explicit stderr
  warning (tool name + file + reason). Nothing is invented: no fabricated
  properties, no fabricated required fields, no heuristic type guessing.
- agents/translator/src/toolset.py holds implementations, not tool schemas,
  and is out of scope (noted, not silently dropped).

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
    failures = 0
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
        except Exception as e:
            failures += 1
            print(f"warn: {path}: json! block #{failures} unparseable, skipped ({e})", file=sys.stderr)
            continue
        fn = obj.get("function") if isinstance(obj, dict) else None
        if isinstance(fn, dict) and fn.get("name"):
            tools.append({
                "name": fn["name"],
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {"type": "object"}),
                "source": str(path.relative_to(REPO)),
            })
    if failures:
        print(f"warn: {path}: {failures} json! block(s) skipped (see above)", file=sys.stderr)
    return tools


def extract_go_tools(path: Path):
    """Parse Go toolDef entries block-by-block.

    Every field of a tool comes from that tool's own brace-matched literal:
    splitting the []toolDef slice into entries first guarantees a required
    list or property can never migrate from one tool to another.
    Returns (tools, skipped) where skipped is [(name_or_?, reason)].
    """
    text = path.read_text(encoding="utf-8", errors="replace")
    tools, skipped = [], []
    try:
        entries = _split_tooldef_entries(text)
    except ValueError as e:
        print(f"warn: {path}: cannot locate toolDef slice ({e}); file skipped", file=sys.stderr)
        return [], [(str(path), "no toolDef slice")]
    for entry in entries:
        name = _go_string_field(entry, "Name")
        if name is None:
            skipped.append(("(unknown)", "entry without Name"))
            continue
        desc = _go_string_field(entry, "Description") or ""
        try:
            params = _go_parameters(entry)
        except ValueError as e:
            print(f"warn: {path}: tool {name!r} skipped ({e})", file=sys.stderr)
            skipped.append((name, str(e)))
            continue
        tools.append({
            "name": name,
            "description": desc,
            "parameters": params,
            "source": str(path.relative_to(REPO)),
        })
    # Deduplicate by name, keep first
    seen, out = set(), []
    for t in tools:
        if t["name"] not in seen:
            seen.add(t["name"])
            out.append(t)
    return out, skipped


def _brace_match(text, open_idx):
    """Index just past the brace matching text[open_idx] == '{'.

    String-aware: skips over "..." (with backslash escapes), `...` raw
    strings, '...' rune/char literals, // line comments and /* */ blocks.
    Raises ValueError if unbalanced.
    """
    assert text[open_idx] == "{"
    i = open_idx + 1
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "{":
            i = _brace_match(text, i)
        elif ch == "}":
            return i + 1
        elif ch == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
        elif ch == "`":
            i = text.find("`", i + 1)
            if i == -1:
                raise ValueError("unterminated raw string")
            i += 1
        elif ch == "'":
            i += 1
            while i < n and text[i] != "'":
                i += 2 if text[i] == "\\" else 1
            i += 1
        elif ch == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i + 2)
            i = n if j == -1 else j + 1
        elif ch == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            if j == -1:
                raise ValueError("unterminated block comment")
            i = j + 2
        else:
            i += 1
    raise ValueError("unbalanced braces")


def _split_tooldef_entries(text):
    """Split a []toolDef{...} slice literal into its top-level entry blocks."""
    m = re.search(r"\[\]toolDef\s*\{", text)
    if not m:
        raise ValueError("no []toolDef slice")
    body_end = _brace_match(text, m.end() - 1)
    body = text[m.end():body_end - 1]
    entries = []
    i = 0
    while i < len(body):
        j = body.find("{", i)
        if j == -1:
            break
        end = _brace_match(body, j)
        entries.append(body[j:end])
        i = end
    if not entries:
        raise ValueError("toolDef slice has no entries")
    return entries


def _go_string_field(block, field):
    """First Field: "value" (escape-aware) within ONE tool block, else None."""
    m = re.search(r"\b" + field + r'\s*:\s*"', block)
    if not m:
        return None
    i = m.end()
    out = []
    while i < len(block):
        ch = block[i]
        if ch == "\\" and i + 1 < len(block):
            out.append(block[i + 1])
            i += 2
        elif ch == '"':
            return "".join(out)
        else:
            out.append(ch)
            i += 1
    return None  # unterminated -> treated as missing


def _go_map_block(block, key):
    """Brace-matched map literal for `"key": map[string]any{...}` in block.

    Returns the inner text (without outer braces), or None if the key is absent.
    """
    m = re.search(r'"' + re.escape(key) + r'"\s*:\s*map\[string\]any\s*\{', block)
    if not m:
        return None
    end = _brace_match(block, m.end() - 1)
    return block[m.end():end - 1]


def _go_property_schema(block, pname):
    """Schema dict for one property entry, or raise ValueError if unreliable."""
    m = re.search(r'"' + re.escape(pname) + r'"\s*:\s*map\[string\]any\s*\{', block)
    if not m:
        raise ValueError(f"property {pname!r} has no map body")
    end = _brace_match(block, m.end() - 1)
    body = block[m.end():end - 1]
    tm = re.search(r'"type"\s*:\s*"([^"]+)"', body)
    if not tm:
        raise ValueError(f"property {pname!r} has no determinable type")
    schema = {"type": tm.group(1)}
    dm = re.search(r'"description"\s*:\s*"((?:[^"\\]|\\.)*)"', body)
    if dm:
        schema["description"] = dm.group(1)
    fm = re.search(r'"format"\s*:\s*"([^"]+)"', body)
    if fm:
        schema["format"] = fm.group(1)
    items = _go_map_block(body, "items")
    if items is not None:
        itm = re.search(r'"type"\s*:\s*"([^"]+)"', items)
        if not itm:
            raise ValueError(f"property {pname!r} array items lack a type")
        schema["items"] = {"type": itm.group(1)}
    em = re.search(r'"enum"\s*:\s*\[\](?:string|any)\s*\{([^}]*)\}', body)
    if em:
        vals = re.findall(r'"((?:[^"\\]|\\.)*)"', em.group(1))
        if not vals:
            raise ValueError(f"property {pname!r} has an unparseable enum")
        schema["enum"] = vals
    return schema


def _go_parameters(entry):
    """OpenAI-style parameters object parsed from ONE tool entry block."""
    m = re.search(r"Parameters\s*:\s*map\[string\]any\s*\{", entry)
    if not m:
        return {"type": "object", "properties": {}, "required": []}
    end = _brace_match(entry, m.end() - 1)
    params = entry[m.end():end - 1]
    props = {}
    props_body = _go_map_block(params, "properties")
    if props_body is not None:
        for pm in re.finditer(r'"([^"]+)"\s*:\s*map\[string\]any\s*\{', props_body):
            pname = pm.group(1)
            if pname in props:
                continue
            props[pname] = _go_property_schema(props_body, pname)
    req = []
    rm = re.search(r'"required"\s*:\s*\[\]string\s*\{([^}]*)\}', params)
    if rm:
        req = re.findall(r'"([^"]+)"', rm.group(1))
    for r in req:
        if r not in props:
            raise ValueError(f"required field {r!r} has no matching property")
    return {"type": "object", "properties": props, "required": req}


def main() -> int:
    all_tools = []
    skipped_all = []
    rust_files = sorted(REPO.rglob("tools.rs"))
    go_files = sorted(REPO.rglob("tools.go"))
    # agents/translator/src/toolset.py holds implementations, not tool schemas.
    py_files = sorted(REPO.rglob("toolset.py"))
    if py_files:
        print(f"note: {len(py_files)} python toolset file(s) out of scope (implementations, not schemas): "
              + ", ".join(str(p.relative_to(REPO)) for p in py_files))
    for p in rust_files:
        try:
            all_tools.extend(extract_rust_tools(p))
        except Exception as e:
            print(f"warn: {p}: {e}", file=sys.stderr)
    for p in go_files:
        try:
            got, skipped = extract_go_tools(p)
            all_tools.extend(got)
            skipped_all.extend([(str(p.relative_to(REPO)), n, r) for n, r in skipped])
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
    if skipped_all:
        print(f"tools explicitly skipped (unparseable, not invented): {len(skipped_all)}")
        for src, name, reason in skipped_all:
            print(f"  - {src} :: {name} ({reason})")
    for t in uniq:
        n_params = len(t.get("parameters", {}).get("properties", {}))
        print(f"  - {t['name']} ({n_params} params) [{t['source']}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
