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
 *   router.add('/',          { tag: 'orchestrator-page', module: '/common/pages/orchestrator-page.js' });
 *   router.add('/agents',    { tag: 'agents-page',       module: '/common/pages/agents-page.js' });
 *   router.add('/chat',      { tag: 'chat-page',         module: '/common/pages/chat-page.js', title: 'Chat' });
 *
 *   router.start(document.getElementById('outlet'));
 *
 * @module router
 */

// ── View-transition contract with core/motion.js ────────────────────────

/**
 * `view-transition-name` the router gives the outgoing and incoming page for
 * the length of a swap. Paired with the `::view-transition-*(page-content)`
 * rules in core/motion.js.
 *
 * It is applied imperatively rather than declared in CSS on purpose: a
 * non-`none` `view-transition-name` makes the element a stacking context *and*
 * a containing block for fixed-position descendants, and pages host
 * fixed-position UI (`app-tooltip`, `app-combobox`) that would then be
 * positioned against the page instead of the viewport. Scoped to the
 * transition, that side effect never outlives the animation.
 */
const VT_PAGE_NAME = 'page-content';

/**
 * Marks a router-driven (same-document) transition on the document element so
 * motion.js can style it apart from the cross-document one that
 * `@view-transition { navigation: auto }` runs. Without the discriminator an
 * in-app navigation animated the `root` snapshot — the whole viewport,
 * including the opaque content card — instead of the page inside it.
 */
const VT_SWAP_CLASS = 'vt-page-swap';

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

// Exported alongside the singleton so the allowlist can be tested against a
// real route table rather than a stub of one. `has()` is a security boundary;
// testing it against a hand-written fake would test the fake.
export class Router {
  /** @type {Array<{pattern: string, tag: string, module: string, title?: string, noShell?: boolean}>} */
  #routes = [];
  /** @type {HTMLElement|null} */
  #outlet = null;
  /** @type {HTMLElement|null} */
  #currentPage = null;
  /** @type {string|null} */
  #currentPattern = null;
  /** Path this router was on before the navigation being handled, so
   *  route-persistence can save the scroll position of the page being left. */
  #previousPath = null;
  /** @type {boolean} */
  #started = false;
  /** @type {Set<string>} Paths that should NOT be intercepted (login, OAuth, etc.) */
  #excludePaths = new Set();
  /** @type {Set<string>} Path prefixes that should NOT be intercepted (API routes, assets) */
  #excludePrefixes = new Set();
  /** @type {((path: string) => boolean)|null} */
  #authGuard = null;
  /**
   * The in-flight view transition, or null. A second navigation started while
   * one is running makes the browser skip the first; without this guard the
   * skipped transition's cleanup would strip `.vt-page-swap` and the page name
   * out from under its successor, and the successor would animate the whole
   * viewport again.
   * @type {ViewTransition|null}
   */
  #activeTransition = null;

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
   * Is this a path the app can actually navigate to?
   *
   * The allowlist for model-authored navigation. A generated surface may name
   * a route in an `href` or an `@OpenUrl`, and without this the router would
   * happily resolve whatever string arrived — an absolute URL off-site, or a
   * path into a tenant the user cannot see. There is no guessing here: the
   * answer comes from the routes this router was actually given, so it cannot
   * drift from what the app can do.
   *
   * Rejects anything that is not a same-origin absolute path — a scheme, a
   * protocol-relative `//host`, or a traversal — before pattern matching, so
   * `javascript:` and `https://elsewhere` never reach the route table.
   *
   * @param {string} path
   * @returns {boolean}
   */
  has(path) {
    if (typeof path !== 'string' || !path) return false;
    if (!path.startsWith('/') || path.startsWith('//')) return false;
    if (/[\u0000-\u001f]/.test(path)) return false;
    let normalized;
    try {
      normalized = normalizePath(path);
    } catch {
      return false;
    }
    if (normalized.includes('..')) return false;
    return this.#routes.some((r) => matchRoute(r.pattern, normalized) !== null);
  }

