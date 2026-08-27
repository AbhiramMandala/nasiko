/**
 * Statement splitter and expression parser for the Weave surface DSL.
 *
 * Two jobs, deliberately separate:
 *
 *   `split()` finds the `name = expression` statements in a buffer, tracking
 *   bracket depth so a newline inside an array or object does not end one. It
 *   also reports the text that was *not* part of any statement. The model is
 *   told to wrap its DSL in two plain-English sentences (agent.yaml rule 12),
 *   so that prose is expected output, not noise — dropping it silently, which
 *   is what a splitter that only returns statements does, loses half of what
 *   the assistant said.
 *
 *   `parseExpression()` is a Pratt parser over the precedence table in
 *   `agent.yaml`. Recursive descent does not survive this grammar: with nine
 *   levels and a right-associative ternary, precedence has to be a number the
 *   parser carries, not a shape in the call graph.
 *
 * Streaming tolerance is the same posture as the lexer's: an unexpected token
 * yields a `Null` node and the parse continues. A statement that cannot be read
 * is one statement missing, never a dead surface.
 *
 * @module common/surface/parser
 */

import { T, tokenize, autoClose } from './lexer.js';

// Precedence, low binds loosest. Mirrors the table agent.yaml teaches the
// model, so the two cannot disagree about what `a + b * c` means.
const PREC = Object.freeze({
  TERNARY: 1, OR: 2, AND: 3, EQ: 4, CMP: 5, ADD: 6, MUL: 7, UNARY: 8, MEMBER: 9,
});

/** Infix operator → [precedence, ast op]. Absent means "not an infix operator". */
const INFIX = Object.freeze({
  [T.OROR]: [PREC.OR, '||'],
  [T.ANDAND]: [PREC.AND, '&&'],
  [T.EQEQ]: [PREC.EQ, '=='], [T.NOTEQ]: [PREC.EQ, '!='],
  [T.GT]: [PREC.CMP, '>'], [T.LT]: [PREC.CMP, '<'],
  [T.GTE]: [PREC.CMP, '>='], [T.LTE]: [PREC.CMP, '<='],
  [T.PLUS]: [PREC.ADD, '+'], [T.MINUS]: [PREC.ADD, '-'],
  [T.STAR]: [PREC.MUL, '*'], [T.SLASH]: [PREC.MUL, '/'], [T.PERCENT]: [PREC.MUL, '%'],
});

/**
 * Does a new `name =` statement begin at or just after `from`, ignoring blank
 * lines? Used to recover from an unbalanced bracket without giving up the rest
 * of the buffer.
 *
 * @param {Array<{t: string}>} tokens
 * @param {number} from
 */
function startsNewStatement(tokens, from) {
  let k = from;
  while (k < tokens.length && tokens[k].t === T.NEWLINE) k++;
  const head = tokens[k];
  if (!head || (head.t !== T.IDENT && head.t !== T.STATE)) return false;
  return tokens[k + 1]?.t === T.EQUALS;
}

/**
 * Split a token stream into top-level statements.
 *
 * @param {Array<{t: string, v?: any, i?: number}>} tokens
 * @param {string} text The (already auto-closed) source the tokens came from.
 * @returns {{statements: Array<{id: string, tokens: any[], raw: string, start: number, end: number}>, proseRanges: Array<[number, number]>}}
 */
