/**
 * Reachability pruning of the DSL buffer.
 *
 * Why this exists: the accumulated surface text is sent back to the model on
 * every revision turn. Without a prune, a statement that `root` stopped
 * referencing three turns ago still rides along forever, so a long session's
 * context grows without bound and the model keeps seeing components the user
 * cannot see. `gc.js` came from the weave2.0 POC; these tests are what let it
 * land on our runtime, whose materializer walks a different shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { unreachableStatements, pruneUnreachable } from '../common/surface/gc.js';
import { walkAstRefs } from '../common/surface/materialize.js';
import { parseBuffer } from '../common/surface/parser.js';

const ids = (text) => text.split('\n').filter(Boolean).map((l) => l.split(' =')[0].trim());

test('an orphan is reported and pruned; root and its subtree survive', () => {
  const dsl = [
    'root = AppStack([kpi], "md")',
    'kpi = AppStatCard("Cost", "$1")',
    'orphan = AppStatCard("Nobody", "0")',
  ].join('\n');

  assert.deepEqual(unreachableStatements(dsl), ['orphan']);
  assert.deepEqual(ids(pruneUnreachable(dsl)), ['root', 'kpi']);
});

test('$state is kept even when nothing references it', () => {
  // It is the user's live value, not a component. Pruning it would silently
  // reset a filter the user set.
  const dsl = ['root = AppStack([], "md")', '$sel = null'].join('\n');

  assert.deepEqual(unreachableStatements(dsl), []);
  assert.ok(ids(pruneUnreachable(dsl)).includes('$sel'));
});

test('reachability follows a transitive chain, not just root\'s direct children', () => {
  const dsl = [
    'root = AppStack([mid], "md")',
    'mid = AppRow([leaf], "sm")',
    'leaf = AppStatCard("Deep", "1")',
  ].join('\n');

  assert.deepEqual(unreachableStatements(dsl), []);
  assert.deepEqual(ids(pruneUnreachable(dsl)), ['root', 'mid', 'leaf']);
});

test('a statement redefined later keeps the last definition, and stays reachable', () => {
  // Redefinition is the whole revision model — a later statement with the same
  // name replaces the earlier one.
  const dsl = [
    'root = AppStack([kpi], "md")',
    'kpi = AppStatCard("Old", "1")',
    'kpi = AppStatCard("New", "2")',
  ].join('\n');

  assert.deepEqual(unreachableStatements(dsl), []);
  assert.ok(pruneUnreachable(dsl).includes('"New"'));
});

test('walkAstRefs finds names evaluation would never reach', () => {
  // The point of a structural walk: evaluate() short-circuits a ternary and
  // resolves refs through scope, so it cannot answer "what does this depend
  // on". Both branches must count as dependencies.
  const { statements } = parseBuffer('root = cond ? a : b');
  const seen = [];
  walkAstRefs(statements[0].ast, (kind, name) => seen.push(`${kind}:${name}`));

  assert.ok(seen.includes('ref:a'), seen.join(','));
  assert.ok(seen.includes('ref:b'), seen.join(','));
});

test('walkAstRefs distinguishes $state from a statement reference', () => {
  const { statements } = parseBuffer('root = AppStack([$sel, other], "md")');
  const seen = [];
  walkAstRefs(statements[0].ast, (kind, name) => seen.push(`${kind}:${name}`));

  // The sigil is part of the name our parser records — `$sel`, not `sel`. That
  // is what makes gc.js's `id.startsWith('$')` keep-rule line up with it.
  assert.ok(seen.includes('state:$sel'), seen.join(','));
  assert.ok(seen.includes('ref:other'), seen.join(','));
});
