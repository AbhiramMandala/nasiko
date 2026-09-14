/**
 * The boot sequence every SPA entry point runs.
 *
 * There are four — `ui/oss/app.js`, `ui/ee/registry/app.js`,
 * `ui/ee/portal/web/app.js`, `ui/ee/tenant/web/app.js` — and before this they
 * each hand-rolled the same eight steps in the same order. Three of the four
 * were near-identical, differing only in their route table and which prefixes
 * they excluded.
 *
 * That is not just repetition. It is four places to remember when the sequence
 * gains a step, and the next step it gains is already known: NAS-211 needs one
 * subscriber registered on the error boundary at boot, and with four entry
 * points that is four registrations, three of which someone will forget. The
 * seam is marked below.
 *
 * ## Layer
 *
 * This sits at PLATFORM (`ui/common/core/`), so it must not import a feature —
 * `layer-direction` is an `enforce: 'zero'` rule and would fail CI. That is why
 * the splash screen and the Weave dock are not in here despite being part of
 * every boot: they live at COMPONENT, above this file. They arrive through
 * `onReady` instead, which is the right shape anyway. A platform-level boot
 * routine has no business knowing a splash screen exists.
 */

import { router } from './router.js';
import { initErrorBoundary, reportError } from './error-boundary.js';
import { initRouteIntegration } from './route-persistence.js';

/**
 * @typedef {object} CreateAppOptions
 * @property {Array<{path: string, tag: string, module: string, title?: string, noShell?: boolean}>} routes
 *   The base route table, in the shape `router.addAll` takes. Required.
 * @property {() => Promise<{routes: () => Array<object>} | null | undefined>} [extensionRoutes]
 *   Optional second table, resolved at boot and appended. This is the
 *   `/routes-ext.js` seam: on OSS it is a no-op, on EE the asset overlay serves
 *   a module that registers the enterprise pages. A rejection here must not
 *   stop the app — the base routes still work — so the caller is expected to
 *   catch and return null, and this treats a null as "no extension".
 * @property {string[]} [exclude]
 *   Exact paths the router must not intercept (`/login` is a full page load —
 *   it has no app-header and it does OAuth redirects).
 * @property {string[]} [excludePrefix]
 *   Prefixes the router must not intercept: APIs, auth callbacks, static assets.
 * @property {string} [outletId]  id of the element the router renders into.
 * @property {() => void | Promise<void>} [onReady]
 *   Runs once the router is live and route persistence is wired. This is where
 *   an entry point dismisses its splash screen and mounts anything that lives
 *   outside the outlet.
 */

/**
 * Boot an SPA. Resolves once the app is live, or once it has failed in a way
 * the page can do nothing about.
 *
 * @param {CreateAppOptions} options
 * @returns {Promise<boolean>} whether the app started
 */
export async function createApp({
  routes,
  extensionRoutes,
  exclude = [],
  excludePrefix = [],
  outletId = 'outlet',
  onReady,
}) {
  // First, so everything below is covered. `initErrorBoundary` is idempotent.
  initErrorBoundary();

  // ── NAS-211 seam ──────────────────────────────────────────────────────
  // The error boundary has had a subscription API (`onError`) since it was
  // written and has never had a subscriber, so every classified error ends at
  // console.error and nothing leaves the browser. When a sink is chosen, it is
  // registered HERE — once, for all four entry points — and not in each app.js.
  // ──────────────────────────────────────────────────────────────────────

  router.addAll(routes);

  if (extensionRoutes) {
    const ext = await extensionRoutes();
    if (ext?.routes) router.addAll(ext.routes());
  }

  if (exclude.length) router.exclude(...exclude);
  if (excludePrefix.length) router.excludePrefix(...excludePrefix);

  const outlet = document.getElementById(outletId);
  if (!outlet) {
    // All four copies logged this and returned. It now goes through the
    // boundary instead, which still console.errors it — a missing outlet is a
    // blank page, and a blank page with no signal anywhere is exactly the
    // failure NAS-211 exists to stop. The message text is unchanged so anything
    // grepping for it still finds it.
    //
    // Deliberately NOT `{ silent: true }`: despite the flag being documented as
    // "don't show UI (just track)", `reportError` skips `_notify` entirely when
    // it is set — and `_notify` is the only thing that reaches subscribers. A
    // silent report is therefore not tracked at all. Noted on NAS-211; until it
    // is resolved, `silent` means "discard".
    reportError(new Error(`[app] #${outletId} element not found`));
    return false;
  }
  router.start(outlet);

  // Scroll positions and deep-link context, restored across reloads.
  initRouteIntegration();

  await onReady?.();
  return true;
}
