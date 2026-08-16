/**
 * Minimal SPA router for vanilla Web Components.
 *
 * History API based, zero dependencies. Intercepts internal `<a>` clicks,
 * lazy-loads page components via dynamic `import()`, and wraps page swaps
 * in the View Transitions API for smooth cross-fade animations.
 *
 * Usage:
 *   import { router } from '/common/core/router.js';
 *
 *   router.add('/',          { tag: 'orchestrator-page', module: '/common/components/orchestrator-page.js' });
 *   router.add('/agents',    { tag: 'agents-page',       module: '/common/components/agents-page.js' });
 *   router.add('/chat',      { tag: 'chat-page',         module: '/common/components/chat-page.js', title: 'Chat' });
 *
 *   router.start(document.getElementById('outlet'));
 *
 * @module router
 */

// ── Route matching ──────────────────────────────────────────────────────

/**
 * Normalize a path for comparison: strip trailing slash, strip .html,
 * treat /index as /.
 */
function normalizePath(p) {
  let n = p.split('?')[0].split('#')[0];
  n = n.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  if (n !== '/' && n.endsWith('/')) n = n.slice(0, -1);
  return n || '/';
}

/**
 * Test whether a route pattern matches a normalized path.
 * Supports :param segments (captured into params object).
 */
function matchRoute(pattern, path) {
  const patParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ── Router singleton ────────────────────────────────────────────────────

class Router {
  /** @type {Array<{pattern: string, tag: string, module: string, title?: string, noShell?: boolean}>} */
  #routes = [];
  /** @type {HTMLElement|null} */
  #outlet = null;
  /** @type {HTMLElement|null} */
  #currentPage = null;
  /** @type {string|null} */
  #currentPattern = null;
  /** @type {boolean} */
  #started = false;
  /** @type {Set<string>} Paths that should NOT be intercepted (login, OAuth, etc.) */
  #excludePaths = new Set();
  /** @type {Set<string>} Path prefixes that should NOT be intercepted (API routes, assets) */
  #excludePrefixes = new Set();
  /** @type {((path: string) => boolean)|null} */
  #authGuard = null;

  /**
   * Register a route.
   * @param {string} pattern — URL path pattern, e.g. '/' or '/agents' or '/agent/:id'
   * @param {{tag: string, module: string, title?: string, noShell?: boolean}} def
   */
  add(pattern, def) {
    this.#routes.push({ pattern: normalizePath(pattern), ...def });
    return this;
  }

  /**
   * Register multiple routes at once.
   * @param {Array<{path: string, tag: string, module: string, title?: string, noShell?: boolean}>} routes
   */
  addAll(routes) {
    for (const r of routes) this.add(r.path, r);
    return this;
  }

  /**
   * Paths that bypass the router entirely (full page load).
   * @param {string[]} paths — exact paths like '/login'
   */
  exclude(...paths) {
    for (const p of paths) this.#excludePaths.add(normalizePath(p));
    return this;
  }

  /**
   * Prefixes that bypass the router (API routes, static assets).
   * @param {string[]} prefixes — e.g. '/api/', '/v1/', '/common/'
   */
  excludePrefix(...prefixes) {
    for (const p of prefixes) this.#excludePrefixes.add(p);
    return this;
  }

  /**
   * Set an auth guard. Called before every navigation; return false to
   * abort (the guard should redirect to login itself).
   * @param {(path: string) => boolean} fn
   */
  guard(fn) {
    this.#authGuard = fn;
    return this;
  }

  /**
   * Start the router. Attaches event listeners and navigates to the
   * current URL.
   * @param {HTMLElement} outlet — the container element for page components
   */
  start(outlet) {
    if (this.#started) return;
    this.#started = true;
    this.#outlet = outlet;

    // Intercept link clicks
    document.addEventListener('click', this.#onClick);
    // Handle back/forward
    window.addEventListener('popstate', this.#onPopState);
    // Initial route
    this.#handleRoute(false);
  }

  /**
   * Navigate programmatically.
   * @param {string} url — absolute path or full URL
   * @param {{replace?: boolean, skipTransition?: boolean}} options
   */
  navigate(url, options = {}) {
    const parsed = new URL(url, location.origin);
    const fullPath = parsed.pathname + parsed.search + parsed.hash;

    // Same page — no-op
    if (fullPath === location.pathname + location.search + location.hash) return;

    if (options.replace) {
      history.replaceState(null, '', fullPath);
    } else {
      history.pushState(null, '', fullPath);
    }
    this.#handleRoute(!options.skipTransition);
  }

  /**
   * Replace current URL without navigation (e.g. for tab syncing).
   */
  replace(url) {
    history.replaceState(null, '', url);
  }

  /** The currently matched route's pattern, or null. */
  get currentPattern() { return this.#currentPattern; }

  /** The current page element in the outlet. */
  get currentPage() { return this.#currentPage; }

  // ── Internal ────────────────────────────────────────────────────────

  #onClick = (e) => {
    // Only intercept plain left-clicks
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const anchor = e.target.closest('a[href]');
    if (!anchor) return;

    // External links or explicit new-tab
    if (anchor.target === '_blank') return;
    if (anchor.origin !== location.origin) return;
    // Download links
    if (anchor.hasAttribute('download')) return;

    const path = anchor.pathname;

    // Excluded exact paths (login, OAuth callbacks)
    if (this.#excludePaths.has(normalizePath(path))) return;

    // Excluded prefixes (API, assets)
    for (const prefix of this.#excludePrefixes) {
      if (path.startsWith(prefix)) return;
    }

    // Check if we have a matching route
    const norm = normalizePath(path);
    const match = this.#findMatch(norm);
    if (!match) return; // Let the browser handle unknown routes

    e.preventDefault();

    const fullPath = path + anchor.search + anchor.hash;
    if (fullPath === location.pathname + location.search + location.hash) return;

    history.pushState(null, '', fullPath);
    this.#handleRoute(true);
  };

  #onPopState = () => {
    this.#handleRoute(true);
  };

  #findMatch(normalizedPath) {
    for (const route of this.#routes) {
      const params = matchRoute(route.pattern, normalizedPath);
      if (params) return { route, params };
    }
    return null;
  }

  async #handleRoute(animate) {
    const path = normalizePath(location.pathname);
    const match = this.#findMatch(path);

    if (!match) {
      // No matching route — could be a 404 or a path the server handles
      return;
    }

    const { route, params } = match;

    // Auth guard
    if (this.#authGuard && !this.#authGuard(path)) return;

    // Emit loading-start for the loading bar
    document.dispatchEvent(new CustomEvent('loading-start', { bubbles: true }));

    // Emit route-change so shell components can update active states
    document.dispatchEvent(new CustomEvent('route-change', {
      bubbles: true,
      detail: { path: location.pathname, pattern: route.pattern, params },
    }));

    // Update document title
    if (route.title) {
      document.title = route.title;
    }

    // If the same route pattern is already active (e.g. same page, different
    // query params), let the page handle the update itself rather than
    // tearing it down and rebuilding it.
    if (this.#currentPattern === route.pattern && this.#currentPage) {
      // Notify the page that the URL changed (query params, etc.)
      this.#currentPage.dispatchEvent(new CustomEvent('route-update', {
        detail: { path: location.pathname, search: location.search, params },
      }));
      document.dispatchEvent(new CustomEvent('loading-end', { bubbles: true }));
      return;
    }

    // Load the page component module
    try {
      await import(route.module);
    } catch (err) {
      console.error(`[router] failed to load module ${route.module}:`, err);
      document.dispatchEvent(new CustomEvent('loading-end', { bubbles: true }));
      return;
    }

    // Swap pages
    const swap = () => {
      if (this.#currentPage) {
        this.#currentPage.remove(); // triggers disconnectedCallback
      }
      const page = document.createElement(route.tag);
      this.#outlet.appendChild(page);
      this.#currentPage = page;
      this.#currentPattern = route.pattern;

      // Hide/show shell for shell-less pages (login)
      const header = /** @type {HTMLElement|null} */ (document.querySelector('app-header'));
      if (header) {
        header.style.display = route.noShell ? 'none' : '';
      }
    };

    if (animate && document.startViewTransition) {
      const transition = document.startViewTransition(swap);
      transition.finished.then(() => {
        document.dispatchEvent(new CustomEvent('loading-end', { bubbles: true }));
      });
    } else {
      swap();
      document.dispatchEvent(new CustomEvent('loading-end', { bubbles: true }));
    }

    // Rewrite .html URLs to clean URLs (backward compat)
    if (location.pathname.endsWith('.html')) {
      const clean = location.pathname
        .replace(/\/index\.html$/, '/')
        .replace(/\.html$/, '');
      history.replaceState(null, '', clean + location.search + location.hash);
    }
  }
}

/** Singleton router instance. */
export const router = new Router();

/**
 * Convenience: navigate from anywhere without importing the router.
 * Used by shell components that can't circular-import the app entry point.
 */
export function navigate(url, options) {
  router.navigate(url, options);
}
