# `ui/` — Nasiko control-plane frontend

Vanilla JavaScript Web Components. **No build step, no bundler, no framework
runtime to install.** The files in this directory are the files the browser
loads; the server embeds them into the binary at compile time with
[`rust-embed`](https://crates.io/crates/rust-embed), so a release build is a
single executable with the UI inside it.

There is nothing to `npm install` in order to run Nasiko. The `package.json`
here exists only for optional type-checking (see [Type checking](#type-checking)).

---

## Layout

```
ui/
├── common/            shared by every edition — the bulk of the UI
│   ├── core/          element base class, DI container, router, bootstrap,
│   │                  data-source registry, events, error boundary
│   ├── services/      API client, query/list helpers, SSE, per-area services
│   ├── state/         signals + store
│   ├── design-system/ primitives — app-button, app-table, app-modal, … ;
│   │                  catalog.json is the generated inventory
│   ├── features/      reusable, domain-aware components (header, nav, graph)
│   ├── pages/         page components, one per screen
│   ├── surface/       the Weave DSL runtime (lexer → parser → materializer →
│   │                  store → render)
│   ├── tokens/        design tokens as CSS custom properties + tokens.json
│   ├── styles/        shared stylesheets
│   ├── utils/         escaping, markdown, dates, icons, streams, theme
│   └── vendor/        single-file ESM builds (lit, marked, dompurify,
│                      highlight.js, chart.js) — see vendor/README.md
├── oss/               this edition's application layer: one .html per URL,
│                      plus per-page preview modules and edition.json
├── scripts/           generators, ui-lint, check-imports
├── tests/             Node test-runner suites (no DOM required)
├── types/             generated globals.d.ts
└── tsconfig.json      type-check scope
```

`ui/` is one tree shared by every Nasiko edition. Each edition declares itself
in `ui/<edition>/edition.json`; the tooling reads whatever manifests are present
rather than hardcoding a list, so a checkout with one edition and a checkout
with several both work unchanged. `ui/scripts/editions.mjs` documents the
manifest contract.

## How it is served

The server crate's `build.rs` walks up from its own directory to find the
`ui/` root and exports it as `NASIKO_UI`. The server then embeds two trees:

| Embed | Served at |
| --- | --- |
| `$NASIKO_UI/oss/` | `/` — page shells, one real URL per screen |
| `$NASIKO_UI/common/` | `/common/…` |

An extension-less path that matches no embedded file falls back to
`index.html`; a path with an extension is a genuine 404, so a stale asset URL
never returns HTML. Because the root is resolved at build time rather than written as a relative
path, the crate can sit at any depth without breaking the embed.

## The layer model

```
APPLICATION      oss/*.html — one page shell per screen, real URLs
      ↓
DOMAIN           page components + their state and services
      ↓
COMPONENTS       reusable, domain-aware, app-agnostic
      ↓
DESIGN SYSTEM    primitives + tokens + type + icons + a11y
      ↓
PLATFORM         core/ · services/ · state/ — DI, errors, api, query,
                 signals, events
```

**Dependencies point downward, never upward.** A design-system primitive must
not know about a page; a shared component must not know where its data comes
from. This is enforced by `ui-lint.mjs`, not by convention.

Composition happens in exactly one place: `common/core/bootstrap.js`. It is the
only file that binds an interface to an implementation.

### Conventions that follow from it

- **Light DOM + `@scope`**, not Shadow DOM. `attachShadow` is a lint error.
  Styles are scoped with CSS `@scope`; every component declares its scope.
- **Data comes from the registry**, never from globals. Components resolve
  loaders through `core/data-sources.js`; assigning `window.fetchX = …` is a
  lint error. An unknown name throws where it is resolved, instead of leaving a
  view empty forever.
- **Teardown is declared, not remembered.** Use `this.listen()`,
  `this.interval()` and `this.signal` from the element base class in
  `connected()`; they are torn down automatically on disconnect.
- **Escaping is by construction.** Use Lit `html` templates, or `escHtml` /
  `escAttr` from `utils/escape.js` — never a locally-defined helper.
- **Colours are tokens.** Literal colour values in the design system are a lint
  error; add or use a token in `common/tokens/`.
- **Import specifiers are what the browser resolves.** There is no bundler and
  no import map, so every specifier is either relative or rooted at `/common/`,
  and every one carries its explicit `.js` extension. `check-imports.mjs` fails
  the build on any that does not resolve to a real file.
- **`design-system/catalog.json` is a contract, not a listing.** It is
  generated from the components and is what anything outside the UI reads to
  learn which components exist and what they accept. Regenerate it whenever a
  component's public surface changes.

## Working on it

Everything runs on Node's built-in tooling — no npm install needed.

```sh
# every relative and /common/… specifier resolves to a file that exists
node ui/scripts/check-imports.mjs

# generated artifacts are in sync with their sources
node ui/scripts/gen-globals.mjs     --check
node ui/scripts/gen-tokens.mjs      --check
node ui/scripts/gen-boot-inline.mjs --check
node ui/scripts/gen-catalog.mjs     --check
node ui/scripts/gen-dsl-catalog.mjs --check

# architecture rules
node ui/scripts/ui-lint.mjs

# hermetic tests — platform layer, streaming, and the surface runtime
node --test ui/tests/*.test.mjs
```

Drop `--check` from any generator to regenerate its output. Never hand-edit a
generated file. `types/globals.d.ts`, `common/tokens/tokens.json`,
`design-system/catalog.json`, `surface/dsl-catalog.json` and the inline boot
snippet in every page `<head>` all have one.

### `ui-lint.mjs` and the ratchet

`ui-lint.mjs` enforces the layer rules above. Rules that are already at zero
fail the build on any new violation. Rules with pre-existing debt are recorded
in `scripts/ui-lint-baseline.json` with an exact count:

> **The baseline may go down. It may never go up.**

A change that adds a violation fails CI even if the rule is not yet at zero.
Fix violations as you touch the files; when a rule reaches zero it stays there.
Regenerate the baseline (only ever downward) with:

```sh
node ui/scripts/ui-lint.mjs --update-baseline
```

### Type checking

The UI is plain JavaScript with JSDoc types; `tsc --checkJs` checks it and
emits nothing.

```sh
cd ui && npm install && npx tsc -p tsconfig.json
```

`tsconfig.json`'s `include` is deliberately narrow — the platform layer and a
couple of utilities. Widen it one directory at a time, and only to a clean
zero. A config that reports thousands of errors gets switched off, which
protects nothing.

### Adding a page

1. Add `ui/oss/<page>.html` — the shell: module order and first-paint skeleton.
2. Add `ui/common/pages/<page>-page.js` (+ `.css`) — the page component.
3. Register its data loaders in `core/data-sources.js`; wire it up in
   `core/bootstrap.js`.
   Then run `node ui/scripts/gen-boot-inline.mjs` so the new page gets the
   shared inline boot snippet.
4. Run the commands above. `check-imports` and `ui-lint` will tell you if the
   dependency direction is wrong.

### Adding a design-system component

1. Create `ui/common/design-system/<name>/` with the component and its styles.
2. Use tokens for every colour, space and radius.
3. Regenerate the catalog: `node ui/scripts/gen-catalog.mjs`.
4. Add a preview so it appears on `/design-system.html`.

## Vendored dependencies

`common/vendor/` holds single-file ESM builds committed directly, because the
UI has no package manager at runtime. Do not edit them — replace them wholesale
on upgrade and update the version table in `common/vendor/README.md`.

## Browser support

Modern evergreen browsers. The UI relies on native ES modules, custom elements,
`AbortController`, CSS custom properties, `@scope` and CSS nesting. There is no
transpilation and no polyfill layer.
