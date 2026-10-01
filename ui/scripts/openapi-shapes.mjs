/**
 * Read response shapes and query parameters off the committed OpenAPI
 * snapshot, in the same vocabulary `data-sources-overrides.json` declares
 * them in — so the two can be compared field by field.
 *
 * ## The gap this closes
 *
 * Every data function is `return fetchApi(url)` with no type information, so
 * the manifest's `responseShape` has always been a hand-written claim about a
 * backend in another crate, and `gen-data-manifest --check` could only verify
 * that the claim was attached to a function that exists. The `$shapeSource`
 * notes in the overrides are a record of how that went: shapes read off the
 * Rust "had drifted four ways", one of them "actively misleading" — fields
 * declared that the struct did not have, which a model binds to and gets
 * nothing, with no diagnostic anywhere.
 *
 * The backend now publishes a spec (`utoipa`, `/api/ee/openapi.json`,
 * snapshotted by `openapi-snapshot.mjs`). This module turns a route into the
 * shape the spec says it returns, and turns a declared shape into a list of
 * disagreements with it. Nothing in here decides policy — `gen-data-manifest`
 * does — this only answers "what does the backend say" and "where do they
 * differ".
 *
 * ## The two vocabularies
 *
 * A declared shape is a tree of `{key: subtree}`, `[subtree]` and type strings
 * like `"number"`, `"number|null"`, `"string (ISO 8601)"`. The spec is JSON
 * Schema with `$ref`, `allOf`, `type: [..., "null"]` and untyped `{}`. Both
 * are reduced to the same normal form before comparing:
 *
 *   { kind: 'object', props: {k: Shape}, required: Set }
 *   { kind: 'array',  items: Shape }
 *   { kind: 'scalar', type: 'number'|'string'|'boolean'|'any'|'union', nullable }
 *
 * `integer` is `number` on this side — JS has one number type and the DSL
 * has one number type, so the distinction cannot reach a generated surface.
 *
 * ## What counts as a disagreement
 *
 * Three things, and each one has cost a real generation:
 *
 *  - a declared field the backend does not return (`missing_in_spec`) — the
 *    binding-to-nothing case;
 *  - a backend field the shape does not declare (`undeclared`) — the model
 *    cannot plan around a field it cannot see, which is how a spend series
 *    shipped without its latency percentiles;
 *  - a type of the wrong kind (`type_mismatch`) — an object where a number
 *    was promised is a chart with no data and a diagnostic that blames the
 *    catalog.
 *
 * Nullability is reported separately (`nullability`) and left to the caller
 * to treat as it likes: a field that can be null and is declared as though it
 * cannot is a default the model will not think to write, but it is not a
 * field that does not exist.
 */

// ── the spec side ────────────────────────────────────────────────────────────

/**
 * Follow `#/components/schemas/X`. `seen` is the chain of names above this
 * point; a name already in it is a cycle, which resolves to `any` rather
 * than recursing forever. Returns the schema and the chain to continue with.
 */
function deref(spec, schema, seen) {
  if (!schema || !schema.$ref) return [schema, seen];
  const name = schema.$ref.replace('#/components/schemas/', '');
  if (seen.has(name)) return [{}, seen];
  const target = spec.components?.schemas?.[name];
  if (!target) throw new Error(`openapi: $ref to unknown schema ${name}`);
  return [target, new Set([...seen, name])];
}

function scalarType(t) {
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'string' || t === 'boolean') return t;
  return 'any';
}

/**
 * Two variants of a tagged enum, folded into one shape. Fields are unioned
 * at every depth; `common` at each object level is the set every variant
 * carries, which is the only set `compareShapes` may report as undeclared.
 */
