// Display formatting shared by the pages and by the design system.
//
// Two kinds of thing live here and they are not the same job.
//
// The `fmt*` family is *unit* formatting: a caller who knows the field is a
// duration, a token count, a cost, asks for that. Pages use it directly.
//
// `applyFormat` and `autoFormat` are *display coercion*: turning a value of
// unknown provenance into something readable. They exist because a generated
// surface has no code. A page can write `render: (v) => fmtCost(v)` on a
// column; a Weave-generated `AppTable(rowsQ, 20, ...)` cannot — `columns` is a
// property, not an attribute, so nothing in the DSL can reach it. Left alone,
// `avg_cost_per_operation: 0.023456789012` renders all twelve digits and
// `bucket_start: "2026-09-09T14:00:00Z"` renders as the raw UTC string. The
// design system has to do this itself or it does not get done.
//
// `autoFormat` is therefore deliberately conservative: it only touches values
// whose *shape* makes the intent unambiguous — a non-integer number, or a
// string that parses as ISO-8601. Integers, ids, and every other string pass
// through untouched, because guessing there costs more than it saves.

/** "980 ms" / "2.3 s" / "4 min" / "1 h 12 min" from a millisecond count. */
export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/** "365 tokens" / "12.4k tokens"; empty string when zero/absent. */
export function fmtTokens(n) {
  if (!n) return '';
  const count = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return `${count} tokens`;
}

/** The house maximum. Two decimals is what a dashboard reads at a glance. */
export const MAX_FRACTION_DIGITS = 2;

/**
 * A number matching an ISO-8601 date, optionally with a time, optionally with a
 * zone. Anchored, so "12" and "2026 was a year" are not dates.
 *
 * Deliberately narrower than `Date.parse`, which accepts "March 3", "12/1/26",
 * and — depending on the engine — plain integers. A table cell holding the
 * string "2026" must not become a timestamp.
 */
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** @returns {boolean} whether `v` is a string this module would read as a date. */
export function isIsoDateTime(v) {
  return typeof v === 'string' && ISO_DATETIME.test(v.trim())
    && !Number.isNaN(Date.parse(v.trim()));
}

/** Whether the ISO string carries a time at all, or is a bare calendar date. */
function hasTime(iso) {
  return /[T ]\d{2}:\d{2}/.test(iso);
}

/**
 * ISO-8601 → the viewer's local time, in their locale.
 *
 * The backend speaks UTC everywhere (`bucket_start`, `created_at`, every
 * timeseries bucket) and a raw `2026-09-09T14:00:00Z` in a cell is both ugly
 * and wrong for the reader — 14:00Z is not 14:00 where they are. A bare
 * `2026-09-09` has no time to convert and is rendered as a date, not as
 * midnight-in-some-zone.
 *
 * @param {string|number|Date} value
 * @param {'auto'|'date'|'time'|'datetime'} [mode]
 */
