import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

test('date formula values share typed queries, CSV, recovery, schema identity, restart and backup', async t => {
  const data = fixture(t, null, () => new Date('2024-02-29T12:00:00Z')), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Schedules' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Start', type: 'date' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Months', type: 'number' });
  const start = table.fields[1]!.id, months = table.fields[2]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'formula',
    formula: { expression: 'DATEADD([' + start + '], [' + months + '], "month")', resultType: 'date' } });
  const due = table.fields[3]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'UTC', type: 'formula',
    formula: { expression: 'DATETIMEVALUE([' + due + '])', resultType: 'datetime' } });
  const utc = table.fields[4]!.id;
  const rows = service.createRecords(table.id, ['2024-01-31', '2024-02-01'].map(date => ({ values: { [start]: date, [months]: 1 } }))).records;
  assert.equal(rows[0]!.values[due], '2024-02-29'); assert.equal(rows[0]!.values[utc], '2024-02-29T00:00:00.000Z');
  const view = service.createView(table.id, { name: 'Upcoming', query: { sort: [{ fieldId: due, direction: 'asc' }],
    filter: { conjunction: 'and', conditions: [{ fieldId: due, operator: 'gt', value: '2024-02-29' }] } } });
  assert.deepEqual(service.queryView(table.id, view.id, {}).records.map(row => row.id), [rows[1]!.id]);
  assert.equal(service.queryRecords(table.id, { filter: { conjunction: 'and', conditions: [
    { fieldId: due, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } },
  ] } }).records[0]!.id, rows[0]!.id);
  assert.equal(service.summarizeRecords(table.id, { groupBy: due }).groups.length, 2);
  assert.match(service.exportCsv(table.id, {}), /2024-02-29T00:00:00.000Z/);
  table = service.updateField(table.id, start, { expectedVersion: table.version, name: 'Begins' });
  assert.deepEqual(service.getRecord(table.id, rows[0]!.id), rows[0]);
  const invalid = service.updateBatch([{ id: rows[0]!.id, expectedVersion: rows[0]!.version, values: { [months]: 0.5 } }], table.id);
  assert.match(invalid.records[0]!.formulaErrors![due]!, /whole number/);
  assert.match(invalid.records[0]!.formulaErrors![utc]!, /referenced/);
  assert.throws(() => service.exportCsv(table.id, {}), /calculation error/);
  service.undoRecordBatch(table.id, invalid.batchId!);
  const current = service.getRecord(table.id, rows[0]!.id);
  assert.equal(current.values[due], '2024-02-29'); assert.equal(current.formulaErrors, undefined);
  assert.throws(() => service.updateBatch([
    { id: current.id, expectedVersion: current.version, values: { [months]: 2 } },
    { id: rows[1]!.id, expectedVersion: 999, values: { [months]: 2 } },
  ], table.id), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(service.getRecord(table.id, current.id), current);
  service.importCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: 'Begins,Months\n2024-02-29,12\n' });
  assert.equal(service.queryRecords(table.id, { offset: 2 }).records[0]!.values[due], '2025-02-28');
  const before = service.queryRecords(table.id, {});
  store.close();
  const reopened = new RecordService(data.open()); assert.deepEqual(reopened.queryRecords(table.id, {}), before);
  const backup = join(dirname(data.path), 'dates.sqlite'), restored = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, restored);
  const restoredStore = new SqliteRecordStore(restored);
  try { assert.deepEqual(new RecordService(restoredStore).queryRecords(table.id, {}), before); }
  finally { restoredStore.close(); }
});

test('date-derived values propagate across linked summaries and date lookups inside the source write', t => {
  const service = new RecordService(fixture(t, null).open());
  let target = service.createTable({ name: 'Dates' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Start', type: 'date' });
  const start = target.fields[1]!.id;
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Tomorrow', type: 'formula',
    formula: { expression: 'DATEADD([' + start + '], 1, "day")', resultType: 'date' } });
  const tomorrow = target.fields[2]!.id;
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Day', type: 'formula',
    formula: { expression: 'DAY([' + tomorrow + '])', resultType: 'number' } });
  let source = service.createTable({ name: 'Summary' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Dates', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = source.fields[1]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Day', type: 'lookup',
    lookup: { relationFieldId: link, fieldId: target.fields[3]!.id, operation: 'min' } });
  const day = source.fields[2]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Planned', type: 'formula',
    formula: { expression: 'DATE(2030, 1, [' + day + '])', resultType: 'date' } });
  const planned = source.fields[3]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Dates', type: 'lookup',
    lookup: { relationFieldId: link, fieldId: tomorrow } });
  const lookup = source.fields[4]!.id;
  const row = service.createRecords(target.id, [{ values: { [start]: '2024-02-28' } }]).records[0]!;
  const dependent = service.createRecords(source.id, [{ values: { [link]: [row.id] } }]).records[0]!;
  assert.equal(dependent.values[planned], '2030-01-29'); assert.deepEqual(dependent.values[lookup], ['2024-02-29']);
  service.updateBatch([{ id: row.id, expectedVersion: row.version, values: { [start]: '2024-02-29' } }], target.id);
  const changed = service.getRecord(source.id, dependent.id);
  assert.equal(changed.values[planned], '2030-01-01'); assert.equal(changed.version, dependent.version + 1);
  assert.deepEqual(changed.values[lookup], ['2024-03-01']);
  assert.equal(service.queryRecords(source.id, { filter: { conjunction: 'and', conditions: [{ fieldId: lookup, operator: 'eq', value: '2024-03-01' }] } }).total, 1);
});

test('format 24 upgrades preserve existing formulas, saved values and versions', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Previous formulas' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Value', type: 'formula', formula: { expression: '1 + 2', resultType: 'number' } });
  const row = service.createRecords(table.id, [{ values: {} }]).records[0]!, views = service.listViews(table.id), before = service.getTable(table.id);
  store.close(); const db = new DatabaseSync(data.path); db.exec('PRAGMA user_version = 24;'); db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(table.id), before); assert.deepEqual(reopened.getRecord(table.id, row.id), row);
  assert.deepEqual(reopened.listViews(table.id), views);
});
