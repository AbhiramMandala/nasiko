/**
 * Route extension seam — base layer, no-op.
 *
 * First link in the `/routes-ext*.js` chain (see
 * `common/core/extension-chain.js` for why it is a chain and not a slot, and
 * `app.js` for the layer list). This file is the one every binary serves; the
 * layers above it are `routes-ext-ee.js` and `routes-ext-mt.js`, each with its
 * own no-op here so nothing 404s on a surface that has no such overlay.
 *
 * It registers nothing, so the chain skips it. A distribution that wants to add
 * routes does NOT edit this file — it supplies its own suffixed file in its own
 * overlay; the enterprise overlay's `routes-ext-ee.js` is the worked example.
 *
 * Same pattern as nav-ext.js.
 */
