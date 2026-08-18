#!/usr/bin/env node
/**
 * Generate `ui/common/tokens/tokens.json` from the CSS files in
 * `ui/common/tokens/`.
 *
 * The CSS is the single source of truth. This emits the machine-readable form —
 * the file a generator reads when it needs to know what values it is allowed to
 * use, and the one artefact that can be handed to something outside this repo.
 *
 * Why generated rather than hand-written: two files describing one set of
 * tokens drift, and the drift is silent. That is the exact failure the old
 * hand-written `PRIMITIVES` list in ui-lint.mjs had — nine components were
 * missing from it and nothing noticed. `--check` makes it impossible here.
 *
 * Usage: node ui/scripts/gen-tokens.mjs [--check]
 *   --check  exit 1 if tokens.json is out of date, without writing (for CI)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(UI, 'common/tokens');
const OUT = resolve(DIR, 'tokens.json');

/** Files that are not a token group. */
const SKIP = new Set(['index.css']);

/**
 * Strip CSS comments while keeping the last one seen before each declaration,
 * so a token's rationale travels with it. Comments are the most valuable thing
 * in these files and dropping them would make the JSON far less useful to a
 * generator deciding *which* token to reach for.
 * @param {string} css
 */
function parse(css) {
  /** @type {Record<string, { value: string, note?: string }>} */
  const out = {};
  let note = '';
  // Walk declaration by declaration, tracking the most recent comment.
  const re = /\/\*([\s\S]*?)\*\/|(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const m of css.matchAll(re)) {
    if (m[1] !== undefined) {
      const text = m[1].replace(/\s+/g, ' ').replace(/^=+|=+$/g, '').trim();
      note = text.length > 3 ? text : '';
      continue;
    }
    const [, , name, value] = m;
    out[name] = note ? { value: value.trim(), note } : { value: value.trim() };
    note = '';
  }
  return out;
}

const groups = {};
let count = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.css') && !SKIP.has(f)).sort()) {
  const tokens = parse(readFileSync(resolve(DIR, file), 'utf8'));
  groups[file.replace(/\.css$/, '')] = { file: `tokens/${file}`, tokens };
  count += Object.keys(tokens).length;
}

const payload = {
  _generated: 'by ui/scripts/gen-tokens.mjs from ui/common/tokens/*.css — do not hand-edit',
  tokensVersion: '1.0',
  contract: [
    'These are the only colour, type, spacing, radius, border, shadow, motion',
    'and z-index values that may appear in generated markup or CSS. A value not',
    'listed here is a design-system gap: report it, do not invent one.',
    'Raw colour literals are permitted in exactly one file, tokens/palette.css.',
  ].join(' '),
  tokenCount: count,
  groups,
};

const next = `${JSON.stringify(payload, null, 2)}\n`;
const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';

if (process.argv.includes('--check')) {
  if (current !== next) {
    console.error('gen-tokens: common/tokens/tokens.json is out of date.');
    console.error('A token was changed without regenerating. Run: node ui/scripts/gen-tokens.mjs');
    process.exit(1);
  }
  console.log(`gen-tokens: tokens.json up to date (${count} tokens, ${Object.keys(groups).length} groups)`);
} else {
  writeFileSync(OUT, next);
  console.log(`gen-tokens: wrote tokens.json — ${count} tokens across ${Object.keys(groups).length} groups`);
}
