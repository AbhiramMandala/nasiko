#!/usr/bin/env node
/**
 * Did this catalog change break anything, or only add to it?
 *
 * The content hash answers "did it change". That is enough while a surface
 * lives only as long as the tab it was generated in. It stops being enough the
 * moment a surface is stored — NAS-294 puts generated DSL in the backend and
 * IndexedDB — because a stored surface is DSL written against a catalog that no
 * longer exists, and positional arguments mean a reordered component silently
 * rebinds every argument in every stored call. That is the AppCard bug again
 * with a longer fuse and no one watching.
 *
 * So the change is classified rather than merely detected:
 *
 *   **additive** — a new component, a new enum value, a new route, or a new
 *   attribute at the end of paramOrder *on a component with no action slot*.
 *   Old DSL keeps meaning exactly what it meant.
 *
 *   **breaking** — a removed or renamed component or attribute, a reordered
 *   paramOrder, a removed enum value, a changed type, a withdrawn route, or a
 *   new attribute on a component whose last argument is its action (appending
 *   there displaces the action, so a stored call rebinds it to the new
 *   attribute). Old DSL now means something else, or nothing.
 *
 * A breaking change is not forbidden. It is required to be deliberate: state
 * it in `dsl-catalog.compat.json` and the gate passes, with the statement
 * standing as the record of what was accepted and why.
 *
 * Usage:
 *   node ui/scripts/catalog-compat.mjs            # classify against the baseline
 *   node ui/scripts/catalog-compat.mjs --accept   # adopt current as the baseline
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = resolve(UI, 'common/surface/dsl-catalog.json');
const BASELINE = resolve(UI, 'common/surface/dsl-catalog.compat.json');

/**
 * @param {object} before
 * @param {object} after
 * @returns {{breaking: string[], additive: string[]}}
 */
