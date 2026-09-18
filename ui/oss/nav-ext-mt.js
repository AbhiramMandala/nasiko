/**
 * Navigation extension seam — multi-tenant layer, no-op default.
 *
 * The slot the multi-tenant overlay fills. Its own `nav-ext-mt.js` shadows this
 * one and receives whatever the layers below produced as `base`, returning them
 * plus its own — instead of shadowing the enterprise layer out of existence,
 * which is what a file sharing that layer's name would do.
 *
 * See common/core/extension-chain.js; the layer list is in navigation.js.
 */
