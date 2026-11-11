import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { startServer } from '../src/http-server.js';

test('HTTP reads require a token, reject foreign origins, and validate pagination', async t => {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service: new RecordService(fixture(t).open()), token });
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${server.url}/tables/prototype`)).status, 401);
  assert.equal((await fetch(`${server.url}/tables/prototype`, {
    headers: { ...headers, Origin: 'https://example.com' },
  })).status, 403);
  const table = await fetch(`${server.url}/tables/prototype`, { headers }).then(r => r.json());
  assert.equal(table.total, 12);
  const page = await fetch(`${server.url}/tables/prototype/records?offset=5&limit=2`, { headers }).then(r => r.json());
  assert.deepEqual(page.records.map((row: { id: string }) => row.id), ['record_6', 'record_7']);
  assert.equal((await fetch(`${server.url}/tables/prototype/records?limit=501`, { headers })).status, 400);
  assert.equal((await fetch(`${server.url}/unknown`, { headers })).status, 404);
});
