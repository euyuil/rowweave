import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), service = new RecordService(data.open());
  let items = service.createTable({ name: 'Items' });
  items = service.createField(items.id, { expectedVersion: items.version, name: 'Amount', type: 'number' });
  const amount = items.fields[1]!.id;
  const rows = service.createRecords(items.id, [10, 20, 100].map(value => ({ values: { [amount]: value } }))).records;
  let orders = service.createTable({ name: 'Orders' });
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Items', type: 'relation', relation: { tableId: items.id, multiple: true } });
  const link = orders.fields[1]!.id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Subtotal', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } });
  const subtotal = orders.fields[2]!.id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Tax rate', type: 'number', defaultValue: 0.1 });
  const rate = orders.fields[3]!.id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Total', type: 'formula', formula: { expression: '[' + subtotal + '] * (1 + [' + rate + '])', resultType: 'number' } });
  const total = orders.fields[4]!.id;
  return { data, service, items, orders, amount, rows, link, subtotal, rate, total };
}

test('linked formulas recalculate saved values, versions, queries, summaries and exports after target edits', t => {
  const { data, service, items, orders, amount, rows, link, subtotal, total } = setup(t);
  const records = service.createRecords(orders.id, [[rows[0]!.id, rows[1]!.id], [rows[2]!.id]].map(ids => ({ values: { [link]: ids } }))).records;
  assert.equal(records[0]!.values[total], 33);
  assert.equal(records[0]!.version, 1);
  const page = service.queryRecords(orders.id, { limit: 1 });
  const view = service.createView(orders.id, { name: 'Over fifty', query: { filter: { conjunction: 'and', conditions: [{ fieldId: total, operator: 'gt', value: 50 }] }, sort: [{ fieldId: total, direction: 'desc' }] } });
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [amount]: 40 } }], items.id);
  const read = service.getRecord(orders.id, records[0]!.id);
  assert.equal(read.values[subtotal], 60);
  assert.equal(read.values[total], 66);
  assert.equal(read.version, 2);
  assert.equal(service.getRecord(orders.id, records[1]!.id).version, 1);
  assert.throws(() => service.queryRecords(orders.id, { offset: 1, expectedRevision: page.revision }), /changed between pages/);
  assert.equal(service.queryView(orders.id, view.id, {}).total, 2);
  assert.equal(service.queryRecords(orders.id, { search: '66' }).total, 1);
  assert.equal(service.summarizeRecords(orders.id, { measures: [{ fieldId: total, operation: 'sum' }] }).totals.values[0], 176);
  assert.match(service.exportCsv(orders.id, {}), /66/);
  assert.throws(() => service.updateBatch([{ id: records[0]!.id, expectedVersion: 1, values: { [link]: [] } }], orders.id), /changed/);
  assert.deepEqual(new RecordService(data.open()).getRecord(orders.id, read.id), read);
});

test('connected formulas propagate across multiple tables and reject cross-table cycles atomically', t => {
  const { service, items, orders, rows, amount, link, total, subtotal } = setup(t);
  const order = service.createRecords(orders.id, [{ values: { [link]: [rows[0]!.id] } }]).records[0]!;
  let reports = service.createTable({ name: 'Reports' });
  reports = service.createField(reports.id, { expectedVersion: reports.version, name: 'Orders', type: 'relation', relation: { tableId: orders.id, multiple: true } });
  const reportLink = reports.fields[1]!.id;
  reports = service.createField(reports.id, { expectedVersion: reports.version, name: 'Order totals', type: 'lookup', lookup: { relationFieldId: reportLink, fieldId: total, operation: 'sum' } });
  const reportSum = reports.fields[2]!.id;
  reports = service.createField(reports.id, { expectedVersion: reports.version, name: 'Doubled', type: 'formula', formula: { expression: '[' + reportSum + '] * 2', resultType: 'number' } });
  const reportTotal = reports.fields[3]!.id;
  const report = service.createRecords(reports.id, [{ values: { [reportLink]: [order.id] } }]).records[0]!;
  assert.equal(report.values[reportTotal], 22);
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [amount]: 50 } }], items.id);
  assert.equal(service.getRecord(reports.id, report.id).values[reportTotal], 110.00000000000001);
  assert.equal(service.getRecord(reports.id, report.id).version, 2);
  let source = service.createField(items.id, { expectedVersion: items.version, name: 'Orders', type: 'relation', relation: { tableId: orders.id, multiple: true } });
  const back = source.fields.at(-1)!.id;
  source = service.createField(items.id, { expectedVersion: source.version, name: 'Order sum', type: 'lookup', lookup: { relationFieldId: back, fieldId: total, operation: 'sum' } });
  const sum = source.fields.at(-1)!.id;
  source = service.createField(items.id, { expectedVersion: source.version, name: 'Calculated amount', type: 'formula', formula: { expression: '[' + sum + ']', resultType: 'number' } });
  const calculated = source.fields.at(-1)!.id;
  const before = service.listTables();
  assert.throws(() => service.updateField(orders.id, subtotal, { expectedVersion: service.getTable(orders.id).version, lookup: { relationFieldId: link, fieldId: calculated, operation: 'sum' } }), /dependency cycle/);
  assert.deepEqual(service.listTables(), before);
});