export function split(tokens, text = '') {
  const statements = [];
  /** @type {Array<[number, number]>} */
  const proseRanges = [];
  let pos = 0;
  let proseFrom = 0;

  const skipLine = () => {
    while (pos < tokens.length && tokens[pos].t !== T.NEWLINE && tokens[pos].t !== T.EOF) pos++;
  };

  while (pos < tokens.length) {
    while (pos < tokens.length && tokens[pos].t === T.NEWLINE) pos++;
    if (pos >= tokens.length || tokens[pos].t === T.EOF) break;

    // A statement starts with a name — an identifier, or `$name` for state.
    const head = tokens[pos];
    const isName = head.t === T.IDENT || head.t === T.STATE;
    if (!isName || tokens[pos + 1]?.t !== T.EQUALS) {
      skipLine();
      continue;
    }

    const start = head.i ?? 0;
    if (start > proseFrom) proseRanges.push([proseFrom, start]);

    const id = String(head.v);
    pos += 2; // name, '='

    const exprTokens = [];
    let depth = 0;
    let end = start;
    while (pos < tokens.length && tokens[pos].t !== T.EOF) {
      const tt = tokens[pos].t;
      if (tt === T.NEWLINE && depth === 0) { end = tokens[pos].i ?? end; pos++; break; }
      if (tt === T.NEWLINE) {
        // Still inside a bracket, so normally this newline is part of a
        // multi-line array or object and the statement continues. But
        // autoClose() closes an unbalanced bracket at the *end of the buffer*,
        // which means one stray `(` from the model would otherwise swallow
        // every statement after it — the whole rest of the dashboard, silently.
        //
        // A following line that opens a new statement is the unambiguous
        // signal that the bracket was a mistake rather than a continuation:
        // `=` never appears inside an expression (assignment is not an
        // expression here, and equality is its own token), so `name =` cannot
        // occur inside a legitimate multi-line literal. Ending here bounds the
        // damage to the one malformed statement.
        if (startsNewStatement(tokens, pos + 1)) { end = tokens[pos].i ?? end; pos++; break; }
        pos++;
        continue;
      }
      if (tt === T.LPAREN || tt === T.LBRACK || tt === T.LBRACE) depth++;
      else if ((tt === T.RPAREN || tt === T.RBRACK || tt === T.RBRACE) && depth > 0) depth--;
      exprTokens.push(tokens[pos]);
      end = (tokens[pos].i ?? end) + 1;
      pos++;
    }

    if (exprTokens.length) {
      statements.push({ id, tokens: exprTokens, raw: text.slice(start, end).trimEnd(), start, end });
      proseFrom = end;
    }
  }

  if (text && proseFrom < text.length) proseRanges.push([proseFrom, text.length]);
  return { statements, proseRanges };
}

/**
 * Parse one expression's tokens into an AST.
 *
 * @param {Array<{t: string, v?: any}>} tokens
 * @returns {object}
 */
