import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture, removeWorkspaceState } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

test('clock refresh pages records, advances each changed version once and preserves edit times and history', async t => {
  let now = new Date('2024-02-29T12:00:40.123Z'), clockReads = 0;
  const data = fixture(t, null, () => { clockReads++; return now; }), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Clock records' });
  for (const [name, type] of [['Created', 'createdTime'], ['Edited', 'updatedTime']]) table = service.createField(table.id, { expectedVersion: table.version, name, type });
  const created = table.fields[1]!.id, edited = table.fields[2]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
  const current = table.fields[3]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Next minute', type: 'formula', formula: { expression: 'DATEADD([' + current + '], 1, "minute")', resultType: 'datetime' } });
  const next = table.fields[4]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Today', type: 'formula', formula: { expression: 'TODAY()', resultType: 'date' } });
  const today = table.fields[5]!.id;
  clockReads = 0;
  const batch = service.createRecords(table.id, Array.from({ length: 205 }, (_, index) => ({ values: { [table.primaryFieldId]: 'Row ' + index } })));
  assert.equal(clockReads, 1, 'A record batch must capture one calculation/edit clock.');
  assert.ok(batch.records.every(row => row.values[current] === '2024-02-29T12:00:00.000Z' && row.values[next] === '2024-02-29T12:01:00.000Z'));
  const before = service.getTable(table.id), history = service.recordBatches(table.id, {});
  now = new Date('2024-02-29T12:01:19.456Z');
  const preview = service.previewFormula(table.id, { expectedVersion: table.version, fieldId: current, formula: { expression: 'NOW()', resultType: 'datetime' } });
  assert.equal(preview.sample!.value, '2024-02-29T12:01:00.000Z');
  assert.equal(service.getRecord(table.id, batch.records[0]!.id).values[current], '2024-02-29T12:00:00.000Z', 'Preview must not refresh stored values.');
  clockReads = 0;
  assert.deepEqual(service.refreshCalculations(), { evaluatedAt: '2024-02-29T12:01:00.000Z', changedRecords: 205, changedTableIds: [table.id] });
  assert.equal(clockReads, 1);
  const after = service.queryRecords(table.id, { limit: 500 }).records;
  assert.ok(after.every(row => row.version === 2 && row.values[current] === '2024-02-29T12:01:00.000Z' && row.values[next] === '2024-02-29T12:02:00.000Z'));
  assert.ok(after.every(row => row.values[created] === '2024-02-29T12:00:40.123Z' && row.values[edited] === '2024-02-29T12:00:40.123Z' && row.values[today] === '2024-02-29'));
  assert.equal(service.getTable(table.id).revision, before.revision + 1);
  assert.equal(service.getTable(table.id).version, before.version);
  assert.deepEqual(service.recordBatches(table.id, {}), history);
  assert.deepEqual(service.refreshCalculations(), { evaluatedAt: '2024-02-29T12:01:00.000Z', changedRecords: 0, changedTableIds: [] });
  assert.deepEqual(service.queryRecords(table.id, { limit: 500 }).records, after);
  assert.throws(() => service.updateBatch([{ id: after[0]!.id, expectedVersion: 1, values: { [table.primaryFieldId]: 'Stale' } }], table.id), { code: 'VERSION_CONFLICT' });
  assert.throws(() => service.undoRecordBatch(table.id, batch.batchId!), { code: 'VERSION_CONFLICT' });
  const change = service.recordHistory(table.id, after[0]!.id, {}).changes[0]!;
  const restored = service.restoreRecord(table.id, after[0]!.id, { changeId: change.id, snapshot: 'after', expectedVersion: after[0]!.version });
  assert.equal(restored.values[current], after[0]!.values[current]); assert.equal(restored.values[edited], now.toISOString());
  service.importCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: 'Name\nImported\n' });
  assert.equal(service.queryRecords(table.id, { offset: 205 }).records[0]!.values[current], '2024-02-29T12:01:00.000Z');
  const saved = service.queryRecords(table.id, { limit: 500 });
  store.close();
  assert.deepEqual(new RecordService(data.open()).queryRecords(table.id, { limit: 500 }), saved);
  const backup = join(dirname(data.path), 'clock.sqlite'), copy = join(dirname(data.path), 'copy.sqlite');
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, copy);
  const copied = new SqliteRecordStore(copy);
  try { assert.deepEqual(new RecordService(copied).queryRecords(table.id, { limit: 500 }), saved); }
  finally { copied.close(); }
});

