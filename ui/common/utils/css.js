/**
 * Cross-browser stand-in for CSS module scripts.
 *
 * A CSS module script — an import carrying the `type: css` attribute — is a
 * Chrome/Edge-only feature. Safari and Firefox reject the attribute while
 * *linking* the module —
 * `TypeError: Import attribute type "css" is not valid` — which fails the whole
 * module graph, so a single such import anywhere in the tree left the entire app
 * blank on those browsers, not just unstyled.
 *
 * Same result, fetched by hand. Callers keep the shape they had:
 *
 *   const styles = await loadCss(new URL('./x.css', import.meta.url));
 *   document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];
 *
 * The top-level `await` is what preserves the old semantics: the module body
 * still cannot run until its sheet exists, and the module graph still evaluates
 * in dependency order, so cascade order across components is unchanged.
 *
 * @param {string|URL} url — absolute URL of the stylesheet, normally
 *   `new URL('./x.css', import.meta.url)`.
 * @returns {Promise<CSSStyleSheet>}
 */
const cache = new Map();

export function loadCss(url) {
  const href = String(url);
  let pending = cache.get(href);
  if (!pending) {
    pending = fetch(href).then(async (res) => {
      if (!res.ok) throw new Error(`loadCss ${href}: ${res.status}`);
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(await res.text());
      return sheet;
    });
    cache.set(href, pending);
  }
  return pending;
}
