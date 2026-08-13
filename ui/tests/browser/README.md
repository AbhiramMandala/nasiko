# Browser tests for `oss/ui`

The Node tests in `oss/ui/tests/*.test.mjs` cover the platform layer against a
fake `window`. They structurally cannot cover the things that make this UI work:
`customElements`, `document.adoptedStyleSheets`, CSS `@scope`, CSS module
scripts, and the real module graph. These do.

Two suites:

| File | What it proves |
| --- | --- |
| `pages.test.mjs` | Every page in `oss/ui/web` and `ee/ui/web` loads with **no uncaught exception, no 404'd module, and every custom element upgraded**. All `/api/**` calls are stubbed — the target is JS runtime failures, not data. |
| `element.test.mjs` | `NasikoElement` end to end: DI resolution, light DOM (no shadow root), `@scope`-wrapped adopted styles, Lit's escaping, the `firstConnected` / `connected` split, re-subscription after a move, and full teardown. |
| `nav.test.mjs` | The `/nav-ext.js` extension seam, under three overlays — OSS-only, EE-as-admin, EE-as-member. Asserts nav *content*, not just that pages load: no EE items leak into OSS, every EE org item and role gate survives, and `fetchTraceDetail` returns the trace object in both editions. This is the test that makes removing the `navigation.js` fork safe to review. |

`serve.mjs` is a ~60-line static server that mirrors the real overlay resolution
(`ee/ui/web` → `oss/ui/web` → `/common/` → `oss/ui/common`), so a page resolves
exactly as it does from the Rust binary. The layer list is a parameter, which is
how `nav.test.mjs` can test an OSS-only console and an EE console in one run. It is also usable on its own as a
zero-backend dev server:

```sh
node oss/ui/tests/browser/serve.mjs . 7788   # then open http://localhost:7788/agents.html
```

## Running

```sh
just test-ui-browser
```

Playwright is a **dev dependency only**. The UI runtime has no build step, no
bundler and no `node_modules` — that property is deliberate and unaffected by
test tooling. Nothing in this directory is embedded in the server binary.

If Chromium is already present (CI images, this repo's sandbox), point Playwright
at it rather than downloading:

```sh
PW_CHROMIUM=/path/to/chrome just test-ui-browser
```

## Why these exist

Phase 1–2 of the Web Components work shipped ~3,000 lines with only Node-level
verification. The first browser run found two things no Node test could:

1. A regression where `smart-table` showed a visible error on `runtime.html`,
   which assigns `dataFn` programmatically *after* the first `refresh()`.
2. A design flaw in `NasikoElement`: `firstConnected()` ran once but teardown ran
   on every disconnect, so a re-parented element lost every listener, timer and
   reactive binding permanently. That is why `connected()` exists.
