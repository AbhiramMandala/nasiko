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
 * Usage: node ui/scripts/gen-data-manifest.mjs [--check]
 *   --check  exit 1 if data-manifest.json is out of date, if an allowlisted
 *            function is not registered, if a declared source is not
 *            allowlisted, or if a shape is declared for a function that no
 *            longer exists (for CI)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const UI = resolve(SCRIPTS, '..');
const SERVICE = resolve(UI, 'common/services/usage-service.js');
const OVERRIDES = resolve(UI, 'common/surface/data-sources-overrides.json');
const OUT = resolve(UI, 'common/surface/data-manifest.json');

const fail = (msg, hint) => {
  console.error(`gen-data-manifest: ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
};

const src = readFileSync(SERVICE, 'utf8');

/**
 * The names the service actually hands to the registry.
 *
 * Read from the `registerAll({...})` call rather than from the `const`
 * declarations, because a function can be defined and deliberately not
 * registered — and only a registered name is callable by `call()`, which is
 * what a `Query` ultimately reaches.
 */
function registeredNames() {
  const m = src.match(/registerAll\(\{([\s\S]*?)\}\s*,/);
  if (!m) fail('could not find the registerAll({...}) call in usage-service.js');
  return m[1].split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Constants used inside route templates, so `${FINOPS_BASE}` resolves. */
function routeConstants() {
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
function parseSources() {
  const consts = routeConstants();
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
    out.set(name, {
      callStyle,
      keys,
      // `${params}` is the built query string, not a path segment — drop it so
      // the route reads as the endpoint a human would recognise.
      // The query string is built at call time; only the path identifies the
      // endpoint, so everything from the first `?` goes.
      route: route
        ? route.replace(/\$\{([A-Z_]+)\}/g, (_, k) => consts[k] ?? `\${${k}}`)
                .replace(/\$\{params\}/g, '')
                .split('?')[0]
        : null,
    });
  }
  return out;
}

const overrides = JSON.parse(readFileSync(OVERRIDES, 'utf8'));
const registered = new Set(registeredNames());
const parsed = parseSources();
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

for (const [name, decl] of Object.entries(declared)) {
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

// ── emit ────────────────────────────────────────────────────────────────────

/**
 * One manifest entry. Derived fields overwrite anything of the same name in
 * the overrides, so a stale hand-written argsShape cannot win over the source.
 */
function entry(name) {
  const { callStyle, keys, route } = parsed.get(name);
  const { description, responseShape, argHints = {} } = declared[name];
  // Keys and their ORDER come from the signature — for a positional function
  // that order is the whole contract. The hints are documentation and are
  // declared, because no type information exists to derive them from.
  const argsShape = {};
  for (const k of keys) argsShape[k] = argHints[k] ?? 'optional';
  return {
    name,
    callStyle,
    route,
    description,
    argsShape,
    responseShape,
  };
}

const scopes = {};
for (const [scope, names] of Object.entries(overrides.scopes ?? {})) {
  scopes[scope] = names.map(entry);
}

const payload = {
  _generated: [
    'Generated by ui/scripts/gen-data-manifest.mjs — do not edit.',
    'Exposure and response shapes come from common/surface/data-sources-overrides.json;',
    'name, callStyle, route and argsShape are read from common/services/usage-service.js.',
    'callStyle says how Query must pass arguments: "object" takes ONE options object,',
    '"positional" takes them in the order listed, "none" takes none. Getting this wrong',
    'does not error — it silently fetches unfiltered data.',
  ].join(' '),
  manifestVersion: overrides.manifestVersion ?? '1.1',
  scopes,
  withheld,
};

const next = `${JSON.stringify(payload, null, 2)}\n`;
const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
const counts = Object.entries(scopes).map(([s, v]) => `${s}: ${v.length}`).join(', ');

if (process.argv.includes('--check')) {
  if (current !== next) {
    fail('common/surface/data-manifest.json is out of date.',
      'A data function or an override changed. Run: node ui/scripts/gen-data-manifest.mjs');
  }
  console.log(`gen-data-manifest: data-manifest.json up to date (${counts}, ${Object.keys(withheld).length} withheld)`);
} else {
  writeFileSync(OUT, next);
  console.log(`gen-data-manifest: wrote data-manifest.json — ${counts}, ${Object.keys(withheld).length} withheld`);
}
