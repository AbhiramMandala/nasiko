/**
 * The `@Name(...)` builtins.
 *
 * A closed set of fourteen, matching `build_builtin_signatures()` in
 * weave2.0's `dashboard/dsl_prompt.py` exactly — that function is what tells
 * the model these exist, so a name here that is not there is unreachable, and
 * a name there that is not here renders as nothing. Adding one means editing
 * both, deliberately; there is no plugin mechanism and there should not be.
 *
 * Thirteen are eager: their arguments are evaluated before they are called.
 * `@Each` is lazy — it takes its template unevaluated and evaluates it once per
 * element against a child scope — so it is handled by the evaluator rather than
 * from this table. `EACH` is exported as the name to special-case.
 *
 * None of them throw. Every one has a defined answer for a non-array, a
 * non-numeric element and a missing argument, because all three are ordinary
 * states while a query is still in flight.
 *
 * @module common/surface/builtins
 */

import { toNumber, toArray } from './coerce.js';

/** The lazy one. The evaluator must intercept this before evaluating args. */
export const EACH = 'Each';

/** Comparison operators `@Filter` accepts, per its signature in the prompt. */
const COMPARE = {
  '==': (a, b) => a == b, // eslint-disable-line eqeqeq -- loose by specification
  '!=': (a, b) => a != b, // eslint-disable-line eqeqeq
  '>': (a, b) => toNumber(a) > toNumber(b),
  '<': (a, b) => toNumber(a) < toNumber(b),
  '>=': (a, b) => toNumber(a) >= toNumber(b),
  '<=': (a, b) => toNumber(a) <= toNumber(b),
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
};

/** Numbers out of any array, non-numeric entries reading as 0. */
const nums = (v) => toArray(v).map(toNumber);

export const BUILTINS = Object.freeze({
  Count: (arr) => toArray(arr).length,
  First: (arr) => (toArray(arr).length ? toArray(arr)[0] : null),
  Last: (arr) => {
    const a = toArray(arr);
    return a.length ? a[a.length - 1] : null;
  },
  Sum: (arr) => nums(arr).reduce((a, b) => a + b, 0),
  // An average of nothing is 0, not NaN — a KPI tile has to print something.
  Avg: (arr) => {
    const a = nums(arr);
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  },
  Min: (arr) => {
    const a = nums(arr);
    return a.length ? Math.min(...a) : 0;
  },
  Max: (arr) => {
    const a = nums(arr);
    return a.length ? Math.max(...a) : 0;
  },

  /** Sorted copy. Numeric when both sides look numeric, else lexicographic. */
  Sort: (arr, field, direction) => {
    const dir = String(direction ?? 'asc').toLowerCase() === 'desc' ? -1 : 1;
    const key = field === undefined || field === null ? null : String(field);
    return [...toArray(arr)].sort((x, y) => {
      const a = key === null ? x : x?.[key];
      const b = key === null ? y : y?.[key];
      const bothNumeric = a !== null && b !== null && a !== '' && b !== ''
        && Number.isFinite(Number(a)) && Number.isFinite(Number(b));
      if (bothNumeric) return (Number(a) - Number(b)) * dir;
      return String(a ?? '').localeCompare(String(b ?? '')) * dir;
    });
  },

  /** Filtered copy. An unknown operator keeps everything rather than nothing. */
  Filter: (arr, field, operator, value) => {
    const cmp = COMPARE[String(operator)];
    if (!cmp) return toArray(arr);
    const key = field === undefined || field === null ? null : String(field);
    return toArray(arr).filter((row) => cmp(key === null ? row : row?.[key], value));
  },

  Round: (n, decimals) => {
    const d = Math.max(0, Math.min(15, Math.trunc(toNumber(decimals))));
    const f = 10 ** d;
    return Math.round(toNumber(n) * f) / f;
  },
  Abs: (n) => Math.abs(toNumber(n)),
  Floor: (n) => Math.floor(toNumber(n)),
  Ceil: (n) => Math.ceil(toNumber(n)),
});

/** Is this a builtin the evaluator can call with evaluated arguments? */
export function isEagerBuiltin(name) {
  return Object.prototype.hasOwnProperty.call(BUILTINS, name);
}

/**
 * Call an eager builtin. An unknown name yields null rather than throwing —
 * the model can invent one, and one empty cell beats a dead surface.
 *
 * @param {string} name
 * @param {unknown[]} args already-evaluated arguments
 */
export function callBuiltin(name, args) {
  const fn = BUILTINS[name];
  if (!fn) return null;
  return fn(...args);
}
