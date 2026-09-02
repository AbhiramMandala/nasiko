/**
 * Statements in, a materialized element tree out.
 *
 * Full re-walk per chunk: every new bit of streamed text re-derives the whole
 * tree from the whole statement list. No incremental patching, no dirty
 * tracking. At the size of one dashboard that is cheap, and it removes the
 * entire class of bug where a partial update leaves the tree describing
 * something the statements no longer say.
 *
 * Four names are intercepted before the generic component lookup, because they
 * are not components: `Query`, `Mutation`, `Action` and `Slot`. That
 * interception is the extension point — anything else that is call-shaped but
 * not an element goes here too, rather than growing a second mechanism.
 *
 * Evaluation is forgiving throughout (see coerce.js). Nothing in this file
 * throws on bad input: a surface is model-authored and a thrown error costs the
 * whole dashboard, so every failure degrades to null plus a diagnostic.
 *
 * @module common/surface/materialize
 */

import { toNumber, toText, toArray } from './coerce.js';
import { EACH, isEagerBuiltin, callBuiltin } from './builtins.js';

/** Call-shaped names that are not components. */
const INTERCEPTED = new Set(['Query', 'Mutation', 'Action', 'Slot']);

/** Action step names, per agent.yaml rule 5. */
const ACTION_STEPS = new Set(['Run', 'Set', 'Reset', 'ToAssistant', 'OpenUrl']);

/**
 * `{ PascalName -> {tag, def} }` from a DSL catalog.
 * @param {{components: Record<string, any>}} catalog
 */
export function buildComponentIndex(catalog) {
  const index = new Map();
  for (const [tag, def] of Object.entries(catalog.components || {})) {
    const pascal = tag.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
    index.set(pascal, { tag, def });
  }
  return index;
}

/**
 * A lexical binding. Two things use it: `@Each`'s loop variable, and `$event`
 * during a single Action run. Both are values that exist for the duration of
 * one evaluation and must not outlive it.
 */
export function childScope(parent, name, value) {
  return { name, value, parent };
}
function lookupScope(scope, name) {
  for (let s = scope; s; s = s.parent) if (s.name === name) return { found: true, value: s.value };
  return { found: false, value: undefined };
}

/**
 * @param {Array<{id: string, ast: object}>} statements latest wins per id
 * @param {Map<string, {tag: string, def: object}>} componentIndex
 * @param {{store?: {get(name: string): unknown}, queryResults?: Map<string, unknown>, mutationResults?: Map<string, any>}} [ctx]
 */
/**
 * Visit every name an AST references, without evaluating it.
 *
 * Evaluation cannot answer "what does this statement depend on" — it resolves
 * refs through the scope chain and short-circuits (a false `Ternary` branch is
 * never walked), so a purely structural question needs a purely structural
 * walk. `gc.js` uses it to decide reachability from `root`.
 *
 * `visit` is called as `(kind, name)` with kind `'ref'` for a statement
 * reference and `'state'` for a `$state` one — the caller needs the difference
 * because `$state` is always kept, reachable or not.
 *
 * @param {object|null} node
 * @param {(kind: 'ref'|'state', name: string) => void} visit
 */
