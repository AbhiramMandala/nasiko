/**
 * Turns parsed DSL statements into a materialized element tree.
 *
 * Full re-walk per chunk, not incremental patching — matches OpenUI Lang's
 * own real behavior (confirmed by direct source inspection) and is cheap
 * enough at our scale. Known limitation: a component that keeps its own
 * internal UI state (e.g. app-table's pagination/search) resets on every
 * re-render, since the element is recreated, not patched.
 *
 * `Query`, `Mutation`, `Action`, and `Slot` are special-cased by name here,
 * before the generic component-lookup path — none of them are real design-
 * system components. This is the one pattern to extend for anything new.
 */

import { createStore } from './store.js';
import { BUILTINS, toNumber } from './builtins.js';

/**
 * Builds a { PascalName -> {tag, def} } lookup from a catalog (already
 * merged with dsl-overrides.json via `mergeDslOverrides`, if applicable).
 * @param {object} catalog
 * @returns {Map<string, {tag: string, def: object}>}
 */
export function buildComponentIndex(catalog) {
  const index = new Map();
  for (const [tag, def] of Object.entries(catalog.components)) {
    const pascal = tag.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
    index.set(pascal, { tag, def });
  }
  return index;
}

/**
 * Merges `dsl-overrides.json`-shaped metadata (childrenParam/dataParam/
 * actionParam/slots/status/...) onto a real catalog's component defs,
 * without ever mutating the real, generated catalog object itself.
 * @param {object} catalog
 * @param {object} overrides { [tag]: {childrenParam?, dataParam?, actionParam?, slots?, status, ...} }
 */
export function mergeDslOverrides(catalog, overrides) {
  const merged = { ...catalog, components: {} };
  for (const [tag, def] of Object.entries(catalog.components)) {
    merged.components[tag] = { ...def, ...(overrides[tag] || {}) };
  }
  return merged;
}

/**
 * Walks an AST calling `visit(kind, name)` for every `Ref` (`kind:'ref'`)
 * and `StateRef` (`kind:'state'`) found anywhere inside it. Shared by this
 * file's `$state` auto-declare pass and gc.js's reachability walk.
 */
export function walkAstRefs(node, visit) {
  if (!node || typeof node !== 'object') return;
  switch (node.k) {
    case 'Ref': visit('ref', node.n); return;
    case 'StateRef': visit('state', node.n); return;
    case 'BinOp': walkAstRefs(node.left, visit); walkAstRefs(node.right, visit); return;
    case 'UnaryOp': walkAstRefs(node.operand, visit); return;
    case 'Ternary':
      walkAstRefs(node.cond, visit); walkAstRefs(node.then, visit); walkAstRefs(node.else, visit);
      return;
    case 'Member': walkAstRefs(node.obj, visit); return;
    case 'Index': walkAstRefs(node.obj, visit); walkAstRefs(node.index, visit); return;
    case 'Arr': for (const e of node.els) walkAstRefs(e, visit); return;
    case 'Obj': for (const [, v] of node.entries) walkAstRefs(v, visit); return;
    case 'Comp':
    case 'BuiltinCall':
      for (const a of node.args) walkAstRefs(a, visit);
      return;
    default: return;
  }
}

function paramOrder(def) {
  const excluded = new Set((def.excludedFromCatalog || []).map((e) => e.attribute));
  const attrs = Object.keys(def.attributes || {}).filter((k) => !excluded.has(k));
  // textParam: the component's real visible content is plain light-DOM text
  // (e.g. app-button/app-badge/app-tag — confirmed directly against their
  // source: "content goes in the default slot" / "the label is whatever
  // you put in the element"), not any attribute. Distinct from
  // childrenParam (a list of real child ELEMENTS, e.g. app-stack/app-modal).
  const leading = def.childrenParam ? ['children'] : def.dataParam ? ['data'] : def.textParam ? ['text'] : [];
  const trailing = def.actionParam ? ['action'] : [];
  return [...leading, ...attrs, ...trailing];
}

