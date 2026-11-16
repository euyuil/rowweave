import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import type { CellValue } from '../../contracts/src/index.js';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

function setup(t: Parameters<typeof fixture>[0], sourceMultiple = true, targetMultiple = true) {
  const data = fixture(t, null), service = new RecordService(data.open());
  let source = service.createTable({ name: 'Source' }), target = service.createTable({ name: 'Target' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Targets', type: 'relation',
    relation: { tableId: target.id, multiple: sourceMultiple }, description: 'Existing source links' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Sources', type: 'relation',
    relation: { tableId: source.id, multiple: targetMultiple } });
  const link = source.fields[1]!, inverse = target.fields[1]!;
  const a = service.createRecords(source.id, ['A1', 'A2', 'A3'].map(name => ({ values: { [source.primaryFieldId]: name } }))).records;
  const b = service.createRecords(target.id, ['B1', 'B2', 'B3'].map(name => ({ values: { [target.primaryFieldId]: name } }))).records;
  const input = () => ({ expectedVersion: service.getTable(source.id).version, targetFieldId: inverse.id,
    expectedTargetVersion: service.getTable(target.id).version });
  return { data, service, source, target, link, inverse, a, b, input };
}

function update(service: RecordService, tableId: string, id: string, values: Record<string, CellValue>) {
  return service.updateBatch([{ id, expectedVersion: service.getRecord(tableId, id).version, values }], tableId).records[0]!;
}

test('pairing existing fields retains both ordered link sets, stable identities and defaults across restart and backup', async t => {
  const { data, service, source, target, link, inverse, a, b, input } = setup(t);
  update(service, source.id, a[0]!.id, { [link.id]: [b[2]!.id] });
  update(service, source.id, a[2]!.id, { [link.id]: [b[1]!.id] });
  update(service, target.id, b[0]!.id, { [inverse.id]: [a[0]!.id] });
  update(service, target.id, b[1]!.id, { [inverse.id]: [a[0]!.id, a[1]!.id] });
  service.updateField(source.id, link.id, { expectedVersion: source.version, defaultValue: [b[2]!.id] });
  const beforeSource = service.getTable(source.id), beforeTarget = service.getTable(target.id);
  const views = service.listViews(source.id);
  const beforeA = a.map(row => service.getRecord(source.id, row.id)), beforeB = b.map(row => service.getRecord(target.id, row.id));
  const beforePage = service.queryRecords(source.id, { limit: 1 });
  const result = service.pairRelationFields(source.id, link.id, input());
  assert.equal(result.version, beforeSource.version + 1);
  assert.equal(service.getTable(target.id).version, beforeTarget.version + 1);
  assert.deepEqual(service.listViews(source.id), views);
  assert.deepEqual(result.fields[1], { ...beforeSource.fields[1], relation: { ...link.relation, inverseFieldId: inverse.id } });
  assert.equal(service.getTable(target.id).fields[1]!.relation!.inverseFieldId, link.id);
  const afterA = a.map(row => service.getRecord(source.id, row.id)), afterB = b.map(row => service.getRecord(target.id, row.id));
  assert.deepEqual(afterA.map(row => row.values[link.id]), [[b[2]!.id, b[0]!.id, b[1]!.id], [b[1]!.id], [b[1]!.id]]);
  assert.deepEqual(afterB.map(row => row.values[inverse.id]), [[a[0]!.id], [a[0]!.id, a[1]!.id, a[2]!.id], [a[0]!.id]]);
  assert.deepEqual(afterA.map((row, index) => row.version - beforeA[index]!.version), [1, 1, 0]);
  assert.deepEqual(afterB.map((row, index) => row.version - beforeB[index]!.version), [0, 1, 1]);
  assert.deepEqual(afterA.map(row => row.id), a.map(row => row.id));
  assert.throws(() => service.queryRecords(source.id, { expectedRevision: beforePage.revision }), { code: 'DATA_CHANGED' });
  assert.throws(() => update(service, source.id, a[0]!.id, { [link.id]: [b[0]!.id, b[0]!.id] }), { code: 'INVALID_VALUE' });
  const created = service.createRecords(source.id, [{ values: {} }]).records[0]!;
  assert.deepEqual(created.values[link.id], [b[2]!.id]);
  assert.deepEqual(service.getRecord(target.id, b[2]!.id).values[inverse.id], [a[0]!.id, created.id]);
  update(service, target.id, b[1]!.id, { [inverse.id]: [] });
  assert.deepEqual(service.getRecord(source.id, a[1]!.id).values[link.id], []);
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(source.id), service.getTable(source.id));
  assert.deepEqual(reopened.readPage(0, 10, target.id), service.readPage(0, 10, target.id));
  const backup = join(dirname(data.path), 'paired.backup'), restoredPath = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, restoredPath);
  const restoredStore = new SqliteRecordStore(restoredPath);
  try {
    const restored = new RecordService(restoredStore);
    assert.deepEqual(restored.getTable(target.id), service.getTable(target.id));
    assert.deepEqual(restored.readPage(0, 10, source.id), service.readPage(0, 10, source.id));
  } finally { restoredStore.close(); }
});

