/**
 * The two generated artifacts the surface runtime is driven by, fetched once.
 *
 * These lived inside `weave-surface.js` as module-private functions, which was
 * fine while that element was the only thing that started a turn. It is not:
 * `weave-dock.js` runs the generation and renders nothing, so it needs the
 * vocabulary without needing the element. Private to one feature, the second
 * caller's only options were to import sideways into another feature or to
 * keep a second copy of the fetch — and the copy would have had its own cache,
 * so the app would fetch the catalog twice and could hold two versions of it.
 *
 * They sit in `surface/` because that is what they load: `dsl-catalog.json` and
 * `diagnostics.json` are generated *into* this directory by `gen-dsl-catalog`
 * and `gen-diagnostics`. Both features import downward to reach them.
 *
 * @module common/surface/catalog-load
 */

/** The generated vocabulary. Fetched once for the whole app. */
let catalogPromise = null;

export function loadCatalog() {
  catalogPromise ??= fetch(new URL('/common/surface/dsl-catalog.json', document.baseURI))
    .then((res) => {
      if (!res.ok) throw new Error(`dsl-catalog.json: ${res.status}`);
      return res.json();
    });
  return catalogPromise;
}

/**
 * How seriously to take each diagnostic code, from the generated manifest.
 *
 * The runtime deliberately does not carry this: a module that reports a problem
 * should not also be ranking it, and the ranking is a product decision that
 * changes without the code changing. Stamped on here, once, so a host has the
 * distinction without every consumer re-deriving it — the page paints a lost
 * chart differently from a dropped connection, which was impossible while every
 * diagnostic arrived as an undifferentiated warning.
 *
 * A code the manifest does not know is treated as fatal: `gen-diagnostics
 * --check` should have caught it, so if one gets here the loud answer is right.
 * A failed fetch leaves the field undefined rather than guessing.
 */
let severityPromise = null;
let severityMap = null;

export function loadSeverities() {
  severityPromise ??= fetch(new URL('/common/surface/diagnostics.json', document.baseURI))
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => { severityMap = json?.diagnostics ?? null; })
    .catch(() => { severityMap = null; });
  return severityPromise;
}

/**
 * Stamp each diagnostic with its severity and its plain-language `why`.
 *
 * `why` is the manifest's one-line answer to "what does this mean for the
 * person looking at the screen" — `orphaned_statement`'s is "the model built
 * something and never put it on the page". A host showing a diagnostic to a
 * user should show that, not the runtime's own message, which names statements
 * and paths that mean nothing outside the generator.
 *
 * @param {{code?: string}[]} diagnostics
 */
export function withSeverity(diagnostics) {
  if (!severityMap) return diagnostics;
  return diagnostics.map((d) => ({
    ...d,
    severity: severityMap[d.code]?.severity ?? 'fatal',
    why: severityMap[d.code]?.why,
  }));
}