export function walkAstRefs(node, visit) {
  if (!node || typeof node !== 'object') return;
  switch (node.k) {
    case 'Ref': visit('ref', node.n); return;
    case 'StateRef': visit('state', node.n); return;
    case 'BinOp': walkAstRefs(node.left, visit); walkAstRefs(node.right, visit); return;
    case 'UnaryOp': walkAstRefs(node.operand, visit); return;
    case 'Ternary':
      walkAstRefs(node.cond, visit);
      walkAstRefs(node.then, visit);
      walkAstRefs(node.else, visit);
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

export function materialize(statements, componentIndex, ctx = {}) {
  // `undefined`, not `null`. "No store" must mean "nothing is set", so a
  // `$state` falls through to the statement that declared it. Answering null
  // meant `$view = "cost"` evaluated to null with no store attached, every
  // `$view == "cost"` took its else branch, and whole halves of a dashboard —
  // including the Query behind them — silently never evaluated.
  const store = ctx.store ?? { get: () => undefined };
  const queryResults = ctx.queryResults ?? new Map();
  const mutationResults = ctx.mutationResults ?? new Map();

  // Symbol table. A later statement with the same name replaces the earlier
  // one — that alone is the whole revision model. `name = null` deletes,
  // per agent.yaml rule 9, so it must not survive as a literal null value.
  const symbols = new Map();
  for (const { id, ast } of statements) {
    if (ast && ast.k === 'Null') symbols.delete(id);
    else symbols.set(id, ast);
  }

  const unresolved = [];
  const diagnostics = [];
  /** @type {Array<{statementId: string, source: string, args: unknown[], select: string|null}>} */
  const queries = [];
  /** @type {Array<{statementId: string, source: string, argsAst: object[]}>} */
  const mutations = [];
  /**
   * A statement referenced from two places is evaluated twice — there is no
   * memoization, deliberately, because a `@Each` body has to be re-evaluated
   * per row. Declaring it twice would make one dashboard look like two fetches.
   */
  const registered = new Set();
  /** Statements already warned about a whole-response default — a Query
   *  referenced twice is evaluated twice, and one mistake is one message. */
  const warnedDefault = new Set();
  const stateNames = new Set();
  const visiting = new Set();

  const note = (code, message, pointer) => diagnostics.push({ source: 'materializer', code, message, pointer });

  /** Every `$name` mentioned anywhere, so undeclared ones can be seeded null. */
  const collectStates = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.k === 'StateRef') stateNames.add(node.n);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(collectStates);
      else if (v && typeof v === 'object') collectStates(v);
    }
  };
  for (const ast of symbols.values()) collectStates(ast);
  for (const id of symbols.keys()) if (id.startsWith('$')) stateNames.add(id);

  /**
   * @param {object|null} node
   * @param {string} statementId the statement this expression belongs to
   * @param {object|null} scope `@Each` loop-variable chain
   */
  /** Does this subtree read any `$state`? See the Query intercept for why. */
  function mentionsState(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.k === 'StateRef') return true;
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) { if (v.some(mentionsState)) return true; }
      else if (v && typeof v === 'object' && mentionsState(v)) return true;
    }
    return false;
  }

  /**
   * The value a `$name` statement declares. Also the `@Reset` target — which is
   * why it is computed for every state name at the end, not only on demand.
   */
  function declaredValue(name, statementId) {
    if (!symbols.has(name)) return null;
    if (visiting.has(name)) { note('cycle', `"${name}" refers to itself`, statementId); return null; }
    visiting.add(name);
    try { return evaluate(symbols.get(name), name, null); }
    finally { visiting.delete(name); }
  }

  function evaluate(node, statementId, scope) {
    if (!node) return null;

    switch (node.k) {
      case 'Str': return node.v;
      case 'Num': return node.v;
      case 'Bool': return node.v;
      case 'Null': return null;

      case 'StateRef': {
        // A per-fire binding first. `$event` is the live value the component
        // just produced, and it belongs to one Action run — putting it in the
        // store would leave the last thing anyone typed sitting there as
        // durable state for every later expression to read.
        const bound = lookupScope(scope, node.n);
        if (bound.found) return bound.value;

        // Then the store, then the statement that declared it. That fallback
        // is what makes the *first* paint of a turn correct: `$days = 7` and
        // `historyQ = Query("fetchUsageHistory", [$days], [])` arrive in the
        // same chunk, and the query has to fetch 7 rather than fetch null and
        // then fetch again once something hydrated the store.
        const held = store.get(node.n);
        if (held !== undefined) return held;
        return declaredValue(node.n, statementId);
      }

      case 'Ref': {
        // A loop variable shadows a statement of the same name, which is what
        // makes `@Each(rows, "r", r.cost)` mean the row and not a statement.
        const local = lookupScope(scope, node.n);
        if (local.found) return local.value;
        if (visiting.has(node.n)) { note('cycle', `"${node.n}" refers to itself`, statementId); return null; }
        if (!symbols.has(node.n)) { unresolved.push(node.n); return null; }
        visiting.add(node.n);
        try {
          const value = evaluate(symbols.get(node.n), node.n, null);
          if (value && typeof value === 'object' && value.type === 'element') value.statementId = node.n;
          return value;
        } finally { visiting.delete(node.n); }
      }

      case 'UnaryOp': {
        const v = evaluate(node.operand, statementId, scope);
        return node.op === '!' ? !v : -toNumber(v);
      }

      case 'BinOp': return binop(node, statementId, scope);

      case 'Ternary':
        return evaluate(node.cond, statementId, scope)
          ? evaluate(node.then, statementId, scope)
          : evaluate(node.else, statementId, scope);

      case 'Member': {
        const target = evaluate(node.obj, statementId, scope);
        if (target === null || target === undefined) return null;
        // On an array, `.field` plucks that field from every element. This is
        // what lets `rows.cost` be the array a chart's `data` needs, and it is
        // taught to the model as "array pluck" in agent.yaml.
        if (Array.isArray(target)) {
          if (node.field === 'length') return target.length;
          return target.map((item) => (item === null || item === undefined ? null : item[node.field] ?? null));
        }
        if (typeof target !== 'object') return null;
        return target[node.field] ?? null;
      }

      case 'Index': {
        const target = evaluate(node.obj, statementId, scope);
        const index = evaluate(node.index, statementId, scope);
        if (target === null || target === undefined || index === null || index === undefined) return null;
        if (Array.isArray(target)) return target[toNumber(index)] ?? null;
        if (typeof target !== 'object') return null;
        return target[String(index)] ?? null;
      }

      case 'Arr': {
        const out = [];
        for (const el of node.els) {
          const v = evaluate(el, statementId, scope);
          // A reference that has not arrived yet is absent, not a literal null
          // in the middle of a children array.
          if (v === null && (el.k === 'Ref' || el.k === 'Comp')) continue;
          out.push(v);
        }
        return out;
      }

      case 'Obj': {
        const out = {};
        for (const [k, v] of node.entries) out[k] = evaluate(v, statementId, scope);
        return out;
      }

      case 'BuiltinCall': return builtin(node, statementId, scope);

      case 'Comp': return comp(node, statementId, scope);

      default: return null;
    }
  }

  function binop(node, statementId, scope) {
    const { op } = node;

    // Short-circuit, and value-returning rather than boolean-returning, so
    // `$label || "Untitled"` yields the string rather than `true`.
    if (op === '&&') {
      const left = evaluate(node.left, statementId, scope);
      return left ? evaluate(node.right, statementId, scope) : left;
    }
    if (op === '||') {
      const left = evaluate(node.left, statementId, scope);
      return left ? left : evaluate(node.right, statementId, scope);
    }

    const l = evaluate(node.left, statementId, scope);
    const r = evaluate(node.right, statementId, scope);

    switch (op) {
      // `+` is concatenation the moment either side is a string. That is the
      // rule the model is taught, and it is what makes `"Cost: " + total` work
      // without a format call.
      case '+': return (typeof l === 'string' || typeof r === 'string')
        ? toText(l) + toText(r)
        : toNumber(l) + toNumber(r);
      case '-': return toNumber(l) - toNumber(r);
      case '*': return toNumber(l) * toNumber(r);
      // Division by zero is 0, never Infinity or NaN — a dashboard prints this.
      case '/': { const d = toNumber(r); return d === 0 ? 0 : toNumber(l) / d; }
      case '%': { const d = toNumber(r); return d === 0 ? 0 : toNumber(l) % d; }
      case '==': return l == r; // eslint-disable-line eqeqeq -- loose by specification
      case '!=': return l != r; // eslint-disable-line eqeqeq
      case '>': return toNumber(l) > toNumber(r);
      case '<': return toNumber(l) < toNumber(r);
      case '>=': return toNumber(l) >= toNumber(r);
      case '<=': return toNumber(l) <= toNumber(r);
      default: return null;
    }
  }

  function builtin(node, statementId, scope) {
    // `@Each` receives its template unevaluated — that is the whole point of
    // it, and why it cannot come from the eager table.
    if (node.name === EACH) {
      const list = toArray(evaluate(node.args[0], statementId, scope));
      const varNode = node.args[1];
      const varName = varNode?.k === 'Str' ? varNode.v : varNode?.k === 'Ref' ? varNode.n : null;
      const template = node.args[2];
      if (!varName || !template) { note('bad_each', '@Each needs (array, varName, template)', statementId); return []; }
      return list.map((item) => evaluate(template, statementId, childScope(scope, varName, item)));
    }
    if (!isEagerBuiltin(node.name)) {
      // An Action step reaching expression position means the model wrote
      // @Set/@Run outside an Action; say so rather than rendering nothing.
      const why = ACTION_STEPS.has(node.name) ? 'is an Action step, not a value' : 'is not a builtin';
      note('unknown_builtin', `@${node.name} ${why}`, statementId);
      return null;
    }
    return callBuiltin(node.name, node.args.map((a) => evaluate(a, statementId, scope)));
  }

  function comp(node, statementId, scope) {
    if (INTERCEPTED.has(node.name)) return intercepted(node, statementId, scope);

    const entry = componentIndex.get(node.name);
    if (!entry) {
      note('unknown_component_type', `"${node.name}" is not in the catalog`, statementId);
      return null;
    }

    const params = entry.def.paramOrder ?? Object.keys(entry.def.attributes ?? {});
    if (node.args.length > params.length) {
      note('excess_arguments',
        `${node.name} takes ${params.length} arguments, ${node.args.length} given`, statementId);
    }

    const props = {};
    let children = null;
    let data = null;
    let text = null;
    let action = null;

    for (let i = 0; i < params.length && i < node.args.length; i++) {
      const param = params[i];
      const value = evaluate(node.args[i], statementId, scope);
      if (param === 'children') children = toArray(value);
      else if (param === 'data') data = value;
      else if (param === 'text') text = value;
      else if (param === 'action') action = value;
      else props[param] = value;
    }

    return {
      type: 'element',
      tag: entry.tag,
      typeName: node.name,
      props,
      children,
      data,
      text,
      action,
      slot: null,
    };
  }

  function intercepted(node, statementId, scope) {
    switch (node.name) {
      case 'Query': {
        // Query("source", [args], default, "dot.path")
        const source = evaluate(node.args[0], statementId, scope);
        const args = toArray(evaluate(node.args[1], statementId, scope));
        const fallback = node.args.length > 2 ? evaluate(node.args[2], statementId, scope) : null;
        const selectNode = node.args[3];
        const select = selectNode ? toText(evaluate(selectNode, statementId, scope)) || null : null;
        if (typeof source !== 'string' || !source) {
          note('bad_query', 'Query needs a data-source name as its first argument', statementId);
          return fallback;
        }
        // Whether these args read `$state` decides what happens when they
        // change. agent.yaml rule 5 is explicit that a `$variable` moving must
        // NOT re-fetch on its own — only `@Run` does that. But a *revision
        // turn* rewriting `Query("fetchUsageHistory", [30], [])` by hand is a
        // different thing and should fetch, and both look identical once the
        // args are evaluated. This flag is what tells them apart.
        const stateful = mentionsState(node.args[1]);
        if (!registered.has(statementId)) {
          registered.add(statementId);
          queries.push({ statementId, source, args, select, stateful });
        }
        // The default stands in for the value *after* the dot-path, because
        // that is what the component will eventually receive. Handing it the
        // whole response instead is a mistake the generator makes — it writes
        // `Query(src, args, {data: [], total: 0}, "data")` and the table gets
        // an object where it wanted rows, then fails somewhere else entirely
        // with "needs an array of rows".
        //
        // Detected narrowly rather than guessed at: only when the default is a
        // plain object that literally contains the first path segment, which no
        // correct default ever does. Applying the path to the default instead
        // would look like a fix and break the correct case — `selectPath([],
        // "data")` is null, so a right answer would become a wrong one.
        if (select && fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
          const head = String(select).split('.')[0];
          if (head && Object.prototype.hasOwnProperty.call(fallback, head) && !warnedDefault.has(statementId)) {
            warnedDefault.add(statementId);
            note(
              'default_is_whole_response',
              `${statementId}'s default looks like the whole response — with a "${select}" path, `
                + `the default should be what that path yields, not the object containing it`,
              statementId,
            );
          }
        }

        // Resolved value if the manager has one, otherwise the declared
        // default — which is why a dashboard shows zeroes rather than blanks
        // while its first fetch is in flight.
        return queryResults.has(statementId) ? queryResults.get(statementId) : fallback;
      }

      case 'Mutation': {
        const source = evaluate(node.args[0], statementId, scope);
        if (typeof source !== 'string' || !source) {
          note('bad_mutation', 'Mutation needs a source name as its first argument', statementId);
          return null;
        }
        if (!registered.has(statementId)) {
          registered.add(statementId);
          mutations.push({ statementId, source, argsAst: node.args[1]?.els ?? [] });
        }
        return mutationResults.get(statementId) ?? { status: 'idle', data: null, error: null };
      }

      case 'Action': {
        const stepNodes = node.args[0]?.k === 'Arr' ? node.args[0].els : [];
        const steps = [];
        for (const step of stepNodes) {
          if (step?.k !== 'BuiltinCall' || !ACTION_STEPS.has(step.name)) {
            note('bad_action_step', 'an Action step must be @Run/@Set/@Reset/@ToAssistant/@OpenUrl', statementId);
            continue;
          }
          steps.push(actionStep(step, statementId, scope));
        }
        return { type: 'action', statementId, steps };
      }

      case 'Slot': {
        const name = toText(evaluate(node.args[0], statementId, scope));
        const child = evaluate(node.args[1], statementId, scope);
        if (!child || child.type !== 'element') {
          note('bad_slot', 'Slot needs a component as its second argument', statementId);
          return child ?? null;
        }
        return { ...child, slot: name || null };
      }

      default: return null;
    }
  }

  /**
   * An Action step. Value expressions stay unevaluated: `@Set($v, r.cost)`
   * inside an `@Each` has to read the row that was clicked, which is only known
   * when it fires.
   */
  function actionStep(step, statementId, scope) {
    const [a, b] = step.args;
    switch (step.name) {
      case 'Run': {
        const ref = a?.k === 'Ref' ? a.n : null;
        // Evaluating the referenced statement is what *declares* it. A
        // `Mutation` is normally reachable from root only through the `@Run`
        // that fires it — nothing renders it — so without this the delete
        // button would point at a mutation the manager has never heard of.
        // Cheap: a Query here just re-reads its cached value.
        if (ref && symbols.has(ref)) evaluate(a, statementId, scope);
        // The scope travels with the step because a Mutation inside an
        // `@Each` sends the row that was clicked, and its argument
        // expressions are evaluated at fire time against that row.
        return { kind: 'run', ref, scope };
      }
      case 'Set':
        return { kind: 'set', target: a?.k === 'StateRef' ? a.n : null, valueAst: b ?? null, scope };
      case 'Reset':
        return { kind: 'reset', targets: step.args.filter((x) => x?.k === 'StateRef').map((x) => x.n) };
      case 'ToAssistant':
        return { kind: 'toAssistant', messageAst: a ?? null, scope };
      case 'OpenUrl':
        return { kind: 'openUrl', urlAst: a ?? null, scope };
      default:
        return { kind: 'unknown' };
    }
  }

  const rootAst = symbols.get('root');
  const root = rootAst ? evaluate(rootAst, 'root', null) : null;
  if (root && root.type === 'element') root.statementId = 'root';
  else if (rootAst) note('root_not_a_component', 'root did not resolve to a component', 'root');

  /**
   * Every `$name`'s declared value, for `@Reset` and for store hydration.
   * A name mentioned but never declared maps to null, deliberately: resetting
   * it should clear it, not leave whatever it happened to hold.
   */
  const stateDefaults = new Map();
  for (const name of stateNames) stateDefaults.set(name, declaredValue(name, name));

  return {
    root: root && root.type === 'element' ? root : null,
    unresolved: [...new Set(unresolved)],
    queries,
    mutations,
    states: [...stateNames],
    stateDefaults,
    /**
     * Evaluate an AST fragment against *this* pass's symbols, store and scope.
     * The action runner needs it: `@Set($v, r.cost)` keeps its value
     * unevaluated so it can read the row that was actually clicked, and that
     * row only exists inside the scope chain of the pass that rendered it.
     */
    evaluateAst: (node, scope = null) => evaluate(node, 'action', scope),
    diagnostics,
    /** Statement ids reachable from root — what a later prune step keeps. */
    symbols,
  };
}