function coerceAndValidate(def, paramName, value, ctx, componentName) {
  const attr = (def.attributes || {})[paramName];
  if (!attr) return value;
  if (attr.type === 'enum' && value != null && !attr.values.includes(value)) {
    ctx.errors.push({
      source: 'materializer', code: 'invalid-enum', component: componentName,
      message: `${componentName}.${paramName} = ${JSON.stringify(value)} is not one of: ${attr.values.join('|')}`,
    });
    return attr.default !== undefined ? attr.default : null;
  }
  if (attr.required && (value === null || value === undefined)) {
    ctx.errors.push({
      source: 'materializer', code: 'missing-required', component: componentName,
      message: `${componentName}.${paramName} is required but missing`,
    });
    return attr.default !== undefined ? attr.default : value;
  }
  return value;
}

// ─── Core evaluator ─────────────────────────────────────────────────────

/**
 * Builds the same evaluation context `materialize()` uses internally, for
 * callers that need to evaluate a raw AST OUTSIDE of a materialize() call —
 * specifically, `query-manager.js`'s `triggerAction`, which must evaluate
 * `@Set`/`@ToAssistant`/`@OpenUrl`/a Mutation's args AST at the moment an
 * Action actually fires (against the CURRENT `$state`/statement list), not
 * against whatever was true when the surface was last rendered.
 * @param {Array<{id: string, ast: object}>} statements
 * @param {Map} componentIndex
 * @param {Map} queryResults
 * @param {Map} mutationResults
 * @param {ReturnType<typeof createStore>} store
 */
export function buildEvalContext(statements, componentIndex, queryResults, mutationResults, store) {
  const symbols = new Map();
  for (const { id, ast } of statements) {
    if (id.startsWith('$')) continue;
    if (ast.k === 'Null') { symbols.delete(id); continue; }
    symbols.set(id, ast);
  }
  return {
    symbols, store, queryResults, mutationResults,
    mutationDefs: new Map(), componentIndex,
    unresolved: [], queries: [], seenQueryIds: new Set(), errors: [], visited: new Set(),
    resolveOverride: null,
  };
}

/**
 * Evaluates a single AST node against an existing context — exported for
 * `query-manager.js`'s fire-time Action evaluation (see `buildEvalContext`).
 */
export function evaluateExpr(node, ctx) {
  if (!node) return null;
  switch (node.k) {
    case 'Str': return node.v;
    case 'Num': return node.v;
    case 'Bool': return node.v;
    case 'Null': return null;
    case 'StateRef': return ctx.store.get(node.n);
    case 'Ref': return resolveRef(node.n, ctx);
    case 'BinOp': return evalBinOp(node, ctx);
    case 'UnaryOp': return evalUnaryOp(node, ctx);
    case 'Ternary':
      return evaluateExpr(node.cond, ctx) ? evaluateExpr(node.then, ctx) : evaluateExpr(node.else, ctx);
    case 'Member': return evalMember(node, ctx);
    case 'Index': return evalIndex(node, ctx);
    case 'Arr': {
      const out = [];
      for (const el of node.els) {
        const v = evaluateExpr(el, ctx);
        if (v === null && (el.k === 'Ref' || el.k === 'Comp')) continue; // dropped, not literal null
        out.push(v);
      }
      return out;
    }
    case 'Obj': {
      const out = {};
      for (const [k, v] of node.entries) out[k] = evaluateExpr(v, ctx);
      return out;
    }
    case 'BuiltinCall': return evalBuiltinCall(node, ctx);
    case 'Comp': return evalComp(node, ctx);
    default: return null;
  }
}

