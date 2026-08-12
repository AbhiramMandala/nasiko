#!/usr/bin/env node
/**
 * Verify every relative and `/common/…` module specifier in the UI resolves to a
 * file that exists.
 *
 * Why this exists: there is no bundler and no type checker, so a mistyped or
 * stale import path is not caught by anything — it becomes a 404 at runtime and
 * takes down that page's entire module graph. This check found
 * `utils/keyboard-shortcuts.js` importing two component files that had never
 * existed, meaning any page that imported it would have thrown on load.
 *
 * Deliberately does NOT try to resolve bare specifiers (there is no import map)
 * or non-`/common/` absolute paths (those are resolved per-binary by the
 * rust-embed overlay chain, not on disk).
 *
 * Usage: node oss/ui/scripts/check-imports.mjs [--quiet]
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'node:fs/promises';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(uiRoot, '../..');
const commonRoot = resolve(uiRoot, 'common');

const SPEC_PATTERNS = [
  /(?:^|\s)(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gm,
  /(?:^|\s)import\s*['"]([^'"]+)['"]/gm,
  /import\(\s*['"]([^'"]+)['"]/gm,
];

const SEARCH = [
  'oss/ui/common/**/*.js',
  'oss/ui/web/*.js',
  'ee/ui/web/**/*.js',
  'ee/ui/registry/**/*.js',
];

const SKIP = (p) => p.includes('/vendor/') || p.includes('/.preview/') || p.endsWith('.preview.js');

const failures = [];
let checked = 0;
let files = 0;

for (const pattern of SEARCH) {
  for await (const entry of glob(pattern, { cwd: repoRoot })) {
    if (SKIP(entry)) continue;
    files++;
    const abs = resolve(repoRoot, entry);
    const source = readFileSync(abs, 'utf8');
    const specs = new Set();
    for (const re of SPEC_PATTERNS) {
      for (const m of source.matchAll(re)) specs.add(m[1]);
    }
    for (const spec of specs) {
      let target;
      if (spec.startsWith('/common/')) target = resolve(commonRoot, spec.slice('/common/'.length));
      else if (spec.startsWith('.')) target = resolve(dirname(abs), spec);
      else continue; // bare specifier, or a site-root path resolved by the server overlay
      checked++;
      if (!existsSync(target)) {
        failures.push(`${entry}\n    imports  ${spec}\n    missing  ${relative(repoRoot, target)}`);
      }
    }
  }
}

const quiet = process.argv.includes('--quiet');
if (failures.length) {
  console.error(`\ncheck-imports: ${failures.length} unresolved module specifier(s)\n`);
  for (const f of failures) console.error('  ' + f + '\n');
  console.error('A missing import is a runtime 404 that breaks the whole page module graph.\n');
  process.exit(1);
}
if (!quiet) console.log(`check-imports: ${checked} specifiers across ${files} files — all resolve`);
