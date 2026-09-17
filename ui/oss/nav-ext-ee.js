/**
 * Navigation extension seam — enterprise layer, no-op default.
 *
 * Exists so `import('/nav-ext-ee.js')` resolves on every surface, including the
 * ones with no enterprise overlay. `ui/ee/web/nav-ext-ee.js` shadows this file
 * on EE and on the multi-tenant dashboard and registers `navExtensionEe`.
 *
 * Deliberately NOT named `nav-ext.js`: see common/core/extension-chain.js.
 */
