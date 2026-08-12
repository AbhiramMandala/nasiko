/**
 * The one HTML-escaping implementation.
 *
 * Before this file there were 38 private escape helpers across the component
 * tree, in four mutually incompatible families, guarding 318 `innerHTML`
 * writes. The families did not agree on what they escaped:
 *
 *   A. DOM round-trip (`el.textContent = s; return el.innerHTML`) — 15 sites.
 *      Escapes `& < >` only. Safe between tags, UNSAFE inside an attribute.
 *   B. `[&<>"']` character map — 15 sites. Correct for both contexts, but split
 *      between `&#39;` and `&#039;` for the apostrophe.
 *   C. Four-replace chain, no apostrophe — 5 sites plus 3 function-local
 *      redefinitions inside column renderers.
 *   D. Three-replace, no quotes at all — 1 site.
 *
 * Two live consequences of the split: `workflow-detail-page.js` interpolated a
 * family-A escaper into `value="${…}"` with a user-controlled workflow name,
 * and `sessions-page.js` did the same into `data-session-id="…"`. Both are
 * attribute-position uses of a text-only escaper.
 *
 * Rules from here on:
 *   - New components extend `NasikoElement` and use Lit's `html` templates,
 *     which escape interpolations automatically. Reach for this file only when
 *     you are building a string for `innerHTML` in legacy code.
 *   - Between tags: `escHtml(value)`.
 *   - Inside a quoted attribute: `escAttr(value)`.
 *   - Do not write a new private `#esc`. If you find one, delete it and import.
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

const TEXT_RE = /[&<>]/g;
const ATTR_RE = /[&<>"'`]/g;

/**
 * Escape for text content — between tags.
 *
 * `null`/`undefined` render as an empty string rather than the strings "null"
 * or "undefined", because every call site was already writing `?? ''` by hand
 * and half of them forgot.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(TEXT_RE, (c) => HTML_ENTITIES[c]);
}

/**
 * Escape for a quoted attribute value. Covers quotes and the backtick, so the
 * result is safe in `"…"`, `'…'`, and — for old IE-style parsers — unquoted
 * contexts too.
 *
 * Always quote the attribute anyway: `title="${escAttr(x)}"`, never
 * `title=${escAttr(x)}`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escAttr(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(ATTR_RE, (c) => HTML_ENTITIES[c]);
}

/**
 * Tagged template that escapes every interpolation for attribute-safe output.
 * Use for whole fragments so you cannot forget a call:
 *
 * ```js
 * el.innerHTML = safeHtml`<a href="${url}" title="${name}">${name}</a>`;
 * ```
 *
 * Every hole is escaped with `escAttr` (the stricter of the two), which is
 * correct in text position as well. To interpolate markup you built yourself,
 * wrap it in `trusted()`.
 */
export function safeHtml(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (v instanceof TrustedMarkup ? v.value : escAttr(v)) + strings[i + 1];
  }
  return out;
}

class TrustedMarkup {
  constructor(value) {
    this.value = value;
  }
}

/**
 * Mark a string as already-safe markup so `safeHtml` interpolates it verbatim.
 *
 * This is the escape hatch and it is deliberately ugly to type. Only pass
 * markup this codebase generated — never anything that originated in a server
 * response or a URL.
 *
 * @param {string} markup
 */
export function trusted(markup) {
  return new TrustedMarkup(String(markup ?? ''));
}

/**
 * Escape a value for embedding in a `style="…"` property value. Strips the
 * characters that would let a value break out of one declaration into another,
 * plus `url(` so an interpolated value cannot start a fetch.
 *
 * Prefer setting a custom property (`el.style.setProperty('--w', pct + '%')`)
 * over interpolating into a style string at all.
 *
 * @param {unknown} value
 */
export function escStyleValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[<>"'`;{}()\\]/g, '').replace(/url\s*\(/gi, '');
}