test('linked errors propagate and clear without persisting lookup inputs or losing unrelated errors', t => {
  const { data, service, items, orders, amount, rows, link, subtotal, total, rate } = setup(t);
  const target = service.createField(items.id, { expectedVersion: items.version, name: 'Inverse amount', type: 'formula', formula: { expression: '100 / [' + amount + ']', resultType: 'number' } });
  const inverse = target.fields.at(-1)!.id;
  service.updateField(orders.id, subtotal, { expectedVersion: service.getTable(orders.id).version, lookup: { relationFieldId: link, fieldId: inverse, operation: 'sum' } });
  const record = service.createRecords(orders.id, [{ values: { [link]: [rows[0]!.id] } }]).records[0]!;
  assert.equal(record.values[total], 11);
  let item = service.getRecord(items.id, rows[0]!.id);
  service.updateBatch([{ id: item.id, expectedVersion: item.version, values: { [amount]: 0 } }], items.id);
  let read = service.getRecord(orders.id, record.id);
  assert.equal(read.values[total], null);
  assert.match(read.formulaErrors![subtotal]!, /linked formula/);
  assert.match(read.formulaErrors![total]!, /referenced calculation/);
  assert.throws(() => service.exportCsv(orders.id, {}), /calculation error/);
  assert.equal(service.queryRecords(orders.id, { fields: [rate] }).records[0]!.formulaErrors, undefined);
  read = service.updateBatch([{ id: read.id, expectedVersion: read.version, values: { [rate]: 0.2 } }], orders.id).records[0]!;
  assert.match(read.formulaErrors![total]!, /referenced calculation/);
  const version = read.version;
  service.updateField(orders.id, total, { expectedVersion: service.getTable(orders.id).version, name: 'Final total' });
  assert.equal(service.getRecord(orders.id, record.id).version, version);
  item = service.getRecord(items.id, item.id);
  service.updateBatch([{ id: item.id, expectedVersion: item.version, values: { [amount]: 25 } }], items.id);
  read = service.getRecord(orders.id, record.id);
  assert.equal(read.values[total], 4.8);
  assert.equal(read.formulaErrors, undefined);
  assert.deepEqual(new RecordService(data.open()).getRecord(orders.id, record.id), read);
});

