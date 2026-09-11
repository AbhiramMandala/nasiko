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
import { createHash } from 'node:crypto';
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

    // The typed contract beyond attributes — a JSON attribute's item shape, an
    // event's detail fields, the children a composite accepts. A stored surface
    // wrote against these too: a field it used that disappears rebinds nothing
    // and reads undefined, so removal is breaking; addition is additive.
    const setDiff = (what, bs, as) => {
      const gone = bs.filter((x) => !as.includes(x));
      const added = as.filter((x) => !bs.includes(x));
      if (gone.length) breaking.push(`${what} lost ${gone.map((x) => `"${x}"`).join(', ')}`);
      if (added.length) additive.push(`${what} gained ${added.map((x) => `"${x}"`).join(', ')}`);
    };
    for (const name of Object.keys(ba)) {
      if (!aa[name]) continue;
      const bs = ba[name].shape, as = aa[name].shape;
      if (bs && as) setDiff(`${tag}.${name} shape`, bs.fields, as.fields);
      else if (bs && !as) breaking.push(`${tag}.${name} lost its item shape`);
      else if (!bs && as) additive.push(`${tag}.${name} now declares an item shape`);
      if (ba[name].reflects && !aa[name].reflects) breaking.push(`${tag}.${name} is no longer reflected`);
    }
    const be = Object.fromEntries((b[tag].events ?? []).map((e) => [e.name, e]));
    const ae = Object.fromEntries((a[tag].events ?? []).map((e) => [e.name, e]));
    for (const name of Object.keys(be)) {
      if (!ae[name]) { breaking.push(`${tag} no longer fires ${name}`); continue; }
      setDiff(`${tag} ${name} detail`, be[name].detail ?? [], ae[name].detail ?? []);
    }
    for (const name of Object.keys(ae)) if (!be[name]) additive.push(`${tag} now fires ${name}`);
    const bc = b[tag].children ?? [], ac = a[tag].children ?? [];
    if (bc.length || ac.length) setDiff(`${tag} children`, bc, ac);
  }
  for (const tag of Object.keys(a)) if (!b[tag]) additive.push(`component ${tag} is new`);

  const br = new Set(before.routes ?? []);
  const ar = new Set(after.routes ?? []);
  for (const r of br) if (!ar.has(r)) breaking.push(`route ${r} was withdrawn — stored links to it now go nowhere`);
  for (const r of ar) if (!br.has(r)) additive.push(`route ${r} is new`);

  return { breaking, additive };
}

/**
 * The version a catalog body hashes to — the same computation gen-dsl-catalog
 * does, so the two can be compared.
 *
 * @param {{components: object, routes: string[]}} catalog
 */
function hashOf(catalog) {
  return createHash('sha256')
    .update(JSON.stringify({ components: catalog.components, routes: catalog.routes }))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Refuse a ledger whose stored version does not hash its own stored body.
 *
 * The ledger's whole job is to answer "what did we last accept". It can only
 * do that if its label and its contents agree, and nothing checked that they
 * did. They came apart once already: resolving the ds-parity merge conflict
 * on this file kept a body recording `app-chart.format-y2` as accepting
 * `duration` under a version whose catalog had dropped it. It stayed
 * invisible for a week because the comparison below short-circuits on equal
 * versions — an unrelated change moved the version, and the stale body then
 * reported a breaking change that had never happened.
 *
 * A wrong answer from a ratchet is worse than no ratchet: this one would have
 * waved through a real narrowing, or blocked a safe change until someone
 * accepted a diff they did not understand. So it stops here instead.
 *
 * @param {object} baseline
 */
function verifyLedger(baseline) {
  const actual = hashOf(baseline);
  if (actual === baseline.catalogVersion) return;
  console.error(`
catalog-compat: the ledger does not match its own version.

  dsl-catalog.compat.json says       ${baseline.catalogVersion}
  but its recorded components hash   ${actual}

The ledger records what was last accepted, and it cannot do that while its
label and its contents disagree — every comparison against it is answering
about a catalog that never existed. This is what a merge conflict resolved in
favour of one side's body and the other side's version string looks like.

Fix it by re-accepting from a catalog you trust:

    node ui/scripts/gen-dsl-catalog.mjs && just catalog-accept

and check the accepted diff, because it will include whatever the stale body
was hiding.`);
  process.exit(1);
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
  verifyLedger(baseline);

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
