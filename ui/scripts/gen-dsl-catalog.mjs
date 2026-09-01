#!/usr/bin/env node
/**
 * Generate `ui/common/surface/dsl-catalog.json` — the vocabulary a generated
 * surface may use, and the single file both this repo and the generator side
 * read.
 *
 * It is `design-system/catalog.json` (generated from the components) merged
 * with `surface/dsl-overrides.json` (the decisions the components cannot state
 * about themselves: may a generated surface name this at all, does its first
 * positional argument mean children or data, which attributes are withheld).
 *
 * Two properties are worth stating, because they are the reason this file
 * exists rather than the design-system catalog being consumed directly:
 *
 *   1. **`paramOrder` is written out, not implied.** The DSL passes arguments
 *      positionally, so what `AppStatCard(a, b, c)` means depends entirely on
 *      attribute order. Left implicit, that order is `Object.keys()` over the
 *      catalog — which is `@attr` order in the component source. Reordering two
 *      documentation lines would then silently change what every existing call
 *      means, with nothing failing. Writing the order into this file turns that
 *      into a visible diff.
 *   2. **`catalogVersion` is a content hash.** A hand-written version does not
 *      move when the contract does, which is the same failure from the other
 *      direction. Any change to a name, a type, an enum value or the parameter
 *      order changes the hash, so a consumer holding a stale copy can tell.
 *
 * Usage: node ui/scripts/gen-dsl-catalog.mjs [--check]
 *   --check  exit 1 if dsl-catalog.json is out of date, or if the overrides
 *            and the catalog have drifted apart, without writing (for CI)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = resolve(UI, 'common/design-system/catalog.json');
const OVERRIDES = resolve(UI, 'common/surface/dsl-overrides.json');
const OUT = resolve(UI, 'common/surface/dsl-catalog.json');

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const overrides = JSON.parse(readFileSync(OVERRIDES, 'utf8')).components;

/** Fail the run with a reason a reader can act on. */
const problems = [];
/** `tag.attribute` for every markup sink withheld — reported, never silent. */
const markupSinks = [];

// ── Drift between the two files ─────────────────────────────────────────────
// Both directions matter. A component with no entry would silently be absent
// from the vocabulary; an entry with no component would silently do nothing.
for (const tag of Object.keys(catalog.components)) {
  if (!overrides[tag]) {
    problems.push(
      `${tag} is in the design system but has no entry in dsl-overrides.json. ` +
      `Add one with "status": "ready" or "blocked" and a reason — a new component ` +
      `must be an explicit decision, not a default.`,
    );
  }
}
for (const tag of Object.keys(overrides)) {
  if (!catalog.components[tag]) {
    problems.push(`${tag} is in dsl-overrides.json but no longer exists in the design system. Remove it.`);
  }
}

// ── Build ───────────────────────────────────────────────────────────────────
const components = {};

for (const [tag, def] of Object.entries(catalog.components)) {
  const ov = overrides[tag];
  if (!ov || ov.status !== 'ready') continue;

  // Excluded twice over: what the catalog itself withholds (raw CSS lengths and
  // the like) plus what the override withholds for this pipeline.
  const catalogExcluded = new Set((def.excludedFromCatalog || []).map((e) => e.attribute));
  const ovExcluded = new Set(ov.dslExcludeAttributes || []);
  for (const name of ovExcluded) {
    if (!def.attributes?.[name]) {
      problems.push(`${tag}: dslExcludeAttributes names "${name}", which is not an attribute of ${tag}.`);
    }
  }

  const attributes = {};
  for (const [name, spec] of Object.entries(def.attributes || {})) {
    if (catalogExcluded.has(name) || ovExcluded.has(name)) continue;
    // A markup sink is withheld here, unconditionally, and no override can
    // re-admit it. The flag comes from the component's own `@attr` line, so
    // adding a second sink withholds it on the next generator run rather than
    // waiting for somebody to notice and edit a list — and a security
    // exception that has to be remembered is one that eventually is not.
    if (spec.markup) {
      markupSinks.push(`${tag}.${name}`);
      continue;
    }
    attributes[name] = spec;
  }

  const firstArg = ['childrenParam', 'dataParam', 'textParam'].filter((k) => ov[k]);
  if (firstArg.length > 1) {
    problems.push(`${tag}: ${firstArg.join(' and ')} all claim the first positional argument — pick one.`);
  }

  // The positional contract, written down. A leading children/data slot when
  // the override declares one, then the surviving attributes in catalog order.
  const leading = ov.childrenParam ? ['children'] : ov.dataParam ? ['data'] : ov.textParam ? ['text'] : [];
  // A trailing synthetic slot for an Action(...) — the component has no such
  // attribute; the renderer binds it as a listener on the element's trigger
  // event instead. Last so it stays optional without displacing anything.
  const trailing = ov.actionParam ? ['action'] : [];
  const paramOrder = [...leading, ...Object.keys(attributes), ...trailing];

  components[tag] = {
    element: def.element ?? tag,
    summary: def.summary,
    ...(ov.childrenParam && { childrenParam: true }),
    ...(ov.dataParam && { dataParam: true }),
    ...(ov.textParam && { textParam: true }),
    ...(ov.actionParam && { actionParam: true }),
    paramOrder,
    attributes,
    slots: def.slots ?? [],
    events: def.events ?? [],
    ...(ov.dataProp && { dataProp: ov.dataProp }),
    ...(ov.dataAsFetcher && { dataAsFetcher: true }),
    ...(ov.actionEvent && { actionEvent: ov.actionEvent }),
    ...(ov.note && { note: ov.note }),
  };
}

const blocked = Object.fromEntries(
  Object.entries(overrides)
    .filter(([, v]) => v.status !== 'ready')
    .map(([tag, v]) => [tag, v.reason ?? 'no reason recorded']),
);

if (problems.length) {
  console.error('gen-dsl-catalog: cannot generate —');
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

// Hash the contract itself, not the file: comments and ordering of the wrapper
// must not move the version, and nothing else may fail to.
const version = createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(0, 12);

const payload = {
  _generated: 'by ui/scripts/gen-dsl-catalog.mjs from design-system/catalog.json + surface/dsl-overrides.json — do not hand-edit',
  catalogVersion: version,
  contract: [
    'The components a generated surface may name, and the only attributes it may',
    'set on each. Arguments are positional: paramOrder is the contract, and it',
    'changes whenever the underlying @attr order does. A component absent from',
    'here is either blocked (see blocked, with a reason) or does not exist.',
  ].join(' '),
  sourceCatalogVersion: catalog.catalogVersion,
  componentCount: Object.keys(components).length,
  components,
  blocked,
};

const next = `${JSON.stringify(payload, null, 2)}\n`;
const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';

if (process.argv.includes('--check')) {
  if (current !== next) {
    console.error('gen-dsl-catalog: common/surface/dsl-catalog.json is out of date.');
    console.error('A component or an override changed. Run: node ui/scripts/gen-dsl-catalog.mjs');
    process.exit(1);
  }
  console.log(`gen-dsl-catalog: dsl-catalog.json up to date (${payload.componentCount} ready, ${Object.keys(blocked).length} blocked, version ${version})`);
  if (markupSinks.length) console.log(`gen-dsl-catalog: withheld markup sinks — ${markupSinks.join(', ')}`);
} else {
  writeFileSync(OUT, next);
  console.log(`gen-dsl-catalog: wrote dsl-catalog.json — ${payload.componentCount} ready, ${Object.keys(blocked).length} blocked, version ${version}`);
  if (markupSinks.length) console.log(`gen-dsl-catalog: withheld markup sinks — ${markupSinks.join(', ')}`);
}
