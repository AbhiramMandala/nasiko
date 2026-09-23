#!/usr/bin/env node
/**
 * Generate `ui/common/surface/data-manifest.json` — the data vocabulary a
 * generated surface may `Query`, and the counterpart to `dsl-catalog.json`.
 *
 * The component vocabulary has been generated, content-hashed and CI-gated for
 * a while. The data vocabulary was not: it lived as a hand-transcribed JSON
 * file in the Weave repo, and nothing checked it against the functions it
 * described. It drifted, and the drift is invisible until a generated
 * dashboard binds to a field the backend stopped returning and renders an
 * em-dash where a number should be.
 *
 * ## What is derived and what is declared
 *
 * Derived from `common/services/usage-service.js`, and therefore unable to
 * drift: the function's **name**, whether it is actually **registered**, its
 * **route**, its **argsShape**, and its **callStyle**.
 *
 * Declared in `common/surface/data-sources-overrides.json`: the **description**
 * and the **responseShape**. These cannot be derived — every usage function is
 * `return fetchApi(url)` with no type information, so the shape is a claim
 * about a service in another repo. `--check` therefore cannot verify a shape;
 * it can only verify that the claim is attached to a function that exists.
 * Closing that last gap needs the backend to publish a schema.
 *
 * ## callStyle is not cosmetic
 *
 * `call(name, ...args)` spreads positionally (`core/data-sources.js:161`), but
 * five of the nine usage functions take a single destructured options object.
 * A positional call into one of those destructures a *string* — every filter
 * comes back undefined and the fetch silently returns unfiltered data. So the
 * manifest states which convention each function uses, and the generator side
 * renders the call form from it rather than assuming.
 *
 * ## The backend's own word: the OpenAPI snapshot
 *
 * "--check cannot verify a shape" stopped being true when the control plane
 * started publishing a utoipa spec. `ui/contracts/openapi.snapshot.json`
 * (kept current by `openapi-snapshot.mjs`) is read here, and for every
 * declared source whose route the spec covers, three more things are checked
 * (`openapi-shapes.mjs` does the reading and comparing):
 *
 *   - the declared responseShape against the spec's 200 response, field by
 *     field — a declared field the backend does not return, a backend field
 *     the shape hides, or a type of the wrong kind, each fails;
 *   - every query-string key the function sends against the parameters the
 *     operation accepts — a key the backend ignores is a dead argument the
 *     model will wire a control into and get unfiltered data back from;
 *   - that the function is a passthrough (`return fetchApi(...)`), or else
 *     declares `$returns`, the wrapper it builds around the wire response,
 *     so the check can see through it.
 *
 * A shape may leave backend fields out, but only through `$omit: {path:
 * reason}` — protocol plumbing and blobs a dashboard has no use for, named
 * and justified, so that "not declared" always means "decided against" and
 * never "nobody looked".
 *
 * A source whose route is NOT in the spec (utoipa is an opt-in rollout; the
 * finops spend-* routes are not annotated yet) is still accepted, but only
 * with a `$shapeSource` saying where its shape was read from. The count of
 * unverifiable sources is printed on every run so it is a number someone
 * can watch go down.
 *
 * ## More than one service
 *
 * `overrides.services` lists the service modules whose registered functions
 * are in play — `["usage-service.js"]` when absent, which is where every
 * scope lives today. Adding a section means adding its service here AND
 * accounting for every function it registers (scope or withheld), because
 * the "every registered function must be accounted for" rule applies per
 * listed service, on purpose: the day agents-service.js is listed, its three
 * functions become decisions someone has to write down.
 *
 * ## The search-argument ledger
 *
 * Weave renders any argument whose hint says "search" as `text [search]`
 * (examples/dynamic_ui/dashboard/dsl_prompt.py), and every such argument in
 * a scope is one more candidate for a search box to be wired into. While
 * the source-capture failure is under investigation that count must not
 * move without someone noticing, so `ui/contracts/search-budget.json` holds
 * the expected count per scope and --check fails on any difference — up or
 * down. Changing it is a one-line, reviewable edit, which is the point.
 *
 * ## Drafting a section while another is frozen
 *
 * `--with FRAGMENT.json` layers a second overrides file over the real one
 * for this run only: its `services`, `scopes`, `sources`, `withheld` and
 * `searchBudget` are added on top. Every check runs against the merged
 * result, and the manifest is written only to `--out PATH`, never to the
 * real file — so a new section can be drafted, checked and reviewed in
 * `ui/contracts/drafts/` without touching data-sources-overrides.json until
 * it is ready to move in. Landing a draft is moving its contents into the
 * real overrides and its budget line into search-budget.json; the fragment
 * then goes away.
 *
 * Usage: node ui/scripts/gen-data-manifest.mjs [--check] [--with FRAGMENT.json --out PATH]
 *   --check  exit 1 if data-manifest.json is out of date, if an allowlisted
 *            function is not registered, if a declared source is not
 *            allowlisted, if a shape is declared for a function that no
 *            longer exists, if a declared shape or a sent argument disagrees
 *            with the OpenAPI snapshot, or if a scope's search-argument count
 *            differs from the ledger (for CI)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findOperation, responseShape, queryParams, normalizeDeclared, compareShapes, applyReturns, omitPath,
} from './openapi-shapes.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const UI = resolve(SCRIPTS, '..');
const SERVICES_DIR = resolve(UI, 'common/services');
const OVERRIDES = resolve(UI, 'common/surface/data-sources-overrides.json');
const OUT = resolve(UI, 'common/surface/data-manifest.json');
const SPEC = resolve(UI, 'contracts/openapi.snapshot.json');
const SEARCH_BUDGET = resolve(UI, 'contracts/search-budget.json');

const fail = (msg, hint) => {
  console.error(`gen-data-manifest: ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
};

const argOpt = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const WITH = argOpt('--with');
const OUT_OVERRIDE = argOpt('--out');
if (WITH && !OUT_OVERRIDE && !process.argv.includes('--check')) {
  fail('--with needs --out: a manifest built from a draft fragment is never written over the real one.');
}

const overrides = JSON.parse(readFileSync(OVERRIDES, 'utf8'));
let fragmentBudget = {};
if (WITH) {
  const frag = JSON.parse(readFileSync(resolve(WITH), 'utf8'));
  overrides.services = [...new Set([...(overrides.services ?? ['usage-service.js']), ...(frag.services ?? [])])];
  for (const key of ['scopes', 'sources', 'withheld']) {
    for (const [k, v] of Object.entries(frag[key] ?? {})) {
      if (overrides[key]?.[k] !== undefined) fail(`--with fragment redefines ${key}.${k}, which the real overrides already have.`);
      overrides[key] = { ...(overrides[key] ?? {}), [k]: v };
    }
  }
  fragmentBudget = frag.searchBudget ?? {};
}

/**
 * The service modules in play. Absent means the one module every scope has
 * lived in so far; the manifest's `_generated` line names whatever is here.
 */
