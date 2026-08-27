/**
 * The coercion rules the DSL evaluates by, in one place because the evaluator
 * and the builtins have to agree exactly.
 *
 * The whole grammar is forgiving on purpose: a wrong type never throws, it
 * converts. A model-authored surface is going to get a type wrong sometimes,
 * and a thrown error there costs the entire dashboard, while a coerced value
 * costs one cell. That trade is stated in agent.yaml — division by zero is 0,
 * `+` concatenates when either side is a string — so these are the semantics
 * the model is taught, not an implementation convenience.
 *
 * @module common/surface/coerce
 */

/**
 * Number-ish reading of any value. Anything with no sensible numeric meaning —
 * null, undefined, an object, an array — is 0 rather than NaN, so arithmetic
 * on missing data produces a number the UI can print instead of "NaN".
 *
 * @param {unknown} v
 * @returns {number}
 */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

/**
 * Array-ish reading. A non-array is an empty list, so every list builtin has a
 * defined answer for "the query has not resolved yet".
 *
 * @param {unknown} v
 * @returns {unknown[]}
 */
export function toArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Text reading for string concatenation. `null` and `undefined` become the
 * empty string rather than the words "null"/"undefined", which is what makes
 * `"Cost: " + missingValue` read as `"Cost: "` instead of `"Cost: null"`.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function toText(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Values an element attribute can carry. */
export function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}
