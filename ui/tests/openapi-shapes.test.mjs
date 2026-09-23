/**
 * openapi-shapes.mjs — the reader that turns the OpenAPI snapshot into the
 * manifest's shape vocabulary, and the comparer that says where a declared
 * shape and the backend disagree.
 *
 * Small hand-built specs rather than the committed snapshot: the snapshot
 * changes whenever the backend does, and a test that breaks on an unrelated
 * route being annotated teaches people to ignore it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findOperation, responseShape, queryParams, normalizeSchema, normalizeDeclared,
  compareShapes, applyReturns, omitPath,
} from '../scripts/openapi-shapes.mjs';
import { canonical, summarizeDrift } from '../scripts/openapi-snapshot.mjs';

const spec = {
  paths: {
    '/api/things': { get: {
      parameters: [{ name: 'limit', in: 'query' }, { name: 'status', in: 'query', required: false }],
      responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Thing' } } } } } },
    } },
    '/api/things/{id}': { get: {
      parameters: [{ name: 'id', in: 'path', required: true }],
      responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } } },
    } },
    '/api/rows': { get: {
      responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Rows' } } } } },
    } },
  },
  components: { schemas: {
    Thing: {
      type: 'object',
      required: ['id', 'count'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        count: { type: 'integer', format: 'int64' },
        note: { type: ['string', 'null'] },
        blob: {},
        child: { $ref: '#/components/schemas/Child' },
      },
    },
    Child: { type: 'object', properties: { name: { type: 'string' }, parent: { $ref: '#/components/schemas/Thing' } } },
    Envelope: { type: 'object', properties: { data: { $ref: '#/components/schemas/Thing' }, message: { type: 'string' }, status_code: { type: 'integer' } } },
    // A tagged enum: two row shapes behind one `rows`.
    Rows: { type: 'object', properties: { data: { oneOf: [
      { type: 'object', properties: { view: { type: 'string' }, rows: { type: 'array', items: { type: 'object', properties: { agent_id: { type: 'string' }, total_cost: { type: 'number' } } } } } },
      { type: 'object', properties: { view: { type: 'string' }, rows: { type: 'array', items: { type: 'object', properties: { maf_id: { type: 'string' }, total_cost: { type: 'number' } } } } } },
    ] } } },
  } },
};

test('findOperation matches the frontend route form: no /api prefix, ${…} for a path parameter', () => {
  assert.equal(findOperation(spec, '/things').path, '/api/things');
  assert.equal(findOperation(spec, '/things/${encodeURIComponent(id)}').path, '/api/things/{id}');
  assert.equal(findOperation(spec, '/nothing'), null);
  assert.equal(findOperation(spec, null), null);
});

test('queryParams lists only query parameters, with whether each is required', () => {
  const q = queryParams(findOperation(spec, '/things').operation);
  assert.deepEqual([...q.keys()], ['limit', 'status']);
  assert.equal(queryParams(findOperation(spec, '/things/${x}').operation).size, 0);
});

test('normalizeSchema: integer is number, [type, null] is nullable, {} is any, a $ref cycle ends', () => {
  const t = normalizeSchema(spec, { $ref: '#/components/schemas/Thing' });
  assert.equal(t.kind, 'object');
  assert.deepEqual(t.props.count, { kind: 'scalar', type: 'number', nullable: false });
  assert.deepEqual(t.props.note, { kind: 'scalar', type: 'string', nullable: true });
  assert.equal(t.props.blob.type, 'any');
  // Thing → Child → Thing: the second Thing resolves to `any` instead of recursing.
  assert.equal(t.props.child.props.parent.type, 'any');
});

test('a tagged enum folds into one object; only fields every variant carries can be undeclared', () => {
  const wire = responseShape(spec, findOperation(spec, '/rows').operation);
  const declared = normalizeDeclared({ data: { view: 'string', rows: [{ agent_id: 'string', total_cost: 'number' }] } });
  assert.deepEqual(compareShapes(declared, wire), []);
  // A field in NO variant is still caught.
  const bad = normalizeDeclared({ data: { view: 'string', rows: [{ nope: 'string', total_cost: 'number' }] } });
  assert.deepEqual(compareShapes(bad, wire).map((f) => f.code), ['missing_in_spec']);
});

test('compareShapes reports the three disagreements, and nullability apart', () => {
  const wire = responseShape(spec, findOperation(spec, '/things').operation);
  const declared = normalizeDeclared([{ id: 'string (uuid)', count: 'string', note: 'string', extra: 'number', child: { name: 'string' } }]);
  const byCode = Object.groupBy(compareShapes(declared, wire), (f) => f.code);
  assert.deepEqual(byCode.type_mismatch.map((f) => f.path), ['[].count']);
  assert.deepEqual(byCode.nullability.map((f) => f.path), ['[].note']);
  assert.deepEqual(byCode.missing_in_spec.map((f) => f.path), ['[].extra']);
  // A backend field of type `any` (free-form JSON, or a $ref cycle) is still a
  // field the shape has to decide about — declare it, or $omit it with a reason.
  assert.deepEqual(byCode.undeclared.map((f) => f.path).sort(), ['[].blob', '[].child.parent']);
});

test('a declared type the checker cannot read is a finding, not a pass', () => {
  const wire = responseShape(spec, findOperation(spec, '/things').operation);
  const declared = normalizeDeclared([{ id: 'uuid', count: 'number', note: 'string|null', blob: 'any', child: { name: 'string', parent: 'any' } }]);
  const f = compareShapes(declared, wire);
  assert.deepEqual(f.map((x) => [x.code, x.path]), [['type_mismatch', '[].id']]);
});

test('ignoreRootKeys drops the envelope at the root and nowhere else', () => {
  const wire = responseShape(spec, findOperation(spec, '/things/${id}').operation);
  const declared = normalizeDeclared({ data: { id: 'string', count: 'number', note: 'string|null', blob: 'any', child: { name: 'string', parent: 'any' } } });
  assert.deepEqual(compareShapes(declared, wire, '', [], { ignoreRootKeys: ['message', 'status_code'] }), []);
  assert.equal(compareShapes(declared, wire).filter((f) => f.code === 'undeclared').length, 2);
});

test('applyReturns builds the wrapper a reshaping function returns, around the wire payload', () => {
  const wire = responseShape(spec, findOperation(spec, '/things').operation);
  const shaped = applyReturns({ data: '$response', total: 'number' }, wire);
  assert.equal(shaped.kind, 'object');
  assert.equal(shaped.props.data.kind, 'array');
  assert.equal(shaped.props.total.type, 'number');
  const inner = applyReturns('$response.data', responseShape(spec, findOperation(spec, '/things/${id}').operation));
  assert.equal(inner.kind, 'object');
  assert.throws(() => applyReturns('$response.nope', wire), /no "nope"/);
});

test('omitPath removes a named field, through arrays, and refuses a field that is not there', () => {
  const wire = responseShape(spec, findOperation(spec, '/things').operation);
  const pruned = omitPath(omitPath(wire, '[].blob'), '[].child.parent');
  assert.ok(!('blob' in pruned.items.props));
  assert.ok(!('parent' in pruned.items.props.child.props));
  assert.ok('blob' in wire.items.props, 'the input is not mutated');
  assert.throws(() => omitPath(wire, '[].nope'), /no "nope"/);
  assert.throws(() => omitPath(wire, 'blob'), /not an array|no "blob"/);
});

test('canonical form sorts keys at every depth and keeps array order', () => {
  const a = canonical({ b: 1, a: { d: [3, 1, 2], c: null } });
  const b = canonical({ a: { c: null, d: [3, 1, 2] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      1,\n      2\n    ]\n  },\n  "b": 1\n}\n');
});

test('summarizeDrift names paths and schemas that appeared, vanished or changed', () => {
  const before = { paths: { '/a': { get: {} }, '/b': { get: {} } }, components: { schemas: { X: { type: 'object' } } } };
  const after = { paths: { '/a': { get: { summary: 's' } }, '/c': { get: {} } }, components: { schemas: { X: { type: 'object' }, Y: {} } } };
  assert.deepEqual(summarizeDrift(before, after), ['  + path /c', '  - path /b', '  ~ path /a', '  + schema Y']);
});
