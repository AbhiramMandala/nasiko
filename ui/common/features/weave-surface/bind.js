/**
 * The binding grammar — pure, no DOM, no network.
 *
 * A generated surface carries values two ways: a literal, or a reference into
 * the data the surface declared. The reference form is a string opening with
 * `@`, which is terser than a wrapper object and unambiguous with one escape:
 *
 *   @agents                     the whole bound value
 *   @spend.summary.total_cost   dotted
 *   @agents[0].name             indexed
 *   @agents.length              the one synthetic accessor
 *   @item.name                  row scope, inside a repeat
 *   @cost | currency            formatted for display
 *   @@rate                      an escaped literal "@rate"
 *
 * Everything here returns a diagnostic rather than throwing. A surface is
 * untrusted input and a bad path is a normal event: the rule from the failure
 * model is that a node degrades, so a caller needs a code it can report and a
 * value it can skip — not an exception that takes the paint down with it.
 *
 * Kept separate from the element so the whole matrix is testable under
 * `node --test` with no browser.
 *
 * @module features/weave-surface/bind
 */

/** Formatters a binding may name. Unknown names are reported, never applied. */
export const FORMATS = new Set([
  'currency', 'number', 'compact', 'percent', 'bytes',
  'duration_ms', 'datetime', 'date', 'relative',
]);

/**
 * True when a prop value is a binding rather than a literal.
 * `@@…` is the escape for a literal that really does start with `@`.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBinding(value) {
  return typeof value === 'string' && value.startsWith('@') && !value.startsWith('@@');
}

/**
 * Undo the `@@` escape on a literal. A no-op for everything else.
 * @param {unknown} value
 */
export function unescapeLiteral(value) {
  return typeof value === 'string' && value.startsWith('@@') ? value.slice(1) : value;
}

/**
 * Split a binding into path segments and an optional formatter.
 *
 * Numeric subscripts become numbers so a resolver can tell `rows[0]` from a key
 * literally called `"0"`, which matters for the non-scalar check downstream.
 *
 * @param {string} expr A binding, with or without the leading `@`.
 * @returns {{ segments: (string|number)[], format: string|null, error: string|null }}
 */
export function parseBinding(expr) {
  const body = expr.startsWith('@') ? expr.slice(1) : expr;
  const pipe = body.indexOf('|');
  const pathPart = (pipe === -1 ? body : body.slice(0, pipe)).trim();
  const format = pipe === -1 ? null : body.slice(pipe + 1).trim();

  if (!pathPart) return { segments: [], format, error: 'empty_binding' };

  /** @type {(string|number)[]} */
  const segments = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let consumed = 0;
  for (const m of pathPart.matchAll(re)) {
    segments.push(m[2] !== undefined ? Number(m[2]) : m[1]);
    consumed = m.index + m[0].length;
  }
  // Anything the tokeniser could not account for is a malformed path — say so
  // rather than silently resolving the prefix.
  if (consumed !== pathPart.length || !segments.length) {
    return { segments, format, error: 'malformed_binding' };
  }
  return { segments, format, error: null };
}

/**
 * Walk `segments` into `root`.
 *
 * A missing intermediate segment resolves to `undefined` rather than failing:
 * the failure model prefers a dashboard with one blank cell to a dashboard that
 * refuses to draw. `.length` on an array is the single synthetic accessor,
 * because a count is the one thing a KPI tile wants that no API returns as a
 * field of its own.
 *
 * @param {unknown} root
 * @param {(string|number)[]} segments
 * @returns {unknown}
 */
export function resolvePath(root, segments) {
  let cur = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (seg === 'length' && Array.isArray(cur)) return cur.length;
    if (typeof cur !== 'object') return undefined;
    cur = /** @type {any} */ (cur)[seg];
  }
  return cur;
}

/** Values an attribute can carry. Anything else is a non-scalar bind. */
function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/** A list attribute may also take an array of scalars (a card's `tags`). */
function isScalarList(v) {
  return Array.isArray(v) && v.every(isScalar);
}

/**
 * Resolve one prop value against a scope.
 *
 * `scope` is a flat object of declared binds plus, inside a repeat, `item`.
 * The outer scope stays visible in a row, so a per-row card can still show a
 * surface-level total.
 *
 * @param {unknown} value The raw prop value from the spec.
 * @param {Record<string, unknown>} scope
 * @param {{ allowList?: boolean, allowObject?: boolean }} [opts]
 *   `allowList` for a catalog `list` attribute, `allowObject` for a `json` one.
 * @returns {{ value: unknown, code?: string, detail?: string }}
 *   `value` is `undefined` when the caller should omit the attribute.
 */
