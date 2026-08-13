#!/usr/bin/env node
/**
 * Regenerate the data-function declarations in `oss/ui/types/globals.d.ts` from
 * `common/services/data-functions.js`.
 *
 * The point is that the typed contract cannot drift from the implementation: the
 * declarations are derived from the actual `window.X = …` assignments, so adding
 * a data function without regenerating is caught by `just check-ui-types`
 * (the call site won't type-check), and a stale declaration cannot survive.
 *
 * Usage: node oss/ui/scripts/gen-globals.mjs [--check]
 *   --check  exit 1 if the file is out of date, without writing (for CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(UI, 'common/services/data-functions.js');
const OUT = resolve(UI, 'types/globals.d.ts');
const BEGIN = '  // ── GENERATED: data functions (do not hand-edit) ──────────────────────────';
const END = '  // ── END GENERATED ─────────────────────────────────────────────────────────';

const src = readFileSync(SRC, 'utf8');
const decls = [...src.matchAll(/^window\.(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)/gm)]
  .map(([, name, params]) => {
    const ps = [...params.split(',')].map((p) => p.trim()).filter(Boolean);
    const sig = ps
      .map((p, i) => `${(p.split('=')[0].trim().replace(/^_+/, '') || `arg${i}`)}?: any`)
      .join(', ');
    return `  ${name}: (${sig}) => Promise<any>;`;
  })
  .sort();

const current = readFileSync(OUT, 'utf8');
const before = current.slice(0, current.indexOf(BEGIN) + BEGIN.length);
const after = current.slice(current.indexOf(END));
const next = `${before}\n${decls.join('\n')}\n${after}`;

if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error(
      `globals.d.ts is out of date (${decls.length} data functions in data-functions.js).\n` +
        'Run: node oss/ui/scripts/gen-globals.mjs',
    );
    process.exit(1);
  }
  console.log(`globals.d.ts is up to date (${decls.length} data functions)`);
} else {
  writeFileSync(OUT, next);
  console.log(`globals.d.ts: ${decls.length} data functions declared`);
}
