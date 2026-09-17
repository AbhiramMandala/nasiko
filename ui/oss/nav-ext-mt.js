/**
 * Navigation extension seam — multi-tenant layer, no-op default.
 *
 * Open slot. The multi-tenant dashboard reuses the enterprise nav as-is today;
 * when it needs an entry of its own, `ui/ee/multi-tenant/web/nav-ext-mt.js`
 * receives the enterprise items as `base` and returns them plus its own,
 * instead of shadowing the enterprise layer out of existence.
 *
 * See common/core/extension-chain.js; the layer list is in navigation.js.
 */
