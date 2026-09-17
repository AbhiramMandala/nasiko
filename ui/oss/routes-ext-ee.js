/**
 * Route extension seam — enterprise layer, no-op default.
 *
 * Exists so `import('/routes-ext-ee.js')` resolves on every surface, including
 * the ones with no enterprise overlay at all. `ui/ee/web/routes-ext-ee.js`
 * shadows this file on EE and on the multi-tenant dashboard (both embed
 * `ee/web`) and registers `routeExtensionEe` with the enterprise pages.
 *
 * Deliberately NOT named `routes-ext.js`: a layer that shares a name with the
 * layer below it shadows it instead of extending it, which is the defect this
 * chain exists to make unrepresentable. See common/core/extension-chain.js.
 */
