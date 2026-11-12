import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { startServer } from '../src/http-server.js';

test('HTTP clients can manage multiple table schemas with versioned writes', async t => {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service: new RecordService(fixture(t, null).open()), token });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${server.url}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.deepEqual(await (await call('/tables')).json(), []);
  const response = await call('/tables', 'POST', { name: 'Projects' });
  assert.equal(response.status, 201);
  const table = await response.json();
  const root = `/tables/${table.id}`;
  const added = await (await call(`${root}/fields`, 'POST', { expectedVersion: 1, name: 'Notes', type: 'text' })).json();
  assert.equal(added.version, 2);
  const fieldId = added.fields[1].id;
  assert.equal((await call(`${root}/fields/${fieldId}`, 'PATCH', { expectedVersion: 1, name: 'Stale' })).status, 409);
  assert.equal((await call(`${root}/fields/${fieldId}`, 'PATCH', { expectedVersion: 2, name: 'Details' })).status, 200);
  const renamed = await (await call(root, 'PATCH', { expectedVersion: 3, name: 'Active projects' })).json();
  assert.equal(renamed.name, 'Active projects');
  assert.equal(renamed.fields[1].name, 'Details');
  assert.deepEqual((await (await call(`${root}/records`)).json()).records, []);
  assert.equal((await call(`${root}/fields/${fieldId}`, 'DELETE', { expectedVersion: 4 })).status, 200);
  assert.equal((await call(root, 'DELETE', { expectedVersion: 5 })).status, 200);
  assert.equal((await call(root)).status, 404);
  assert.deepEqual(await (await call('/tables')).json(), []);
});
