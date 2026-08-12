/**
 * How the UI decides it is running in development.
 *
 * This exists because the heuristic was about to be duplicated in two places
 * (`core/events.js`, `utils/url-policy.js`) and the first version was wrong in
 * both directions: it treated *any* non-default port as development, so a
 * production deployment behind `:8443` would have thrown on policy violations
 * in front of customers, while a developer running the Rust binary against a
 * real hostname would have got silent `console.error`s instead of failures.
 *
 * Signals used, in order:
 *   1. `window.nasikoConfig.dev === true` — explicit, server-injected. The
 *      server already knows: `oss/server/src/main.rs` switches `Cache-Control`
 *      to `no-cache` under `cfg!(debug_assertions)`, so a debug build can set
 *      this the same way. This is the authoritative signal.
 *   2. Loopback and reserved-for-development hostnames.
 *
 * Nothing else. In particular not the port, and not the presence of a preview
 * fixture — a fixture is a file the release binary currently still ships.
 */

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** True when strict, throw-on-violation behaviour should be used. */
export function isDev() {
  if (typeof window !== 'undefined' && window.nasikoConfig?.dev === true) return true;
  if (typeof location === 'undefined') return false;
  const host = location.hostname || '';
  return DEV_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.test');
}

/**
 * Fail loudly in development, record and continue in production.
 *
 * The asymmetry is the point: a contract violation should stop the developer
 * who introduced it, and must not take down a page in front of a customer for a
 * problem that is, by then, already shipped.
 *
 * @param {string} message
 */
export function violation(message) {
  if (isDev()) throw new Error(message);
  console.error(message);
}
