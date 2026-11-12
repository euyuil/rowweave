import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { startServer } from '../src/http-server.js';

test('HTTP queries return totals and revisions and reject stale continuation pages', async t => {
  const service = new RecordService(fixture(t).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const query = (body: unknown) => fetch(`${server.url}/tables/prototype/query`, { method: 'POST', headers, body: JSON.stringify(body) });
  const first = await (await query({ limit: 2, fields: ['field_1'] })).json();
  assert.equal(first.total, 12);
  assert.equal(first.records.length, 2);
  assert.equal(first.schemaVersion, 1);
  assert.deepEqual(Object.keys(first.records[0].values), ['field_1']);
  service.updateBatch([{ id: 'record_1', expectedVersion: 1, values: { field_1: 'Changed' } }]);
  const stale = await query({ offset: 2, expectedRevision: first.revision });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'DATA_CHANGED');
  const filtered = await (await query({ filter: { conjunction: 'and', conditions: [{ fieldId: 'field_1', operator: 'eq', value: 'Changed' }] } })).json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.records[0].id, 'record_1');
  assert.equal((await query({ fields: ['unknown'] })).status, 400);
});
