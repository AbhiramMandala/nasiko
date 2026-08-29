/**
 * Tokenizer for the dynamic-UI DSL.
 *
 * Grammar (see weave2.0/docs/DYNAMIC_UI_DSL_EXPLAINED.md and the production
 * implementation plan): statements, component/Query/Mutation/Action/Slot
 * calls, arrays, objects, refs, `$state` variables, `@builtin` calls, and a
 * full expression grammar (operators, ternary, member/index access) ported
 * from OpenUI Lang's real lexer/precedence table (session research, real
 * file+line evidence — see the plan). Comments and `$`/`@` prefixes were
 * deliberately cut in the POC; both are now real, per that plan.
 */

export const T = Object.freeze({
  NEWLINE: 'NEWLINE', LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  LBRACK: 'LBRACK', RBRACK: 'RBRACK', LBRACE: 'LBRACE', RBRACE: 'RBRACE',
  COLON: 'COLON', COMMA: 'COMMA', EQUALS: 'EQUALS',
  STR: 'STR', NUM: 'NUM', BOOL: 'BOOL', NULL: 'NULL', IDENT: 'IDENT', TYPE: 'TYPE', EOF: 'EOF',
  // Operators / expression grammar additions:
  PLUS: 'PLUS', MINUS: 'MINUS', STAR: 'STAR', SLASH: 'SLASH', PERCENT: 'PERCENT',
  EQEQ: 'EQEQ', NOTEQ: 'NOTEQ', GREATER: 'GREATER', LESS: 'LESS',
  GREATEREQ: 'GREATEREQ', LESSEQ: 'LESSEQ', AND: 'AND', OR: 'OR', NOT: 'NOT',
  QUESTION: 'QUESTION', DOT: 'DOT',
  // Reactive state / builtins:
  STATEVAR: 'STATEVAR', BUILTINCALL: 'BUILTINCALL',
});

// Single-character punctuation that never participates in a 2-char operator.
const PUNCT = {
  '(': T.LPAREN, ')': T.RPAREN, '[': T.LBRACK, ']': T.RBRACK,
  '{': T.LBRACE, '}': T.RBRACE, ':': T.COLON, ',': T.COMMA,
};

/**
 * Repairs a streamed-but-incomplete buffer by closing any open string and any
 * open brackets, so the lexer/parser always run against a syntactically
 * complete (if partially-defined) buffer. Ported from OpenUI Lang's
 * `autoClose()` (packages/lang-core/src/parser/statements.ts).
 * @param {string} input
 * @returns {{text: string, wasIncomplete: boolean}}
 */
export function autoClose(input) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' && stack[stack.length - 1] === '(') stack.pop();
    else if (c === ']' && stack[stack.length - 1] === '[') stack.pop();
    else if (c === '}' && stack[stack.length - 1] === '{') stack.pop();
  }
  const wasIncomplete = inStr || stack.length > 0;
  if (!wasIncomplete) return { text: input, wasIncomplete: false };
  let out = input;
  if (inStr) { if (esc) out += '\\'; out += '"'; }
  for (let j = stack.length - 1; j >= 0; j--) {
    out += stack[j] === '(' ? ')' : stack[j] === '[' ? ']' : '}';
  }
  return { text: out, wasIncomplete: true };
}

/**
 * @param {string} text
 * @returns {Array<{t: string, v?: string|number}>}
 */
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    if (c === '\n') { tokens.push({ t: T.NEWLINE }); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }

    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < n) {
          const next = text[j + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          j += 2;
        } else {
          value += text[j];
          j++;
        }
      }
      tokens.push({ t: T.STR, v: value });
      i = j + 1; // skip closing quote (autoClose guarantees one exists)
      continue;
    }

    if (/[0-9]/.test(c)) {
      // Sign is never folded into the number token — always emit a separate
      // MINUS and let the parser's unary-minus rule combine `-5` into
      // UnaryOp('-', Num(5)). Folding sign into the literal would make
      // `5-3` (no spaces) lex as NUM(5), NUM(-3) — losing the subtraction
      // entirely. This is the standard approach and matches OpenUI's own
      // lexer (sign is a real operator token, never part of a number).
      let j = i;
      while (j < n && /[0-9]/.test(text[j])) j++;
      if (text[j] === '.' && /[0-9]/.test(text[j + 1] || '')) {
        j++;
        while (j < n && /[0-9]/.test(text[j])) j++;
      }
      tokens.push({ t: T.NUM, v: Number(text.slice(i, j)) });
      i = j;
      continue;
    }

    if (c === '$' && /[a-zA-Z_]/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(text[j])) j++;
      tokens.push({ t: T.STATEVAR, v: text.slice(i, j) }); // value INCLUDES the '$'
      i = j;
      continue;
    }

    if (c === '@' && /[a-zA-Z_]/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(text[j])) j++;
      tokens.push({ t: T.BUILTINCALL, v: text.slice(i + 1, j) }); // value EXCLUDES the '@'
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (word === 'true') tokens.push({ t: T.BOOL, v: true });
      else if (word === 'false') tokens.push({ t: T.BOOL, v: false });
      else if (word === 'null') tokens.push({ t: T.NULL });
      else if (/^[A-Z]/.test(word)) tokens.push({ t: T.TYPE, v: word });
      else tokens.push({ t: T.IDENT, v: word });
      i = j;
      continue;
    }

    // Two-character operators — must be checked before their single-char
    // prefix falls through to PUNCT/unary handling.
    const two = text.slice(i, i + 2);
    if (two === '==') { tokens.push({ t: T.EQEQ }); i += 2; continue; }
    if (two === '!=') { tokens.push({ t: T.NOTEQ }); i += 2; continue; }
    if (two === '>=') { tokens.push({ t: T.GREATEREQ }); i += 2; continue; }
    if (two === '<=') { tokens.push({ t: T.LESSEQ }); i += 2; continue; }
    if (two === '&&') { tokens.push({ t: T.AND }); i += 2; continue; }
    if (two === '||') { tokens.push({ t: T.OR }); i += 2; continue; }

    if (c === '=') { tokens.push({ t: T.EQUALS }); i++; continue; }
    if (c === '+') { tokens.push({ t: T.PLUS }); i++; continue; }
    if (c === '-') { tokens.push({ t: T.MINUS }); i++; continue; }
    if (c === '*') { tokens.push({ t: T.STAR }); i++; continue; }
    if (c === '/') { tokens.push({ t: T.SLASH }); i++; continue; }
    if (c === '%') { tokens.push({ t: T.PERCENT }); i++; continue; }
    if (c === '>') { tokens.push({ t: T.GREATER }); i++; continue; }
    if (c === '<') { tokens.push({ t: T.LESS }); i++; continue; }
    if (c === '!') { tokens.push({ t: T.NOT }); i++; continue; }
    if (c === '?') { tokens.push({ t: T.QUESTION }); i++; continue; }
    if (c === '.') { tokens.push({ t: T.DOT }); i++; continue; }

    if (PUNCT[c]) { tokens.push({ t: PUNCT[c] }); i++; continue; }

    // Unknown character (e.g. the model emitted stray prose) — skip, matching
    // OpenUI's own streaming-tolerant lexer behavior.
    i++;
  }

  tokens.push({ t: T.EOF });
  return tokens;
}
