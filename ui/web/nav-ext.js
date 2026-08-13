/**
 * Navigation extension point — OSS default: no extension.
 *
 * `navigation.js` imports `/nav-ext.js` on every page. This file exists so that
 * import always resolves in OSS: a downstream distribution (see
 * `ee/ui/web/nav-ext.js`) places its own copy in a higher-priority asset layer
 * and it wins, exactly like `login.html` does. Without this file the OSS console
 * would take a 404 on every page load.
 *
 * To extend navigation in a distribution, export `navExtension` with any of:
 *
 *   context()                  → resolved once per page, passed to the hooks below
 *   items(base, ctx)           → return the rail + topbar item array
 *   moduleNav(module, base, ctx) → return that module's tree, or null
 *
 * Hooks may be async. A hook that throws is logged and the base nav is used, so a
 * broken extension degrades the nav rather than blanking the shell.
 */

export const navExtension = {};
