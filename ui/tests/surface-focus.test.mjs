/**
 * Caret preservation across the renderer's full rebuild.
 *
 * The renderer has no reconciler, so a `$state` write destroys and recreates
 * the input the user is typing into — one character lands and focus drops to
 * <body>. These are the two halves of the mitigation, driven through a hand-
 * built document rather than a browser: what is under test is the decision to
 * restore or refuse, which is pure logic. That it actually holds a caret in a
 * real input is a browser test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { captureFocus, restoreFocus } = await import(
  new URL('../common/surface/focus.js', import.meta.url).href);

/** The smallest element that answers what focus.js asks of one. */
function el(tag, extra = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    parentElement: null,
    focused: false,
    focusOpts: null,
    range: null,
    focus(opts) { node.focused = true; node.focusOpts = opts; doc.activeElement = node; },
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === node) return true;
      return false;
    },
    append(...kids) {
      for (const k of kids) { k.parentElement = node; node.children.push(k); }
      return node;
    },
    ...extra,
  };
  return node;
}

/** A text control: reports a selection and accepts one back. */
function input(value = '') {
  return el('input', {
    value,
    selectionStart: 0,
    selectionEnd: 0,
    selectionDirection: 'none',
    setSelectionRange(s, e, d) { this.range = [s, e, d]; },
  });
}

const doc = { activeElement: null };

/** container > app-search > input, which is the real shape being protected. */
function tree(value = 'ab') {
  const container = el('div');
  const search = el('app-search');
  const field = input(value);
  container.append(search);
  search.append(field);
  return { container, search, field };
}

test('the caret comes back to the same field, at the same offset', () => {
  const before = tree('abc');
  before.field.selectionStart = 2;
  before.field.selectionEnd = 2;
  doc.activeElement = before.field;
  const snapshot = captureFocus(before.container, doc);

  // What the renderer does: same shape, all-new nodes.
  const after = tree('abc');
  assert.equal(restoreFocus(after.container, snapshot), true);
  assert.equal(after.field.focused, true);
  assert.deepEqual(after.field.range, [2, 2, 'none']);
  assert.equal(before.field.focused, false, 'the old node is gone, not refocused');
});

test('refocusing never scrolls — a repaint is not a navigation', () => {
  // Without preventScroll a filter box below the fold drags the page to itself
  // on every keystroke, which is a worse bug than the one being fixed.
  const before = tree();
  doc.activeElement = before.field;
  const after = tree();
  restoreFocus(after.container, captureFocus(before.container, doc));
  assert.deepEqual(after.field.focusOpts, { preventScroll: true });
});

test('a reshaped tree is refused, not guessed at', () => {
  // A $view toggle swaps the control for something else. The index still
  // resolves — that is exactly the danger — so the tag is what catches it.
  const before = tree();
  doc.activeElement = before.field;
  const snapshot = captureFocus(before.container, doc);

  const after = el('div');
  const chart = el('app-chart');
  after.append(chart);
  chart.append(el('canvas'));
  assert.equal(restoreFocus(after, snapshot), false, 'must not focus a different control');
});

test('a shorter value clamps the offset instead of throwing', () => {
  // The repaint that lost the caret can also be the one that shortened the
  // value — a Query landing, a @Reset. A saved offset past the end throws in
  // some browsers rather than saturating.
  const before = tree('abcdef');
  before.field.selectionStart = 6;
  before.field.selectionEnd = 6;
  doc.activeElement = before.field;
  const snapshot = captureFocus(before.container, doc);

  const after = tree('ab');
  assert.equal(restoreFocus(after.container, snapshot), true);
  assert.deepEqual(after.field.range, [2, 2, 'none']);
});

test('focus outside the surface is left alone', () => {
  // The prompt box lives on the page, not in the container. Capturing it would
  // mean every paint steals focus back into the dashboard mid-sentence.
  const { container } = tree();
  const elsewhere = input('typing in the composer');
  doc.activeElement = elsewhere;
  assert.equal(captureFocus(container, doc), null);
});

test('nothing focused, and the container itself, are both no-ops', () => {
  const { container } = tree();
  doc.activeElement = null;
  assert.equal(captureFocus(container, doc), null);
  doc.activeElement = container;
  assert.equal(captureFocus(container, doc), null);
  assert.equal(restoreFocus(container, null), false);
});

test('a focused element with no selection still gets its focus back', () => {
  // A button or a checkbox mid-keyboard-navigation. Reading selectionStart off
  // one throws in some browsers, so the capture is a capability test.
  const container = el('div');
  const button = el('app-button');
  const inner = el('button');
  // Defined after construction, not through the spread — a spread reads the
  // getter, so the throw would land while building the fixture rather than
  // where a real DOM throws it, which is on access.
  Object.defineProperty(inner, 'selectionStart', {
    get() { throw new TypeError('no selection on this input type'); },
  });
  container.append(button);
  button.append(inner);
  doc.activeElement = inner;

  const snapshot = captureFocus(container, doc);
  assert.equal(snapshot.start, null);

  const after = el('div');
  const button2 = el('app-button');
  const inner2 = el('button');
  after.append(button2);
  button2.append(inner2);
  assert.equal(restoreFocus(after, snapshot), true);
  assert.equal(inner2.focused, true);
});
