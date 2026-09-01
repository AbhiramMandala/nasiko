/**
 * Breaking vs additive.
 *
 * The content hash says a catalog changed. This says whether the change
 * rebinds arguments in DSL that was already written — which is the only
 * question that matters once a surface outlives the tab it was generated in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../scripts/catalog-compat.mjs';

const cat = (components, routes = []) => ({ components, routes });
const card = (paramOrder, attributes = {}) => ({ paramOrder, attributes });

test('appending a parameter is additive — old calls simply do not pass it', () => {
  const { breaking, additive } = classify(
    cat({ 'app-x': card(['a', 'b']) }),
    cat({ 'app-x': card(['a', 'b', 'c']) }),
  );
  assert.deepEqual(breaking, []);
  assert.equal(additive.length, 1);
});

test('inserting a parameter mid-list is breaking, however innocent it looks', () => {
  // paramOrder follows @attr order, so adding a line in the middle of a
  // component's docblock rebinds every argument after it. This is the least
  // obvious breaking change available and the easiest one to make by accident.
  const { breaking } = classify(
    cat({ 'app-x': card(['a', 'b']) }),
    cat({ 'app-x': card(['a', 'new', 'b']) }),
  );
  assert.equal(breaking.length, 1);
  assert.match(breaking[0], /paramOrder changed/);
});

test('reordering two parameters is breaking', () => {
  const { breaking } = classify(
    cat({ 'app-stat-card': card(['label', 'value', 'delta', 'trend']) }),
    cat({ 'app-stat-card': card(['label', 'value', 'trend', 'delta']) }),
  );
  assert.equal(breaking.length, 1);
});

test('removing a component is breaking', () => {
  const { breaking } = classify(cat({ 'app-x': card(['a']) }), cat({}));
  assert.match(breaking[0], /was removed/);
});

test('adding a component is additive', () => {
  const { breaking, additive } = classify(cat({}), cat({ 'app-x': card(['a']) }));
  assert.deepEqual(breaking, []);
  assert.match(additive[0], /is new/);
});

test('removing an attribute is breaking', () => {
  const { breaking } = classify(
    cat({ 'app-x': card(['a'], { a: { type: 'string' }, b: { type: 'string' } }) }),
    cat({ 'app-x': card(['a'], { a: { type: 'string' } }) }),
  );
  assert.ok(breaking.some((x) => /app-x\.b was removed/.test(x)));
});

test('changing an attribute type is breaking', () => {
  const { breaking } = classify(
    cat({ 'app-x': card(['a'], { a: { type: 'string' } }) }),
    cat({ 'app-x': card(['a'], { a: { type: 'number' } }) }),
  );
  assert.match(breaking[0], /changed type: string → number/);
});

test('widening an enum is additive, narrowing it is breaking', () => {
  const before = cat({ 'app-x': card(['v'], { v: { type: 'enum', values: ['a', 'b'] } }) });
  const wider = cat({ 'app-x': card(['v'], { v: { type: 'enum', values: ['a', 'b', 'c'] } }) });
  const narrower = cat({ 'app-x': card(['v'], { v: { type: 'enum', values: ['a'] } }) });

  assert.deepEqual(classify(before, wider).breaking, []);
  assert.match(classify(before, wider).additive[0], /also accepts "c"/);
  assert.match(classify(before, narrower).breaking[0], /no longer accepts "b"/);
});

test('withdrawing a route is breaking — stored links go nowhere', () => {
  const { breaking } = classify(cat({}, ['/a', '/b']), cat({}, ['/a']));
  assert.match(breaking[0], /route \/b was withdrawn/);
});

test('adding a route is additive', () => {
  const { breaking, additive } = classify(cat({}, ['/a']), cat({}, ['/a', '/b']));
  assert.deepEqual(breaking, []);
  assert.match(additive[0], /route \/b is new/);
});

test('an unchanged catalog reports nothing at all', () => {
  const c = cat({ 'app-x': card(['a'], { a: { type: 'string' } }) }, ['/a']);
  const { breaking, additive } = classify(c, c);
  assert.deepEqual(breaking, []);
  assert.deepEqual(additive, []);
});

test('several breakages are all reported, not just the first', () => {
  const { breaking } = classify(
    cat({ 'app-x': card(['a', 'b']), 'app-y': card(['a']) }),
    cat({ 'app-x': card(['b', 'a']) }),
  );
  assert.equal(breaking.length, 2, 'one fix per run is a slow way to find out');
});