function mergeVariants(a, b) {
  if (a.kind === 'object' && b.kind === 'object') {
    const props = { ...a.props };
    for (const [k, v] of Object.entries(b.props)) props[k] = k in props ? mergeVariants(props[k], v) : v;
    const commonA = a.common ?? new Set(Object.keys(a.props));
    const commonB = b.common ?? new Set(Object.keys(b.props));
    const common = new Set([...commonA].filter((k) => commonB.has(k)));
    return { kind: 'object', props, required: common, common, nullable: a.nullable || b.nullable };
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return { kind: 'array', items: mergeVariants(a.items, b.items), nullable: a.nullable || b.nullable };
  }
  if (a.kind === 'scalar' && b.kind === 'scalar' && a.type === b.type) {
    return { ...a, nullable: a.nullable || b.nullable };
  }
  return { kind: 'scalar', type: 'union', nullable: a.nullable || b.nullable };
}

/** JSON Schema → normal form. */
export function normalizeSchema(spec, schema, seen = new Set()) {
  if (!schema) return { kind: 'scalar', type: 'any', nullable: true };
  [schema, seen] = deref(spec, schema, seen);
  if (schema.allOf) {
    // utoipa uses allOf for "a $ref, but nullable/described" and for merges.
    const parts = schema.allOf.map((s) => normalizeSchema(spec, s, seen));
    const objs = parts.filter((p) => p.kind === 'object');
    if (objs.length === parts.length) {
      const props = Object.assign({}, ...objs.map((o) => o.props));
      const required = new Set(objs.flatMap((o) => [...o.required]));
      return { kind: 'object', props, required, nullable: schema.nullable === true };
    }
    return parts.length === 1 ? { ...parts[0], nullable: parts[0].nullable || schema.nullable === true } : { kind: 'scalar', type: 'union', nullable: true };
  }
  if (schema.oneOf || schema.anyOf) {
    const parts = (schema.oneOf || schema.anyOf).map((s) => normalizeSchema(spec, s, seen));
    const nonNull = parts.filter((p) => !(p.kind === 'scalar' && p.type === 'null'));
    if (nonNull.length === 1) return { ...nonNull[0], nullable: true };
    if (nonNull.length > 1 && nonNull.every((p) => p.kind === 'object')) {
      // A tagged enum (`#[serde(tag = "view")]` → oneOf of objects). The
      // declared shape describes one variant and says so in prose, so it is
      // compared against the union of the variants' fields, and only a field
      // EVERY variant carries can be reported as undeclared.
      return { ...nonNull.reduce(mergeVariants), nullable: parts.length !== nonNull.length };
    }
    return { kind: 'scalar', type: 'union', nullable: parts.length !== nonNull.length };
  }
  let types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes('null') || schema.nullable === true;
  types = types.filter((t) => t !== 'null');
  if (types.length === 0 && schema.properties) types = ['object'];
  if (types.length === 0 && schema.items) types = ['array'];
  if (types.length === 0) return { kind: 'scalar', type: 'any', nullable: true };
  if (types.length > 1) return { kind: 'scalar', type: 'union', nullable };
  const [t] = types;
  if (t === 'object') {
    if (!schema.properties) return { kind: 'scalar', type: 'any', nullable }; // a free-form map
    const props = {};
    for (const [k, v] of Object.entries(schema.properties)) props[k] = normalizeSchema(spec, v, seen);
    return { kind: 'object', props, required: new Set(schema.required ?? []), nullable };
  }
  if (t === 'array') return { kind: 'array', items: normalizeSchema(spec, schema.items, seen), nullable };
  return { kind: 'scalar', type: scalarType(t), nullable };
}

/**
 * Match a frontend route (`/agents`, `/observability/session/${x}`) to a spec
 * path. The frontend omits the `/api` prefix and writes path parameters as
 * `${…}`; the spec has `/api/...` and `{name}`. Segments compare positionally,
 * and a `${…}` segment matches any `{…}` segment.
 */
