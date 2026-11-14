import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fixture, removeWorkspaceState } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

test('transaction receipts count final record changes, exclude failed writes and page stably without snapshots', t => {
  const service = new RecordService(fixture(t, null, () => new Date('2026-11-13T10:00:00Z')).open());
  let table = service.createTable({ name: 'Batches' });
  assert.deepEqual(service.recordBatches(table.id, {}), { batches: [] });
  const records = service.createRecords(table.id, ['1', '2'].map(name => ({ values: { [table.primaryFieldId]: name } }))).records;
  const created = service.recordBatches(table.id, {}).batches[0]!;
  assert.equal(created.recordCount, 2); assert.equal(created.remainingCount, 2); assert.equal(created.recordWrite, true);
  assert.equal(created.changedAt, '2026-11-13T10:00:00.000Z');
  const detail = service.recordBatchChanges(table.id, created.id, { limit: 1 });
  assert.equal(detail.changes.length, 1); assert.ok(detail.nextBefore);
  assert.equal(Object.hasOwn(detail.changes[0]!, 'before'), false);
  assert.deepEqual(service.recordBatchChanges(table.id, created.id, { before: detail.nextBefore }).changes.map(change => change.recordId), [records[0]!.id]);
  assert.throws(() => service.updateBatch(records.map((record, index) => ({ id: record.id, expectedVersion: index ? 99 : 1, values: { [table.primaryFieldId]: '3' } })), table.id), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(service.recordBatches(table.id, {}).batches, [created]);
  table = service.applyConversion(table.id, table.primaryFieldId, { expectedVersion: table.version, field: { name: 'Number', type: 'number' } });
  const page = service.recordBatches(table.id, { limit: 1 });
  assert.equal(page.batches[0]!.recordWrite, false);
  assert.equal(page.batches[0]!.recordCount, 2);
  service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 4 } }]);
  assert.deepEqual(service.recordBatches(table.id, { before: page.nextBefore }).batches, [created]);
  assert.deepEqual(service.recordBatchChanges(table.id, created.id, { limit: 1 }), detail);
  for (const input of [{ limit: 101 }, { before: -1 }]) {
    assert.throws(() => service.recordBatches(table.id, input), { code: 'INVALID_HISTORY' });
    assert.throws(() => service.recordBatchChanges(table.id, created.id, input), { code: 'INVALID_HISTORY' });
  }
  const other = service.createTable({ name: 'Other' });
  assert.throws(() => service.recordBatchChanges(other.id, created.id, {}), { code: 'HISTORY_NOT_FOUND' });
});

test('receipts include reciprocal side effects and retain original size after a related table is removed', t => {
  const service = new RecordService(fixture(t, null).open());
  let projects = service.createTable({ name: 'Projects' }), tasks = service.createTable({ name: 'Tasks' });
  const project = service.createRecords(projects.id, [{ values: {} }]).records[0]!;
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project', type: 'relation', relation: { tableId: projects.id, multiple: false }, reverseField: { name: 'Tasks', multiple: true, expectedVersion: projects.version } });
  const link = tasks.fields[1]!.id;
  const task = service.createRecords(tasks.id, [{ values: { [link]: [project.id] } }]).records[0]!;
  const batch = service.recordBatches(tasks.id, {}).batches[0]!;
  assert.equal(batch.recordCount, 2);
  const changes = service.recordBatchChanges(tasks.id, batch.id, {}).changes;
  assert.deepEqual(new Set(changes.map(change => change.tableId)), new Set([tasks.id, projects.id]));
  assert.equal(changes.find(change => change.recordId === project.id)!.afterVersion, service.getRecord(projects.id, project.id).version);
  assert.deepEqual(service.recordBatchChanges(projects.id, batch.id, {}), service.recordBatchChanges(tasks.id, batch.id, {}));
  tasks = service.deleteField(tasks.id, link, { expectedVersion: tasks.version });
  projects = service.getTable(projects.id);
  projects = service.deleteField(projects.id, projects.fields[1]!.id, { expectedVersion: projects.version });
  service.deleteTable(tasks.id, { expectedVersion: tasks.version });
  const remaining = service.recordBatchChanges(projects.id, batch.id, {});
  assert.equal(remaining.batch.recordCount, 2); assert.equal(remaining.batch.remainingCount, 1);
  assert.deepEqual(remaining.changes.map(change => change.recordId), [project.id]);
  assert.equal(remaining.changes.some(change => change.recordId === task.id), false);
});