function resolveRef(name, ctx) {
  if (ctx.resolveOverride) {
    const v = ctx.resolveOverride(name);
    if (v !== undefined) return v; // @Each loop-variable shadow
  }
  if (ctx.visited.has(name)) return null; // cycle
  if (!ctx.symbols.has(name)) { ctx.unresolved.push(name); return null; } // forward ref, not yet defined
  const targetAst = ctx.symbols.get(name);
  if (targetAst.k === 'Comp' && targetAst.name === 'Query') return materializeQuery(name, targetAst, ctx);
  if (targetAst.k === 'Comp' && targetAst.name === 'Mutation') return materializeMutation(name, targetAst, ctx);
  ctx.visited.add(name);
  try {
    const value = evaluateExpr(targetAst, ctx);
    if (value && typeof value === 'object' && value.type === 'element') value.statementId = name;
    return value;
  } finally { ctx.visited.delete(name); }
}

function evalBinOp(node, ctx) {
  if (node.op === '&&') {
    const left = evaluateExpr(node.left, ctx);
    return left ? evaluateExpr(node.right, ctx) : left;
  }
  if (node.op === '||') {
    const left = evaluateExpr(node.left, ctx);
    return left ? left : evaluateExpr(node.right, ctx);
  }
  const left = evaluateExpr(node.left, ctx);
  const right = evaluateExpr(node.right, ctx);
  switch (node.op) {
    case '+':
      if (typeof left === 'string' || typeof right === 'string') {
        return String(left ?? '') + String(right ?? '');
      }
      return toNumber(left) + toNumber(right);
    case '-': return toNumber(left) - toNumber(right);
    case '*': return toNumber(left) * toNumber(right);
    case '/': return toNumber(right) === 0 ? 0 : toNumber(left) / toNumber(right);
    case '%': return toNumber(right) === 0 ? 0 : toNumber(left) % toNumber(right);
    case '==': return left == right; // eslint-disable-line eqeqeq
    case '!=': return left != right; // eslint-disable-line eqeqeq
    case '>': return toNumber(left) > toNumber(right);
    case '<': return toNumber(left) < toNumber(right);
    case '>=': return toNumber(left) >= toNumber(right);
    case '<=': return toNumber(left) <= toNumber(right);
    default: return null;
  }
}

function evalUnaryOp(node, ctx) {
  const operand = evaluateExpr(node.operand, ctx);
  if (node.op === '!') return !operand;
  if (node.op === '-') return -toNumber(operand);
  return null;
}

function evalMember(node, ctx) {
  const obj = evaluateExpr(node.obj, ctx);
  if (obj == null) return null;
  if (Array.isArray(obj)) {
    if (node.field === 'length') return obj.length;
    return obj.map((item) => (item == null ? null : (item[node.field] ?? null)));
  }
  return obj[node.field];
}

function evalIndex(node, ctx) {
  const obj = evaluateExpr(node.obj, ctx);
  const idx = evaluateExpr(node.index, ctx);
  if (obj == null || idx == null) return null;
  if (Array.isArray(obj)) return obj[toNumber(idx)];
  return obj[String(idx)];
}

function evalBuiltinCall(node, ctx) {
  if (node.name === 'Each') return evalEach(node.args, ctx);
  const builtin = BUILTINS[node.name];
  if (!builtin) return null;
  const args = node.args.map((a) => evaluateExpr(a, ctx));
  return builtin.fn(...args);
}

function evalEach(argsAst, ctx) {
  if (argsAst.length < 3) return [];
  const arr = evaluateExpr(argsAst[0], ctx);
  if (!Array.isArray(arr)) return [];
  const varNode = argsAst[1];
  const varName = varNode.k === 'Ref' ? varNode.n : varNode.k === 'Str' ? varNode.v : null;
  if (!varName) return [];
  const template = argsAst[2];
  const parentOverride = ctx.resolveOverride;
  return arr.map((item) => {
    const childCtx = {
      ...ctx,
      resolveOverride: (name) => (name === varName ? item : (parentOverride ? parentOverride(name) : undefined)),
    };
    return evaluateExpr(template, childCtx);
  });
}

function evalComp(node, ctx) {
  if (node.name === 'Action') return materializeAction(node, ctx);
  if (node.name === 'Slot') return materializeSlot(node, ctx);
  return evalRealComp(node, ctx);
}

