/**
 * The empty-state starters are claims the product makes before anyone types.
 *
 * Each one is a button saying "ask me this". If the generator cannot answer
 * it, the first thing a new user sees is the feature declining. That is how
 * the dock ended up offering "Create a new agent" — a request with no data
 * source behind it — for as long as it did: nothing checked.
 *
 * So the claim is checked here instead of asserted in a comment. A starter is
 * only allowed if it is a prompt the eval suite records and replays, which
 * means there is a committed generation proving it produces a surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WEAVE_STARTERS } from '../common/surface/starters.js';
import { CASES } from '../scripts/eval-generations.mjs';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Casing is the one difference allowed: a chip is title case, a prompt is not. */
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

const byPrompt = new Map(CASES.map((c) => [norm(c.prompt), c]));

test('every starter is a prompt the eval suite measures', () => {
  for (const starter of WEAVE_STARTERS) {
    assert.ok(byPrompt.has(norm(starter)),
      `"${starter}" is not an eval case. Add it to CASES in eval-generations.mjs and `
      + 'record a generation for it, or offer a starter that is already proven.');
  }
});

test('every starter has a committed generation behind it', () => {
  for (const starter of WEAVE_STARTERS) {
    const c = byPrompt.get(norm(starter));
    if (!c) continue; // reported by the test above
    const fixture = resolve(UI, 'tests/fixtures/generations', `${c.id}.dsl`);
    assert.ok(existsSync(fixture), `${c.id} has no recorded fixture — ${starter}`);
  }
});

test('a starter never offers something the generator must decline', () => {
  for (const starter of WEAVE_STARTERS) {
    const c = byPrompt.get(norm(starter));
    if (!c) continue;
    assert.ok(!c.expect?.noSurface && !c.expect?.allowNoSurface,
      `${c.id} is a case whose correct outcome is prose, not a surface — ${starter}`);
  }
});

test('the starters cover more than one shape of answer', () => {
  // Four breakdowns would teach a first-time user that breakdowns are all
  // this does. The set is an introduction to the surface, not four ways to
  // ask the same question.
  const shapes = new Set(WEAVE_STARTERS.map((s) => {
    const e = byPrompt.get(norm(s))?.expect ?? {};
    if (e.minActions || e.minStates) return 'interactive';
    if (e.minChartKinds) return 'breadth';
    if (e.tags?.includes('app-table')) return 'breakdown';
    return 'series';
  }));
  assert.ok(shapes.size >= 3, `starters cover only ${[...shapes].join(', ')}`);
});