export function classify(before, after) {
  const breaking = [];
  const additive = [];

  const b = before.components ?? {};
  const a = after.components ?? {};

  for (const tag of Object.keys(b)) {
    if (!a[tag]) { breaking.push(`component ${tag} was removed — every stored call to it now names nothing`); continue; }

    // `action` is not an attribute — it is a synthetic slot that is always last
    // by construction, so it is compared separately from the attributes rather
    // than in place.
    //
    // It used to be trimmed off and then ignored, on the reasoning that
    // appending an attribute is safe because "a stored call simply does not
    // pass the new trailing argument". That reasoning is wrong for exactly the
    // components that have an `action`, and the repo's own test caught it:
    // `AppSelect(…11 nulls…, act)` puts the action in the last position by
    // construction, because that is the only position it has. Append a twelfth
    // attribute and the action does not stay put — it moves to index 13, and
    // the stored call now binds `act` to `fit-content`. No error; the control
    // just stops doing anything. That is precisely the failure this gate
    // exists to name, and it was the one case it waved through.
    //
    // So: appending is additive on a component with no action, and breaking on
    // one with an action. That does make every new attribute on the nine
    // interactive components a deliberate accept. It should — under positional
    // binding there is no such thing as a free append there. The durable fix is
    // to stop binding the action positionally; until then the gate says so out
    // loud instead of being quietly wrong.
    const endsWithAction = (p) => p[p.length - 1] === 'action';
    const trim = (p) => (endsWithAction(p) ? p.slice(0, -1) : p);
    const bFull = b[tag].paramOrder ?? [];
    const aFull = a[tag].paramOrder ?? [];
    const bp = trim(bFull);
    const ap = trim(aFull);
    // A prefix match is the whole test for the attributes themselves; anything
    // else rebinds arguments that were already written.
    const kept = ap.slice(0, bp.length);
    if (JSON.stringify(kept) !== JSON.stringify(bp)) {
      breaking.push(`${tag} paramOrder changed: [${bp.join(', ')}] → [${ap.join(', ')}]`);
    } else if (ap.length > bp.length) {
      const gained = ap.slice(bp.length).map((p) => `"${p}"`).join(', ');
      if (endsWithAction(aFull)) {
        breaking.push(
          `${tag} gained ${gained} at the end, which moves its action slot from ` +
            `argument ${bp.length + 1} to ${ap.length + 1} — every stored call that ` +
            `passes an action positionally now binds it to "${ap[ap.length - 1]}" instead`,
        );
      } else {
        additive.push(`${tag} gained ${gained} at the end`);
      }
    }

    const ba = b[tag].attributes ?? {};
    const aa = a[tag].attributes ?? {};
    for (const name of Object.keys(ba)) {
      if (!aa[name]) { breaking.push(`${tag}.${name} was removed`); continue; }
      if (ba[name].type !== aa[name].type) {
        breaking.push(`${tag}.${name} changed type: ${ba[name].type} → ${aa[name].type}`);
      }
      const bv = ba[name].values ?? null;
      const av = aa[name].values ?? null;
      if (bv && av) {
        const gone = bv.filter((v) => !av.includes(v));
        const added = av.filter((v) => !bv.includes(v));
        if (gone.length) breaking.push(`${tag}.${name} no longer accepts ${gone.map((v) => `"${v}"`).join(', ')}`);
        if (added.length) additive.push(`${tag}.${name} also accepts ${added.map((v) => `"${v}"`).join(', ')}`);
      }
    }
    for (const name of Object.keys(aa)) if (!ba[name]) additive.push(`${tag}.${name} is new`);
  }
  for (const tag of Object.keys(a)) if (!b[tag]) additive.push(`component ${tag} is new`);

  const br = new Set(before.routes ?? []);
  const ar = new Set(after.routes ?? []);
  for (const r of br) if (!ar.has(r)) breaking.push(`route ${r} was withdrawn — stored links to it now go nowhere`);
  for (const r of ar) if (!br.has(r)) additive.push(`route ${r} is new`);

  return { breaking, additive };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const current = JSON.parse(readFileSync(CURRENT, 'utf8'));

  if (!existsSync(BASELINE)) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`catalog-compat: no baseline — adopted ${current.catalogVersion} as the first one.`);
    process.exit(0);
  }

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

  if (process.argv.includes('--accept')) {
    const { breaking, additive } = classify(baseline, current);
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`catalog-compat: baseline is now ${current.catalogVersion}.`);
    if (breaking.length) console.log(`  accepted ${breaking.length} breaking change(s):`);
    for (const x of breaking) console.log(`    ✗ ${x}`);
    for (const x of additive) console.log(`    + ${x}`);
    process.exit(0);
  }

  if (baseline.catalogVersion === current.catalogVersion) {
    console.log(`catalog-compat: unchanged at ${current.catalogVersion}.`);
    process.exit(0);
  }

  const { breaking, additive } = classify(baseline, current);
  for (const x of additive) console.log(`  + ${x}`);

  if (!breaking.length) {
    // Additive only. Adopt silently: refusing here would mean a ceremony for
    // every new component, and a gate that fires on safe changes is a gate
    // people learn to wave through.
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`catalog-compat: ${additive.length} additive change(s), ${baseline.catalogVersion} → ${current.catalogVersion}. Baseline updated.`);
    process.exit(0);
  }

  console.error(`\ncatalog-compat: ${breaking.length} breaking change(s) in ${baseline.catalogVersion} → ${current.catalogVersion}:\n`);
  for (const x of breaking) console.error(`  ✗ ${x}`);
  console.error(`
Arguments are positional, so a stored surface written against ${baseline.catalogVersion}
will rebind them silently rather than fail — nothing errors, the dashboard is
just wrong. Once NAS-294 persists generated DSL that becomes a live problem
rather than a theoretical one.

If this is intended, say so:

    just catalog-accept

which adopts the new baseline and records what was accepted in the diff.`);
  process.exit(1);
}
