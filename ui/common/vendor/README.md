# Vendored libraries

Single-file ESM builds, committed directly because the UI has no build step or
package manager (see "UI is vanilla JS" in CLAUDE.md). Do not edit these files;
replace them wholesale when upgrading.

| File               | Package        | Version | Source                                                            |
| ------------------ | -------------- | ------- | ----------------------------------------------------------------- |
| `marked.esm.js`    | `marked`       | 15.0.12 | `https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.esm.js`   |
| `dompurify.esm.js` | `dompurify`    | 3.2.6   | `https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.es.mjs` |
| `highlight.esm.js` | `highlight.js` | 11.11.1 | `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/es/common/+esm` (common-languages bundle) |
| `lit-all.esm.js`   | `lit` + `@lit/context` | 3.3.3 / 1.x | Built locally — see "Rebuilding lit-all.esm.js" below |

To upgrade: download the new version from the URL above (bump the version in
the path), strip any trailing `//# sourceMappingURL=...` line (the `.map`
files are not vendored), and update this table.

## Rebuilding `lit-all.esm.js`

Lit ships as many small modules with bare specifiers, so unlike the others it
cannot be downloaded as one file. It is bundled locally instead — a one-off
build step for a vendored artifact, not a build step for the UI:

```sh
mkdir /tmp/lit && cd /tmp/lit
npm i esbuild lit@3 @lit/context@1
cat > entry.js <<'EOF'
export { LitElement, html, svg, css, nothing, noChange, render } from 'lit';
export { unsafeHTML } from 'lit/directives/unsafe-html.js';
export { classMap } from 'lit/directives/class-map.js';
export { styleMap } from 'lit/directives/style-map.js';
export { repeat } from 'lit/directives/repeat.js';
export { when } from 'lit/directives/when.js';
export { map } from 'lit/directives/map.js';
export { join } from 'lit/directives/join.js';
export { ifDefined } from 'lit/directives/if-defined.js';
export { live } from 'lit/directives/live.js';
export { ref, createRef } from 'lit/directives/ref.js';
export { cache } from 'lit/directives/cache.js';
export { guard } from 'lit/directives/guard.js';
export { keyed } from 'lit/directives/keyed.js';
export { asyncReplace } from 'lit/directives/async-replace.js';
export { until } from 'lit/directives/until.js';
export { ContextProvider, ContextConsumer, createContext, ContextRoot } from '@lit/context';
EOF
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=none \
  --target=es2022 --outfile=lit-all.esm.js
```

Then copy over `oss/ui/common/vendor/lit-all.esm.js` and bump the table above.
Verify the result has no bare imports (`grep -E "from ['\"][^./]" lit-all.esm.js`
must be empty) — a bare specifier would 404 at runtime, since there is no import
map and no bundler.

Consumed by `/common/core/element.js` (the `NasikoElement` base class).

`lit-all.esm.d.ts` beside it is **ours**, not part of the vendored artifact: it is
what stops `tsc --checkJs` from type-checking 28KB of minified output, and it gives
us Lit types with no runtime dependency. Keep it when replacing the `.js`; add to
it when you start using another Lit export.

---

Consumed by `/common/utils/markdown.js`: `marked`, `dompurify`, `highlight.js`.
