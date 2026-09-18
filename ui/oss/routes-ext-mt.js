/**
 * Route extension seam — multi-tenant layer, no-op default.
 *
 * The slot the multi-tenant overlay fills. Its own `routes-ext-mt.js` shadows
 * this one and ADDS to the enterprise routes rather than replacing them —
 * which is exactly what would have happened had it been obliged to call the
 * file `routes-ext.js`.
 *
 * See common/core/extension-chain.js; the layer list is in app.js.
 */