export function findOperation(spec, route, method = 'get') {
  if (!route) return null;
  const want = `/api${route}`.split('/');
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    const have = path.split('/');
    if (have.length !== want.length) continue;
    const ok = have.every((seg, i) => seg === want[i] || (seg.startsWith('{') && want[i].startsWith('${')));
    if (ok && ops[method]) return { path, operation: ops[method] };
  }
  return null;
}

/** The 200 response's JSON shape for an operation, in normal form. */
export function responseShape(spec, operation) {
  const schema = operation.responses?.['200']?.content?.['application/json']?.schema;
  if (!schema) return null;
  return normalizeSchema(spec, schema);
}

/** Query parameter names an operation accepts, with whether each is required. */
export function queryParams(operation) {
  const out = new Map();
  for (const p of operation.parameters ?? []) if (p.in === 'query') out.set(p.name, p.required === true);
  return out;
}

// ── the declared side ────────────────────────────────────────────────────────

/**
 * A declared type string → normal form. The first token is the type; a
 * `|null` anywhere marks it nullable; a parenthesised remainder is prose for
 * the model and is ignored here. `"number (0-23)"`, `"string|null"`,
 * `"boolean (true when …)"` all parse.
 */
function parseDeclaredType(s) {
  const nullable = /\|\s*null\b/.test(s);
  const head = s.trim().split(/[\s|(]/)[0];
  const type = head === 'integer' ? 'number' : head;
  return { kind: 'scalar', type: ['number', 'string', 'boolean', 'any'].includes(type) ? type : 'unknown', nullable, raw: s };
}

export function normalizeDeclared(shape) {
  if (Array.isArray(shape)) {
    return { kind: 'array', items: shape.length ? normalizeDeclared(shape[0]) : { kind: 'scalar', type: 'any' } };
  }
  if (shape && typeof shape === 'object') {
    const props = {};
    for (const [k, v] of Object.entries(shape)) {
      if (k.startsWith('$')) continue; // $comment and friends are for humans
      props[k] = normalizeDeclared(v);
    }
    return { kind: 'object', props };
  }
  if (typeof shape === 'string') return parseDeclaredType(shape);
  return { kind: 'scalar', type: 'unknown', raw: String(shape) };
}

// ── comparison ───────────────────────────────────────────────────────────────

/**
 * Where a declared shape and a spec shape disagree. Each finding is
 * `{ code, path, detail }`; `path` is dotted from the response root with
 * `[]` for array items, which is the same path a Query's dot-path argument
 * would use — so a finding names the exact thing a generated surface would
 * bind to.
 */
export function compareShapes(declared, fromSpec, path = '', out = [], opts = {}) {
  const at = (k) => (path ? `${path}.${k}` : k);
  // Root-level keys the caller has chosen not to surface — the control
  // plane's `{data, status_code, message}` envelope, typically. Only at the
  // root: a `message` field inside a row is data.
  const ignored = new Set(path === '' ? opts.ignoreRootKeys ?? [] : []);
  if (fromSpec.kind === 'scalar' && fromSpec.type === 'any') return out; // the spec has nothing to say
  if (declared.kind !== fromSpec.kind) {
    // A declared type string with a kind the spec contradicts. `unknown`
    // declared types (free prose) are reported once, as such.
    out.push({ code: 'type_mismatch', path: path || '(root)',
      detail: `declared ${describe(declared)}, backend returns ${describe(fromSpec)}` });
    return out;
  }
  if (declared.kind === 'object') {
    for (const [k, v] of Object.entries(declared.props)) {
      if (!(k in fromSpec.props)) {
        out.push({ code: 'missing_in_spec', path: at(k), detail: 'declared, but the backend does not return it' });
      } else {
        compareShapes(v, fromSpec.props[k], at(k), out, opts);
      }
    }
    for (const k of Object.keys(fromSpec.props)) {
      if (ignored.has(k)) continue;
      if (fromSpec.common && !fromSpec.common.has(k)) continue; // only some variants have it
      if (!(k in declared.props)) {
        out.push({ code: 'undeclared', path: at(k), detail: `backend returns ${describe(fromSpec.props[k])}, shape does not declare it` });
      }
    }
    return out;
  }
  if (declared.kind === 'array') return compareShapes(declared.items, fromSpec.items, `${path}[]`, out, opts);
  // scalars
  if (declared.type === 'unknown') {
    out.push({ code: 'type_mismatch', path, detail: `"${declared.raw}" is not a type this checker understands; start it with number, string, boolean or any` });
    return out;
  }
  if (fromSpec.type !== 'union' && declared.type !== 'any' && declared.type !== fromSpec.type) {
    out.push({ code: 'type_mismatch', path, detail: `declared ${declared.type}, backend returns ${fromSpec.type}` });
  }
  if (fromSpec.nullable && !declared.nullable) {
    out.push({ code: 'nullability', path, detail: `backend may return null, shape says ${declared.raw}` });
  }
  return out;
}

export function describe(shape) {
  if (shape.kind === 'object') return 'an object';
  if (shape.kind === 'array') return 'an array';
  return shape.type + (shape.nullable ? '|null' : '');
}

/**
 * Substitute a source's declared `$returns` template over the spec shape.
 * `"$response"` is the whole wire response; `"$response.data"` picks into it.
 * Anything else is a declared type string, normalized as usual. This is how a
 * function that reshapes what it fetched (`{ data: rows, total: rows.length }`)
 * still gets its shape checked: the wrapper is declared, the payload is read
 * off the spec.
 */
export function applyReturns(template, wire) {
  if (typeof template === 'string' && template.startsWith('$response')) {
    let cur = wire;
    for (const seg of template.slice('$response'.length).split('.').filter(Boolean)) {
      if (cur.kind !== 'object' || !(seg in cur.props)) {
        throw new Error(`$returns picks "${template}" but the backend response has no "${seg}" there`);
      }
      cur = cur.props[seg];
    }
    return cur;
  }
  if (Array.isArray(template)) return { kind: 'array', items: applyReturns(template[0], wire) };
  if (template && typeof template === 'object') {
    const props = {};
    for (const [k, v] of Object.entries(template)) props[k] = applyReturns(v, wire);
    return { kind: 'object', props, required: new Set(Object.keys(props)) };
  }
  return normalizeDeclared(template);
}

/**
 * Remove one field from a normal-form shape by its dotted path (`[]` steps
 * into an array). For a source's `$omit`: fields the backend returns that a
 * generated surface has no use for — protocol plumbing, blobs, internal ids
 * — declared away with a reason instead of left as silent drift. Throws when
 * the path names nothing, because an omission of a field that does not exist
 * is a stale note.
 */
export function omitPath(shape, path) {
  const [head, ...rest] = path.split('.');
  if (head === '[]') {
    // The response itself is an array; the path names a field of its items.
    if (shape.kind !== 'array') throw new Error(`$omit "${path}": the response is not an array`);
    if (!rest.length) throw new Error(`$omit "${path}": name a field inside the array items`);
    return { ...shape, items: omitPath(shape.items, rest.join('.')) };
  }
  const step = head.endsWith('[]') ? head.slice(0, -2) : head;
  if (shape.kind !== 'object' || !(step in shape.props)) {
    throw new Error(`$omit names "${path}", but the backend response has no "${step}" there`);
  }
  let child = shape.props[step];
  if (head.endsWith('[]')) {
    if (child.kind !== 'array') throw new Error(`$omit "${path}": "${step}" is not an array`);
    if (!rest.length) throw new Error(`$omit "${path}": name a field inside the array items, or omit "${step}" itself`);
    child = { ...child, items: omitPath(child.items, rest.join('.')) };
    return { ...shape, props: { ...shape.props, [step]: child } };
  }
  if (!rest.length) {
    const props = { ...shape.props };
    delete props[step];
    return { ...shape, props };
  }
  return { ...shape, props: { ...shape.props, [step]: omitPath(child, rest.join('.')) } };
}