export function parseExpression(tokens) {
  let pos = 0;
  const cur = () => tokens[pos] ?? { t: T.EOF };
  const adv = () => tokens[pos++];
  const eat = (kind) => { if (cur().t === kind) pos++; };

  /**
   * Precedence climbing. `minPrec` is the loosest operator this call will
   * absorb; anything looser is left for the caller, which is what makes
   * left-associativity fall out without a separate rule per level.
   */
  function parseExpr(minPrec = 0) {
    let left = parseUnary();

    for (;;) {
      const t = cur().t;

      // Ternary is right-associative and binds loosest, so its branches parse
      // at precedence 0 and a nested `a ? b : c ? d : e` groups to the right.
      if (t === T.QUESTION && minPrec <= PREC.TERNARY) {
        adv();
        const then = parseExpr(0);
        eat(T.COLON);
        const otherwise = parseExpr(0);
        left = { k: 'Ternary', cond: left, then, else: otherwise };
        continue;
      }

      const infix = INFIX[t];
      if (!infix) break;
      const [prec, op] = infix;
      if (prec < minPrec) break;
      adv();
      // Left-associative: the right side must bind strictly tighter.
      const right = parseExpr(prec + 1);
      left = { k: 'BinOp', op, left, right };
    }

    return left;
  }

  function parseUnary() {
    const t = cur().t;
    if (t === T.BANG || t === T.MINUS) {
      const op = t === T.BANG ? '!' : '-';
      adv();
      return { k: 'UnaryOp', op, operand: parseUnary() };
    }
    return parsePostfix(parsePrimary());
  }

  /** `.field` and `[expr]`, both left-associative and tighter than anything else. */
  function parsePostfix(node) {
    for (;;) {
      if (cur().t === T.DOT) {
        adv();
        const name = cur();
        if (name.t === T.IDENT || name.t === T.TYPE) { adv(); node = { k: 'Member', obj: node, field: String(name.v) }; }
        else break;
      } else if (cur().t === T.LBRACK) {
        adv();
        const index = parseExpr(0);
        eat(T.RBRACK);
        node = { k: 'Index', obj: node, index };
      } else break;
    }
    return node;
  }

  function parsePrimary() {
    const tok = cur();
    switch (tok.t) {
      case T.STR: adv(); return { k: 'Str', v: tok.v };
      case T.NUM: adv(); return { k: 'Num', v: tok.v };
      case T.BOOL: adv(); return { k: 'Bool', v: tok.v };
      case T.NULL: adv(); return { k: 'Null' };
      case T.STATE: adv(); return { k: 'StateRef', n: String(tok.v) };
      case T.IDENT: adv(); return { k: 'Ref', n: String(tok.v) };
      case T.LBRACK: return parseArr();
      case T.LBRACE: return parseObj();
      case T.LPAREN: {
        adv();
        const inner = parseExpr(0);
        eat(T.RPAREN);
        return inner;
      }
      case T.BUILTIN: {
        adv();
        return { k: 'BuiltinCall', name: String(tok.v), args: parseArgs() };
      }
      case T.TYPE: {
        if (tokens[pos + 1]?.t === T.LPAREN) {
          adv();
          return { k: 'Comp', name: String(tok.v), args: parseArgs() };
        }
        adv();
        return { k: 'Null' }; // a bare Type name is not an expression
      }
      default:
        adv(); // unexpected token — skip one and keep going
        return { k: 'Null' };
    }
  }

  /** `( expr, expr, ... )` — shared by component calls and builtin calls. */
  function parseArgs() {
    const args = [];
    eat(T.LPAREN);
    while (cur().t !== T.RPAREN && cur().t !== T.EOF) {
      args.push(parseExpr(0));
      if (cur().t === T.COMMA) adv();
      else if (cur().t !== T.RPAREN) break; // malformed — stop rather than spin
    }
    eat(T.RPAREN);
    return args;
  }

  function parseArr() {
    adv();
    const els = [];
    while (cur().t !== T.RBRACK && cur().t !== T.EOF) {
      els.push(parseExpr(0));
      if (cur().t === T.COMMA) adv();
      else if (cur().t !== T.RBRACK) break;
    }
    eat(T.RBRACK);
    return { k: 'Arr', els };
  }

  function parseObj() {
    adv();
    const entries = [];
    while (cur().t !== T.RBRACE && cur().t !== T.EOF) {
      const kt = cur();
      const key = kt.t === T.IDENT || kt.t === T.STR || kt.t === T.TYPE ? (adv(), String(kt.v)) : (adv(), '?');
      eat(T.COLON);
      entries.push([key, parseExpr(0)]);
      if (cur().t === T.COMMA) adv();
      else if (cur().t !== T.RBRACE) break;
    }
    eat(T.RBRACE);
    return { k: 'Obj', entries };
  }

  return parseExpr(0);
}

/**
 * Parse a whole (possibly mid-stream) buffer.
 *
 * @param {string} text
 * @returns {{statements: Array<{id: string, ast: object, raw: string}>, prose: string[], wasIncomplete: boolean}}
 */
export function parseBuffer(text) {
  const { text: repaired, wasIncomplete } = autoClose(text);
  const tokens = tokenize(repaired);
  const { statements, proseRanges } = split(tokens, repaired);

  // Everything between statements, line by line. This is what the assistant
  // said in plain English, and it belongs in the chat log rather than nowhere.
  const prose = [];
  for (const [from, to] of proseRanges) {
    for (const line of repaired.slice(from, to).split('\n')) {
      const trimmed = line.trim();
      if (trimmed) prose.push(trimmed);
    }
  }

  return {
    statements: statements.map((s) => ({ id: s.id, ast: parseExpression(s.tokens), raw: s.raw })),
    prose,
    wasIncomplete,
  };
}
