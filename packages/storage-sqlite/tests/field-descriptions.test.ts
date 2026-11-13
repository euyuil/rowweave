import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

test('field descriptions survive edits, conversion, restart and backup without rewriting records', async t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Guidance' });
  const description = '  Enter the invoice total.\n含税金额 <b>plain text</b>  ';
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'text', description });
  const field = table.fields[1]!;
  assert.equal(field.description, description.trim());
  const record = service.createRecords(table.id, [{ values: { [field.id]: '12.5' } }]).records[0]!;
  const history = service.recordHistory(table.id, record.id, {});
  table = service.updateField(table.id, field.id, { expectedVersion: table.version, name: 'Total' });
  assert.equal(table.fields[1]!.description, description.trim());
  table = service.updateField(table.id, field.id, { expectedVersion: table.version, description: 'New guidance' });
  assert.deepEqual(service.getRecord(table.id, record.id), record);
  assert.deepEqual(service.recordHistory(table.id, record.id, {}), history);
  const conversion = { expectedVersion: table.version, field: { name: 'Total', type: 'number' } };
  assert.equal(service.previewConversion(table.id, field.id, conversion).field.description, 'New guidance');
  table = service.applyConversion(table.id, field.id, conversion);
  assert.equal(table.fields[1]!.id, field.id); assert.equal(table.fields[1]!.description, 'New guidance');
  assert.equal(service.getRecord(table.id, record.id).values[field.id], 12.5);
  store.close();
  assert.deepEqual(new RecordService(data.open()).getTable(table.id), table);
  const backup = join(dirname(data.path), 'backup.sqlite'), restored = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, restored);
  const restoredStore = new SqliteRecordStore(restored);
  try { assert.deepEqual(restoredStore.getTable(table.id), table); }
  finally { restoredStore.close(); }
});

test('HTTP and SDK validate description limits, preserve omitted values and reject stale updates', async t => {
  const service = new RecordService(fixture(t, null).open()), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token }); t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  let table = await api.createTable({ name: 'Descriptions' });
  const field = table.primaryFieldId, original = table;
  table = await api.updateField(table.id, field, { expectedVersion: table.version, description: 'a'.repeat(2000) });
  assert.equal(table.fields[0]!.description?.length, 2000);
  await assert.rejects(api.updateField(table.id, field, { expectedVersion: original.version, description: 'Stale' }), { code: 'SCHEMA_CONFLICT' });
  for (const description of [null, 42, {}, 'a'.repeat(2001)]) {
    const response = await fetch(`${server.url}/tables/${table.id}/fields/${field}`, { method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: table.version, description }) });
    assert.equal(response.status, 400); assert.equal((await response.json() as { error: { code: string } }).error.code, 'INVALID_SCHEMA');
    assert.deepEqual(await api.getTable(table.id), table);
  }
  table = await api.updateField(table.id, field, { expectedVersion: table.version, description: ' \n ' });
  assert.equal(Object.hasOwn(table.fields[0]!, 'description'), false);
});