test('clock refresh propagates linked arrays, linked clock formulas and errors while leaving unrelated records unchanged', t => {
  let now = new Date('2024-02-29T23:59:30Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let target = service.createTable({ name: 'Clock source' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Today', type: 'formula', formula: { expression: 'TODAY()', resultType: 'date' } });
  const date = target.fields[1]!.id;
  let source = service.createTable({ name: 'Clock summary' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Items', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = source.fields[1]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Dates', type: 'lookup', lookup: { relationFieldId: link, fieldId: date } });
  const dates = source.fields[2]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Day', type: 'formula', formula: { expression: 'DAY(ARRAYGET([' + dates + '], 1))', resultType: 'number' } });
  const day = source.fields[3]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Link clock', type: 'formula', formula: { expression: 'CONCAT(NOW(), ARRAYLEN([' + link + ']))', resultType: 'text' } });
  const linkedClock = source.fields[4]!.id;
  const item = service.createRecords(target.id, [{ values: {} }]).records[0]!;
  const row = service.createRecords(source.id, [{ values: { [link]: [item.id] } }]).records[0]!;
  assert.equal(row.values[day], 29); assert.equal(row.values[linkedClock], '2024-02-29T23:59:00.000Z1');
  const staticTable = service.createTable({ name: 'Unrelated' }), staticRow = service.createRecords(staticTable.id, [{ values: {} }]).records[0]!;
  const original = service.getTable(staticTable.id);
  const view = service.createView(source.id, { name: 'First day', query: { filter: { conjunction: 'and', conditions: [{ fieldId: day, operator: 'eq', value: 1 }] } } });
  assert.equal(service.queryView(source.id, view.id, {}).total, 0);
  now = new Date('2024-03-01T00:00:10Z');
  assert.equal(service.refreshCalculations().changedRecords, 2);
  const changed = service.getRecord(source.id, row.id);
  assert.equal(changed.values[day], 1); assert.equal(changed.values[linkedClock], '2024-03-01T00:00:00.000Z1'); assert.equal(changed.version, 2);
  assert.equal(service.queryView(source.id, view.id, {}).total, 1);
  assert.match(service.exportCsv(source.id, {}), /2024-03-01/);
  now = new Date('+010000-01-01T00:00:00Z');
  service.refreshCalculations(); assert.match(service.getRecord(source.id, row.id).formulaErrors![day]!, /referenced/);
  now = new Date('2024-03-01T00:00:10Z');
  service.refreshCalculations(); assert.equal(service.getRecord(source.id, row.id).formulaErrors, undefined);
  assert.deepEqual(service.getTable(staticTable.id), original); assert.deepEqual(service.getRecord(staticTable.id, staticRow.id), staticRow);
});

