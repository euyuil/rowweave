import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { SqliteRecordStore } from '../src/record-store.js';

test('automatic numbers backfill in record order and remain immutable across schema and record edits', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Tickets' });
  const original = service.createRecords(table.id, ['First', 'Second'].map(name => ({ values: { [table.primaryFieldId]: name } }))).records;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Ticket', type: 'autoNumber' });
  const number = table.fields[1]!.id;
  const rows = service.queryRecords(table.id, {}).records;
  assert.deepEqual(rows.map(row => [row.id, row.version, row.values[number]]), original.map((row, index) => [row.id, row.version + 1, index + 1]));
  for (const value of [null, 1, 5, '5']) {
    assert.throws(() => service.createRecords(table.id, [{ values: { [number]: value } }]), { code: 'READ_ONLY_FIELD' });
    assert.throws(() => service.updateBatch([{ id: rows[0]!.id, expectedVersion: rows[0]!.version, values: { [number]: value } }], table.id), { code: 'READ_ONLY_FIELD' });
  }
  assert.throws(() => service.updateField(table.id, number, { expectedVersion: table.version, defaultValue: 20 }), { code: 'INVALID_SCHEMA' });
  assert.throws(() => service.previewConversion(table.id, number, { expectedVersion: table.version, field: { name: 'Editable', type: 'number' } }), { code: 'CONVERSION_REQUIRED' });
  table = service.updateTable(table.id, { expectedVersion: table.version, primaryFieldId: number });
  table = service.updateField(table.id, number, { expectedVersion: table.version, name: 'Sequence' });
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: rows[0]!.version, values: { [table.fields[0]!.id]: 'Renamed' } }], table.id);
  const next = service.createRecords(table.id, [{ values: {} }, { values: {} }]).records;
  assert.deepEqual(next.map(row => row.values[number]), [3, 4]);
  assert.equal(service.getRecord(table.id, rows[0]!.id).values[number], 1);
});

test('automatic sequences persist across connections and backups while failed batches and CSV previews consume nothing', async t => {
  const data = fixture(t, null), first = new RecordService(data.open()), second = new RecordService(data.open());
  const target = first.createTable({ name: 'Targets' });
  let table = first.createTable({ name: 'Tickets' });
  table = first.createField(table.id, { expectedVersion: table.version, name: 'Ticket', type: 'autoNumber' });
  const number = table.fields[1]!.id;
  table = first.createField(table.id, { expectedVersion: table.version, name: 'Target', type: 'relation', relation: { tableId: target.id, multiple: false } });
  const link = table.fields[2]!.id;
  assert.throws(() => first.createRecords(table.id, [{ values: {} }, { values: { [link]: ['missing'] } }]), { code: 'INVALID_LINK' });
  const one = first.createRecords(table.id, [{ values: {} }]).records[0]!;
  const two = second.createRecords(table.id, [{ values: {} }]).records[0]!;
  assert.deepEqual([one.values[number], two.values[number]], [1, 2]);
  const csv = { expectedVersion: table.version, hasHeader: true, csv: 'Name,Ticket\nImported,999\n' };
  const preview = first.previewCsv(table.id, csv);
  assert.deepEqual(preview.mapping, [table.fields[0]!.id, null]);
  assert.equal(preview.invalid, 0);
  first.importCsv(table.id, csv);
  assert.equal(first.queryRecords(table.id, {}).records[2]!.values[number], 3);
  assert.throws(() => first.previewCsv(table.id, { ...csv, mapping: [table.fields[0]!.id, number] }), { code: 'INVALID_CSV' });
  const backup = join(dirname(data.path), 'numbers-backup.sqlite'), restored = join(dirname(data.path), 'numbers-restored.sqlite');
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, restored);
  const store = new SqliteRecordStore(restored);
  try { assert.equal(new RecordService(store).createRecords(table.id, [{ values: {} }]).records[0]!.values[number], 4); }
  finally { store.close(); }
  assert.equal(new RecordService(data.open()).createRecords(table.id, [{ values: {} }]).records[0]!.values[number], 4);
});

