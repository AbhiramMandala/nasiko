/**
 * Route extension seam — multi-tenant layer, no-op default.
 *
 * Nothing shadows this file today: the multi-tenant dashboard
 * (`ee/tenant-server/src/mtui.rs`) has no routes of its own yet. The slot is
 * open so that the day it does, `ui/ee/multi-tenant/web/routes-ext-mt.js`
 * ADDS to the enterprise routes rather than replacing them — which is exactly
 * what would have happened had it been obliged to call the file
 * `routes-ext.js`.
 *
 * See common/core/extension-chain.js; the layer list is in app.js.
 */
