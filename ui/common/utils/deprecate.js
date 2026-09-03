/**
 * Deprecated-alias helpers — how a rename lands without breaking a page.
 *
 * A design-system rename touches every call site in oss/, ee/ and every stored
 * Weave surface. The rule (CONVENTIONS.md §1) is: the new name is canonical, the
 * old one keeps working for one release and says so once in the console, and
 * the alias is deleted in the release after. These three helpers are that rule.
 */

const seen = new Set();

/** `console.warn` once per key for the life of the page. */
export function warnOnce(key, message) {
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(`[design-system] ${message}`);
}

/**
 * Read an attribute by its canonical name, falling back to legacy names.
 *
 *   const heading = readAttr(this, 'heading', 'title');
 *
 * Returns `null` when none is present. The legacy hit warns once per element
 * type + attribute so a page full of old markup logs one line, not hundreds.
 */
export function readAttr(el, name, ...legacy) {
  if (el.hasAttribute(name)) return el.getAttribute(name);
  for (const old of legacy) {
    if (el.hasAttribute(old)) {
      warnOnce(`${el.localName}.${old}`, `<${el.localName} ${old}> is deprecated — use ${name}=. It still works this release.`);
      return el.getAttribute(old);
    }
  }
  return null;
}

/** `hasAttribute` with the same fallback and warning. */
export function hasAttr(el, name, ...legacy) {
  return readAttr(el, name, ...legacy) !== null;
}

/**
 * Find a slotted child by `data-slot="name"`, accepting the Shadow-DOM style
 * `slot="name"` for one release. Direct children only.
 */
export function slotted(el, name) {
  for (const child of el.children) {
    if (child.dataset.slot === name) return child;
    if (child.getAttribute('slot') === name) {
      warnOnce(`${el.localName}.slot=${name}`, `<${el.localName}> child with slot="${name}" — use data-slot="${name}" (light DOM has no slot attribute).`);
      return child;
    }
  }
  return null;
}

/**
 * Dispatch a canonical event and, for one release, its legacy-named twin so
 * existing listeners keep firing. Both bubble; both carry the same detail. The
 * return value is the canonical event's `dispatchEvent` result, so a cancelable
 * event's `preventDefault()` is still honoured by the caller.
 */
export function emit(el, name, detail, { legacy, cancelable = false } = {}) {
  const ok = el.dispatchEvent(new CustomEvent(name, { bubbles: true, cancelable, detail }));
  if (legacy) el.dispatchEvent(new CustomEvent(legacy, { bubbles: true, cancelable, detail: { ...detail, deprecatedEvent: name } }));
  return ok;
}
