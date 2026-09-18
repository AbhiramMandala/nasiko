/**
 * The edition overlay seam — a chain, not a slot.
 *
 * ## What this replaces
 *
 * `app.js` imported `/routes-ext.js` and `navigation.js` imported
 * `/nav-ext.js`, each resolving to exactly one file through the rust-embed
 * overlay: this tree's no-op, or an overlay's real one shadowing it. That works
 * only for as long as *one* overlay defines each name.
 *
 * Distributions stack more than one. Where a higher overlay grows a
 * `routes-ext.js` of its own, that file shadows the lower overlay's rather than
 * extending it, and every route the lower one registered disappears. Nothing
 * throws — the import succeeds, it simply resolves to the wrong file — so the
 * symptom is a working app with pages missing from it. Same for `nav-ext.js`
 * and the nav tree. That is NAS-637, and it was cheap to fix only while no
 * third layer existed.
 *
 * ## The shape
 *
 * Each layer gets a name no sibling can shadow — `-ext.js`, `-ext-ee.js`,
 * `-ext-mt.js` — with a documented no-op for every one of them in `ui/oss/`,
 * the layer every binary embeds. An overlay replaces only the file bearing
 * *its* suffix; the layers below it keep resolving to their own files. The
 * caller folds the contributions together, base first, so adding a layer is an
 * entry in a list rather than a rewrite of what is already there.
 *
 * Contributions are still resolved through `data-sources.js` under a
 * per-layer name (`routeExtension` / `routeExtensionEe` / …) rather than read
 * off the module's exports, so the seam keeps the DI contract the rest of the
 * architecture uses and stays testable through `__dataSources`. The names are
 * written out as literals at the call sites, never assembled from a suffix —
 * a registry name you cannot grep for is the `window.fetch*` problem the
 * registry was built to end.
 *
 * ## Failure is per layer
 *
 * A layer that 404s, throws on load, or registers nothing contributes nothing
 * and the rest of the chain still applies. The alternative — one rejection
 * taking out the whole seam — is how a missing enterprise module would blank
 * the OSS nav too.
 *
 * @see ui/oss/app.js, ui/oss/navigation.js for the two layer lists.
 */

import { resolveOptional } from './data-sources.js';

/**
 * @typedef {[specifier: string, registryName: string]} ExtensionLayer
 *   A module URL resolved through the asset overlay, and the data-source name
 *   that module registers its contribution under.
 */

/**
 * Load an extension chain once and hand back the layers that contributed,
 * in the order given (base first).
 *
 * The import is for its side effect — the module registers itself — and the
 * value comes back out of the registry, which is why a module that loads but
 * registers nothing (every base no-op) is simply absent from the result rather
 * than an entry the caller has to null-check.
 *
 * @param {ExtensionLayer[]} layers  Base layer first.
 * @param {string} tag  Log prefix, e.g. 'app' or 'navigation'.
 * @returns {() => Promise<object[]>} memoised loader
 */
export function extensionChain(layers, tag) {
  let chain;
  return () => {
    chain ??= Promise.all(
      layers.map(([spec, name]) =>
        import(spec)
          .then(() => resolveOptional(name))
          .catch((err) => {
            // Warn, not error: on OSS and EE the -mt layer is a no-op stub and
            // a genuine failure here is a 404 the operator can act on, while
            // the app carries on with the layers that did load.
            console.warn(`[${tag}] ${spec} failed to load — that layer contributes nothing`, err);
            return undefined;
          }),
      ),
    ).then((all) => all.filter((ext) => ext != null));
    return chain;
  };
}
