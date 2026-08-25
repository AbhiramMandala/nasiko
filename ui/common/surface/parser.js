/**
 * Statement splitter + expression parser for the dynamic-UI DSL.
 *
 * Full operator-precedence (Pratt) parser, ported from OpenUI Lang's real
 * precedence table (session research, `expressions.ts:10-18,38-67`) — see
 * the production implementation plan. `parseComp`/`parseArr`/`parseObj`
 * still handle their own shapes directly (no operators inside those
 * dispatch points beyond what a nested `parseExpr` call already provides).
 */

import { T, tokenize, autoClose } from './lexer.js';

/**
 * Splits a token stream into top-level statements, respecting bracket depth
 * so a newline inside an array/object literal doesn't end the statement.
 * A statement's identifier is either a plain IDENT (`name = ...`) or a
 * STATEVAR (`$name = ...`, a reactive-state declaration).
 * @param {Array<{t: string, v?: any}>} tokens
 * @returns {Array<{id: string, tokens: Array<{t: string, v?: any}>}>}
 */
export function split(tokens) {
  const stmts = [];
  let pos = 0;

  while (pos < tokens.length) {
    while (pos < tokens.length && tokens[pos].t === T.NEWLINE) pos++;
    if (pos >= tokens.length || tokens[pos].t === T.EOF) break;

    if (tokens[pos].t !== T.IDENT && tokens[pos].t !== T.STATEVAR) {
      // Not a statement start (stray text, or a TYPE/literal at top level) —
      // skip to the next newline, matching OpenUI's tolerant behavior.
      while (pos < tokens.length && tokens[pos].t !== T.NEWLINE && tokens[pos].t !== T.EOF) pos++;
      continue;
    }
    const id = tokens[pos].v;
    pos++;

    if (pos >= tokens.length || tokens[pos].t !== T.EQUALS) {
      while (pos < tokens.length && tokens[pos].t !== T.NEWLINE && tokens[pos].t !== T.EOF) pos++;
      continue;
    }
    pos++;

    const exprTokens = [];
    let depth = 0;
    while (pos < tokens.length && tokens[pos].t !== T.EOF) {
      const tt = tokens[pos].t;
      if (tt === T.NEWLINE && depth === 0) { pos++; break; }
      if (tt === T.NEWLINE) { pos++; continue; }
      if (tt === T.LPAREN || tt === T.LBRACK || tt === T.LBRACE) depth++;
      else if ((tt === T.RPAREN || tt === T.RBRACK || tt === T.RBRACE) && depth > 0) depth--;
      exprTokens.push(tokens[pos]);
      pos++;
    }
    if (exprTokens.length) stmts.push({ id, tokens: exprTokens });
  }
  return stmts;
}

const PREC = {
  TERNARY: 1, OR: 2, AND: 3, EQ: 4, CMP: 5, ADD: 6, MUL: 7, UNARY: 8, MEMBER: 9,
};

function getInfixPrec(tok) {
  switch (tok.t) {
    case T.QUESTION: return PREC.TERNARY;
    case T.OR: return PREC.OR;
    case T.AND: return PREC.AND;
    case T.EQEQ:
    case T.NOTEQ: return PREC.EQ;
    case T.GREATER:
    case T.LESS:
    case T.GREATEREQ:
    case T.LESSEQ: return PREC.CMP;
    case T.PLUS:
    case T.MINUS: return PREC.ADD;
    case T.STAR:
    case T.SLASH:
    case T.PERCENT: return PREC.MUL;
    case T.DOT:
    case T.LBRACK: return PREC.MEMBER;
    default: return 0;
  }
}

const BINOP_SYMBOL = {
  [T.PLUS]: '+', [T.MINUS]: '-', [T.STAR]: '*', [T.SLASH]: '/', [T.PERCENT]: '%',
  [T.EQEQ]: '==', [T.NOTEQ]: '!=', [T.GREATER]: '>', [T.LESS]: '<',
  [T.GREATEREQ]: '>=', [T.LESSEQ]: '<=', [T.AND]: '&&', [T.OR]: '||',
};

/**
 * Recursive-descent + Pratt-climbing expression parser.
 * @param {Array<{t: string, v?: any}>} tokens
 * @returns {object} AST node
 */
