import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { ApiFailure, createWorkspaceClient } from '../../../packages/client/src/http-client.js';
import { startServer } from '../src/http-server.js';

test('CSV HTTP and client support preview, atomic import and text export with common authentication and errors', async t => {
  const service = new RecordService(fixture(t, null).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  let table = await api.createTable({ name: 'Data exchange' });
  table = await api.createField(table.id, { expectedVersion: 1, name: 'Amount', type: 'number' });
  const input = { expectedVersion: table.version, hasHeader: true, csv: 'Name,Amount\r\n"中文,🌱",123\r\n' };
  const preview = await api.previewCsv(table.id, input);
  assert.equal(preview.invalid, 0);
  assert.equal(preview.total, 1);
  assert.deepEqual(await api.importCsv(table.id, input), { imported: 1 });
  assert.equal(await api.exportCsv(table.id), '\uFEFF' + input.csv);
  await assert.rejects(api.importCsv(table.id, { ...input, csv: input.csv + 'bad,not a number' }), (error: unknown) => error instanceof ApiFailure && error.code === 'INVALID_VALUE');
  assert.equal((await api.getTable(table.id)).total, 1);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const response = await fetch(`${server.url}/tables/${table.id}/export`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(response.headers.get('content-disposition')!, /attachment/);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf]);
  for (const path of ['import', 'import/preview', 'export']) {
    assert.equal((await fetch(`${server.url}/tables/${table.id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  }
  await assert.rejects(createWorkspaceClient({ url: server.url, token: 'wrong' }).exportCsv(table.id), (error: unknown) => error instanceof ApiFailure && error.code === 'UNAUTHORIZED');
  await assert.rejects(api.exportCsv(table.id, { viewId: 'missing' }), (error: unknown) => error instanceof ApiFailure && error.code === 'VIEW_NOT_FOUND');
  await assert.rejects(api.previewCsv(table.id, input, AbortSignal.abort()), (error: unknown) => error instanceof Error && error.name === 'AbortError');
});

test('CSV upload accepts files above the ordinary JSON body limit while preserving cell validation', async t => {
  const service = new RecordService(fixture(t, null).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const table = await api.createTable({ name: 'Large file' });
  const csv = 'Name\n' + ('x'.repeat(9_000) + '\n').repeat(1_000);
  const preview = await api.previewCsv(table.id, { expectedVersion: 1, hasHeader: true, csv });
  assert.equal(preview.total, 1_000);
  assert.equal(preview.invalid, 0);
  assert.equal(preview.samples[0]!.cells[0]!.length, 201);
  assert.equal((await api.getTable(table.id)).total, 0);
});
