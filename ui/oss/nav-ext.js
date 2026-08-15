/**
 * Navigation extension point — OSS default: no-op.
 *
 * This file exists so `import('/nav-ext.js')` in navigation.js resolves without
 * a 404 on OSS (where EeAssets doesn't overlay it). It registers nothing —
 * navigation.js falls back to the base nav when `resolveOptional('navExtension')`
 * returns undefined.
 *
 * To extend navigation in a distribution, see `ee/ui/web/nav-ext.js` for the
 * pattern: register a `navExtension` object via data-sources with any of:
 *
 *   context()                  → resolved once per page, passed to the hooks below
 *   items(base, ctx)           → return the rail + topbar item array
 *   moduleNav(module, base, ctx) → return that module's tree, or null
 */