function materializeQuery(statementId, ast, ctx) {
  const [toolNode, argsNode, defaultsNode, pathNode] = ast.args;
  const toolName = toolNode && toolNode.k === 'Str' ? toolNode.v : null;
  const args = argsNode ? evaluateExpr(argsNode, ctx) : [];
  const defaults = defaultsNode !== undefined ? evaluateExpr(defaultsNode, ctx) : null;
  const path = pathNode && pathNode.k === 'Str' ? pathNode.v : null;
  if (toolName && !ctx.seenQueryIds.has(statementId)) {
    ctx.seenQueryIds.add(statementId);
    ctx.queries.push({ statementId, toolName, args: Array.isArray(args) ? args : [], path });
  }
  return ctx.queryResults.has(statementId) ? ctx.queryResults.get(statementId) : defaults;
}

function materializeMutation(statementId, ast, ctx) {
  const [sourceNode, argsNode] = ast.args;
  const sourceName = sourceNode && sourceNode.k === 'Str' ? sourceNode.v : null;
  if (sourceName) {
    ctx.mutationDefs.set(statementId, { sourceName, argsAst: argsNode || { k: 'Arr', els: [] } });
  }
  return ctx.mutationResults.get(statementId) || { status: 'idle', data: null, error: null };
}

/** `Action([@Run(x), @Set($y, expr), @Reset($z), @ToAssistant(msg), @OpenUrl(url)])` */
function materializeAction(node, ctx) {
  const stepsNode = node.args[0];
  const stepAsts = stepsNode && stepsNode.k === 'Arr' ? stepsNode.els : [];
  const steps = [];
  for (const s of stepAsts) {
    if (!s || s.k !== 'BuiltinCall') continue;
    const a = s.args;
    if (s.name === 'Run') {
      const refNode = a[0];
      if (refNode && refNode.k === 'Ref') {
        const targetAst = ctx.symbols.get(refNode.n);
        const isMutation = targetAst && targetAst.k === 'Comp' && targetAst.name === 'Mutation';
        // materializeAction only *peeks* at symbols to classify the ref —
        // it doesn't go through resolveRef, so nothing else would ever
        // populate `mutationDefs` for a Mutation only ever reached this
        // way. Explicitly materialize it here so query-manager.js's
        // triggerAction can look up its sourceName/argsAst later.
        if (isMutation) materializeMutation(refNode.n, targetAst, ctx);
        steps.push({ kind: 'run', statementId: refNode.n, refType: isMutation ? 'mutation' : 'query' });
      }
    } else if (s.name === 'Set') {
      const targetNode = a[0];
      const target = targetNode && targetNode.k === 'StateRef' ? targetNode.n : null;
      if (target) steps.push({ kind: 'set', target, valueAst: a[1] || { k: 'Null' } });
    } else if (s.name === 'Reset') {
      const targets = a.filter((x) => x.k === 'StateRef').map((x) => x.n);
      if (targets.length) steps.push({ kind: 'reset', targets });
    } else if (s.name === 'ToAssistant') {
      steps.push({ kind: 'toAssistant', messageAst: a[0] || { k: 'Str', v: '' } });
    } else if (s.name === 'OpenUrl') {
      steps.push({ kind: 'openUrl', urlAst: a[0] || { k: 'Str', v: '' } });
    }
  }
  return { type: 'action', steps };
}

/** `Slot("footer", child)` — tags the materialized child with `.slot` so
 * render.js can mark it (e.g. `data-slot="footer"`) before appending. */
function materializeSlot(node, ctx) {
  const slotNameNode = node.args[0];
  const childNode = node.args[1];
  const slotName = slotNameNode && slotNameNode.k === 'Str' ? slotNameNode.v : null;
  const value = childNode ? evaluateExpr(childNode, ctx) : null;
  if (value && typeof value === 'object' && value.type === 'element' && slotName) {
    value.slot = slotName;
  }
  return value;
}

