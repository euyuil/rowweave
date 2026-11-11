import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { startServer } from '../src/http-server.js';

test('HTTP writes expose validation, conflict and body-size errors without losing saved data', async t => {
  const token = randomBytes(32).toString('hex');
  const store = fixture(t).open();
  const server = await startServer({ service: new RecordService(store), token });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const patch = (body: string) => fetch(`${server.url}/tables/prototype/records`, { method: 'PATCH', headers, body });
  const update = [{ id: 'record_1', expectedVersion: 1, values: { field_1: 'Saved' } }];
  const saved = await patch(JSON.stringify(update));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).records[0].version, 2);
  const conflict = await patch(JSON.stringify(update));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'VERSION_CONFLICT');
  assert.equal((await patch('{')).status, 400);
  assert.equal((await patch('{}')).status, 400);
  assert.equal((await patch(' '.repeat(8 * 1024 * 1024 + 1))).status, 413);
  assert.equal(store.readPage(0, 1).records[0]?.values['field_1'], 'Saved');
});
