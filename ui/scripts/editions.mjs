/**
 * Edition discovery for the shared UI tooling.
 *
 * Why this exists: `ui/` is ONE tree shared by every edition, but the OSS slice
 * published slice of it goes to the public repo (see the UI allowlist in
 * `scripts/sync-oss.sh`). The tooling in this directory is published with it, so
 * it must not contain hardcoded knowledge of the unpublished editions — a published
 * `ui-lint.mjs` full of per-edition globs advertises the private layout, and the
 * enterprise-only element list is exactly the kind of thing the edition boundary
 * exists to keep out.
 *
 * So each edition DECLARES itself in `ui/<edition>/edition.json` and the tooling
 * reads whatever manifests are present. A private checkout has more of them than
 * a published one, and every rule that depends on a private edition simply has
 * nothing to check where that edition is absent. Adding a future edition means
 * adding one manifest, not editing two scripts.
 *
 * Manifest shape (all fields optional except `layer`):
 *
 *   {
 *     "public": true,                       // is this edition published?
 *     "layer": "application",               // default layer for its files
 *     "layerOverrides": [                   // subtrees that sit lower
 *       { "prefix": "components/", "layer": "domain" }
 *     ],
 *     "sources": {
 *       "lint": ["*.{js,css,html}"],        // globs, relative to the edition dir
 *       "imports": ["*.js"]
 *     },
 *     "mounts": { "/components/": "components" },  // server mount -> subdir
 *     "privateElements": ["users-page"]     // custom elements this edition owns
 *   }
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
export const UI = resolve(SCRIPTS, '..');
export const REPO = resolve(UI, '..');

const MANIFEST = 'edition.json';

function load(name) {
  const path = resolve(UI, name, MANIFEST);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`ui/${name}/${MANIFEST} is not readable JSON: ${err.message}`);
  }
  if (!raw.layer) throw new Error(`ui/${name}/${MANIFEST} must declare "layer"`);

  const dir = `ui/${name}`;
  return {
    name,
    dir,
    isPublic: raw.public === true,
    layer: raw.layer,
    layerOverrides: (raw.layerOverrides ?? []).map((o) => ({
      prefix: `${dir}/${o.prefix}`,
      layer: o.layer,
    })),
    lintGlobs: (raw.sources?.lint ?? []).map((g) => `${dir}/${g}`),
    importGlobs: (raw.sources?.imports ?? []).map((g) => `${dir}/${g}`),
    mounts: Object.entries(raw.mounts ?? {}).map(([spec, sub]) => ({
      spec,
      prefix: `${dir}/${sub}/`,
    })),
    privateElements: raw.privateElements ?? [],
    // Optional: the module that must import every *-service.js in its directory,
    // because a service registers its data functions as an import side effect.
    serviceBarrel: raw.serviceBarrel ? `${dir}/${raw.serviceBarrel}` : null,
  };
}

/** Every edition present in this checkout, lowest name first for stable output. */
export const EDITIONS = readdirSync(UI, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(resolve(UI, e.name, MANIFEST)))
  .map((e) => load(e.name))
  .sort((a, b) => a.name.localeCompare(b.name));

if (EDITIONS.length === 0) {
  throw new Error(
    `no editions found: expected at least one ui/<edition>/${MANIFEST}. ` +
      'Every edition declares its own layout — see the comment at the top of ui/scripts/editions.mjs.',
  );
}

export const PUBLIC_EDITIONS = EDITIONS.filter((e) => e.isPublic);
export const PRIVATE_EDITIONS = EDITIONS.filter((e) => !e.isPublic);

/** Lint globs across every edition, repo-relative. */
export const lintGlobs = () => EDITIONS.flatMap((e) => e.lintGlobs);

/** Import-resolution globs across every edition, repo-relative. */
export const importGlobs = () => EDITIONS.flatMap((e) => e.importGlobs);

/** The edition a repo-relative path belongs to, or null. */
export const editionOf = (rel) => EDITIONS.find((e) => rel.startsWith(`${e.dir}/`)) ?? null;

/**
 * Resolve a server-mounted specifier (e.g. `/components/users-page.js`) to a
 * repo-relative path. Mapping these is what lets the boundary rules see a public
 * edition reaching for a private one's mount.
 */
export function resolveMount(spec) {
  for (const ed of EDITIONS) {
    for (const m of ed.mounts) {
      if (spec.startsWith(m.spec)) return m.prefix + spec.slice(m.spec.length);
    }
  }
  return null;
}

/** Declared layer name for a repo-relative path inside an edition, or null. */
export function editionLayerOf(rel) {
  const ed = editionOf(rel);
  if (!ed) return null;
  for (const o of ed.layerOverrides) {
    if (rel.startsWith(o.prefix)) return o.layer;
  }
  return ed.layer;
}

/** Service-barrel paths for the editions that declare one, repo-relative. */
export const serviceBarrels = () => EDITIONS.map((e) => e.serviceBarrel).filter(Boolean);

/** Custom-element names owned by editions that are NOT published. */
export const privateElementNames = () => PRIVATE_EDITIONS.flatMap((e) => e.privateElements);
