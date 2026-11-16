import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { createWorkspaceClient } from '../../../packages/client/src/http-client.js';
import { startServer } from '../src/http-server.js';

test('live notifications require authorization and follow committed writes and reconnects', async t => {
  const service = new RecordService(fixture(t).open()), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  assert.equal((await fetch(server.url + '/workspace/events')).status, 401);
  const controller = new AbortController();
  const response = await fetch(server.url + '/workspace/events', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /\{\}/);
  const api = createWorkspaceClient({ url: server.url, token });
  await api.updateRecords('prototype', [{ id: 'record_1', expectedVersion: 1, values: { field_1: 'Live' } }]);
  assert.match(new TextDecoder().decode((await reader.read()).value), /\{\}/);
  assert.equal((await api.getRecord('prototype', 'record_1')).values['field_1'], 'Live');
  await reader.cancel(); controller.abort();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Notification timed out')), 2_000);
    const unsubscribe = api.watchWorkspace(() => { clearTimeout(timer); unsubscribe(); resolve(); }, reject);
  });
});

test('service shutdown ends active notification streams', { timeout: 3_000 }, async t => {
  const service = new RecordService(fixture(t).open()), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  const response = await fetch(server.url + '/workspace/events', { headers: { Authorization: `Bearer ${token}` } });
  const reader = response.body!.getReader();
  await reader.read();
  await server.close();
  assert.equal((await reader.read()).done, true);
});
