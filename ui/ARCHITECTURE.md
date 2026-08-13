# `oss/ui` — Architecture

`AGENTS.md` is the binding *coding standard* (how to write a component). This
file is the *architecture*: the layers, which way dependencies are allowed to
point, and what lives where. Read this once; read `AGENTS.md` every time you add
a file.

## The layer model

```
┌──────────────────────────────────────────────────────────────┐
│ APPLICATION   web/*.html — one real URL each, no client router │
│               page shell, module order, first-paint skeleton   │
└───────────────────────────────┬──────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────┐
│ DOMAIN        one folder per business area                    │
│               agents · orchestration · observability · mcp ·  │
│               tokenops · org(EE) · settings                   │
│               page components + domain state + domain service │
└───────────────────────────────┬──────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────┐
│ COMPONENTS    reusable, domain-aware but app-agnostic         │
│               smart-table · app-header · user-picker · …      │
└───────────────────────────────┬──────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────┐
│ DESIGN SYSTEM primitives + tokens + type + icons + a11y       │
│               app-button · app-badge · app-modal · app-card    │
│               global.css · styles/* · not-defined · page-layout│
└───────────────────────────────┬──────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────┐
│ PLATFORM      core/ · services/ · state/                      │
│               DI · errors · api · query · signals · events    │
└──────────────────────────────────────────────────────────────┘
```

**The one rule that matters: dependencies point downward, never upward.**

```
✅  agents domain  →  smart-table  →  app-button  →  tokens  →  platform
❌  app-button     →  agents service          (primitive knows a domain)
❌  design system  →  core/events.js          (bottom layer knows the bus)
❌  smart-table    →  window.fetchAgents      (shared component knows a page's data)
```

A violation is not a style problem. It is what makes a component library
un-reusable, and it is the reason `oss/ui/common/components/` currently contains
seven enterprise-only page components that ship, unreachable, inside the public
OSS binary.

## Platform layer — what you get, and what to stop doing

| Use this | Instead of | Why |
| --- | --- | --- |
| `static inject = { api: keys.api }` | `import { fetchApi } from '/common/services/api.js'` | Swappable per test/tenant/environment. Nothing could be substituted before except by a global override inside the preview tool. |
| `ApiError` + `err.code` | `throw new Error(await res.text())` | The server's machine-readable `code` was read in **zero** places; JSON bodies reached users as literal JSON in toasts. |
| `listFetcher('/agents')` | hand-built query string + offset math | The same four lines were retyped nine times for the query string alone, across ~50 functions in one file. |
| `dataSources.register('fetchAgents', fn)` | `window.fetchAgents = fn` | Missing names threw instead of rendering an empty view forever; duplicate names are an error instead of last-script-wins. |
| `this.listen()` / `this.interval()` / `this.signal` | manual `addEventListener` / `setInterval` / no AbortController | Three confirmed listener leaks and an uncancellable stream existed. Now torn down automatically — register them in `connected()`, not `firstConnected()`, so they are re-established after a move. |
| Lit `html` templates | `innerHTML` + a private `#esc()` | 38 escape helpers in 4 incompatible families, two used in attribute position where they don't escape quotes. Lit escapes by construction. |
| `publish('agent:created', …)` | each screen re-polling the server | Screens had no way to hear about each other's changes; `EVENTS` also declares which caches to invalidate, so the two can't drift. |
| `resource(key, loader)` | hand-rolled `sessionStorage` caches | Three components each rolled their own read/write/sweep. One implementation: single-flight, stale-while-revalidate, cross-tab invalidation. |
| `setSearchParams({ tab })` | `location.search = …` | Enforces the URL allowlist — a URL is copied, logged, screenshotted and sent to third parties in `Referer`; in-memory state isn't. |
| `escHtml` / `escAttr` from `utils/escape.js` | a new private `#esc` | One implementation, correct in both text and attribute position. |

Composition happens in exactly one place: `core/bootstrap.js`. It is the
frontend counterpart of `oss/server/src/main.rs` — the only file that binds an
interface to an implementation.

## Two deliberate divergences from the reference architecture

The architecture this follows recommends two things we are **not** doing. Both
are judgment calls, recorded here so they are decisions rather than oversights.

### 1. Light DOM + `@scope`, not Shadow DOM

The reference architecture recommends Shadow DOM for encapsulation. This
codebase has the opposite rule, applied without exception — 69 of 69 components,
zero `attachShadow` calls — and switching now would be a rewrite, not a fix:

