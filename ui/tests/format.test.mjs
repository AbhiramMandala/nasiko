/**
 * Display formatting (common/utils/units.js).
 *
 * This module exists because a Weave-generated surface has no code: it cannot
 * write a column renderer, cannot call toFixed, and the DSL's `@builtins` are
 * arithmetic only. Whatever the backend sends goes on screen exactly as it
 * arrives unless the design system formats it. The tests that matter here are
 * therefore the *restraint* ones — what autoFormat leaves alone — because a
 * formatter that rewrites an id or a version string does more damage than the
 * twelve-decimal cost it was added to fix.
 *
 * Locale- and zone-dependent output is asserted by shape, not by string: these
 * run in CI's UTC and on a developer's laptop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const U = await import('../common/utils/units.js');

test('numbers are capped at two decimals', () => {
  assert.equal(U.fmtNumber(1234.5678), '1,234.57');
  assert.equal(U.fmtNumber(1234), '1,234');
  assert.equal(U.fmtNumber(0), '0');
  assert.equal(U.fmtNumber(null), '—');
  assert.equal(U.fmtNumber('12.345'), '12.35');
});

test('a figure that would round away keeps its significant digits', () => {
  // $0.0004 per operation is the real shape of this data. Two decimals would
  // render a whole column as "0.00", which is not shorter, it is empty.
  assert.equal(U.fmtNumber(0.000423), '0.00042');
  assert.equal(U.fmtCurrency(0.000423), '$0.00042');
  assert.equal(U.fmtCurrency(1234.5678), '$1,234.57');
  assert.equal(U.fmtCurrency(0), '$0.00');
});

test('ISO-8601 is recognised and nothing else is', () => {
  assert.equal(U.isIsoDateTime('2026-09-09T14:00:00Z'), true);
  assert.equal(U.isIsoDateTime('2026-09-09'), true);
  assert.equal(U.isIsoDateTime('2026-09-09T14:00:00+05:30'), true);
  // Date.parse accepts all of these. This module must not.
  assert.equal(U.isIsoDateTime('2026'), false);
  assert.equal(U.isIsoDateTime('12/1/26'), false);
  assert.equal(U.isIsoDateTime('March 3'), false);
  assert.equal(U.isIsoDateTime('2026-13-45'), false, 'well-shaped but not a real date');
  assert.equal(U.isIsoDateTime(20260909), false, 'a number is never a date here');
});

test('a UTC timestamp is shown in local time, a bare date as a date', () => {
  const timed = U.fmtDateTime('2026-09-09T14:00:00Z');
  assert.notEqual(timed, '2026-09-09T14:00:00Z');
  assert.match(timed, /\d/);
  assert.doesNotMatch(timed, /[TZ]/, 'no ISO punctuation survives');
  // A bare calendar date has no time to convert, so inventing midnight-in-a-
  // zone would move it across a day boundary for half the world.
  assert.match(U.fmtDate('2026-09-09'), /2026/);
  assert.doesNotMatch(U.fmtDateTime('2026-09-09'), /:/, 'no clock on a dateless value');
});

test('autoFormat touches only the two unambiguous shapes', () => {
  assert.equal(U.autoFormat(0.023456789012), '0.02');
  assert.notEqual(U.autoFormat('2026-09-09T14:00:00Z'), '2026-09-09T14:00:00Z');
  // Integers keep every digit, ungrouped: the commonest integer in these
  // tables is an id, and "1,234,567" is not an id.
  assert.equal(U.autoFormat(1234567), '1234567');
  assert.equal(U.autoFormat('v1.2.3'), 'v1.2.3');
  assert.equal(U.autoFormat('1.2.3'), '1.2.3');
  assert.equal(U.autoFormat('agent-7'), 'agent-7');
  assert.equal(U.autoFormat('claude-opus-4-20250101'), 'claude-opus-4-20250101');
  assert.equal(U.autoFormat(''), '');
  assert.equal(U.autoFormat(null), '');
  assert.equal(U.autoFormat(undefined), '');
  assert.equal(U.autoFormat(true), 'true');
});

test('a numeric string is a number that lost its type in the DOM', () => {
  // Every attribute arrives as text, so app-stat-card sees "0.023456789012".
  assert.equal(U.autoFormat('0.023456789012'), '0.02');
  // But only when it round-trips exactly — a padded or formatted string is
  // something a page already decided on.
  assert.equal(U.autoFormat('1,234.5'), '1,234.5');
  assert.equal(U.autoFormat('007'), '007');
  assert.equal(U.autoFormat('$12.50'), '$12.50');
});

test('applyFormat covers the catalog names and degrades instead of throwing', () => {
  assert.equal(U.applyFormat(1536, 'bytes'), '1.5 KB');
  assert.equal(U.applyFormat(1234567, 'compact'), '1.2M');
  assert.equal(U.applyFormat(12.3456, 'percent'), '12.35%');
  assert.equal(U.applyFormat(0.023456789012, 'text'), '0.023456789012',
    'text is the opt-out');
  assert.equal(U.applyFormat(2500, 'duration'), '2.5 s');
  // An unknown name comes from a generated attribute. A slightly plainer
  // number beats an exception on the render path.
  assert.equal(U.applyFormat(0.12345, 'not-a-format'), '0.12');
  assert.equal(U.applyFormat(null, 'currency'), '');
});
