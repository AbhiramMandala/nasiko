#!/usr/bin/env node
/**
 * Merges the real, generated `ui/common/design-system/catalog.json` with
 * `ui/common/surface/dsl-overrides.json` (DSL-specific metadata the real
 * catalog can't know about — childrenParam/dataParam/actionParam/slots/
 * propAssignments/dslExcludeAttributes/status) and writes ONE output file,
 * `ui/common/surface/dsl-catalog.json` — the single file both the frontend
 * and weave2.0 read from now on, replacing hand-copying/hand-editing.
 *
 * `--check`: exit 1 if any real catalog component has no entry in
 * dsl-overrides.json (forces an explicit ready/blocked decision on every
 * new component, forever — same philosophy as gen-catalog.mjs's own
 * `--check`). Does not write anything in this mode.
 *
 * Usage: node ui/scripts/gen-dsl-catalog.mjs [--check]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI = resolve(__dirname, '..');
const CATALOG_PATH = resolve(UI, 'common/design-system/catalog.json');
const OVERRIDES_PATH = resolve(UI, 'common/surface/dsl-overrides.json');
const OUT_PATH = resolve(UI, 'common/surface/dsl-catalog.json');

const checkOnly = process.argv.includes('--check');

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));

const missing = Object.keys(catalog.components).filter(
  (tag) => !(tag in overrides) || tag === '$comment',
);
if (missing.length) {
  console.error(
    `gen-dsl-catalog: ${missing.length} real component(s) have no dsl-overrides.json entry: ` +
    `${missing.join(', ')}\nEvery component in catalog.json needs an explicit "status": "ready"|"blocked" ` +
    `decision in dsl-overrides.json before it can reach the model.`,
  );
  process.exit(1);
}

if (checkOnly) {
  console.log(`gen-dsl-catalog: OK — all ${Object.keys(catalog.components).length} components classified.`);
  process.exit(0);
}

const merged = { catalogVersion: catalog.catalogVersion, components: {} };
let readyCount = 0;
for (const [tag, def] of Object.entries(catalog.components)) {
  const override = overrides[tag];
  if (override.status !== 'ready') continue;
  readyCount++;
  const { status, reason, note, dslExcludeAttributes, ...dslMeta } = override;
  // Physically remove excluded attributes here — not just skip them in the
  // frontend's positional-arg mapping — so the backend's prompt-signature
  // generator (which reads this same merged file) never lists an attribute
  // the frontend would silently drop. Doing this only on one side would
  // shift every later positional argument onto the wrong real attribute.
  const attributes = { ...(def.attributes || {}) };
  for (const attr of dslExcludeAttributes || []) delete attributes[attr];
  merged.components[tag] = { ...def, ...dslMeta, attributes };
}

writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2) + '\n');
console.log(`gen-dsl-catalog: wrote ${OUT_PATH} — ${readyCount} ready / ${Object.keys(catalog.components).length} total.`);
