/**
 * Navigation extension seam — enterprise layer, no-op default.
 *
 * Exists so `import('/nav-ext-ee.js')` resolves on every surface, including the
 * ones with no enterprise overlay at all. Where that overlay is present it
 * supplies its own `nav-ext-ee.js`, shadowing this one, and registers
 * `navExtensionEe`.
 *
 * Deliberately NOT named `nav-ext.js`: see common/core/extension-chain.js.
 */
