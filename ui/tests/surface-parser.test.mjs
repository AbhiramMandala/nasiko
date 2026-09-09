/**
 * Lexer and Pratt parser for the surface DSL.
 *
 * The grammar under test is the one agent.yaml teaches the model, so the
 * worked examples from that prompt are fixtures here: if the prompt and the
 * parser disagree, these fail rather than a dashboard rendering wrongly.
 *
 * The regression that motivated the rewrite is `parses a ternary as one
 * argument`. A parser that skips `$`, `==` and `?` does not throw on Worked
 * Example 3 — it silently reads one argument as nine, shifts every parameter,
 * and renders a confident, wrong stat card.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tokenize, autoClose, T } = await import(new URL('../common/surface/lexer.js', import.meta.url).href);
const { parseBuffer, parseExpression } = await import(new URL('../common/surface/parser.js', import.meta.url).href);

/** Parse a bare expression. */
const expr = (src) => parseBuffer(`x = ${src}`).statements[0].ast;
/** Compact rendering of an AST, so precedence assertions read like the source. */
function show(n) {
  if (!n) return '?';
  switch (n.k) {
    case 'Num': case 'Bool': return String(n.v);
    case 'Str': return JSON.stringify(n.v);
    case 'Null': return 'null';
    case 'Ref': return n.n;
    case 'StateRef': return n.n;
    case 'BinOp': return `(${show(n.left)} ${n.op} ${show(n.right)})`;
    case 'UnaryOp': return `(${n.op}${show(n.operand)})`;
    case 'Ternary': return `(${show(n.cond)} ? ${show(n.then)} : ${show(n.else)})`;
    case 'Member': return `${show(n.obj)}.${n.field}`;
    case 'Index': return `${show(n.obj)}[${show(n.index)}]`;
    case 'Comp': return `${n.name}(${n.args.map(show).join(', ')})`;
    case 'BuiltinCall': return `@${n.name}(${n.args.map(show).join(', ')})`;
    case 'Arr': return `[${n.els.map(show).join(', ')}]`;
    case 'Obj': return `{${n.entries.map(([k, v]) => `${k}: ${show(v)}`).join(', ')}}`;
    default: return n.k;
  }
}

// ── lexer ───────────────────────────────────────────────────────────────────

test('lexes the tokens the old grammar skipped', () => {
  const kinds = tokenize('$a @Sum . ? == != >= <= && || ! %').map((t) => t.t);
  for (const k of [T.STATE, T.BUILTIN, T.DOT, T.QUESTION, T.EQEQ, T.NOTEQ,
                   T.GTE, T.LTE, T.ANDAND, T.OROR, T.BANG, T.PERCENT]) {
    assert.ok(kinds.includes(k), `missing ${k}`);
  }
});

test('a state token keeps its $ so it cannot collide with a statement name', () => {
  const [tok] = tokenize('$view');
  assert.deepEqual([tok.t, tok.v], [T.STATE, '$view']);
});

test('a builtin token drops its @ so the name is the lookup key', () => {
  const [tok] = tokenize('@Sum');
  assert.deepEqual([tok.t, tok.v], [T.BUILTIN, 'Sum']);
});

test('minus always lexes as an operator, never as part of a number', () => {
  // `total -5` must be a subtraction, not two adjacent values.
  const kinds = tokenize('total -5').map((t) => t.t);
  assert.deepEqual(kinds, [T.IDENT, T.MINUS, T.NUM, T.EOF]);
  assert.equal(show(expr('-5')), '(-5)');
  assert.equal(show(expr('1.5')), '1.5', 'a decimal point still belongs to the number');
});