const SERVICES = overrides.services ?? ['usage-service.js'];
for (const f of SERVICES) {
  if (!/^[a-z-]+-service\.js$/.test(f) || !existsSync(resolve(SERVICES_DIR, f))) {
    fail(`overrides.services names "${f}", which is not a module under common/services/.`);
  }
}

/**
 * The names the service actually hands to the registry.
 *
 * Read from the `registerAll({...})` call rather than from the `const`
 * declarations, because a function can be defined and deliberately not
 * registered — and only a registered name is callable by `call()`, which is
 * what a `Query` ultimately reaches.
 */
function registeredNames(src) {
  const m = src.match(/registerAll\(\{([\s\S]*?)\}\s*,/);
  if (!m) fail('could not find the registerAll({...}) call in usage-service.js');
  return m[1].split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Constants used inside route templates, so `${FINOPS_BASE}` resolves. */
function routeConstants(src) {
  const consts = {};
  for (const m of src.matchAll(/^const ([A-Z_]+)\s*=\s*'([^']*)'/gm)) consts[m[1]] = m[2];
  return consts;
}

/**
 * Parse each `const fetchX = async (...) => { ... }` into what can be known
 * about it without running it.
 *
 * `callStyle` is the discriminator that matters: a parameter list starting
 * with `{` is one options object, anything else is positional. `argsShape`
 * keeps declared order either way, because for a positional function that
 * order IS the contract.
 */
function parseSources(src) {
  const consts = routeConstants(src);
  const out = new Map();
  const re = /const ((?:fetch|list)[A-Za-z]+)\s*=\s*async\s*\(([\s\S]*?)\)\s*=>\s*\{?([\s\S]*?)\n\};/g;
  for (const m of src.matchAll(re)) {
    const [, name, rawParams, body] = m;
    const params = rawParams.replace(/\s+/g, ' ').trim();

    let callStyle = 'positional';
    let keys = [];
    if (!params) {
      callStyle = 'none';
    } else if (params.startsWith('{')) {
      callStyle = 'object';
      keys = params.slice(1, params.indexOf('}')).split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      // `days = 7` -> `days`; defaults are not part of the caller's contract.
      keys = params.split(',').map((s) => s.split('=')[0].trim()).filter(Boolean);
    }

    const route = body.match(/fetchApi\(\s*`([^`]+)`/)?.[1] ?? body.match(/fetchApi\(\s*'([^']+)'/)?.[1] ?? null;
    // Does the function hand back what it fetched, untouched? Exactly one
    // `return`, and it is the fetch. Anything else reshapes the response and
    // has to declare `$returns` for the spec check to see through it.
    const returns = [...body.matchAll(/\breturn\b\s*([^;]*)/g)].map((r) => r[1].trim());
    const passthrough = returns.length === 1 && /^fetchApi\(/.test(returns[0]);
    out.set(name, {
      callStyle,
      keys,
      wireKeys: wireKeys(body),
      passthrough,
      // `${params}` is the built query string, not a path segment — drop it so
      // the route reads as the endpoint a human would recognise.
      // The query string is built at call time; only the path identifies the
      // endpoint, so everything from the first `?` goes.
      route: route
        ? route.replace(/\$\{([A-Z_]+)\}/g, (_, k) => consts[k] ?? `\${${k}}`)
                .replace(/\$\{(?:params|qs\([^`]*?\))\}/g, '')
                .split('?')[0]
        : null,
    });
  }
  return out;
}

