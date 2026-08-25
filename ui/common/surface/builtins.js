/**
 * `@builtin(...)` functions — ported directly from OpenUI Lang's real
 * implementation (session research, `builtins.ts:41-179`), forgiving-
 * coercion behavior kept exactly as-is per the production plan's decision:
 * no builtin ever throws; wrong types silently coerce to 0/null/[]/the
 * input itself, matching the rest of this DSL's evaluator (§2.3).
 *
 * `Each` is deliberately NOT in this file — it is "lazy" (receives
 * unevaluated AST, not values) and is handled directly in materialize.js's
 * evaluator, exactly where `Query`/`Mutation`/`Action`/`Slot` are handled.
 */

function toNumber(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    return Number.isNaN(n) ? 0 : n;
  }
  if (typeof val === 'boolean') return val ? 1 : 0;
  return 0; // null/undefined/object/array
}

function resolveField(item, field) {
  if (item == null) return null;
  return item[field];
}

export const BUILTINS = {
  Count: { fn: (arr) => (Array.isArray(arr) ? arr.length : 0) },
  First: { fn: (arr) => (Array.isArray(arr) ? (arr[0] ?? null) : null) },
  Last: { fn: (arr) => (Array.isArray(arr) ? (arr[arr.length - 1] ?? null) : null) },
  Sum: {
    fn: (arr) => (Array.isArray(arr) ? arr.reduce((a, b) => a + toNumber(b), 0) : 0),
  },
  Avg: {
    fn: (arr) =>
      Array.isArray(arr) && arr.length
        ? arr.reduce((a, b) => a + toNumber(b), 0) / arr.length
        : 0,
  },
  Min: {
    fn: (arr) =>
      Array.isArray(arr) && arr.length
        ? arr.reduce((acc, b) => Math.min(acc, toNumber(b)), toNumber(arr[0]))
        : 0,
  },
  Max: {
    fn: (arr) =>
      Array.isArray(arr) && arr.length
        ? arr.reduce((acc, b) => Math.max(acc, toNumber(b)), toNumber(arr[0]))
        : 0,
  },
  Sort: {
    fn: (arr, field, dir) => {
      if (!Array.isArray(arr)) return arr;
      const direction = dir === 'desc' ? -1 : 1;
      const copy = arr.slice();
      copy.sort((a, b) => {
        const av = resolveField(a, field);
        const bv = resolveField(b, field);
        const an = toNumber(av);
        const bn = toNumber(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn) && (typeof av === 'number' || typeof bv === 'number')) {
          return (an - bn) * direction;
        }
        return String(av ?? '').localeCompare(String(bv ?? '')) * direction;
      });
      return copy;
    },
  },
  Filter: {
    fn: (arr, field, op, value) => {
      if (!Array.isArray(arr)) return [];
      return arr.filter((item) => {
        const v = resolveField(item, field);
        switch (op) {
          case '==': return v == value; // eslint-disable-line eqeqeq
          case '!=': return v != value; // eslint-disable-line eqeqeq
          case '>': return toNumber(v) > toNumber(value);
          case '<': return toNumber(v) < toNumber(value);
          case '>=': return toNumber(v) >= toNumber(value);
          case '<=': return toNumber(v) <= toNumber(value);
          case 'contains': return String(v ?? '').includes(String(value ?? ''));
          default: return false;
        }
      });
    },
  },
  Round: {
    fn: (n, decimals) => {
      const num = toNumber(n);
      const d = decimals != null ? toNumber(decimals) : 0;
      return Math.round(num * 10 ** d) / 10 ** d;
    },
  },
  Abs: { fn: (n) => Math.abs(toNumber(n)) },
  Floor: { fn: (n) => Math.floor(toNumber(n)) },
  Ceil: { fn: (n) => Math.ceil(toNumber(n)) },
};

export function isBuiltin(name) {
  return name in BUILTINS;
}

export { toNumber };
