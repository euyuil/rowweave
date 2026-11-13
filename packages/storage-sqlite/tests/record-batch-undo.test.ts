import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { randomBytes } from 'node:crypto';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Undo' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const amount = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Done', type: 'checkbox' });
  const done = table.fields[2]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Double', type: 'formula', formula: { expression: `[${amount}] * 2`, resultType: 'number' } });
  return { data, store, service, table, amount, done, double: table.fields[3]!.id };
}

test('saved batch undo preserves UUIDs, typed values and later fields, and can be undone again', t => {
  const { service, table: original, amount, done, double } = setup(t);
  const rows = service.createRecords(original.id, [0, 1].map(value => ({ values: { [original.primaryFieldId]: '', [amount]: value, [done]: false } }))).records;
  service.updateBatch(rows.map(row => ({ id: row.id, expectedVersion: 1, values: { [amount]: 10, [done]: true } })), original.id);
  const saved = service.recordBatches(original.id, {}).batches[0]!;
  const table = service.createField(original.id, { expectedVersion: original.version, name: 'Later', type: 'text', defaultValue: 'For new records' });
  const later = table.fields.at(-1)!.id;
  const undo = service.undoRecordBatch(table.id, saved.id);
  assert.equal(undo.undoneBatchId, saved.id);
  for (const [index, row] of service.queryRecords(table.id, {}).records.entries()) {
    assert.equal(row.id, rows[index]!.id); assert.equal(row.version, 3);
    assert.equal(row.values[amount], index); assert.equal(row.values[double], index * 2);
    assert.equal(row.values[done], false); assert.equal(row.values[table.primaryFieldId], '');
    assert.equal(row.values[later], null);
  }
  assert.equal(service.recordBatchChanges(table.id, undo.batchId, {}).batch.undoOf, saved.id);
  assert.throws(() => service.undoRecordBatch(table.id, saved.id), { code: 'VERSION_CONFLICT' });
  const redo = service.undoRecordBatch(table.id, undo.batchId);
  assert.equal(service.recordBatchChanges(table.id, redo.batchId, {}).batch.undoOf, undo.batchId);
  for (const row of service.queryRecords(table.id, {}).records) {
    assert.equal(row.version, 4); assert.equal(row.values[amount], 10); assert.equal(row.values[done], true); assert.equal(row.values[double], 20);
  }
});

test('creation and deletion undo retain original identities and reject stale deletion cycles', t => {
  const { service, table, amount } = setup(t);
  const rows = service.createRecords(table.id, [{ values: { [amount]: 2 } }, { values: { [amount]: 3 } }]).records;
  const creation = service.recordBatches(table.id, {}).batches[0]!;
  const removed = service.undoRecordBatch(table.id, creation.id);
  assert.equal(service.queryRecords(table.id, {}).total, 0);
  assert.equal(service.recordTrash(table.id, {}).records.length, 2);
  const restored = service.undoRecordBatch(table.id, removed.batchId);
  assert.deepEqual(service.queryRecords(table.id, {}).records.map(row => row.id), rows.map(row => row.id));
  assert.ok(service.queryRecords(table.id, {}).records.every(row => row.version === 2));
  assert.throws(() => service.undoRecordBatch(table.id, removed.batchId), { code: 'VERSION_CONFLICT' });
  const removedAgain = service.undoRecordBatch(table.id, restored.batchId);
  assert.throws(() => service.undoRecordBatch(table.id, removed.batchId), { code: 'VERSION_CONFLICT' });
  service.undoRecordBatch(table.id, removedAgain.batchId);
  assert.ok(service.queryRecords(table.id, {}).records.every(row => row.version === 3));
});

test('cross-table reciprocal swaps undo atomically against the final graph and recalculate linked formulas', t => {
  const { service, table: projects, amount } = setup(t);
  const parents = service.createRecords(projects.id, [2, 5].map(value => ({ values: { [amount]: value } }))).records;
  let tasks = service.createTable({ name: 'Tasks' });
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project', type: 'relation', relation: { tableId: projects.id, multiple: false }, reverseField: { name: 'Task', multiple: false, expectedVersion: projects.version } });
  const link = tasks.fields[1]!.id, inverse = service.getTable(projects.id).fields.at(-1)!.id;
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Amount', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } });
  const lookup = tasks.fields[2]!.id;
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Computed', type: 'formula', formula: { expression: `[${lookup}] * 3`, resultType: 'number' } });
  const computed = tasks.fields[3]!.id;
  const rows = service.createRecords(tasks.id, parents.map(row => ({ values: { [link]: [row.id] } }))).records;
  const beforeParents = parents.map(row => service.getRecord(projects.id, row.id));
  service.updateBatch(rows.map((row, index) => ({ id: row.id, expectedVersion: row.version, values: { [link]: [parents[1 - index]!.id] } })), tasks.id);
  const batch = service.recordBatches(tasks.id, {}).batches[0]!;
  assert.equal(batch.recordCount, 4);
  const undo = service.undoRecordBatch(tasks.id, batch.id);
  for (const [index, row] of rows.entries()) {
    const task = service.getRecord(tasks.id, row.id), project = service.getRecord(projects.id, parents[index]!.id);
    assert.deepEqual(task.values[link], [parents[index]!.id]);
    assert.equal(task.values[computed], [6, 15][index]);
    assert.deepEqual(project.values[inverse], [row.id]);
    assert.equal(project.version, beforeParents[index]!.version + 2);
  }
  assert.equal(service.recordBatchChanges(tasks.id, undo.batchId, {}).batch.recordCount, 4);
});