function evalRealComp(node, ctx) {
  const entry = ctx.componentIndex.get(node.name);
  if (!entry) return null; // unknown component — dropped, matches OpenUI's rule
  const params = paramOrder(entry.def);
  const props = {};
  let children = null;
  let data = null;
  let text = null;
  for (let i = 0; i < params.length && i < node.args.length; i++) {
    const paramName = params[i];
    let value = evaluateExpr(node.args[i], ctx);
    if (paramName === 'text') text = value == null ? null : String(value);
    else if (paramName === 'children') children = Array.isArray(value) ? value : [];
    else if (paramName === 'data') {
      // A propAssignments component (e.g. app-chart) may legitimately take
      // an object form (`{labels, datasets}`), not just an array of rows —
      // only force-coerce to an array for the plain dataParam convention
      // (app-table-style: always a row array, resolved via a synthetic
      // registered data source in render.js).
      data = (entry.def.propAssignments || []).includes('data')
        ? value
        : (Array.isArray(value) ? value : []);
    }
    else {
      value = coerceAndValidate(entry.def, paramName, value, ctx, node.name);
      props[paramName] = value;
    }
  }
  if (node.args.length > params.length) {
    ctx.errors.push({
      source: 'materializer', code: 'excess-args', component: node.name,
      message: `${node.name} given ${node.args.length} args, only ${params.length} params exist`,
    });
  }
  return { type: 'element', tag: entry.tag, typeName: node.name, props, children, data, text };
}

// ─── Entry point ────────────────────────────────────────────────────────

/**
 * @param {Array<{id: string, ast: object}>} statements latest-wins per id; a
 *   `name = null` statement deletes any earlier statement with that name.
 * @param {Map<string, {tag: string, def: object}>} componentIndex
 * @param {Map<string, any>} [queryResults] statementId -> resolved Query value
 * @param {Map<string, {status, data, error}>} [mutationResults] statementId -> Mutation result
 * @param {ReturnType<typeof createStore>} [store] reactive `$variable` store —
 *   pass the SAME store across every call within one surface session so
 *   values survive re-renders; defaults to a fresh throwaway store.
 * @returns {{root: object|null, unresolved: string[], queries: Array, mutationDefs: Map, errors: Array}}
 */
export function materialize(
  statements, componentIndex, queryResults = new Map(), mutationResults = new Map(), store = createStore(),
) {
  const symbols = new Map();
  const stateDecls = [];
  for (const { id, ast } of statements) {
    if (id.startsWith('$')) { stateDecls.push({ id, ast }); continue; }
    if (ast.k === 'Null') { symbols.delete(id); continue; } // explicit delete
    symbols.set(id, ast);
  }

  const ctx = {
    symbols, store, queryResults, mutationResults,
    mutationDefs: new Map(),
    componentIndex,
    unresolved: [],
    queries: [],
    seenQueryIds: new Set(),
    errors: [],
    visited: new Set(),
    resolveOverride: null,
  };

  // Explicit $state declarations: only fills a value the store doesn't
  // already have (store.initialize semantics — never clobber a value
  // already changed via @Set).
  const declaredNames = new Set(stateDecls.map((s) => s.id));
  for (const { id, ast } of stateDecls) {
    store.initialize({ [id]: evaluateExpr(ast, ctx) });
  }
  // Auto-declare: any $var referenced anywhere but never explicitly
  // declared gets an implicit `null` default.
  const referencedState = new Set();
  for (const { ast } of statements) {
    walkAstRefs(ast, (kind, name) => { if (kind === 'state') referencedState.add(name); });
  }
  for (const name of referencedState) {
    if (!declaredNames.has(name)) store.initialize({ [name]: null });
  }

  const rootAst = symbols.get('root');
  const root = rootAst ? evaluateExpr(rootAst, ctx) : null;
  if (root && typeof root === 'object') root.statementId = 'root';

  return { root, unresolved: ctx.unresolved, queries: ctx.queries, mutationDefs: ctx.mutationDefs, errors: ctx.errors };
}
