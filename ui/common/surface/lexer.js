/**
 * Tokenizer for the Weave surface DSL.
 *
 * The grammar is the one `agent.yaml` teaches the model, so it is the full one
 * from the start: operators with nine precedence levels, ternary, member and
 * index access, `$state`, `@builtins`. There is no useful subset stage — the
 * simplest worked example in the prompt already uses `Query(...)`, and a lexer
 * that skips `$` and `?` does not fail loudly, it silently reinterprets
 * `$view == "cost" ? a : b` as a different, valid-looking argument list.
 *
 * Two properties carry over from the POC and are load-bearing:
 *
 *   - `autoClose()` runs before tokenizing, so a buffer cut mid-stream still
 *     lexes and parses as something complete. This is what makes rendering a
 *     half-arrived response possible at all.
 *   - An unrecognised character is skipped rather than thrown on. The model
 *     writes prose around the DSL by design (agent.yaml rule 12), and a
 *     tokenizer that refuses stray text would take the whole surface down with
 *     the first friendly sentence.
 *
 * @module common/surface/lexer
 */

export const T = Object.freeze({
  NEWLINE: 'NEWLINE',
  LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  LBRACK: 'LBRACK', RBRACK: 'RBRACK',
  LBRACE: 'LBRACE', RBRACE: 'RBRACE',
  COLON: 'COLON', COMMA: 'COMMA', EQUALS: 'EQUALS', DOT: 'DOT', QUESTION: 'QUESTION',
  PLUS: 'PLUS', MINUS: 'MINUS', STAR: 'STAR', SLASH: 'SLASH', PERCENT: 'PERCENT',
  EQEQ: 'EQEQ', NOTEQ: 'NOTEQ', GT: 'GT', LT: 'LT', GTE: 'GTE', LTE: 'LTE',
  ANDAND: 'ANDAND', OROR: 'OROR', BANG: 'BANG',
  STR: 'STR', NUM: 'NUM', BOOL: 'BOOL', NULL: 'NULL',
  IDENT: 'IDENT', TYPE: 'TYPE', STATE: 'STATE', BUILTIN: 'BUILTIN',
  EOF: 'EOF',
});

/** Single-character punctuation with no two-character form starting with it. */
const PUNCT1 = {
  '(': T.LPAREN, ')': T.RPAREN, '[': T.LBRACK, ']': T.RBRACK,
  '{': T.LBRACE, '}': T.RBRACE, ':': T.COLON, ',': T.COMMA,
  '.': T.DOT, '?': T.QUESTION,
  '+': T.PLUS, '-': T.MINUS, '*': T.STAR, '/': T.SLASH, '%': T.PERCENT,
};

/**
 * Two-character operators, checked before the single-character table.
 * `=`, `!`, `>` and `<` each have both forms, so order matters here.
 */
const PUNCT2 = {
  '==': T.EQEQ, '!=': T.NOTEQ, '>=': T.GTE, '<=': T.LTE, '&&': T.ANDAND, '||': T.OROR,
};

/** The single-character fallbacks for the four that also start a pair. */
const PUNCT1_AMBIGUOUS = { '=': T.EQUALS, '!': T.BANG, '>': T.GT, '<': T.LT };

/**
 * Repair a streamed-but-incomplete buffer by closing any open string and any
 * open bracket, so the lexer and parser always see something syntactically
 * complete even when it is semantically half-written.
 *
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
 * @returns {Array<{t: string, v?: string|number|boolean, i?: number}>}
 */
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    const start = i;

    if (c === '\n') { tokens.push({ t: T.NEWLINE, i: start }); i++; continue; }
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
      tokens.push({ t: T.STR, v: value, i: start });
      i = j + 1; // autoClose guarantees the closing quote exists
      continue;
    }

    // Numbers are unsigned here. A leading `-` is always the MINUS operator and
    // negation is the parser's job — otherwise `total -5` lexes as two values
    // with no operator between them and silently means something else.
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(text[j])) j++;
      if (text[j] === '.' && /[0-9]/.test(text[j + 1] || '')) {
        j++;
        while (j < n && /[0-9]/.test(text[j])) j++;
      }
      tokens.push({ t: T.NUM, v: Number(text.slice(i, j)), i: start });
      i = j;
      continue;
    }

    // `$name` — a reactive state reference. The value keeps the `$`, so a state
    // name can never collide with a statement name of the same spelling.
    if (c === '$' && /[a-zA-Z_]/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(text[j])) j++;
      tokens.push({ t: T.STATE, v: text.slice(i, j), i: start });
      i = j;
      continue;
    }

    // `@Name` — a builtin call. The `@` is consumed; the value is the bare name.
    if (c === '@' && /[a-zA-Z_]/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(text[j])) j++;
      tokens.push({ t: T.BUILTIN, v: text.slice(i + 1, j), i: start });
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (word === 'true') tokens.push({ t: T.BOOL, v: true, i: start });
      else if (word === 'false') tokens.push({ t: T.BOOL, v: false, i: start });
      else if (word === 'null') tokens.push({ t: T.NULL, i: start });
      else if (/^[A-Z]/.test(word)) tokens.push({ t: T.TYPE, v: word, i: start });
      else tokens.push({ t: T.IDENT, v: word, i: start });
      i = j;
      continue;
    }

    const two = PUNCT2[text.slice(i, i + 2)];
    if (two) { tokens.push({ t: two, i: start }); i += 2; continue; }
    if (PUNCT1_AMBIGUOUS[c]) { tokens.push({ t: PUNCT1_AMBIGUOUS[c], i: start }); i++; continue; }
    if (PUNCT1[c]) { tokens.push({ t: PUNCT1[c], i: start }); i++; continue; }

    // Unrecognised character — skip it. The model writes prose around the DSL
    // on purpose, so this is an expected path, not an error path.
    i++;
  }

  tokens.push({ t: T.EOF, i: n });
  return tokens;
}
