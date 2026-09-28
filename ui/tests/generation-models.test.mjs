/**
 * The model list the dock and the page offer, and the choice they remember.
 *
 * The route is held to the same JSON file by a Rust test
 * (every_generation_model_is_in_generation_models_json), so what these pin is
 * the browser half: only a well-formed list is ever offered, a remembered
 * choice survives only while it is still on offer, and the options both hosts
 * render come from one function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkedModels, chosenModel, rememberModel, modelLabel, modelOptions,
} from '../common/surface/generation-models.js';

const FILE = JSON.parse(readFileSync(new URL('../common/surface/generation-models.json', import.meta.url)));

/** A Storage stand-in; `broken` throws the way private mode can. */
function store(initial = {}, { broken = false } = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => { if (broken) throw new Error('denied'); return data.has(k) ? data.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('denied'); data.set(k, String(v)); },
    data,
  };
}

test('the shipped list is well formed, defaults to Haiku, and offers Sonnet 5', () => {
  const list = checkedModels(FILE);
  assert.ok(list, 'the real file must pass the same check the picker applies');
  assert.equal(list.default, 'haiku');
  assert.deepEqual(list.models.map((m) => m.key), ['haiku', 'sonnet']);
  assert.match(modelLabel(list, 'sonnet'), /Sonnet 5/);
});

test('the list carries keys, never model ids', () => {
  // What reaches the wire is whatever `key` says. A provider id here would be
  // a page naming its own model — exactly what the route exists to prevent.
  for (const m of FILE.models) assert.doesNotMatch(m.key, /anthropic|claude|[.:]/, m.key);
});

test('a list whose default is not one of its models is refused, not guessed around', () => {
  assert.equal(checkedModels({ default: 'opus', models: [{ key: 'haiku', label: 'Haiku' }] }), null);
  assert.equal(checkedModels({ default: 'haiku', models: [] }), null);
  assert.equal(checkedModels(null), null);
  assert.equal(checkedModels({ default: 'haiku', models: 'haiku' }), null);
});

test('with nothing remembered, the default is preselected', () => {
  assert.equal(chosenModel(checkedModels(FILE), store()), 'haiku');
});

test('a remembered choice is preselected while it is still offered', () => {
  const s = store();
  rememberModel('sonnet', s);
  assert.equal(chosenModel(checkedModels(FILE), s), 'sonnet');
});

test('a remembered model that is no longer offered falls back to the default', () => {
  assert.equal(chosenModel(checkedModels(FILE), store({ 'weave-model': 'retired-model' })), 'haiku');
});

test('storage that throws still yields the default, and remembering is a no-op', () => {
  const s = store({}, { broken: true });
  assert.equal(chosenModel(checkedModels(FILE), s), 'haiku');
  assert.doesNotThrow(() => rememberModel('sonnet', s));
});

test('an unloadable list chooses nothing, so the request carries no key', () => {
  assert.equal(chosenModel(null, store({ 'weave-model': 'sonnet' })), null);
});

test('both hosts render the same options, keyed by the model key', () => {
  assert.deepEqual(JSON.parse(modelOptions(checkedModels(FILE))), [
    { value: 'haiku', label: modelLabel(checkedModels(FILE), 'haiku') },
    { value: 'sonnet', label: modelLabel(checkedModels(FILE), 'sonnet') },
  ]);
});
