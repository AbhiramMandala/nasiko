import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {callReadSource} from '../common/surface/source-policy.js';
import {createQueryManager} from '../common/surface/queries.js';
const manifest = JSON.parse(readFileSync(new URL('../common/surface/data-manifest.json', import.meta.url)));

test('the runtime calls only approved reads, including the saved legacy inventory', () => {
  const seen = [];
  const invoke = (...args) => seen.push(args);
  for (const source of manifest.scopes.tokenops) callReadSource(manifest, invoke, source.name, [1]);
  assert.equal(seen.length, 9);
  for (const name of ['deleteAgent', 'fetchAnything', '__proto__']) {
    assert.throws(() => callReadSource(manifest, invoke, name, []), /not approved/);
  }
  assert.throws(() => callReadSource(null, invoke, 'fetchUsageSummary', []), /not approved/);
  assert.equal(seen.length, 9);
});

test('a mutation cannot bypass the generated-surface policy by using an approved read name', async () => {
  const seen = [];
  const diagnostics = [];
  const queries = createQueryManager({call: (...args) => seen.push(args), allowMutations: false,
    onDiagnostic: d => diagnostics.push(d)});
  queries.sync([], [{statementId: 'm', source: 'fetchUsageSummary'}]);
  assert.equal((await queries.fireMutation('m', [])).ok, false);
  assert.deepEqual(seen, []);
  assert.equal(diagnostics[0].code, 'mutation_not_allowed');
});
