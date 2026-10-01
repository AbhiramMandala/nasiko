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
 * The data vocabulary, and the closed sets inside it.
 *
 * `dsl-catalog.json` says what a surface may draw; `data-manifest.json` says
 * what it may ask for. The runtime has always loaded the first and never the
 * second, which is why an argument outside its own enum could only be caught
 * by the backend answering 400 — the browser had the DSL and no idea what the
 * DSL was allowed to say.
 *
 * Shaped into `{source: {callStyle, keys, enums}}` here rather than handed on
 * whole, because the caller needs to resolve a positional index or an options
 * key to an argument name, and nothing else in the manifest concerns it.
 * `keys` is `argsShape`'s own key order, which for a positional source IS the
 * call signature — the same order `Query`'s argument array is written in.
 *
 * A failure resolves to null and the guard that reads it simply does not run.
 * A check that cannot load is not a reason to stop a dashboard rendering.
 */
let manifestPromise = null;
let enumPromise = null;
let argEnumMap = null;

/** Required for source authorization; callers must fail closed on rejection. */
export function loadDataManifest() {
  manifestPromise ??= fetch(new URL('/common/surface/data-manifest.json', globalThis.document?.baseURI))
    .then(res => {
      if (!res.ok) throw new Error(`data-manifest.json: ${res.status}`);
      return res.json();
    });
  return manifestPromise;
}

export function loadArgEnums() {
  enumPromise ??= (async () => {
    try {
      const manifest = await loadDataManifest();
      const map = {};
      // Scopes overlap — a source can appear in several. They are the same
      // generated entry each time, so last write wins and says the same thing.
      for (const sources of Object.values(manifest?.scopes ?? {})) {
        for (const src of sources) {
          if (!src?.argsEnum) continue;
          map[src.name] = {
            callStyle: src.callStyle,
            keys: Object.keys(src.argsShape ?? {}),
            enums: src.argsEnum,
          };
        }
      }
      argEnumMap = map;
    } catch { argEnumMap = null; }
  })();
  return enumPromise;
}

/** The loaded table, or null before {@link loadArgEnums} resolves. */
export function argEnums() { return argEnumMap; }

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
  // Wrapped, not bare: `document.baseURI` throws synchronously where there is
  // no document, and a throw here would take down whatever asked rather than
  // leaving the table null the way every other failure in this function does.
  // The runtime calls this from inside a turn now, so "no document" is a real
  // caller (a test, a worker), not a hypothetical.
  severityPromise ??= (async () => {
    try {
      const res = await fetch(new URL('/common/surface/diagnostics.json', globalThis.document?.baseURI));
      severityMap = res.ok ? (await res.json())?.diagnostics ?? null : null;
    } catch { severityMap = null; }
  })();
  return severityPromise;
}

/**
 * The loaded severity/repairable table, or null before {@link loadSeverities}
 * resolves. The repair loop needs the whole entry, not just the severity
 * `withSeverity` stamps on — `repairable` is what decides whether a diagnostic
 * is worth a turn.
 */
export function severities() { return severityMap; }

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