test('lookup configuration, local conversions, empty links and CSV writes keep connected results consistent', t => {
  const { service, orders, rows, link, subtotal, total, rate, amount } = setup(t);
  let record = service.createRecords(orders.id, [{ values: { [link]: rows.slice(0, 2).map(row => row.id) } }]).records[0]!;
  let schema = service.getTable(orders.id);
  schema = service.updateField(orders.id, subtotal, { expectedVersion: schema.version, lookup: { relationFieldId: link, fieldId: amount, operation: 'average' } });
  record = service.getRecord(orders.id, record.id);
  assert.equal(record.values[total], 16.5);
  assert.equal(record.version, 2);
  service.applyConversion(orders.id, rate, { expectedVersion: schema.version, field: { name: 'Tax rate', type: 'text' } });
  assert.match(service.getRecord(orders.id, record.id).formulaErrors![total]!, /number/);
  schema = service.applyConversion(orders.id, rate, { expectedVersion: service.getTable(orders.id).version, field: { name: 'Tax rate', type: 'number', defaultValue: 0.1 } });
  record = service.getRecord(orders.id, record.id);
  assert.equal(record.values[total], 16.5);
  assert.equal(record.formulaErrors, undefined);
  schema = service.updateField(orders.id, link, { expectedVersion: schema.version, defaultValue: [rows[0]!.id] });
  service.importCsv(orders.id, { expectedVersion: schema.version, hasHeader: true, csv: 'Name\nImported' });
  assert.equal(service.queryRecords(orders.id, { search: 'Imported' }).records[0]!.values[total], 11);
  record = service.updateBatch([{ id: record.id, expectedVersion: record.version, values: { [link]: [] } }], orders.id).records[0]!;
  assert.equal(record.values[total], null);
  assert.equal(record.formulaErrors, undefined);
  schema = service.updateField(orders.id, subtotal, { expectedVersion: schema.version, lookup: { relationFieldId: link, fieldId: amount, operation: 'count' } });
  assert.equal(service.getRecord(orders.id, record.id).values[total], 0);
  schema = service.updateField(orders.id, subtotal, { expectedVersion: schema.version, lookup: { relationFieldId: link, fieldId: amount, operation: 'values' } });
  const arrayResult = service.getRecord(orders.id, record.id);
  assert.equal(arrayResult.values[total], null); assert.match(arrayResult.formulaErrors![total]!, /single value/);
  service.updateField(orders.id, total, { expectedVersion: schema.version, formula: { expression: 'COALESCE(ARRAYSUM([' + subtotal + ']), 0) * (1 + [' + rate + '])', resultType: 'number' } });
  assert.equal(service.getRecord(orders.id, record.id).values[total], 0);
  assert.equal(service.getRecord(orders.id, record.id).formulaErrors, undefined);
  assert.equal(service.queryRecords(orders.id, { search: 'Imported' }).records[0]!.values[total], 11);
});

test('reciprocal edits and deletion recalculate formulas on the opposite record', t => {
  const service = new RecordService(fixture(t, null).open());
  let projects = service.createTable({ name: 'Projects' });
  let tasks = service.createTable({ name: 'Tasks' });
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Effort', type: 'number' });
  const effort = tasks.fields[1]!.id;
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project', type: 'relation', relation: { tableId: projects.id, multiple: false },
    reverseField: { name: 'Tasks', multiple: true, expectedVersion: projects.version } });
  const link = tasks.fields[2]!.id;
  projects = service.getTable(projects.id);
  const reverse = projects.fields[1]!.id;
  projects = service.createField(projects.id, { expectedVersion: projects.version, name: 'Effort total', type: 'lookup', lookup: { relationFieldId: reverse, fieldId: effort, operation: 'sum' } });
  const sum = projects.fields[2]!.id;
  projects = service.createField(projects.id, { expectedVersion: projects.version, name: 'Budget', type: 'formula', formula: { expression: 'COALESCE([' + sum + '], 0) * 100', resultType: 'number' } });
  const budget = projects.fields[3]!.id;
  const project = service.createRecords(projects.id, [{ values: {} }]).records[0]!;
  const task = service.createRecords(tasks.id, [{ values: { [effort]: 3, [link]: [project.id] } }]).records[0]!;
  let read = service.getRecord(projects.id, project.id);
  assert.equal(read.values[budget], 300);
  assert.equal(read.version, 2);
  service.deleteRecords(tasks.id, [{ id: task.id, expectedVersion: task.version }]);
  read = service.getRecord(projects.id, project.id);
  assert.equal(read.values[budget], 0);
  assert.equal(read.version, 3);
});