test('two-character operators win over their one-character prefixes', () => {
  assert.deepEqual(tokenize('a == b').map((t) => t.t).slice(0, 3), [T.IDENT, T.EQEQ, T.IDENT]);
  assert.deepEqual(tokenize('a = b').map((t) => t.t).slice(0, 3), [T.IDENT, T.EQUALS, T.IDENT]);
  assert.deepEqual(tokenize('a >= b').map((t) => t.t).slice(0, 3), [T.IDENT, T.GTE, T.IDENT]);
  assert.deepEqual(tokenize('a > b').map((t) => t.t).slice(0, 3), [T.IDENT, T.GT, T.IDENT]);
});

test('autoClose repairs a buffer cut mid-stream', () => {
  assert.equal(autoClose('root = AppStack([kpis').text, 'root = AppStack([kpis])');
  assert.equal(autoClose('a = "unter').text, 'a = "unter"');
  assert.equal(autoClose('a = 1').wasIncomplete, false);
});

// ── precedence ──────────────────────────────────────────────────────────────

test('multiplication binds tighter than addition', () => {
  assert.equal(show(expr('1 + 2 * 3')), '(1 + (2 * 3))');
  assert.equal(show(expr('1 * 2 + 3')), '((1 * 2) + 3)');
});

test('arithmetic binds tighter than comparison, comparison than equality', () => {
  assert.equal(show(expr('a + 1 > b')), '((a + 1) > b)');
  assert.equal(show(expr('a > b == c')), '((a > b) == c)');
});

test('&& binds tighter than ||', () => {
  assert.equal(show(expr('a || b && c')), '(a || (b && c))');
});

test('same-precedence operators are left-associative', () => {
  assert.equal(show(expr('1 - 2 - 3')), '((1 - 2) - 3)');
  assert.equal(show(expr('1 / 2 * 3')), '((1 / 2) * 3)');
});

test('ternary binds loosest and nests to the right', () => {
  assert.equal(show(expr('a || b ? 1 : 2')), '((a || b) ? 1 : 2)');
  assert.equal(show(expr('a ? 1 : b ? 2 : 3')), '(a ? 1 : (b ? 2 : 3))');
});

test('parentheses override precedence', () => {
  assert.equal(show(expr('(1 + 2) * 3')), '((1 + 2) * 3)');
});

test('unary binds tighter than binary, and stacks', () => {
  assert.equal(show(expr('-a + b')), '((-a) + b)');
  assert.equal(show(expr('!a && b')), '((!a) && b)');
  assert.equal(show(expr('!!a')), '(!(!a))');
});

test('member and index bind tightest and chain', () => {
  assert.equal(show(expr('rows.cost')), 'rows.cost');
  assert.equal(show(expr('rows[0].cost')), 'rows[0].cost');
  assert.equal(show(expr('a.b + c')), '(a.b + c)');
  assert.equal(show(expr('-a.b')), '(-a.b)', 'negation applies to the whole member chain');
});

// ── statements and prose ────────────────────────────────────────────────────

test('a $state declaration is a statement, keeping its $ as the name', () => {
  const { statements } = parseBuffer('$view = "cost"');
  assert.deepEqual([statements[0].id, show(statements[0].ast)], ['$view', '"cost"']);
});

test('prose around the DSL is captured, not dropped', () => {
  // agent.yaml rule 12 requires exactly this shape. A splitter that only
  // returns statements loses both sentences the assistant wrote.
  const { statements, prose } = parseBuffer(
    'Sure — building that now.\nroot = AppStack([kpi], "md")\nHere is your dashboard!',
  );
  assert.deepEqual(prose, ['Sure — building that now.', 'Here is your dashboard!']);
  assert.deepEqual(statements.map((s) => s.id), ['root']);
});

test('a statement keeps its original source text', () => {
  const { statements } = parseBuffer('root = AppStack([kpi], "md")');
  assert.equal(statements[0].raw, 'root = AppStack([kpi], "md")');
});

test('a multi-line array does not end the statement early', () => {
  const { statements } = parseBuffer('root = AppStack([\n  a,\n  b\n], "md")');
  assert.equal(statements.length, 1);
  assert.equal(show(statements[0].ast), 'AppStack([a, b], "md")');
});