  /** Every registered pattern. For diagnostics that want to say what *is* allowed. */
  patterns() {
    return this.#routes.map((r) => r.pattern);
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

    // No route for this path, so there is nothing here that can render it.
    // Usually that means this document never registered a route table at all:
    // every page also ships as a standalone `.html`, which loads its own page
    // component but not `app.js`, and `addAll()` lives in `app.js`. It can also
    // mean the target genuinely belongs to the server.
    //
    // Either way, hand it to the browser. Pushing state first and then finding
    // nothing to render left the address bar on the new URL with the old page
    // still on screen — on chat.html that looked like a session row that
    // refused to open, and the URL even lost its `.html`, so a refresh then
    // loaded the SPA and showed the right session. `#onClick` has always fallen
    // through to the browser on an unmatched path; this makes the programmatic
    // path agree with it.
    if (!this.#findMatch(normalizePath(parsed.pathname))) {
      if (options.replace) location.replace(fullPath);
      else location.assign(fullPath);
      return;
    }

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
    // Back/forward, as opposed to a deliberate click. route-persistence only
    // restores a remembered scroll position for this kind of navigation —
    // landing mid-page after clicking a rail item would read as a bug.
    this.#handleRoute(true, { popState: true });
  };

  #findMatch(normalizedPath) {
    for (const route of this.#routes) {
      const params = matchRoute(route.pattern, normalizedPath);
      if (params) return { route, params };
    }
    return null;
  }

  async #handleRoute(animate, { popState = false } = {}) {
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

    // Emit route-change so shell components can update active states.
    //
    // `previousPath` is what route-persistence.js has always read (:177) to know
    // whose scroll position to save, and it was never sent — so saving never ran
    // and restoring was a silent no-op. It went unnoticed because the document
    // was the scroller and the browser restored that by itself. Now that the
    // card is the scroller the browser cannot, so the field has to be real.
    const previousPath = this.#previousPath;
    this.#previousPath = location.pathname;
    document.dispatchEvent(new CustomEvent('route-change', {
      bubbles: true,
      detail: { path: location.pathname, previousPath, pattern: route.pattern, params, popState },
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
      // Name the page on both sides of the swap so the capture is scoped to it
      // rather than falling back to the full-viewport `root` snapshot. The
      // outgoing page has to be named before `startViewTransition` (the old
      // state is captured on the way in); the incoming one inside the callback,
      // which is where it first exists.
      const rootEl = document.documentElement;
      rootEl.classList.add(VT_SWAP_CLASS);
      if (this.#currentPage) this.#currentPage.style.viewTransitionName = VT_PAGE_NAME;

      const transition = document.startViewTransition(() => {
        swap();
        this.#currentPage.style.viewTransitionName = VT_PAGE_NAME;
      });
      this.#activeTransition = transition;

      // A transition that gets superseded — the user clicks a second link
      // before the first animation lands — rejects `ready` with "Transition
      // was skipped". That is ordinary, not a fault, but nothing was attached
      // to it, so the rejection went unhandled and surfaced as a page error.
      // Every browser test treats a page error as a failure, which is how
      // module-nav.test.mjs found this. The real handling is on `finished`
      // below; these two only say "yes, we know".
      transition.ready.catch(() => {});
      transition.updateCallbackDone.catch(() => {});

      // `finished` rejects when the update callback throws — the loading bar
      // used to hang forever in that case, since only the fulfilled path
      // cleared it.
      const cleanup = () => {
        if (this.#activeTransition !== transition) return;
        this.#activeTransition = null;
        rootEl.classList.remove(VT_SWAP_CLASS);
        if (this.#currentPage) this.#currentPage.style.viewTransitionName = '';
        document.dispatchEvent(new CustomEvent('loading-end', { bubbles: true }));
      };
      transition.finished.then(cleanup, cleanup);
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