test('saved batch conflicts preserve unrelated changes and roll back late dependency failures', t => {
  const { data, service, table, amount } = setup(t);
  const rows = service.createRecords(table.id, [1, 2, 3].map(value => ({ values: { [amount]: value } }))).records;
  service.updateBatch(rows.slice(0, 2).map(row => ({ id: row.id, expectedVersion: 1, values: { [amount]: 8 } })), table.id);
  const saved = service.recordBatches(table.id, {}).batches[0]!;
  const other = new RecordService(data.open());
  other.updateBatch([{ id: rows[2]!.id, expectedVersion: 1, values: { [amount]: 99 } }], table.id);
  service.undoRecordBatch(table.id, saved.id);
  assert.equal(service.getRecord(table.id, rows[2]!.id).values[amount], 99);
  const current = service.queryRecords(table.id, {}).records;
  service.updateBatch(current.slice(0, 2).map(row => ({ id: row.id, expectedVersion: row.version, values: { [amount]: 10 } })), table.id);
  const next = service.recordBatches(table.id, {}).batches[0]!;
  other.deleteRecords(table.id, [{ id: rows[1]!.id, expectedVersion: 4 }]);
  const batches = service.recordBatches(table.id, {}), first = service.getRecord(table.id, rows[0]!.id);
  assert.throws(() => service.undoRecordBatch(table.id, next.id), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(service.getRecord(table.id, first.id), first); assert.deepEqual(service.recordBatches(table.id, {}), batches);
  const fresh = service.createRecords(table.id, [{ values: {} }, { values: {} }]).records;
  const created = service.recordBatches(table.id, {}).batches[0]!;
  let references = service.createTable({ name: 'References' });
  references = service.createField(references.id, { expectedVersion: references.version, name: 'Link', type: 'relation', relation: { tableId: table.id, multiple: false } });
  service.createRecords(references.id, [{ values: { [references.fields[1]!.id]: [fresh[1]!.id] } }]);
  const revision = service.getTable(table.id).revision;
  assert.throws(() => service.undoRecordBatch(table.id, created.id), { code: 'RELATION_DEPENDENCY' });
  assert.equal(service.getTable(table.id).revision, revision);
  assert.deepEqual(fresh.map(row => service.getRecord(table.id, row.id)), fresh);
});

test('current constraints and schema batches reject undo without partial changes', t => {
  const { service, table: original, amount } = setup(t);
  const rows = service.createRecords(original.id, [{ values: {} }, { values: {} }]).records;
  service.updateBatch(rows.map(row => ({ id: row.id, expectedVersion: 1, values: { [amount]: 7 } })), original.id);
  const saved = service.recordBatches(original.id, {}).batches[0]!;
  let table = service.updateField(original.id, amount, { expectedVersion: original.version, required: true });
  const current = service.queryRecords(table.id, {}).records, history = service.recordBatches(table.id, {});
  assert.throws(() => service.undoRecordBatch(table.id, saved.id), /required/);
  assert.deepEqual(service.queryRecords(table.id, {}).records, current); assert.deepEqual(service.recordBatches(table.id, {}), history);
  table = service.updateField(table.id, table.fields[3]!.id, { expectedVersion: table.version, formula: { expression: `[${amount}] * 4`, resultType: 'number' } });
  const schema = service.recordBatches(table.id, {}).batches[0]!;
  assert.equal(schema.recordWrite, false);
  assert.throws(() => service.undoRecordBatch(table.id, schema.id), { code: 'INVALID_HISTORY' });
});

test('complete saved undo and its receipt survive restart, backup and format-18 migration', async t => {
  const { data, store, service, table, amount } = setup(t);
  const row = service.createRecords(table.id, [{ values: { [amount]: 1 } }]).records[0]!;
  service.updateBatch([{ id: row.id, expectedVersion: 1, values: { [amount]: 2 } }], table.id);
  const batch = service.recordBatches(table.id, {}).batches[0]!;
  store.close();
  const db = new DatabaseSync(data.path); db.exec('ALTER TABLE record_batches DROP COLUMN undo_of; PRAGMA user_version = 18;'); db.close();
  const restarted = new RecordService(data.open()), result = restarted.undoRecordBatch(table.id, batch.id);
  assert.equal(restarted.getRecord(table.id, row.id).values[amount], 1);
  const backup = join(dirname(data.path), 'backup.sqlite'), restoredPath = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup); assert.equal((await restoreWorkspace(backup, restoredPath)).version, 19);
  const restoredStore = new SqliteRecordStore(restoredPath);
  try {
    const restored = new RecordService(restoredStore);
    assert.equal(restored.recordBatchChanges(table.id, result.batchId, {}).batch.undoOf, batch.id);
    restored.undoRecordBatch(table.id, result.batchId);
    assert.equal(restored.getRecord(table.id, row.id).values[amount], 2);
    assert.equal(restored.getRecord(table.id, row.id).version, 4);
  } finally { restoredStore.close(); }
});

