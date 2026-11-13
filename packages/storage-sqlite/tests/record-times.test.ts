import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

test('automatic times use one service transaction clock, backfill known history and reject forged values', t => {
  let now = '2026-11-01T01:02:03.004Z';
  const service = new RecordService(fixture(t, null, () => new Date(now)).open());
  let table = service.createTable({ name: 'Timed records' });
  const original = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Original' } }]).records[0]!;
  const originalTime = now;
  now = '2026-11-02T01:02:03.004Z';
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Created', type: 'createdTime' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Edited', type: 'updatedTime' });
  const created = table.fields[1]!.id, edited = table.fields[2]!.id;
  const backfilled = service.getRecord(table.id, original.id);
  assert.equal(backfilled.values[created], originalTime); assert.equal(backfilled.values[edited], originalTime);
  assert.equal(backfilled.version, original.version + 2);
  for (const field of [created, edited]) {
    for (const value of [null, '2000-01-01T00:00:00Z']) {
      assert.throws(() => service.createRecords(table.id, [{ values: { [field]: value } }]), { code: 'READ_ONLY_FIELD' });
      assert.throws(() => service.updateBatch([{ id: original.id, expectedVersion: backfilled.version, values: { [field]: value } }], table.id), { code: 'READ_ONLY_FIELD' });
    }
    assert.throws(() => service.updateField(table.id, field, { expectedVersion: table.version, required: true }), { code: 'INVALID_SCHEMA' });
  }
  const batch = service.createRecords(table.id, [{ values: {} }, { values: {} }]);
  assert.deepEqual(batch.records.map(row => [row.values[created], row.values[edited]]), [[now, now], [now, now]]);
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Edit label', type: 'formula', formula: { expression: `CONCAT("Saved ", [${edited}])`, resultType: 'text' } });
  const label = table.fields[3]!.id, current = service.getRecord(table.id, original.id);
  now = '2026-11-03T01:02:03.004Z';
  const saved = service.updateBatch([{ id: original.id, expectedVersion: current.version, values: { [table.primaryFieldId]: 'Changed' } }], table.id).records[0]!;
  assert.equal(saved.values[created], originalTime); assert.equal(saved.values[edited], now); assert.equal(saved.values[label], 'Saved ' + now);
  assert.equal(service.queryRecords(table.id, { filter: { conjunction: 'and', conditions: [{ fieldId: edited, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } }] } }).records[0]!.id, original.id);
  now = '2026-11-04T01:02:03.004Z';
  assert.throws(() => service.updateBatch([{ id: original.id, expectedVersion: saved.version, values: { [table.primaryFieldId]: 'Must roll back' } },
    { id: batch.records[0]!.id, expectedVersion: 1, values: { [table.primaryFieldId]: 'Stale after formula creation' } }], table.id), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(service.getRecord(table.id, original.id), saved);
  table = service.updateField(table.id, edited, { expectedVersion: table.version, name: 'Last saved' });
  assert.equal(service.getRecord(table.id, original.id).values[edited], saved.values[edited]);
});

test('restoration and saved undo retain original creation while recording the new save time', async t => {
  let now = '2026-11-01T00:00:00.000Z';
  const data = fixture(t, null, () => new Date(now)), service = new RecordService(data.open());
  let table = service.createTable({ name: 'Recovery times' });
  const row = service.createRecords(table.id, [{ values: {} }]).records[0]!, originalTime = now;
  service.deleteRecords(table.id, [{ id: row.id, expectedVersion: row.version }]);
  const deletion = service.recordTrash(table.id, {}).records[0]!;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Created', type: 'createdTime' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Edited', type: 'updatedTime' });
  const created = table.fields[1]!.id, edited = table.fields[2]!.id;
  now = '2026-11-02T00:00:00.000Z';
  const restored = service.restoreDeletedRecords(table.id, [{ id: row.id, deletionId: deletion.deletionId }]);
  assert.equal(restored.records[0]!.values[created], originalTime); assert.equal(restored.records[0]!.values[edited], now);
  const undone = service.undoRecordBatch(table.id, restored.batchId!);
  now = '2026-11-03T00:00:00.000Z';
  service.undoRecordBatch(table.id, undone.batchId);
  const redone = service.getRecord(table.id, row.id);
  assert.equal(redone.values[created], originalTime); assert.equal(redone.values[edited], now);
  const creation = service.recordHistory(table.id, row.id, {}).changes.at(-1)!;
  now = '2026-11-04T00:00:00.000Z';
  const snapshot = service.restoreRecord(table.id, row.id, { changeId: creation.id, snapshot: 'after', expectedVersion: redone.version });
  assert.equal(snapshot.values[created], originalTime); assert.equal(snapshot.values[edited], now);
  assert.deepEqual(new RecordService(data.open()).getRecord(table.id, row.id), snapshot);
  const backup = join(dirname(data.path), 'times-backup.sqlite'), restoredPath = join(dirname(data.path), 'times-restored.sqlite');
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, restoredPath);
  const store = new SqliteRecordStore(restoredPath);
  try { assert.deepEqual(new RecordService(store).getRecord(table.id, row.id), snapshot); }
  finally { store.close(); }
});