export function fmtDateTime(value, mode = 'auto') {
  const raw = typeof value === 'string' ? value.trim() : value;
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  const timed = mode === 'auto' ? (typeof raw !== 'string' || hasTime(raw)) : mode !== 'date';
  if (!timed) {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  if (mode === 'time') {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Bare calendar date, never a time. */
export function fmtDate(value) { return fmtDateTime(value, 'date'); }

/**
 * Round to two decimals — except where two decimals would erase the number.
 *
 * A per-operation cost is routinely $0.0004. Rounding it to "0.00" does not
 * shorten the figure, it deletes it, and a column of "0.00" is a column of
 * nothing. So a non-zero value that would round away keeps two significant
 * digits instead. Everything at or above 0.01 gets the flat two-decimal rule
 * the dashboard was asked for.
 */
function trimFraction(n) {
  if (!Number.isFinite(n)) return null;
  if (n === 0 || Number.isInteger(n)) return n;
  const rounded = Number(n.toFixed(MAX_FRACTION_DIGITS));
  if (rounded !== 0) return rounded;
  return Number(n.toPrecision(2));
}

/**
 * Grouped decimal, capped at two fraction digits.
 * `1234.5678` → "1,234.57"; `1234` → "1,234"; `0.0004` → "0.0004".
 */
export function fmtNumber(n, { grouping = true } = {}) {
  const num = typeof n === 'string' ? Number(n) : n;
  if (num == null || typeof num !== 'number' || !Number.isFinite(num)) return '—';
  const value = trimFraction(num);
  // maximumFractionDigits has a hard ceiling of 20 and `value` has already been
  // rounded, so this is a formatting pass, not a second rounding.
  return new Intl.NumberFormat(undefined, {
    useGrouping: grouping,
    maximumFractionDigits: 20,
  }).format(value);
}

/**
 * Money. Sub-cent figures keep their significant digits for the same reason
 * `trimFraction` does — `$0.00` per operation is not a price, it is a bug
 * report.
 */
export function fmtCurrency(n, { currency = 'USD' } = {}) {
  const num = typeof n === 'string' ? Number(n) : n;
  if (num == null || typeof num !== 'number' || !Number.isFinite(num)) return '—';
  const value = trimFraction(num);
  const digits = Math.min(20, Math.max(2, decimalsOf(value)));
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value);
}

/** How many fraction digits a already-trimmed number actually carries. */
function decimalsOf(n) {
  const s = String(n);
  const dot = s.indexOf('.');
  if (dot === -1) return 0;
  const exp = s.indexOf('e');
  // 4e-7 stringifies without a dot after the mantissa; fall back to the cap.
  if (exp !== -1) return 20;
  return s.length - dot - 1;
}

/** "1.2M" / "12.4k" / "980". */
export function fmtCompact(n) {
  const num = typeof n === 'string' ? Number(n) : n;
  if (num == null || typeof num !== 'number' || !Number.isFinite(num)) return '—';
  return new Intl.NumberFormat(undefined,
    { notation: 'compact', maximumFractionDigits: 1 }).format(num);
}

/** `0.42` is not 42% here — the backend sends percentages as percentages. */
export function fmtPercent(n) {
  const num = typeof n === 'string' ? Number(n) : n;
  if (num == null || typeof num !== 'number' || !Number.isFinite(num)) return '—';
  return `${fmtNumber(num, { grouping: false })}%`;
}

/** The format names a component's `format` attribute accepts. */
export const FORMATS = ['number', 'currency', 'percent', 'compact', 'bytes',
  'duration', 'tokens', 'date', 'time', 'datetime', 'text'];

/** "1.4 GB" from a byte count. */
export function fmtBytes(n) {
  const num = typeof n === 'string' ? Number(n) : n;
  if (num == null || typeof num !== 'number' || !Number.isFinite(num)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = num;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${fmtNumber(v, { grouping: false })} ${units[i]}`;
}

/**
 * Format `value` as `kind`, where `kind` is one of {@link FORMATS}.
 *
 * An unknown `kind` falls through to {@link autoFormat} rather than throwing:
 * the caller is frequently a generated attribute, and a surface that renders
 * its numbers slightly plainer is a better failure than one that renders an
 * exception.
 */
export function applyFormat(value, kind, opts = {}) {
  if (value == null || value === '') return '';
  switch (kind) {
    case 'text': return String(value);
    case 'number': return fmtNumber(value);
    case 'currency': return fmtCurrency(value, opts);
    case 'percent': return fmtPercent(value);
    case 'compact': return fmtCompact(value);
    case 'bytes': return fmtBytes(value);
    case 'duration': return fmtDuration(typeof value === 'string' ? Number(value) : value);
    case 'tokens': return fmtCompact(value);
    case 'date': return fmtDateTime(value, 'date');
    case 'time': return fmtDateTime(value, 'time');
    case 'datetime': return fmtDateTime(value, 'datetime');
    default: return autoFormat(value);
  }
}

/**
 * Readable form of a value nobody annotated.
 *
 * Only two shapes are unambiguous enough to act on:
 *   - a number with a fractional part → two decimals, grouped
 *   - a string that is ISO-8601 → local date/time
 *
 * Integers keep their exact digits ungrouped, because the commonest integer in
 * these tables is an id and "1,234,567" is not an id. Booleans, nulls and every
 * other string are returned as-is.
 */
export function autoFormat(value) {
  if (value == null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? String(value) : fmtNumber(value);
  }
  if (typeof value === 'string') {
    if (isIsoDateTime(value)) return fmtDateTime(value);
    // A numeric *string* is the generated-surface case: every attribute
    // arrives as text, so `value="0.023456789"` is a number that lost its
    // type on the way through the DOM. Reformat it only when it round-trips
    // exactly, so version strings and ids are never touched.
    const trimmed = value.trim();
    if (trimmed && !Number.isNaN(Number(trimmed)) && String(Number(trimmed)) === trimmed) {
      const num = Number(trimmed);
      if (!Number.isInteger(num)) return fmtNumber(num);
    }
    return value;
  }
  return String(value);
}
