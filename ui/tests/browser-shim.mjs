/**
 * Minimal browser globals so the Platform layer can be unit-tested in Node
 * without a headless browser.
 *
 * Deliberately minimal: this shim is for the layers that should NOT need a DOM
 * (api, container, errors, query, signal, store, events, url-policy). Anything
 * that needs real custom elements, adoptedStyleSheets or CSSStyleSheet belongs
 * in a browser-driven test instead — do not grow this file to fake those, or the
 * tests stop telling you anything about the real runtime.
 */

export function installBrowserShim({ hostname = 'localhost', port = '9090', pathname = '/' } = {}) {
  globalThis.window = globalThis;
  globalThis.location = {
    hostname,
    port,
    pathname,
    search: '',
    hash: '',
    href: `http://${hostname}${port ? ':' + port : ''}${pathname}`,
  };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  globalThis.sessionStorage = memoryStorage();
  globalThis.localStorage = memoryStorage();
  // Not a DOM — an EventTarget wearing the name. State modules broadcast their
  // changes on `document` because that is the one node every listener already
  // shares; `dispatchEvent`/`addEventListener` is the whole of what they use,
  // and Node has had both since 15. Anything reaching for `querySelector` here
  // is a component, and components are tested in a browser.
  globalThis.document = new EventTarget();
  return () => {
    delete globalThis.window.nasikoConfig;
  };
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}