test('pairing rejects stale schemas, incompatible targets, missing and already paired fields without mutations', t => {
  const { service, source, target, link, inverse, input } = setup(t);
  const before = service.listTables(), valid = input();
  for (const invalid of [{ ...valid, expectedVersion: 1 }, { ...valid, expectedTargetVersion: 1 }]) {
    assert.throws(() => service.pairRelationFields(source.id, link.id, invalid), { code: 'SCHEMA_CONFLICT' });
  }
  for (const invalid of [null, {}, { ...valid, targetFieldId: '' }, { ...valid, expectedTargetVersion: '2' }]) {
    assert.throws(() => service.pairRelationFields(source.id, link.id, invalid), { code: 'INVALID_SCHEMA' });
  }
  assert.throws(() => service.pairRelationFields(source.id, 'missing', valid), { code: 'FIELD_NOT_FOUND' });
  assert.throws(() => service.pairRelationFields(source.id, link.id, { ...valid, targetFieldId: 'missing' }), { code: 'FIELD_NOT_FOUND' });
  assert.throws(() => service.pairRelationFields(source.id, source.primaryFieldId, valid), { code: 'INVALID_SCHEMA' });
  assert.throws(() => service.pairRelationFields(source.id, link.id, { ...valid, targetFieldId: target.primaryFieldId }), { code: 'INVALID_SCHEMA' });
  assert.deepEqual(service.listTables(), before);
  const wrong = service.createField(target.id, { expectedVersion: target.version, name: 'Wrong target', type: 'relation', relation: { tableId: target.id, multiple: true } });
  assert.throws(() => service.pairRelationFields(source.id, link.id, { ...input(), targetFieldId: wrong.fields.at(-1)!.id }), { code: 'INVALID_SCHEMA' });
  service.pairRelationFields(source.id, link.id, input());
  const paired = service.listTables();
  assert.throws(() => service.pairRelationFields(source.id, link.id, input()), { code: 'RELATION_DEPENDENCY' });
  assert.deepEqual(service.listTables(), paired);
  assert.equal(service.getTable(target.id).fields.find(field => field.id === inverse.id)!.relation!.inverseFieldId, link.id);
});

test('cardinality conflicts roll back both schemas, values, normalized links, revisions and history', t => {
  const { data, service, source, target, link, inverse, a, b, input } = setup(t, true, false);
  update(service, source.id, a[0]!.id, { [link.id]: [b[0]!.id] });
  update(service, target.id, b[0]!.id, { [inverse.id]: [a[1]!.id] });
  const db = new DatabaseSync(data.path);
  try {
    const snapshot = () => ({ tables: service.listTables(), a: service.readPage(0, 10, source.id), b: service.readPage(0, 10, target.id),
      edges: db.prepare('SELECT * FROM relation_edges ORDER BY source_record_id, field_id, position').all(),
      batches: service.recordBatches(source.id, {}) });
    const before = snapshot();
    assert.throws(() => service.pairRelationFields(source.id, link.id, input()), { code: 'INVALID_VALUE' });
    assert.deepEqual(snapshot(), before);
    update(service, target.id, b[0]!.id, { [inverse.id]: [] });
    service.pairRelationFields(source.id, link.id, input());
    assert.deepEqual(service.getRecord(target.id, b[0]!.id).values[inverse.id], [a[0]!.id]);
  } finally { db.close(); }
});