test('reciprocal edits stamp both sides before local calculations and roll back failed targets', t => {
  let now = '2026-11-01T00:00:00.000Z';
  const service = new RecordService(fixture(t, null, () => new Date(now)).open());
  let target = service.createTable({ name: 'Projects' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Edited', type: 'updatedTime' });
  const edited = target.fields[1]!.id;
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Label', type: 'formula', formula: { expression: `CONCAT([${edited}])`, resultType: 'text' } });
  const label = target.fields[2]!.id;
  const project = service.createRecords(target.id, [{ values: {} }]).records[0]!;
  let source = service.createTable({ name: 'Tasks' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Project', type: 'relation', relation: { tableId: target.id, multiple: false },
    reverseField: { name: 'Tasks', multiple: true, expectedVersion: target.version } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Edited', type: 'updatedTime' });
  now = '2026-11-02T00:00:00.000Z';
  const task = service.createRecords(source.id, [{ values: { [source.fields[1]!.id]: [project.id] } }]).records[0]!;
  const current = service.getRecord(target.id, project.id);
  assert.equal(current.version, project.version + 1);
  assert.equal(current.values[edited], now); assert.equal(current.values[label], now); assert.equal(task.values[source.fields[2]!.id], now);
  now = '2026-11-03T00:00:00.000Z';
  assert.throws(() => service.updateBatch([{ id: task.id, expectedVersion: task.version, values: { [source.fields[1]!.id]: ['missing'] } }], source.id), { code: 'INVALID_LINK' });
  assert.deepEqual(service.getRecord(target.id, project.id), current); assert.deepEqual(service.getRecord(source.id, task.id), task);
});

test('CSV assigns service times and legacy records without durable history retain unknown times', t => {
  let now = '2026-11-01T00:00:00.000Z';
  const data = fixture(t, null, () => new Date(now)), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Legacy' });
  const row = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Old' } }]).records[0]!;
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec('DROP TABLE field_sequences; DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; PRAGMA user_version = 15;'); db.close();
  const upgraded = new RecordService(data.open());
  table = upgraded.createField(table.id, { expectedVersion: table.version, name: 'Created', type: 'createdTime' });
  table = upgraded.createField(table.id, { expectedVersion: table.version, name: 'Edited', type: 'updatedTime' });
  const created = table.fields[1]!.id, edited = table.fields[2]!.id;
  assert.equal(upgraded.getRecord(table.id, row.id).values[created], null); assert.equal(upgraded.getRecord(table.id, row.id).values[edited], null);
  now = '2026-11-02T00:00:00.000Z';
  const csv = { expectedVersion: table.version, hasHeader: true, csv: 'Name,Created,Edited\nImported,2000-01-01T00:00:00Z,2000-01-01T00:00:00Z\n' };
  assert.deepEqual(upgraded.previewCsv(table.id, csv).mapping, [table.primaryFieldId, null, null]);
  upgraded.importCsv(table.id, csv);
  const imported = upgraded.queryRecords(table.id, {}).records[1]!;
  assert.equal(imported.values[created], now); assert.equal(imported.values[edited], now);
  const current = upgraded.getRecord(table.id, row.id);
  const saved = upgraded.updateBatch([{ id: row.id, expectedVersion: current.version, values: { [table.primaryFieldId]: 'Changed' } }], table.id).records[0]!;
  assert.equal(saved.values[created], null); assert.equal(saved.values[edited], now);
});

test('derived recalculation leaves edit times unchanged while timestamp lookups remain typed', t => {
  let now = '2026-11-01T00:00:00.000Z';
  const service = new RecordService(fixture(t, null, () => new Date(now)).open());
  let target = service.createTable({ name: 'Amounts' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number' });
  const amount = target.fields[1]!.id, item = service.createRecords(target.id, [{ values: { [amount]: 10 } }]).records[0]!;
  let source = service.createTable({ name: 'Totals' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Items', type: 'relation', relation: { tableId: target.id, multiple: true } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Sum', type: 'lookup', lookup: { relationFieldId: source.fields[1]!.id, fieldId: amount, operation: 'sum' } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Total', type: 'formula', formula: { expression: `[${source.fields[2]!.id}] * 2`, resultType: 'number' } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Edited', type: 'updatedTime' });
  const edited = source.fields[4]!.id, originalTime = now;
  const original = service.createRecords(source.id, [{ values: { [source.fields[1]!.id]: [item.id] } }]).records[0]!;
  now = '2026-11-02T00:00:00.000Z';
  service.updateBatch([{ id: item.id, expectedVersion: item.version, values: { [amount]: 20 } }], target.id);
  const recalculated = service.getRecord(source.id, original.id);
  assert.equal(recalculated.values[source.fields[3]!.id], 40); assert.equal(recalculated.values[edited], originalTime);
  let references = service.createTable({ name: 'References' });
  references = service.createField(references.id, { expectedVersion: references.version, name: 'Total', type: 'relation', relation: { tableId: source.id, multiple: false } });
  references = service.createField(references.id, { expectedVersion: references.version, name: 'Edited', type: 'lookup', lookup: { relationFieldId: references.fields[1]!.id, fieldId: edited } });
  const field = references.fields[2]!.id;
  const row = service.createRecords(references.id, [{ values: { [references.fields[1]!.id]: [original.id] } }]).records[0]!;
  assert.deepEqual(row.values[field], [originalTime]);
  assert.equal(service.queryRecords(references.id, { filter: { conjunction: 'and', conditions: [{ fieldId: field, operator: 'gte', value: originalTime }] } }).total, 1);
});