export function resolveValue(value, scope, { allowList = false, allowObject = false } = {}) {
  if (!isBinding(value)) return { value: unescapeLiteral(value) };

  const expr = /** @type {string} */ (value);
  const { segments, format, error } = parseBinding(expr);
  if (error) return { value: undefined, code: error, detail: expr };

  const head = segments[0];
  if (!(typeof head === 'string' && Object.prototype.hasOwnProperty.call(scope, head))) {
    return { value: undefined, code: 'unresolved_bind', detail: expr };
  }

  const raw = resolvePath(scope, segments);
  if (raw === undefined) {
    // Distinguished from unresolved_bind on purpose: the bind is legal, the
    // data just did not carry that field this time. One is a spec bug, the
    // other is an empty cell, and conflating them buries the real one.
    return { value: undefined, code: 'empty_bind', detail: expr };
  }

  if (!isScalar(raw) && !(allowList && isScalarList(raw)) && !allowObject) {
    return { value: undefined, code: 'non_scalar_bind', detail: expr };
  }

  if (format === null) return { value: raw };
  if (!FORMATS.has(format)) {
    // The raw value still renders — an unknown formatter should cost the
    // formatting, not the number.
    return { value: raw, code: 'unknown_format', detail: format };
  }
  return { value: applyFormat(raw, format) };
}

/**
 * Render a raw value for display.
 *
 * Formatting lives here rather than in the components because the components
 * take strings: `app-stat-card` writes `value` out verbatim, so a bound
 * `total_cost` of 0.18342 reaches the user as "0.18342" unless something on
 * this path turns it into "$0.1834".
 *
 * @param {unknown} value
 * @param {string} format One of `FORMATS`.
 * @returns {string}
 */
export function applyFormat(value, format) {
  const n = typeof value === 'number' ? value : Number(value);
  const bad = Number.isNaN(n);
  switch (format) {
    case 'currency':
      return bad ? String(value) : n.toLocaleString(undefined, {
        style: 'currency', currency: 'USD',
        minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2,
      });
    case 'number':
      return bad ? String(value) : n.toLocaleString();
    case 'compact':
      return bad ? String(value) : n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    case 'percent':
      return bad ? String(value) : `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    case 'bytes': {
      if (bad) return String(value);
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let v = n;
      let i = 0;
      while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
      return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[i]}`;
    }
    case 'duration_ms': {
      if (bad) return String(value);
      if (n < 1000) return `${Math.round(n)} ms`;
      if (n < 60_000) return `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
      return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
    }
    case 'datetime':
    case 'date': {
      const d = new Date(/** @type {any} */ (value));
      if (Number.isNaN(d.getTime())) return String(value);
      return format === 'date' ? d.toLocaleDateString() : d.toLocaleString();
    }
    case 'relative': {
      const d = new Date(/** @type {any} */ (value));
      if (Number.isNaN(d.getTime())) return String(value);
      const secs = Math.round((d.getTime() - Date.now()) / 1000);
      const abs = Math.abs(secs);
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
      if (abs < 60) return rtf.format(secs, 'second');
      if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute');
      if (abs < 86_400) return rtf.format(Math.round(secs / 3600), 'hour');
      return rtf.format(Math.round(secs / 86_400), 'day');
    }
    default:
      return String(value);
  }
}

/**
 * Expand a `repeat` into one scope per row.
 *
 * `repeat` accepts a bare binding (index-keyed) or `{ items, key }`. The key is
 * what lets the renderer reconcile rows by identity instead of by position —
 * without one, a sort or a refetch reorders every element and takes focus and
 * scroll with it, which is exactly what reconcile-by-id exists to prevent.
 *
 * @param {unknown} repeat
 * @param {Record<string, unknown>} scope
 * @param {number} cap Maximum rows to expand.
 * @returns {{ rows: {scope: Record<string, unknown>, key: string}[], total: number, code?: string, detail?: string }}
 */
export function expandRepeat(repeat, scope, cap = 200) {
  const spec = typeof repeat === 'string' ? { items: repeat, key: null } : /** @type {any} */ (repeat) || {};
  const { items, key = null } = spec;
  if (!isBinding(items)) return { rows: [], total: 0, code: 'malformed_binding', detail: String(items) };

  const { segments, error } = parseBinding(items);
  if (error) return { rows: [], total: 0, code: error, detail: items };
  const head = segments[0];
  if (!(typeof head === 'string' && Object.prototype.hasOwnProperty.call(scope, head))) {
    return { rows: [], total: 0, code: 'unresolved_bind', detail: items };
  }

  const list = resolvePath(scope, segments);
  if (!Array.isArray(list)) return { rows: [], total: 0, code: 'repeat_not_array', detail: items };

  const rows = list.slice(0, cap).map((row, index) => {
    const rowScope = { ...scope, item: row, index };
    let k = String(index);
    if (key) {
      const resolved = resolveValue(key, rowScope);
      if (isScalar(resolved.value) && resolved.value !== null) k = String(resolved.value);
    }
    return { scope: rowScope, key: k };
  });

  const out = { rows, total: list.length };
  if (list.length > cap) return { ...out, code: 'repeat_truncated', detail: `${cap} of ${list.length}` };
  if (!key) return { ...out, code: 'repeat_unkeyed', detail: items };
  return out;
}
