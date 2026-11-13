import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';
import { startServer } from '../../../apps/server/src/http-server.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null, () => new Date('2026-11-13T08:00:00Z')), store = data.open(), service = new RecordService(store);
  const table = service.createTable({ name: 'Trash' });
  return { data, store, service, table };
}

test('trash has bounded stable pages, exact display values and only the latest deletion', t => {
  const { service, table } = setup(t);
  assert.deepEqual(service.recordTrash(table.id, {}), { records: [] });
  const rows = service.createRecords(table.id, ['', '中文 🌱', null].map(name => ({ values: { [table.primaryFieldId]: name } }))).records;
  service.deleteRecords(table.id, rows.map(row => ({ id: row.id, expectedVersion: row.version })));
  const page = service.recordTrash(table.id, { limit: 2 });
  assert.equal(page.records.length, 2);
  assert.ok(page.nextBefore);
  assert.deepEqual(page.records.map(row => row.displayValue), [null, '中文 🌱']);
  assert.equal(page.records[0]!.deletedAt, '2026-11-13T08:00:00.000Z');
  assert.equal(page.records[0]!.batchId, page.records[1]!.batchId);
  assert.equal(Object.hasOwn(page.records[0]!, 'values'), false);
  const next = service.recordTrash(table.id, { before: page.nextBefore, limit: 2 });
  assert.equal(next.records[0]!.displayValue, '');
  assert.equal(next.nextBefore, undefined);
  const recovered = service.restoreDeletedRecords(table.id, [page.records[0]!]).records[0]!;
  assert.equal(recovered.id, rows[2]!.id);
  assert.equal(recovered.version, rows[2]!.version + 1);
  assert.throws(() => service.restoreDeletedRecords(table.id, [page.records[0]!]), { code: 'VERSION_CONFLICT' });
  assert.throws(() => service.updateBatch([{ id: recovered.id, expectedVersion: 1, values: { [table.primaryFieldId]: 'Stale' } }], table.id), { code: 'VERSION_CONFLICT' });
  service.deleteRecords(table.id, [{ id: recovered.id, expectedVersion: recovered.version }]);
  const newest = service.recordTrash(table.id, {}).records;
  assert.equal(newest.length, 3);
  assert.ok(newest[0]!.deletionId > page.records[0]!.deletionId);
  assert.throws(() => service.restoreDeletedRecords(table.id, [page.records[0]!]), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(service.recordTrash(table.id, { before: page.nextBefore, limit: 2 }), next);
  for (const query of [{ limit: 0 }, { limit: 101 }, { before: -1 }]) assert.throws(() => service.recordTrash(table.id, query), { code: 'INVALID_HISTORY' });
});

test('deleted restoration applies current schema, defaults and explicit repairs without resurrecting removed fields', t => {
  const { service, table: initial } = setup(t);
  let table = service.createField(initial.id, { expectedVersion: initial.version, name: 'Amount', type: 'number' });
  const amount = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Old notes', type: 'text' });
  const removed = table.fields[2]!.id;
  const row = service.createRecords(table.id, [{ values: { [amount]: 0, [removed]: 'Old' } }]).records[0]!;
  service.deleteRecords(table.id, [{ id: row.id, expectedVersion: 1 }]);
  const deleted = service.recordTrash(table.id, {}).records[0]!;
  table = service.deleteField(table.id, removed, { expectedVersion: table.version });
  table = service.updateField(table.id, amount, { expectedVersion: table.version, name: 'Renamed' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Default', type: 'checkbox', defaultValue: false });
  const defaultField = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Required', type: 'text', required: true });
  const required = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Double', type: 'formula', formula: { expression: `[${amount}] * 2`, resultType: 'number' } });
  const formula = table.fields.at(-1)!.id;
  assert.throws(() => service.restoreDeletedRecords(table.id, [deleted]), /required/);
  assert.throws(() => service.restoreDeletedRecords(table.id, [{ ...deleted, values: { [formula]: 9 } }]), { code: 'READ_ONLY_FIELD' });
  assert.throws(() => service.restoreDeletedRecords(table.id, [{ ...deleted, values: { [removed]: 'Old' } }]), /Unknown field/);
  const recovered = service.restoreDeletedRecords(table.id, [{ ...deleted, values: { [required]: 'Repaired', [amount]: 5 } }]).records[0]!;
  assert.equal(recovered.id, row.id);
  assert.equal(recovered.version, 2);
  assert.equal(recovered.values[defaultField], false);
  assert.equal(recovered.values[formula], 10);
  assert.equal(Object.hasOwn(recovered.values, removed), false);
  const change = service.recordHistory(table.id, row.id, {}).changes[0]!;
  assert.deepEqual(change.restoredFrom, { changeId: deleted.deletionId, snapshot: 'before' });
  assert.deepEqual(service.recordChange(table.id, row.id, change.id).after, recovered);
  assert.deepEqual(service.recordTrash(table.id, {}), { records: [] });
});

test('restore rejects stale deletion batches atomically across service connections', t => {
  const { data, service, table } = setup(t);
  const rows = service.createRecords(table.id, [{ values: {} }, { values: {} }]).records;
  service.deleteRecords(table.id, rows.map(row => ({ id: row.id, expectedVersion: 1 })));
  const deleted = service.recordTrash(table.id, {}).records;
  const other = new RecordService(data.open());
  other.restoreDeletedRecords(table.id, [deleted[1]!]);
  const revision = service.getTable(table.id).revision, history = service.recordHistory(table.id, deleted[0]!.id, {});
  assert.throws(() => service.restoreDeletedRecords(table.id, deleted), { code: 'VERSION_CONFLICT' });
  assert.equal(service.getTable(table.id).revision, revision);
  assert.deepEqual(service.recordHistory(table.id, deleted[0]!.id, {}), history);
  assert.equal(service.queryRecords(table.id, {}).total, 1);
  for (const input of [[], [deleted[0], deleted[0]], [{ id: deleted[0]!.id, deletionId: -1 }], [null]]) assert.throws(() => service.restoreDeletedRecords(table.id, input));
  const creation = service.recordHistory(table.id, deleted[0]!.id, {}).changes.at(-1)!;
  assert.throws(() => service.restoreDeletedRecords(table.id, [{ id: creation.recordId, deletionId: creation.id }]), { code: 'INVALID_HISTORY' });
});

test('restored reciprocal links respect current cardinality and roll back late target failures', t => {
  const { service, table: target } = setup(t);
  const project = service.createRecords(target.id, [{ values: {} }]).records[0]!;
  let tasks = service.createTable({ name: 'Tasks' });
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project', type: 'relation', relation: { tableId: target.id, multiple: false }, reverseField: { name: 'Task', multiple: false, expectedVersion: target.version } });
  const link = tasks.fields[1]!.id, inverse = service.getTable(target.id).fields[1]!.id;
  const first = service.createRecords(tasks.id, [{ values: { [link]: [project.id] } }]).records[0]!;
  service.deleteRecords(tasks.id, [{ id: first.id, expectedVersion: first.version }]);
  const deleted = service.recordTrash(tasks.id, {}).records[0]!;
  const second = service.createRecords(tasks.id, [{ values: { [link]: [project.id] } }]).records[0]!;
  const currentProject = service.getRecord(target.id, project.id), revision = service.getTable(tasks.id).revision;
  assert.throws(() => service.restoreDeletedRecords(tasks.id, [deleted]), { code: 'INVALID_VALUE' });
  assert.equal(service.getTable(tasks.id).revision, revision);
  assert.deepEqual(service.getRecord(target.id, project.id), currentProject);
  service.deleteRecords(tasks.id, [{ id: second.id, expectedVersion: second.version }]);
  const recovered = service.restoreDeletedRecords(tasks.id, [deleted]).records[0]!;
  assert.deepEqual(recovered.values[link], [project.id]);
  assert.deepEqual(service.getRecord(target.id, project.id).values[inverse], [first.id]);
  assert.equal(service.recordHistory(tasks.id, first.id, {}).changes[0]!.batchId, service.recordHistory(target.id, project.id, {}).changes[0]!.batchId);
  service.deleteRecords(tasks.id, [{ id: recovered.id, expectedVersion: recovered.version }]);
  const pending = service.recordTrash(tasks.id, {}).records;
  const latestProject = service.getRecord(target.id, project.id);
  service.deleteRecords(target.id, [{ id: project.id, expectedVersion: latestProject.version }]);
  const before = service.recordHistory(tasks.id, second.id, {});
  assert.throws(() => service.restoreDeletedRecords(tasks.id, [
    { ...pending.find(row => row.id === second.id)!, values: { [link]: [] } }, pending.find(row => row.id === first.id)!,
  ]), { code: 'INVALID_LINK' });
  assert.deepEqual(service.recordHistory(tasks.id, second.id, {}), before);
  assert.equal(service.queryRecords(tasks.id, {}).total, 0);
});

test('closed self-linked sets restore together with original UUIDs and current computed values', t => {
  const { service, table: initial } = setup(t);
  let table = service.createField(initial.id, { expectedVersion: initial.version, name: 'Peer', type: 'relation', relation: { tableId: initial.id, multiple: false } });
  const link = table.fields[1]!.id;
  const rows = service.createRecords(table.id, [{ values: {} }, { values: {} }]).records;
  const linked = service.updateBatch(rows.map((row, index) => ({ id: row.id, expectedVersion: 1, values: { [link]: [rows[1 - index]!.id] } })), table.id).records;
  service.deleteRecords(table.id, linked.map(row => ({ id: row.id, expectedVersion: row.version })));
  const deleted = service.recordTrash(table.id, {}).records;
  assert.throws(() => service.restoreDeletedRecords(table.id, [deleted[0]!]), { code: 'INVALID_LINK' });
  const restored = service.restoreDeletedRecords(table.id, deleted).records;
  for (const row of restored) {
    const previous = linked.find(item => item.id === row.id)!;
    assert.deepEqual(row.values, previous.values);
    assert.equal(row.version, previous.version + 1);
  }
  assert.deepEqual(service.queryRecords(table.id, {}).records.map(row => row.id), restored.map(row => row.id));
});

test('trash survives restart, workspace backup and migration from format 16', async t => {
  const { data, store, service, table } = setup(t);
  const row = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Keep me' } }]).records[0]!;
  service.deleteRecords(table.id, [{ id: row.id, expectedVersion: 1 }]);
  const expected = service.recordTrash(table.id, {});
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec('DROP TABLE attachments; DROP TABLE field_sequences; DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP INDEX changes_deleted; PRAGMA user_version = 16;'); db.close();
  const migrated = new RecordService(data.open());
  assert.deepEqual(migrated.recordTrash(table.id, {}), expected);
  const backup = join(dirname(data.path), 'backup.sqlite'), restoredPath = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup);
  assert.equal((await restoreWorkspace(backup, restoredPath)).version, 23);
  const restoredStore = new SqliteRecordStore(restoredPath);
  try {
    const restored = new RecordService(restoredStore);
    assert.deepEqual(restored.recordTrash(table.id, {}), expected);
    assert.equal(restored.restoreDeletedRecords(table.id, expected.records).records[0]!.id, row.id);
  } finally { restoredStore.close(); }
  assert.deepEqual(migrated.recordTrash(table.id, {}), expected);
});

test('HTTP and SDK share bounded trash and atomic current-version recovery', async t => {
  const { service, table } = setup(t), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const row = (await api.createRecords(table.id, [{ values: {} }])).records[0]!;
  await api.deleteRecords(table.id, [{ id: row.id, expectedVersion: 1 }]);
  const deleted = await api.recordTrash(table.id, { limit: 1 });
  assert.equal(deleted.records[0]!.id, row.id);
  const snapshot = await api.recordChange(table.id, row.id, deleted.records[0]!.deletionId);
  assert.deepEqual(snapshot.before, row);
  assert.deepEqual((await api.restoreDeletedRecords(table.id, deleted.records)).records[0], { ...row, version: 2 });
  await assert.rejects(api.restoreDeletedRecords(table.id, deleted.records), { code: 'VERSION_CONFLICT' });
  await assert.rejects(api.recordTrash(table.id, { limit: 101 }), { code: 'INVALID_HISTORY' });
  assert.deepEqual(await api.recordTrash(table.id), { records: [] });
});
