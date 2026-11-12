import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { startServer } from '../src/http-server.js';

test('HTTP views can be created, queried, updated and deleted with version checks', async t => {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service: new RecordService(fixture(t).open()), token });
  t.after(() => server.close());
  const root = `${server.url}/tables/prototype/views`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${root}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await (await call('')).json()).length, 1);
  const response = await call('', 'POST', { name: 'Saved' });
  assert.equal(response.status, 201);
  const view = await response.json();
  const page = await (await call(`/${view.id}/query`, 'POST', { limit: 2 })).json();
  assert.equal(page.total, 12);
  assert.equal(page.viewVersion, 1);
  assert.equal((await call(`/${view.id}`, 'PATCH', { expectedVersion: 1, name: 'Renamed' })).status, 200);
  assert.equal((await call(`/${view.id}/query`, 'POST', { expectedViewVersion: 1 })).status, 409);
  assert.equal((await (await call(`/${view.id}`)).json()).name, 'Renamed');
  assert.equal((await call(`/${view.id}`, 'DELETE', { expectedVersion: 2 })).status, 200);
  assert.equal((await call(`/${view.id}`)).status, 404);
});