test('large fan-out recalculation updates every affected record and rolls back late conflicts', t => {
  const { service, items, orders, amount, rows, link, total } = setup(t);
  const records = service.createRecords(orders.id, Array.from({ length: 505 }, () => ({ values: { [link]: [rows[0]!.id] } }))).records;
  const before = service.getTable(orders.id);
  assert.throws(() => service.updateBatch([
    { id: rows[0]!.id, expectedVersion: 1, values: { [amount]: 30 } },
    { id: rows[1]!.id, expectedVersion: 99, values: { [amount]: 30 } },
  ], items.id), /changed/);
  assert.deepEqual(service.getTable(orders.id), before);
  assert.equal(service.getRecord(orders.id, records[504]!.id).values[total], 11);
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [amount]: 30 } }], items.id);
  assert.equal(service.queryRecords(orders.id, { filter: { conjunction: 'and', conditions: [{ fieldId: total, operator: 'eq', value: 33 }] } }).total, 505);
  assert.equal(service.getRecord(orders.id, records[504]!.id).version, 2);
});

test('same-table summaries and downstream formulas handle existing records and schema edits', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Work' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Effort', type: 'number' });
  const effort = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Related', type: 'relation', relation: { tableId: table.id, multiple: true } });
  const link = table.fields[2]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Linked effort', type: 'lookup', lookup: { relationFieldId: link, fieldId: effort, operation: 'sum' } });
  const summary = table.fields[3]!.id;
  const item = service.createRecords(table.id, [{ values: { [effort]: 4 } }]).records[0]!;
  const parent = service.createRecords(table.id, [{ values: { [link]: [item.id] } }]).records[0]!;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Double', type: 'formula', formula: { expression: '[' + summary + '] * 2', resultType: 'number' } });
  const double = table.fields[4]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Final', type: 'formula', formula: { expression: '[' + double + '] + 1', resultType: 'number' } });
  const final = table.fields[5]!.id;
  assert.equal(service.getRecord(table.id, parent.id).values[final], 9);
  const before = service.getRecord(table.id, parent.id);
  table = service.updateField(table.id, double, { expectedVersion: table.version, formula: { expression: '[' + summary + '] * 3', resultType: 'number' } });
  assert.equal(service.getRecord(table.id, parent.id).values[final], 13);
  assert.equal(service.getRecord(table.id, parent.id).version, before.version + 1);
  const currentItem = service.getRecord(table.id, item.id);
  service.updateBatch([{ id: item.id, expectedVersion: currentItem.version, values: { [effort]: 6 } }], table.id);
  assert.equal(service.getRecord(table.id, parent.id).values[final], 19);
  assert.throws(() => service.updateField(table.id, summary, { expectedVersion: table.version, lookup: { relationFieldId: link, fieldId: final, operation: 'sum' } }), /dependency cycle/);
});

test('connected calculations survive backup restoration and older workspace migration preserves versions', async t => {
  const { data, service, items, orders, rows, amount, link, total } = setup(t);
  const record = service.createRecords(orders.id, [{ values: { [link]: [rows[0]!.id] } }]).records[0]!;
  const backup = join(dirname(data.path), 'backup.sqlite'), restoredPath = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup);
  await restoreWorkspace(backup, restoredPath);
  const store = new SqliteRecordStore(restoredPath);
  try {
    const restored = new RecordService(store);
    assert.deepEqual(restored.getRecord(orders.id, record.id), record);
    restored.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [amount]: 30 } }], items.id);
    assert.equal(restored.getRecord(orders.id, record.id).values[total], 33);
    assert.equal(service.getRecord(orders.id, record.id).values[total], 11);
  } finally { store.close(); }
  const old = fixture(t, null), previous = old.open(), original = new RecordService(previous);
  const table = original.createTable({ name: 'Existing' });
  const row = original.createRecords(table.id, [{ values: {} }]).records[0]!;
  const schema = original.getTable(table.id);
  previous.close();
  const db = new DatabaseSync(old.path);
  db.exec('DROP TABLE attachments; DROP TABLE field_sequences; DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; PRAGMA user_version = 12;');
  db.close();
  const migrated = new RecordService(old.open());
  assert.deepEqual(migrated.getTable(table.id), schema);
  assert.deepEqual(migrated.getRecord(table.id, row.id), row);
});