- The **first-paint contract depends on light DOM.** `styles/not-defined.css`
  (746 lines) styles un-upgraded elements from a `<link>`ed sheet, and
  `styles/page-layout.css` owns every page element's outer box in one place so
  the same rule serves both the pre-upgrade and post-upgrade paint. Shadow DOM
  makes both impossible: nothing outside a shadow root can style inside it, so
  every page would need its skeleton duplicated *inside* each component, which
  is the duplication the file exists to remove.
- **`@scope` already provides the isolation** that motivates Shadow DOM. Scoping
  proximity is a cascade criterion above specificity, so a component's rules win
  locally without `!important` — which is why 13,000 lines of CSS need exactly
  two `!important` declarations.
- Light DOM keeps `Ctrl+F`, screen readers, and password managers working on real
  elements, which is one of the stated reasons for leaving Flutter in the first
  place. Shadow DOM re-introduces a milder version of that problem.

The trade-off we accept: no hard style encapsulation, so a careless global
selector can still reach into a component. The Phase 6 DOM lint checks for that.

### 2. Directory domains, not published npm packages

The reference architecture suggests `@nasiko/tokens`, `@nasiko/ui`, and
independent package versioning. That requires a package manager and a build step,
and "no build step, no bundler, no `node_modules` at runtime" is the one
advantage this stack holds over React as well as Flutter — the UI is embedded
directly in the Rust binary and served same-origin, with one artifact and one
deploy.

So the domain boundaries are enforced by directory structure and a dependency
lint rather than by package.json boundaries. If the UI is ever distributed for
customers to embed, that is the moment to revisit — and the layering here is what
makes it a packaging change rather than a rewrite.

Also deferred, correctly: **micro-frontends**. They belong above the domain
boundary and only once team count demands it. Nothing here forecloses them.

## Where things live

```
oss/ui/
├── ARCHITECTURE.md          this file
├── AGENTS.md                the binding coding standard
├── common/
│   ├── core/                PLATFORM — bootstrap, container, element, errors,
│   │                        events, data-sources, env
│   ├── services/            PLATFORM — api, query, sse
│   ├── state/               PLATFORM — signal, store
│   ├── utils/               PLATFORM — escape, url-policy, icons, toast, …
│   ├── global.css           DESIGN SYSTEM — tokens
│   ├── styles/              DESIGN SYSTEM — utility layers, not-defined, page-layout
│   ├── components/          DESIGN SYSTEM primitives + shared COMPONENTS
│   │                        (being split by domain — see below)
│   └── vendor/              single-file ESM deps, incl. lit-all.esm.js
├── tests/                   Node-runner tests for the platform layer
└── web/                     APPLICATION — one .html per URL
```

`components/` is currently flat: 69 elements, 63% of the code being page
components, with seven EE-only pages mixed in. Splitting it by domain — and
moving the EE-only pages to `ee/ui/` — is the next structural step. The target:

```
common/
├── design-system/primitives/   app-button app-badge app-modal app-card …
├── shell/                      app-header app-module-nav app-nav-search app-user-menu
└── domains/
    ├── agents/                 agents-page your-agents-page agent-card-page …
    ├── orchestration/          orchestrator-page workflows chat executions
    ├── observability/          sessions flows traces resources
    ├── mcp/                    mcp-page connectors
    ├── tokenops/               tokenops llm-router
    └── settings/               settings secrets setup-cli
ee/ui/components/domains/org/   users teams departments access-control …
```

## Adding things

- **A primitive** → `AGENTS.md` § "New primitive". Extend `NasikoElement`, inline
  `static styleText`, tokens only, add a `:not(:defined)` entry if it occupies
  layout, `defineElement('app-thing', AppThing)`.
- **A page** → `AGENTS.md` § "New page". Also: `page-layout.css` for the host
  box, `not-defined.css` for the skeleton, a `<page>.preview.js` fixture in the
  same commit.
- **A data function** → build it with `listFetcher`/`detailFetcher` in the
  domain's service module, `registerAll(...)` it, never assign to `window`.
- **A cross-domain notification** → add it to `EVENTS` in `core/events.js` with
  its payload shape and the cache keys it invalidates, then `publish(...)`.

## Running the tests

```sh
just test-ui        # platform-layer tests (Node's runner — no npm, no bundler)
just test           # Rust unit + frontend + server integration
```