test('pairing enforces the multiple-link capacity without discarding incoming links', t => {
  const { service, source, target, link, inverse, b, input } = setup(t);
  const incoming = service.createRecords(source.id, Array.from({ length: 201 }, () => ({ values: { [link.id]: [b[0]!.id] } }))).records;
  const before = service.listTables();
  assert.throws(() => service.pairRelationFields(source.id, link.id, input()), { code: 'INVALID_VALUE' });
  assert.deepEqual(service.listTables(), before);
  assert.equal(service.getRecord(target.id, b[0]!.id).values[inverse.id], null);
  assert.deepEqual(service.getRecord(source.id, incoming.at(-1)!.id).values[link.id], [b[0]!.id]);
});

test('self-table pairing merges distinct fields and advances a record version only once', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Peers' });
  for (const name of ['Outgoing', 'Incoming']) table = service.createField(table.id, { expectedVersion: table.version, name,
    type: 'relation', relation: { tableId: table.id, multiple: true } });
  const [link, inverse] = table.fields.slice(1);
  const rows = service.createRecords(table.id, Array.from({ length: 3 }, () => ({ values: {} }))).records;
  update(service, table.id, rows[0]!.id, { [link!.id]: [rows[1]!.id], [inverse!.id]: [rows[2]!.id] });
  update(service, table.id, rows[2]!.id, { [link!.id]: [rows[1]!.id], [inverse!.id]: [rows[1]!.id] });
  const before = rows.map(row => service.getRecord(table.id, row.id));
  assert.throws(() => service.pairRelationFields(table.id, link!.id, { expectedVersion: table.version, expectedTargetVersion: table.version, targetFieldId: link!.id }), { code: 'INVALID_SCHEMA' });
  table = service.pairRelationFields(table.id, link!.id, { expectedVersion: table.version, expectedTargetVersion: table.version, targetFieldId: inverse!.id });
  assert.equal(table.version, 4);
  const after = rows.map(row => service.getRecord(table.id, row.id));
  assert.deepEqual(after.map((row, index) => row.version - before[index]!.version), [0, 1, 1]);
  assert.deepEqual(after[1]!.values[inverse!.id], [rows[0]!.id, rows[2]!.id]);
  assert.deepEqual(after[1]!.values[link!.id], [rows[2]!.id]);
  assert.deepEqual(after[2]!.values[link!.id], [rows[1]!.id, rows[0]!.id]);
  assert.equal(table.fields[1]!.relation!.inverseFieldId, inverse!.id);
  assert.equal(table.fields[2]!.relation!.inverseFieldId, link!.id);
});