test('saved recovery preserves automatic identities and allocates only for fields added after deletion', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Recovery' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Ticket', type: 'autoNumber' });
  const number = table.fields[1]!.id;
  const created = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Original' } }]);
  const row = created.records[0]!;
  const undo = service.undoRecordBatch(table.id, created.batchId!);
  assert.equal(service.createRecords(table.id, [{ values: {} }]).records[0]!.values[number], 2);
  service.undoRecordBatch(table.id, undo.batchId);
  assert.equal(service.getRecord(table.id, row.id).values[number], 1);
  const current = service.getRecord(table.id, row.id);
  service.deleteRecords(table.id, [{ id: row.id, expectedVersion: current.version }]);
  const deletion = service.recordTrash(table.id, {}).records[0]!;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Later sequence', type: 'autoNumber' });
  const later = table.fields[2]!.id;
  assert.throws(() => service.restoreDeletedRecords(table.id, [{ id: row.id, deletionId: deletion.deletionId, values: { [number]: 99 } }]), { code: 'READ_ONLY_FIELD' });
  const restored = service.restoreDeletedRecords(table.id, [{ id: row.id, deletionId: deletion.deletionId }]).records[0]!;
  assert.equal(restored.values[number], 1); assert.equal(restored.values[later], 2);
  const next = service.createRecords(table.id, [{ values: {} }]).records[0]!;
  assert.deepEqual([next.values[number], next.values[later]], [3, 3]);
});

test('concurrent writers allocate distinct automatic numbers and sequence exhaustion rolls back the batch', async t => {
  const data = fixture(t, null), service = new RecordService(data.open());
  let table = service.createTable({ name: 'Concurrent tickets' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Ticket', type: 'autoNumber' });
  const number = table.fields[1]!.id;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      (async () => {
        const { SqliteRecordStore } = await import(workerData.store);
        const { RecordService } = await import(workerData.service);
        const store = new SqliteRecordStore(workerData.path);
        try { new RecordService(store).createRecords(workerData.tableId, Array.from({ length: 20 }, () => ({ values: {} }))); }
        finally { store.close(); }
      })();`, { eval: true, workerData: { path: data.path, tableId: table.id,
      store: new URL('../src/record-store.js', import.meta.url).href, service: new URL('../../core/src/record-service.js', import.meta.url).href } });
    worker.once('error', reject); worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}.`)));
  })));
  assert.deepEqual(service.queryRecords(table.id, { sort: [{ fieldId: number, direction: 'asc' }] }).records.map(row => row.values[number]), Array.from({ length: 80 }, (_, i) => i + 1));
  const db = new DatabaseSync(data.path);
  try { db.prepare('UPDATE field_sequences SET last_value = ? WHERE field_id = ?').run(Number.MAX_SAFE_INTEGER - 1, number); }
  finally { db.close(); }
  assert.throws(() => service.createRecords(table.id, [{ values: {} }, { values: {} }]), { code: 'SEQUENCE_EXHAUSTED' });
  assert.equal(service.getTable(table.id).total, 80);
  assert.equal(service.createRecords(table.id, [{ values: {} }]).records[0]!.values[number], Number.MAX_SAFE_INTEGER);
  assert.throws(() => service.createRecords(table.id, [{ values: {} }]), { code: 'SEQUENCE_EXHAUSTED' });
});

test('automatic numbers are numeric inputs for filtering, summaries, formulas and linked values', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Tickets' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Ticket', type: 'autoNumber' });
  const number = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Double', type: 'formula', formula: { expression: `[${number}] * 2`, resultType: 'number' } });
  const rows = service.createRecords(table.id, [{ values: {} }, { values: {} }]).records;
  assert.deepEqual(rows.map(row => row.values[table.fields[2]!.id]), [2, 4]);
  assert.equal(service.queryRecords(table.id, { filter: { conjunction: 'and', conditions: [{ fieldId: number, operator: 'gte', value: 2 }] } }).records[0]!.id, rows[1]!.id);
  assert.deepEqual(service.summarizeRecords(table.id, { measures: [{ fieldId: number, operation: 'sum' }] }).totals.values, [3]);
  let source = service.createTable({ name: 'References' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Tickets', type: 'relation', relation: { tableId: table.id, multiple: true } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Numbers', type: 'lookup', lookup: { relationFieldId: source.fields[1]!.id, fieldId: number } });
  const row = service.createRecords(source.id, [{ values: { [source.fields[1]!.id]: rows.map(row => row.id) } }]).records[0]!;
  assert.deepEqual(row.values[source.fields[2]!.id], [1, 2]);
});