// ── the worked examples from agent.yaml ─────────────────────────────────────

test('parses a ternary as ONE argument, not as several', () => {
  // The regression. Under the previous grammar `$`, `==`, `?` and `:` were all
  // skipped, so this parsed as nine positional arguments and every parameter
  // after the first shifted.
  const ast = expr('AppStatCard($view == "cost" ? "Total cost" : "Requests", costQ, "neutral")');
  assert.equal(ast.args.length, 3);
  assert.equal(show(ast.args[0]), '(($view == "cost") ? "Total cost" : "Requests")');
});

test('Worked Example 1 — Query with a default and a dot-path', () => {
  const ast = expr('Query("fetchUsageSummary", [], 0, "total_cost_usd")');
  assert.equal(ast.k, 'Comp');
  assert.equal(ast.name, 'Query');
  assert.equal(ast.args.length, 4, 'source, positional args, default, dot-path');
});

test('Worked Example 2c — array pluck inside an object literal', () => {
  const ast = expr('AppChart({labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}]}, "line")');
  assert.equal(show(ast.args[0]),
    '{labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}]}');
});

test('Worked Example 3b — an Action carrying builtin steps', () => {
  const ast = expr('Action([@Set($days, 30), @Run(historyQ)])');
  assert.equal(show(ast), 'Action([@Set($days, 30), @Run(historyQ)])');
});

test('every worked example parses with no give-up nodes', () => {
  const EXAMPLES = [
    'root = AppStack([kpis], "md")',
    'kpis = AppRow([kpiCost, kpiCount], "md")',
    'totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")',
    'historyRows = Query("fetchUsageHistory", [14], [])',
    'table = AppTable(historyRows, 14, "pages", false)',
    'chart = AppChart({labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}]}, "line", false, "currency", "USD")',
    '$view = "cost"',
    'costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)',
    'showSeven = Action([@Set($days, 7), @Run(historyQ)])',
    'saveFooter = Slot("footer", saveBtn)',
    'kpi = AppStatCard($view == "cost" ? "Total cost" : "Requests", $view == "cost" ? costQ : opsQ, "neutral")',
    'gone = null',
  ];
  const { statements } = parseBuffer(EXAMPLES.join('\n'));
  assert.equal(statements.length, EXAMPLES.length);
  const gaveUp = (n) => {
    if (!n || typeof n !== 'object') return false;
    if (n.k === 'Null') return false; // a written `null` is legitimate
    for (const v of Object.values(n)) {
      if (Array.isArray(v) ? v.some(gaveUp) : gaveUp(v)) return true;
    }
    return false;
  };
  for (const s of statements) {
    assert.equal(gaveUp(s.ast), false, `${s.id} contains an unparsed node`);
  }
  assert.equal(show(statements.at(-1).ast), 'null', 'deletion parses as a real null');
});

test('an unreadable statement costs one statement, not the buffer', () => {
  const { statements } = parseBuffer('good = AppStack([a], "md")\nbad = AppStack(((\nalso = "fine"');
  assert.deepEqual(statements.map((s) => s.id), ['good', 'bad', 'also']);
  assert.equal(show(statements[2].ast), '"fine"');
});

test('parses every prefix of a streamed statement without throwing', () => {
  const full = 'root = AppStack([kpis, table], "md")';
  for (let i = 1; i <= full.length; i++) {
    assert.doesNotThrow(() => parseBuffer(full.slice(0, i)), `failed at prefix length ${i}`);
  }
});

test('a multi-line literal still continues across newlines', () => {
  // The recovery rule above must not fire here: no line inside a legitimate
  // multi-line literal opens with `name =`.
  const { statements } = parseBuffer('chart = AppChart({\n  labels: rows.date,\n  datasets: [{label: "Cost", data: rows.cost}]\n}, "line")\nnext = 1');
  assert.deepEqual(statements.map((s) => s.id), ['chart', 'next']);
  assert.equal(statements[0].ast.args.length, 2);
});
