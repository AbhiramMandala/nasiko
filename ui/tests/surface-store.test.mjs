import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../common/surface/store.js';

test('a value read before anything is set falls back to the declared default', () => {
  const s = createStore();
  s.initialize(new Map([['$days', 7]]));
  assert.equal(s.get('$days'), 7);
  assert.equal(s.get('$nothing'), undefined);
});

test('a write that changes nothing notifies nobody', () => {
  const s = createStore();
  let n = 0;
  s.subscribe(() => n++);
  s.set('$view', 'cost');
  s.set('$view', 'cost');
  assert.equal(n, 1, 'a double-click on the same tab must not repaint twice');
});

test('subscribers hear the names that moved, and only those', () => {
  const s = createStore();
  const heard = [];
  s.subscribe((c) => heard.push(...c.names));
  s.set('$a', 1);
  s.set('$b', 2);
  s.set('$a', 1);
  assert.deepEqual(heard, ['$a', '$b']);
});

test('@Reset goes back to the declared default, not to null', () => {
  const s = createStore();
  s.initialize({ $days: 7 });
  s.set('$days', 30);
  assert.equal(s.get('$days'), 30);
  s.reset(['$days']);
  assert.equal(s.get('$days'), 7);
});

test('@Reset of an undeclared variable clears it', () => {
  const s = createStore();
  s.set('$loose', 'x');
  s.reset(['$loose']);
  assert.equal(s.get('$loose'), undefined);
});

test('a first initialize notifies nobody', () => {
  const s = createStore();
  let n = 0;
  s.subscribe(() => n++);
  s.initialize({ $days: 7, $view: 'cost' });
  assert.equal(n, 0, 'the materializer already reads the declaring statement, so nothing on screen moved');
});

test('a revision that moves a declared default moves an untouched variable', () => {
  const s = createStore();
  s.initialize({ $days: 7 });
  const heard = [];
  s.subscribe((c) => heard.push(...c.names));
  s.initialize({ $days: 30 });
  assert.equal(s.get('$days'), 30);
  assert.deepEqual(heard, ['$days']);
});

test('a revision that moves a default leaves a variable the user set alone', () => {
  const s = createStore();
  s.initialize({ $days: 7 });
  s.set('$days', 90);
  s.initialize({ $days: 30 });
  assert.equal(s.get('$days'), 90, 'a filter the user moved must survive a revision turn');
  s.reset(['$days']);
  assert.equal(s.get('$days'), 30, 'but the new declaration is what it resets to');
});

test('an explicit null is a value, not an absence', () => {
  const s = createStore();
  s.initialize({ $sel: 'a' });
  s.set('$sel', null);
  assert.equal(s.get('$sel'), null);
});

test('a throwing subscriber does not stop the others', () => {
  const s = createStore();
  let reached = false;
  s.subscribe(() => { throw new Error('boom'); });
  s.subscribe(() => { reached = true; });
  s.set('$a', 1);
  assert.equal(reached, true);
});

test('unsubscribe stops delivery', () => {
  const s = createStore();
  let n = 0;
  const off = s.subscribe(() => n++);
  s.set('$a', 1);
  off();
  s.set('$a', 2);
  assert.equal(n, 1);
});