test('a late clock refresh failure rolls back earlier pages and cleans up temporary calculation state', t => {
  let now = new Date('2024-02-29T12:00:00Z');
  const data = fixture(t, null, () => now), service = new RecordService(data.open());
  let table = service.createTable({ name: 'Atomic refresh' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Now', type: 'formula', formula: { expression: 'CONCAT(NOW(), [' + table.primaryFieldId + '])', resultType: 'text' } });
  service.createRecords(table.id, Array.from({ length: 205 }, () => ({ values: {} })));
  const before = service.queryRecords(table.id, { limit: 500 });
  const db = new DatabaseSync(data.path);
  try {
    db.exec("CREATE TRIGGER reject_clock_test BEFORE UPDATE ON records WHEN OLD.position = 202 BEGIN SELECT RAISE(ABORT, 'clock refresh test failure'); END;");
    now = new Date('2024-02-29T12:01:00Z');
    assert.throws(() => service.refreshCalculations(), /clock refresh test failure/);
    assert.deepEqual(service.queryRecords(table.id, { limit: 500 }), before);
    db.exec('DROP TRIGGER reject_clock_test;');
    assert.equal(service.refreshCalculations().changedRecords, 205);
    assert.equal(service.refreshCalculations().changedRecords, 0);
  } finally { db.close(); }
});

test('record-dependent clock formulas refresh only calendar results that change in each named zone', t => {
  let now = new Date('2024-02-29T15:59:30Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Regional dates' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Today', type: 'formula',
    formula: { expression: 'TODAY([' + table.primaryFieldId + '])', resultType: 'date' } });
  const date = table.fields[1]!.id;
  const rows = service.createRecords(table.id, ['Asia/Shanghai', 'America/New_York', null, 'Invalid/Zone'].map(zone => ({ values: { [table.primaryFieldId]: zone } }))).records;
  now = new Date('2024-02-29T16:00:00Z');
  assert.equal(service.refreshCalculations().changedRecords, 1);
  const after = service.queryRecords(table.id, {}).records;
  assert.equal(after[0]!.values[date], '2024-03-01'); assert.equal(after[0]!.version, 2);
  assert.deepEqual(after.slice(1), rows.slice(1));
});

test('reciprocal edits capture the same clock for automatic edit times and ordinary clock formulas', t => {
  let now = new Date('2024-02-29T12:00:30.123Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let target = service.createTable({ name: 'Targets' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Edited', type: 'updatedTime' });
  const edited = target.fields[1]!.id;
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
  const time = target.fields[2]!.id;
  let source = service.createTable({ name: 'Sources' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Targets', type: 'relation', relation: { tableId: target.id, multiple: true },
    reverseField: { name: 'Sources', multiple: true, expectedVersion: target.version } });
  const targetRow = service.createRecords(target.id, [{ values: {} }]).records[0]!;
  const sourceRow = service.createRecords(source.id, [{ values: {} }]).records[0]!;
  now = new Date('2024-02-29T12:01:55.789Z');
  service.updateBatch([{ id: sourceRow.id, expectedVersion: sourceRow.version, values: { [source.fields[1]!.id]: [targetRow.id] } }], source.id);
  const after = service.getRecord(target.id, targetRow.id);
  assert.equal(after.version, 2); assert.equal(after.values[time], '2024-02-29T12:01:00.000Z'); assert.equal(after.values[edited], now.toISOString());
});

test('constant clock propagation retains JSON numbers, booleans, nulls, text and error recovery', t => {
  let now = new Date('2024-02-29T23:59:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Typed clock results' });
  for (const [name, expression, resultType] of [
    ['Minute', 'MINUTE(NOW())', 'number'], ['Flag', 'MINUTE(NOW()) > 0', 'checkbox'],
    ['Optional', 'IF(MINUTE(NOW()) == 0, NULL, "value")', 'text'], ['Label', 'CONCAT("line\\n", NOW())', 'text'],
  ]) table = service.createField(table.id, { expectedVersion: table.version, name, type: 'formula', formula: { expression, resultType } });
  const [minute, flag, optional, label] = table.fields.slice(1).map(field => field.id);
  const row = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: '{"unchanged":true}' } }]).records[0]!;
  now = new Date('2024-03-01T00:00:00Z');
  service.refreshCalculations();
  const after = service.getRecord(table.id, row.id);
  assert.equal(after.version, 2); assert.equal(after.values[minute!], 0); assert.equal(after.values[flag!], false);
  assert.equal(after.values[optional!], null); assert.equal(after.values[label!], 'line\n2024-03-01T00:00:00.000Z');
  assert.equal(after.values[table.primaryFieldId], '{"unchanged":true}');
  now = new Date('+010000-01-01T00:00:00Z'); service.refreshCalculations();
  assert.equal(Object.keys(service.getRecord(table.id, row.id).formulaErrors!).length, 4);
  now = new Date('2024-03-01T00:00:00Z'); service.refreshCalculations();
  assert.equal(service.getRecord(table.id, row.id).formulaErrors, undefined);
});

test('clock semantics migration preserves deterministic formulas, values and saved versions', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Existing formulas' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Total', type: 'formula', formula: { expression: 'ARRAYSUM(ARRAY(1, 2))', resultType: 'number' } });
  service.createRecords(table.id, [{ values: {} }]);
  const schema = service.getTable(table.id), records = service.queryRecords(table.id, {}), views = service.listViews(table.id);
  store.close();
  const db = new DatabaseSync(data.path); removeWorkspaceState(db); db.exec('PRAGMA user_version = 26;'); db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(table.id), schema); assert.deepEqual(reopened.queryRecords(table.id, {}), records); assert.deepEqual(reopened.listViews(table.id), views);
  assert.equal(reopened.refreshCalculations().changedRecords, 0);
  const check = new DatabaseSync(data.path);
  try { assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 32); } finally { check.close(); }
});