/**
 * The query-string keys a function actually puts on the wire, read from how
 * it builds them: the object literal handed to `qs({...})` or
 * `new URLSearchParams({...})`, any `.set('key', …)`, and `?key=${…}` in a
 * template. Best effort and shallow on purpose — it only has to catch the
 * failure it was written for, a function sending `page` to a backend that
 * pages by `offset` and silently returning page one forever.
 */
function wireKeys(body) {
  const keys = new Set();
  for (const m of body.matchAll(/(?:\bqs|URLSearchParams)\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    for (const part of m[1].split(',')) {
      const k = part.trim().split(':')[0].trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) keys.add(k);
    }
  }
  for (const m of body.matchAll(/\.set\(\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of body.matchAll(/[?&]([A-Za-z_][A-Za-z0-9_]*)=\$\{/g)) keys.add(m[1]);
  return [...keys];
}

const registered = new Set();
const parsed = new Map();
const serviceOf = new Map();
for (const f of SERVICES) {
  const src = readFileSync(resolve(SERVICES_DIR, f), 'utf8');
  for (const n of registeredNames(src)) { registered.add(n); serviceOf.set(n, f); }
  for (const [n, v] of parseSources(src)) parsed.set(n, v);
}
const declared = overrides.sources ?? {};
const withheld = overrides.withheld ?? {};

// ── the four ways this can be wrong, each failing loudly ────────────────────

const allowlisted = new Set(Object.values(overrides.scopes ?? {}).flat());

for (const name of allowlisted) {
  if (!registered.has(name)) {
    fail(`"${name}" is allowlisted for generation but usage-service.js does not register it.`,
      'Either it was renamed or removed — drop it from scopes, or fix the name.');
  }
  if (!declared[name]) {
    fail(`"${name}" is allowlisted but has no entry under "sources".`,
      'A source with no description and no responseShape gives the model a name and nothing to bind to.');
  }
}

/**
 * The four shapes of answer a source can give, and what each one is FOR.
 *
 * The manifest has always said how to call a source and never what kind of
 * question it answers. Seven lines that all read "here is a way to fetch
 * tokenops data" are seven interchangeable options, so a request for a
 * "comprehensive" dashboard goes to whichever description sounds most
 * complete — and `fetchTokenopsDashboard` does. The model then had one
 * categorical row set in hand and drew it twice, because a bar over agent
 * names is the only chart that row set can make.
 *
 * That is not a model choosing badly. A dashboard's chart shapes follow its
 * DATA shapes, and it could not plan data shapes it could not see.
 *
 * So each source declares what it answers. It makes the difference between
 * `fetchSpendTimeseries` and `fetchUsageByModel` legible as a difference in
 * kind rather than in wording, which is what lets "cover the trend and the
 * breakdown" be a thing a model can act on.
 */
const ANSWERS = {
  summary: 'one figure or a flat set of them, for the window as a whole — a KPI strip',
  series: 'a value over TIME, one point per bucket — a line chart',
  breakdown: 'a value per CATEGORY, one row per thing — a bar, donut or ranking',
  // Never rendered bare. A composite declares `contains`, and the line the
  // model reads names both what is in there AND what is not — see
  // `compositeMeans`. "Several of the above" on its own is the sentence that
  // cost a whole round of this: fetchTokenopsDashboard is KPIs, a summary and
  // per-agent rows with no time series anywhere in it, and a model told the
  // response holds "several of the above" reasonably read that as including
  // one, fetched it alone, and drew its one row set twice.
  composite: 'several of these in one response',
};

/** The kinds a composite can be made of. `composite` is not composable. */
const COMPOSITE_PARTS = ['summary', 'series', 'breakdown'];

/** What each kind is drawn as — the half of ANSWERS that says what to build. */
const DRAWS = {
  summary: 'a KPI strip, no chart',
  series: 'a line chart',
  breakdown: 'a bar, donut or ranking',
};

/**
 * What a composite's source line says.
 *
 * The absence is stated, not left to be inferred. A model cannot tell the
 * difference between "this response has no series" and "the description did
 * not happen to mention one", and the second reading is the one that ends
 * with a single Query and a single chart shape.
 */
function compositeMeans(contains) {
  const has = COMPOSITE_PARTS.filter((k) => contains.includes(k));
  const lacks = COMPOSITE_PARTS.filter((k) => !contains.includes(k));
  // Each part carries the same chart guidance it would as a standalone kind.
  // Without it a composite named what it held and not what to DO with it: a
  // generation read the per-agent rows out of this response, got no hint that
  // a breakdown is a bar or a donut, and put them in a table — on a request
  // that said "with charts". The simple kinds had said so all along; the
  // composite dropped the second half of every one of them.
  const drawn = has.map((k) => `${k} (${DRAWS[k]})`).join(' + ');
  return `${drawn} in one response`
    + (lacks.length ? ` — it has NO ${lacks.join(' and no ')}, so that needs its own Query` : '');
}

/** Fields that make something a time axis, and ones that make it a dimension. */
const TIME_FIELDS = ['bucket_start', 'date', 'day', 'hour', 'timestamp', 'period_start'];
const DIMENSION_FIELDS = ['agent_name', 'agent_id', 'model', 'provider', 'name', 'workflow', 'label'];

/** Every field name anywhere in a declared shape, at any depth. */
function shapeFields(shape, out = new Set()) {
  if (Array.isArray(shape)) { for (const v of shape) shapeFields(v, out); return out; }
  if (shape && typeof shape === 'object') {
    for (const [k, v] of Object.entries(shape)) { out.add(k); shapeFields(v, out); }
  }
  return out;
}

for (const [name, decl] of Object.entries(declared)) {
  // `answers` is a claim about the response, so it is checked against the
  // response — the same reason argHints are checked against the signature.
  // A source labelled `series` whose shape has no time field would teach the
  // model to reach for a line chart it cannot draw, which is worse than the
  // silence this replaces.
  const answers = decl.answers;
  if (answers !== undefined) {
    if (!ANSWERS[answers]) {
      fail(`"${name}" declares answers: "${answers}", which is not one of ${Object.keys(ANSWERS).join(', ')}.`,
        'The set is closed on purpose: it is rendered into the prompt as a menu, and a fifth '
        + 'kind nobody defined is a word the model has to guess the meaning of.');
    }
    const fields = shapeFields(decl.responseShape);
    // A composite says WHICH kinds, and each one is checked like a standalone
    // claim of that kind would be. Left unchecked, `composite` was the one
    // label that could mean anything — and the most-reached-for source in the
    // scope was wearing it while containing no series at all.
    if (answers === 'composite') {
      const contains = decl.contains;
      if (!Array.isArray(contains) || contains.length < 2) {
        fail(`"${name}" answers "composite" but does not declare which kinds it contains.`,
          `Add contains: [...] with at least two of ${COMPOSITE_PARTS.join(', ')}. `
          + 'A composite that does not say what is in it is a label the model has to guess at, '
          + 'and it guesses that everything is in it.');
      } else {
        for (const part of contains) {
          if (!COMPOSITE_PARTS.includes(part)) {
            fail(`"${name}" declares contains: "${part}", which is not one of ${COMPOSITE_PARTS.join(', ')}.`,
              'A composite is made of the simple kinds; it cannot contain another composite.');
          }
        }
        if (contains.includes('series') && !TIME_FIELDS.some((f) => fields.has(f))) {
          fail(`"${name}" says it contains a series, but its responseShape has no time field.`,
            'This is the check that was missing: a composite claiming a series it does not have '
            + 'is why a dashboard asking for breadth fetched one source and drew one shape twice.');
        }
        if (contains.includes('breakdown') && !DIMENSION_FIELDS.some((f) => fields.has(f))) {
          fail(`"${name}" says it contains a breakdown, but its responseShape has no dimension field.`,
            'Nothing to break down by means no categories to put on an axis.');
        }
      }
    } else if (decl.contains) {
      fail(`"${name}" declares contains but answers "${answers}", not "composite".`,
        'Only a composite is made of parts.');
    }
    if (answers === 'series' && !TIME_FIELDS.some((f) => fields.has(f))) {
      fail(`"${name}" answers "series" but its responseShape has no time field (${TIME_FIELDS.join(', ')}).`,
        'A series the model cannot find a time axis in is a line chart it cannot draw.');
    }
    if (answers === 'breakdown' && !DIMENSION_FIELDS.some((f) => fields.has(f))) {
      fail(`"${name}" answers "breakdown" but its responseShape has no dimension field (${DIMENSION_FIELDS.join(', ')}).`,
        'A breakdown with nothing to break down by has no categories to put on an axis.');
    }
  }

  // A hint for an argument that no longer exists is drift of exactly the kind
  // this generator exists to catch — the signature moved and the docs did not.
  for (const k of Object.keys(decl.argHints ?? {})) {
    if (!parsed.get(name)?.keys.includes(k)) {
      fail(`"${name}" declares an argHint for "${k}", which is not a parameter of the function.`,
        'The signature changed. Update the hint, or drop it.');
    }
  }
  if (!registered.has(name)) {
    fail(`a responseShape is declared for "${name}", which is not registered.`,
      'A shape for a function nobody can call is a claim nothing will ever check.');
  }
  if (!allowlisted.has(name)) {
    fail(`"${name}" is declared under "sources" but is in no scope.`,
      'Add it to a scope, or move it to "withheld" with the reason.');
  }
}

// Every registered function must be accounted for — allowlisted or explicitly
// withheld with a reason. Silence is what let four usable data sources sit
// unexposed for weeks without anyone noticing they were missing.
for (const name of registered) {
  if (!allowlisted.has(name) && !withheld[name]) {
    fail(`"${name}" is registered but neither allowlisted nor withheld.`,
      'Add it to a scope to expose it, or to "withheld" with the reason it stays out. '
      + 'Defaulting to silence is how the manifest fell four sources behind the registry.');
  }
}

// ── the backend's word ──────────────────────────────────────────────────────

if (!existsSync(SPEC)) {
  fail('ui/contracts/openapi.snapshot.json is missing.',
    'Run: node ui/scripts/openapi-snapshot.mjs --write (against a running control plane).');
}
const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
/** The control plane's standard envelope. Not data; never surfaced to the model. */
const ENVELOPE_KEYS = ['message', 'status_code'];
const verified = [];
const unverifiable = [];

for (const [name, decl] of Object.entries(declared)) {
  const p = parsed.get(name);
  if (!p) continue; // already failed above
  const found = findOperation(spec, p.route);
  if (!found) {
    // utoipa is opt-in; a route it does not cover can still be exposed, but
    // the shape has to say where it came from, because nothing here can.
    if (!decl.$shapeSource) {
      fail(`"${name}" (${p.route}) is not in the OpenAPI snapshot and declares no $shapeSource.`,
        'Either annotate the route with #[utoipa::path] and re-snapshot, or say which Rust struct '
        + 'the shape was read from — a shape nobody can check needs a provenance someone can.');
    }
    unverifiable.push(name);
    continue;
  }

  // Arguments: everything the function sends must be something the backend
  // reads. The failure this catches is silent on both sides — the backend
  // ignores an unknown key, the function gets a plausible response.
  const accepted = queryParams(found.operation);
  for (const k of p.wireKeys) {
    if (!accepted.has(k)) {
      fail(`"${name}" sends "${k}" to GET ${found.path}, which does not accept it `
        + `(accepted: ${[...accepted.keys()].join(', ') || 'none'}).`,
        'A dead argument in the manifest is a control the model will wire up and a filter that '
        + 'never happens. Drop it from the function, or fix the backend.');
    }
  }

  // Shape: what a Query yields, compared with what the wire carries.
  if (!p.passthrough && decl.$returns === undefined) {
    fail(`"${name}" reshapes the response before returning it, but declares no $returns.`,
      'Declare the wrapper, e.g. { "data": "$response", "total": "number" }, so the payload inside it '
      + 'can still be checked against the spec.');
  }
  const wire = responseShape(spec, found.operation);
  if (!wire) { unverifiable.push(name); continue; }
  let expected;
  try {
    expected = applyReturns(decl.$returns ?? '$response', wire);
    // `$omit` is {path: reason}. A field left out WITH a reason is a decision;
    // a field left out without one is the drift this check exists to catch.
    for (const [path, reason] of Object.entries(decl.$omit ?? {})) {
      if (typeof reason !== 'string' || !reason.trim()) fail(`"${name}" omits "${path}" without saying why.`);
      expected = omitPath(expected, path);
    }
  } catch (e) {
    fail(`"${name}": ${e.message}`);
  }
  const findings = compareShapes(normalizeDeclared(decl.responseShape), expected, '', [], {
    ignoreRootKeys: decl.$returns === undefined ? ENVELOPE_KEYS : [],
  });
  if (findings.length) {
    console.error(`gen-data-manifest: "${name}"'s responseShape disagrees with GET ${found.path} in the OpenAPI snapshot:`);
    for (const f of findings) console.error(`  ${f.code.padEnd(16)} ${f.path}: ${f.detail}`);
    fail(`${findings.length} disagreement(s) between the declared shape and the backend.`,
      'The spec is the backend describing itself; the shape is a claim about it. When they differ '
      + 'the shape is what changes — unless the spec is stale, in which case re-snapshot first.');
  }
  verified.push(name);
}

// ── the search-argument ledger ─────────────────────────────────────────────

/** Mirrors dsl_prompt.py: a hint with the word "search" in it renders as `text [search]`. */
const SEARCHY = /\bsearch\b/i;

// ── emit ────────────────────────────────────────────────────────────────────

/**
 * The closed set an argument accepts, read out of its own hint.
 *
 * `argsShape` is prose — `range` is the literal string `"24h" | "7d" | "30d"`
 * — and until now the only thing that parsed it was `classify_argument()` on
 * the generator side, which turns it into `enum "24h"|"7d"|"30d"` for the
 * prompt. So the model was told the closed set and nothing on this side could
 * check the model against it: a generated control bound `range: "1d"` and the
 * first thing to notice was the backend returning 400.
 *
 * Deriving it here rather than porting the regex to each consumer is the point.
 * Two regexes over the same prose is two things to keep in step, and the one
 * that drifts is the one nobody is looking at. This writes the machine-readable
 * form down once, the same reason `paramOrder` is written into dsl-catalog.json
 * instead of re-derived from attribute order at every reader.
 *
 * Two or more quoted alternatives is a closed set; one quoted value is an
 * example and stays prose. Mirrors `_ENUM` in the generator's dsl_prompt.py.
 */
const ENUM = /"[^"]+"(?:\s*\|\s*"[^"]+")+/;

function enumValues(hint) {
  const m = ENUM.exec(String(hint ?? ''));
  return m ? m[0].split('|').map((v) => v.trim().replace(/^"|"$/g, '')) : null;
}

/**
 * One manifest entry. Derived fields overwrite anything of the same name in
 * the overrides, so a stale hand-written argsShape cannot win over the source.
 */
function entry(name) {
  const { callStyle, keys, route } = parsed.get(name);
  const { description, responseShape, argHints = {}, answers, contains } = declared[name];
  // Keys and their ORDER come from the signature — for a positional function
  // that order is the whole contract. The hints are documentation and are
  // declared, because no type information exists to derive them from.
  const argsShape = {};
  for (const k of keys) argsShape[k] = argHints[k] ?? 'optional';
  // Only the arguments that actually carry one, so a source with no closed
  // set has no empty object to read past.
  const argsEnum = {};
  for (const [k, hint] of Object.entries(argsShape)) {
    const values = enumValues(hint);
    if (values) argsEnum[k] = values;
  }
  return {
    name,
    callStyle,
    route,
    description,
    argsShape,
    ...(Object.keys(argsEnum).length && { argsEnum }),
    ...(answers && {
      answers,
      answersMeans: answers === 'composite' ? compositeMeans(contains ?? []) : ANSWERS[answers],
      ...(contains && { contains }),
    }),
    responseShape,
  };
}

const scopes = {};
for (const [scope, names] of Object.entries(overrides.scopes ?? {})) {
  scopes[scope] = names.map(entry);
}

const searchCounts = {};
for (const [scope, entries] of Object.entries(scopes)) {
  searchCounts[scope] = entries.reduce(
    (n, e) => n + Object.values(e.argsShape).filter((hint) => SEARCHY.test(hint)).length, 0);
}
if (!existsSync(SEARCH_BUDGET)) {
  fail('ui/contracts/search-budget.json is missing.',
    `Create it with the current counts: ${JSON.stringify(searchCounts)}`);
}
const budget = { ...JSON.parse(readFileSync(SEARCH_BUDGET, 'utf8')), ...fragmentBudget };
for (const [scope, count] of Object.entries(searchCounts)) {
  if (typeof budget[scope] !== 'number') {
    fail(`scope "${scope}" has no entry in search-budget.json (it currently carries ${count} [search] argument(s)).`,
      'Add it. Every scope\'s search-argument count is a number someone has agreed to.');
  }
  if (budget[scope] !== count) {
    fail(`scope "${scope}" carries ${count} [search] argument(s); search-budget.json says ${budget[scope]}.`,
      count > budget[scope]
        ? 'A new search-capable argument is one more candidate for the source-capture failure under '
          + 'investigation. If it is intended, raise the ledger in the same change and say why.'
        : 'Fewer than the ledger says — lower it so the ledger stays exact.');
  }
}

const payload = {
  _generated: [
    'Generated by ui/scripts/gen-data-manifest.mjs — do not edit.',
    'Exposure and response shapes come from common/surface/data-sources-overrides.json;',
    `name, callStyle, route and argsShape are read from ${SERVICES.map((f) => `common/services/${f}`).join(', ')}.`,
    'callStyle says how Query must pass arguments: "object" takes ONE options object,',
    '"positional" takes them in the order listed, "none" takes none. Getting this wrong',
    'does not error — it silently fetches unfiltered data.',
  ].join(' '),
  manifestVersion: overrides.manifestVersion ?? '1.1',
  scopes,
  withheld,
};

const next = `${JSON.stringify(payload, null, 2)}\n`;
const target = OUT_OVERRIDE ? resolve(OUT_OVERRIDE) : OUT;
const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
const counts = Object.entries(scopes).map(([s, v]) => `${s}: ${v.length}`).join(', ');
const searchLine = Object.entries(searchCounts).map(([s, n]) => `${s}: ${n}`).join(', ');
console.log(`gen-data-manifest: spec-verified ${verified.length} source(s)`
  + (unverifiable.length ? `, ${unverifiable.length} not in the OpenAPI snapshot (${unverifiable.join(', ')})` : '')
  + `; [search] arguments per scope — ${searchLine}`);

if (process.argv.includes('--check')) {
  if (WITH && !OUT_OVERRIDE) {
    // A draft has nothing committed to be out of date against; the checks
    // above are the whole point of running it.
    console.log(`gen-data-manifest: draft ${WITH} passes every check (${counts}, ${Object.keys(withheld).length} withheld)`);
    process.exit(0);
  }
  if (current !== next) {
    fail('common/surface/data-manifest.json is out of date.',
      'A data function or an override changed. Run: node ui/scripts/gen-data-manifest.mjs');
  }
  console.log(`gen-data-manifest: data-manifest.json up to date (${counts}, ${Object.keys(withheld).length} withheld)`);
} else {
  writeFileSync(target, next);
  console.log(`gen-data-manifest: wrote ${OUT_OVERRIDE ? target : 'data-manifest.json'} — ${counts}, ${Object.keys(withheld).length} withheld`);
}