test('pairing recalculates connected formulas once and records schema history without resetting edit times', t => {
  const { service, source, target, link, inverse, a, b, input } = setup(t);
  const currentTarget = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number' });
  const amount = currentTarget.fields.at(-1)!.id;
  for (const [index, record] of b.entries()) update(service, target.id, record.id, { [amount]: (index + 1) * 10 });
  let currentSource = service.createField(source.id, { expectedVersion: source.version, name: 'Edited', type: 'updatedTime' });
  const edited = currentSource.fields.at(-1)!.id;
  currentSource = service.createField(source.id, { expectedVersion: currentSource.version, name: 'Subtotal', type: 'lookup',
    lookup: { relationFieldId: link.id, fieldId: amount, operation: 'sum' } });
  const subtotal = currentSource.fields.at(-1)!.id;
  currentSource = service.createField(source.id, { expectedVersion: currentSource.version, name: 'Total', type: 'formula',
    formula: { expression: '[' + subtotal + '] * 2', resultType: 'number' } });
  const total = currentSource.fields.at(-1)!.id;
  update(service, source.id, a[0]!.id, { [link.id]: [b[0]!.id] });
  update(service, target.id, b[1]!.id, { [inverse.id]: [a[0]!.id] });
  update(service, target.id, b[2]!.id, { [inverse.id]: [a[1]!.id] });
  let report = service.createTable({ name: 'Report' });
  report = service.createField(report.id, { expectedVersion: report.version, name: 'Sources', type: 'relation',
    relation: { tableId: source.id, multiple: true } });
  const reportLink = report.fields.at(-1)!.id;
  report = service.createField(report.id, { expectedVersion: report.version, name: 'Total', type: 'lookup',
    lookup: { relationFieldId: reportLink, fieldId: total, operation: 'sum' } });
  const reportSum = report.fields.at(-1)!.id;
  report = service.createField(report.id, { expectedVersion: report.version, name: 'Doubled', type: 'formula',
    formula: { expression: '[' + reportSum + '] * 2', resultType: 'number' } });
  const doubled = report.fields.at(-1)!.id;
  const reportRow = service.createRecords(report.id, [{ values: { [reportLink]: [a[0]!.id] } }]).records[0]!;
  assert.equal(reportRow.values[doubled], 40);
  const before = service.getRecord(source.id, a[0]!.id), untouched = service.getRecord(source.id, a[2]!.id);
  const reportPage = service.queryRecords(report.id, {});
  service.pairRelationFields(source.id, link.id, input());
  const after = service.getRecord(source.id, a[0]!.id), changedReport = service.getRecord(report.id, reportRow.id);
  assert.equal(after.values[subtotal], 30); assert.equal(after.values[total], 60);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.values[edited], before.values[edited]);
  assert.deepEqual(service.getRecord(source.id, a[2]!.id), untouched);
  assert.equal(changedReport.values[doubled], 120);
  assert.equal(changedReport.version, reportRow.version + 1);
  assert.throws(() => service.queryRecords(report.id, { expectedRevision: reportPage.revision }), { code: 'DATA_CHANGED' });
  assert.equal(service.queryRecords(source.id, { filter: { conjunction: 'and', conditions: [{ fieldId: total, operator: 'eq', value: 60 }] } }).total, 2);
  assert.match(service.exportCsv(source.id, {}), /60/);
  const receipt = service.recordBatches(source.id, {}).batches[0]!;
  assert.equal(receipt.recordWrite, false); assert.equal(receipt.recordCount, 4);
  assert.throws(() => service.undoRecordBatch(source.id, receipt.id), { code: 'INVALID_HISTORY' });
  assert.throws(() => service.updateBatch([{ id: after.id, expectedVersion: before.version, values: { [link.id]: [] } }], source.id), { code: 'VERSION_CONFLICT' });
  const change = service.recordHistory(source.id, after.id, {}).changes[0]!;
  const restored = service.restoreRecord(source.id, after.id, { changeId: change.id, snapshot: 'before', expectedVersion: after.version });
  assert.deepEqual(restored.values[link.id], [b[0]!.id]);
  assert.deepEqual(service.getRecord(target.id, b[1]!.id).values[inverse.id], []);
  assert.equal(service.getRecord(report.id, reportRow.id).values[doubled], 40);
});

test('the pairing transaction rechecks a target schema changed after the caller read it', t => {
  const { data, service, source, target, link, inverse } = setup(t);
  const otherConnection = data.open();
  service.updateTable(target.id, { expectedVersion: target.version, name: 'Changed target' });
  const before = service.listTables();
  assert.throws(() => otherConnection.pairRelationFields(source, link, target, inverse), { code: 'SCHEMA_CONFLICT' });
  assert.deepEqual(service.listTables(), before);
});

test('pairing empty fields changes schemas without rewriting empty records or inventing a history batch', t => {
  const { service, source, target, link, a, b, input } = setup(t);
  const beforeA = service.readPage(0, 10, source.id), beforeB = service.readPage(0, 10, target.id);
  const batches = service.recordBatches(source.id, {});
  service.pairRelationFields(source.id, link.id, input());
  assert.deepEqual(a.map(row => service.getRecord(source.id, row.id).values), beforeA.records.map(row => row.values));
  assert.deepEqual(b.map(row => service.getRecord(target.id, row.id).version), beforeB.records.map(row => row.version));
  assert.deepEqual(service.recordBatches(source.id, {}), batches);
});