test('closed self-linked deletion batches undo together and preserve relationship identities', t => {
  const { service, table: original } = setup(t);
  const table = service.createField(original.id, { expectedVersion: original.version, name: 'Peer', type: 'relation', relation: { tableId: original.id, multiple: false } });
  const link = table.fields.at(-1)!.id;
  const rows = service.createRecords(table.id, [{ values: {} }, { values: {} }]).records;
  const linked = service.updateBatch(rows.map((row, index) => ({ id: row.id, expectedVersion: 1, values: { [link]: [rows[1 - index]!.id] } })), table.id).records;
  service.deleteRecords(table.id, linked.map(row => ({ id: row.id, expectedVersion: row.version })));
  const deleted = service.recordBatches(table.id, {}).batches[0]!;
  const undo = service.undoRecordBatch(table.id, deleted.id);
  for (const row of linked) assert.deepEqual(service.getRecord(table.id, row.id), { ...row, version: row.version + 1 });
  service.undoRecordBatch(table.id, undo.batchId);
  assert.equal(service.queryRecords(table.id, {}).total, 0);
});

test('incomplete cross-table receipts and oversized batches cannot cause partial undo', t => {
  const { service, table: projects } = setup(t);
  const project = service.createRecords(projects.id, [{ values: {} }]).records[0]!;
  let tasks = service.createTable({ name: 'Tasks' });
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project', type: 'relation', relation: { tableId: projects.id, multiple: false }, reverseField: { name: 'Tasks', multiple: true, expectedVersion: projects.version } });
  service.createRecords(tasks.id, [{ values: { [tasks.fields[1]!.id]: [project.id] } }]);
  const batch = service.recordBatches(tasks.id, {}).batches[0]!;
  tasks = service.deleteField(tasks.id, tasks.fields[1]!.id, { expectedVersion: tasks.version });
  const target = service.getTable(projects.id);
  service.deleteField(projects.id, target.fields.at(-1)!.id, { expectedVersion: target.version });
  service.deleteTable(tasks.id, { expectedVersion: tasks.version });
  const current = service.getRecord(projects.id, project.id);
  assert.throws(() => service.undoRecordBatch(projects.id, batch.id), { code: 'HISTORY_INCOMPLETE' });
  assert.deepEqual(service.getRecord(projects.id, project.id), current);
  const many = service.createTable({ name: 'Large import' });
  service.importCsv(many.id, { expectedVersion: many.version, csv: 'Name\n' + 'Row\n'.repeat(2001), hasHeader: true });
  const large = service.recordBatches(many.id, {}).batches[0]!;
  assert.throws(() => service.undoRecordBatch(many.id, large.id), /2000/);
  assert.equal(service.queryRecords(many.id, { limit: 1 }).total, 2001);
  let wide = service.createTable({ name: 'Wide updates' });
  for (let index = 0; index < 10; index++) wide = service.createField(wide.id, { expectedVersion: wide.version, name: `Field ${index}`, type: 'text' });
  service.importCsv(wide.id, { expectedVersion: wide.version, csv: 'Name\n' + 'Row\n'.repeat(2000), hasHeader: true });
  const rows = [0, 500, 1000, 1500].flatMap(offset => service.queryRecords(wide.id, { offset, limit: 500 }).records);
  service.updateBatch(rows.map(row => ({ id: row.id, expectedVersion: row.version, values: { [wide.primaryFieldId]: 'Changed' } })), wide.id);
  const manyCells = service.recordBatches(wide.id, {}).batches[0]!;
  assert.throws(() => service.undoRecordBatch(wide.id, manyCells.id), /20000/);
  assert.equal(service.getRecord(wide.id, rows[0]!.id).values[wide.primaryFieldId], 'Changed');
});

test('HTTP and SDK undo complete saved transactions with explicit redo and stale rejection', async t => {
  const { service, table, amount } = setup(t), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token }); t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const row = (await api.createRecords(table.id, [{ values: { [amount]: 1 } }])).records[0]!;
  await api.updateRecords(table.id, [{ id: row.id, expectedVersion: 1, values: { [amount]: 2 } }]);
  const batch = (await api.recordBatches(table.id)).batches[0]!;
  const undo = await api.undoRecordBatch(table.id, batch.id);
  assert.equal((await api.getRecord(table.id, row.id)).values[amount], 1);
  await assert.rejects(api.undoRecordBatch(table.id, batch.id), { code: 'VERSION_CONFLICT' });
  const redo = await api.undoRecordBatch(table.id, undo.batchId);
  assert.equal((await api.getRecord(table.id, row.id)).values[amount], 2);
  assert.equal((await api.recordBatchChanges(table.id, redo.batchId)).batch.undoOf, undo.batchId);
});