test('CSV, deletion and both restoration paths create record-operation receipts', t => {
  const service = new RecordService(fixture(t, null).open()), table = service.createTable({ name: 'Import' });
  service.importCsv(table.id, { expectedVersion: table.version, csv: 'Name\nOne\nTwo\n', hasHeader: true });
  const imported = service.recordBatches(table.id, {}).batches[0]!;
  assert.equal(imported.recordWrite, true); assert.equal(imported.recordCount, 2);
  const row = service.queryRecords(table.id, {}).records[0]!, change = service.recordHistory(table.id, row.id, {}).changes[0]!;
  const restored = service.restoreRecord(table.id, row.id, { changeId: change.id, snapshot: 'after', expectedVersion: row.version });
  assert.equal(service.recordBatches(table.id, {}).batches[0]!.recordWrite, true);
  service.deleteRecords(table.id, [{ id: row.id, expectedVersion: restored.version }]);
  const deleted = service.recordBatches(table.id, {}).batches[0]!;
  assert.equal(deleted.recordWrite, true); assert.equal(deleted.recordCount, 1);
  service.restoreDeletedRecords(table.id, service.recordTrash(table.id, {}).records);
  assert.equal(service.recordBatches(table.id, {}).batches[0]!.recordWrite, true);
});

test('format-17 migration preserves history without inventing old receipts and new receipts survive backup', async t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store), table = service.createTable({ name: 'Old' });
  const row = service.createRecords(table.id, [{ values: {} }]).records[0]!, history = service.recordHistory(table.id, row.id, {});
  store.close();
  const db = new DatabaseSync(data.path);
  removeWorkspaceState(db); db.exec('DROP TABLE attachments; DROP TABLE field_sequences; DROP TABLE record_batch_tables; DROP TABLE record_batches; PRAGMA user_version = 17;'); db.close();
  const migrated = new RecordService(data.open());
  assert.deepEqual(migrated.recordHistory(table.id, row.id, {}), history);
  assert.deepEqual(migrated.recordBatches(table.id, {}), { batches: [] });
  assert.throws(() => migrated.recordBatchChanges(table.id, history.changes[0]!.batchId, {}), { code: 'HISTORY_NOT_FOUND' });
  migrated.updateBatch([{ id: row.id, expectedVersion: 1, values: { [table.primaryFieldId]: 'New value' } }], table.id);
  const batch = migrated.recordBatches(table.id, {}).batches[0]!;
  const backup = join(dirname(data.path), 'backup.sqlite'), restoredPath = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup); assert.equal((await restoreWorkspace(backup, restoredPath)).version, 34);
  const restoredStore = new SqliteRecordStore(restoredPath);
  try {
    const restored = new RecordService(restoredStore);
    assert.deepEqual(restored.recordBatches(table.id, {}), migrated.recordBatches(table.id, {}));
    assert.deepEqual(restored.recordBatchChanges(table.id, batch.id, {}), migrated.recordBatchChanges(table.id, batch.id, {}));
  } finally { restoredStore.close(); }
});

test('HTTP and SDK expose authenticated bounded transaction inspection', async t => {
  const service = new RecordService(fixture(t, null).open()), table = service.createTable({ name: 'HTTP' }), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token }); t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const rows = (await api.createRecords(table.id, [{ values: {} }, { values: {} }])).records;
  const batch = (await api.recordBatches(table.id)).batches[0]!;
  assert.equal(batch.recordCount, 2);
  const page = await api.recordBatchChanges(table.id, batch.id, { limit: 1 });
  assert.equal(page.changes[0]!.recordId, rows[1]!.id);
  const next = await api.recordBatchChanges(table.id, batch.id, { before: page.nextBefore! });
  assert.equal(next.changes[0]!.recordId, rows[0]!.id);
  assert.equal((await api.recordChange(table.id, rows[0]!.id, next.changes[0]!.id)).after!.id, rows[0]!.id);
  await assert.rejects(api.recordBatchChanges(table.id, 'missing', {}), { code: 'HISTORY_NOT_FOUND' });
  await assert.rejects(api.recordBatches(table.id, { limit: 101 }), { code: 'INVALID_HISTORY' });
});