export function parseExpression(tokens) {
  let pos = 0;
  const cur = () => tokens[pos] ?? { t: T.EOF };
  const adv = () => tokens[pos++];
  const eat = (kind) => { if (cur().t === kind) pos++; };

  function parseExpr(minPrec) {
    let left = parseUnary();
    while (true) {
      const tok = cur();
      const prec = getInfixPrec(tok);
      if (prec === 0 || prec < minPrec) break;

      if (tok.t === T.QUESTION) {
        adv();
        const thenBranch = parseExpr(0);
        eat(T.COLON);
        const elseBranch = parseExpr(0);
        left = { k: 'Ternary', cond: left, then: thenBranch, else: elseBranch };
        continue;
      }
      if (tok.t === T.DOT) {
        adv();
        const fieldTok = cur();
        const field = (fieldTok.t === T.IDENT || fieldTok.t === T.TYPE)
          ? adv().v
          : (adv(), '?');
        left = { k: 'Member', obj: left, field };
        continue;
      }
      if (tok.t === T.LBRACK) {
        adv();
        const index = parseExpr(0);
        eat(T.RBRACK);
        left = { k: 'Index', obj: left, index };
        continue;
      }
      // Plain left-associative binary operator — right side parses at
      // prec+1 so equal-precedence operators group to the left.
      adv();
      const right = parseExpr(prec + 1);
      left = { k: 'BinOp', op: BINOP_SYMBOL[tok.t], left, right };
    }
    return left;
  }

  function parseUnary() {
    const tok = cur();
    if (tok.t === T.NOT) { adv(); return { k: 'UnaryOp', op: '!', operand: parseExpr(PREC.UNARY) }; }
    if (tok.t === T.MINUS) { adv(); return { k: 'UnaryOp', op: '-', operand: parseExpr(PREC.UNARY) }; }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = cur();
    if (tok.t === T.STR) { adv(); return { k: 'Str', v: tok.v }; }
    if (tok.t === T.NUM) { adv(); return { k: 'Num', v: tok.v }; }
    if (tok.t === T.BOOL) { adv(); return { k: 'Bool', v: tok.v }; }
    if (tok.t === T.NULL) { adv(); return { k: 'Null' }; }
    if (tok.t === T.LBRACK) return parseArr();
    if (tok.t === T.LBRACE) return parseObj();
    if (tok.t === T.LPAREN) { adv(); const inner = parseExpr(0); eat(T.RPAREN); return inner; }
    if (tok.t === T.STATEVAR) { adv(); return { k: 'StateRef', n: tok.v }; }
    if (tok.t === T.BUILTINCALL) {
      const name = adv().v;
      eat(T.LPAREN);
      const args = [];
      while (cur().t !== T.RPAREN && cur().t !== T.EOF) {
        args.push(parseExpr(0));
        if (cur().t === T.COMMA) adv();
      }
      eat(T.RPAREN);
      return { k: 'BuiltinCall', name, args };
    }
    if (tok.t === T.TYPE) {
      if (tokens[pos + 1]?.t === T.LPAREN) return parseComp();
      adv();
      return { k: 'Null' }; // bare Type ref not supported
    }
    if (tok.t === T.IDENT) { adv(); return { k: 'Ref', n: tok.v }; }
    // Unknown/unexpected token — skip one, return Null (streaming tolerance).
    adv();
    return { k: 'Null' };
  }

  function parseComp() {
    const name = adv().v; // TYPE token
    eat(T.LPAREN);
    const args = [];
    while (cur().t !== T.RPAREN && cur().t !== T.EOF) {
      args.push(parseExpr(0));
      if (cur().t === T.COMMA) adv();
    }
    eat(T.RPAREN);
    return { k: 'Comp', name, args };
  }

  function parseArr() {
    adv(); // [
    const els = [];
    while (cur().t !== T.RBRACK && cur().t !== T.EOF) {
      els.push(parseExpr(0));
      if (cur().t === T.COMMA) adv();
    }
    eat(T.RBRACK);
    return { k: 'Arr', els };
  }

  function parseObj() {
    adv(); // {
    const entries = [];
    while (cur().t !== T.RBRACE && cur().t !== T.EOF) {
      const kt = cur();
      const key = kt.t === T.IDENT || kt.t === T.STR || kt.t === T.TYPE ? (adv(), String(kt.v)) : (adv(), '?');
      eat(T.COLON);
      entries.push([key, parseExpr(0)]);
      if (cur().t === T.COMMA) adv();
    }
    eat(T.RBRACE);
    return { k: 'Obj', entries };
  }

  return parseExpr(0);
}

/**
 * Parses a full (possibly incomplete/streaming) DSL buffer into an ordered
 * list of {id, ast, raw} statements. Runs `autoClose` first so a mid-token
 * stream cut still tokenizes/parses cleanly. `raw` is the exact source
 * substring for this statement (used by gc.js's reachability pruning to
 * rebuild pruned text without re-serializing the AST).
 * @param {string} text
 * @returns {{statements: Array<{id: string, ast: object, raw: string}>, wasIncomplete: boolean}}
 */
export function parseBuffer(text) {
  const { text: repaired, wasIncomplete } = autoClose(text);
  const tokens = tokenize(repaired);
  const raw = split(tokens);
  const statements = raw.map((s) => ({
    id: s.id,
    ast: parseExpression(s.tokens),
    raw: rawStatementText(s.id, s.tokens),
  }));
  return { statements, wasIncomplete };
}

/**
 * Reconstructs a plausible source line for one statement from its tokens —
 * used only for gc.js's pruned-text output, which doesn't need to be
 * byte-identical to the model's original formatting, only re-parseable.
 */
function rawStatementText(id, tokens) {
  let out = `${id} = `;
  for (const t of tokens) out += tokenText(t);
  return out;
}

function tokenText(tok) {
  switch (tok.t) {
    case T.STR: return `"${String(tok.v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    case T.NUM: return String(tok.v);
    case T.BOOL: return tok.v ? 'true' : 'false';
    case T.NULL: return 'null';
    case T.IDENT:
    case T.TYPE: return tok.v;
    case T.STATEVAR: return tok.v;
    case T.BUILTINCALL: return `@${tok.v}`;
    case T.LPAREN: return '(';
    case T.RPAREN: return ')';
    case T.LBRACK: return '[';
    case T.RBRACK: return ']';
    case T.LBRACE: return '{';
    case T.RBRACE: return '}';
    case T.COLON: return ': ';
    case T.COMMA: return ', ';
    case T.EQUALS: return ' = ';
    case T.PLUS: return ' + ';
    case T.MINUS: return ' - ';
    case T.STAR: return ' * ';
    case T.SLASH: return ' / ';
    case T.PERCENT: return ' % ';
    case T.EQEQ: return ' == ';
    case T.NOTEQ: return ' != ';
    case T.GREATER: return ' > ';
    case T.LESS: return ' < ';
    case T.GREATEREQ: return ' >= ';
    case T.LESSEQ: return ' <= ';
    case T.AND: return ' && ';
    case T.OR: return ' || ';
    case T.NOT: return '!';
    case T.QUESTION: return ' ? ';
    case T.DOT: return '.';
    default: return '';
  }
}
