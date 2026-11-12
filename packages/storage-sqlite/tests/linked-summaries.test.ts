import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let target = service.createTable({ name: 'Items' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number', numberFormat: 'currency', currency: 'USD' });
  const amount = target.fields[1]!.id;
  const rows = service.createRecords(target.id, [0, 10, null, 20].map(value => ({ values: { [amount]: value } }))).records;
  let source = service.createTable({ name: 'Groups' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Items', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = source.fields[1]!.id;
  const fields: Record<string, string> = {};
  for (const operation of ['values', 'count', 'sum', 'average', 'min', 'max']) {
    source = service.createField(source.id, { expectedVersion: source.version, name: operation, type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation } });
    fields[operation] = source.fields.at(-1)!.id;
  }
  return { data, store, service, target, source, amount, rows, link, fields };
}

test('linked summaries preserve zero, ignore nulls and distinguish empty summaries from counts', t => {
  const { service, source, rows, link, fields } = setup(t);
  const records = service.createRecords(source.id, [rows.map(row => row.id), [], [rows[2]!.id], [rows[0]!.id]].map(ids => ({ values: { [link]: ids } }))).records;
  const values = (index: number) => Object.fromEntries(Object.entries(fields).map(([name, id]) => [name, records[index]!.values[id]]));
  assert.deepEqual(values(0), { values: [0, 10, null, 20], count: 3, sum: 30, average: 10, min: 0, max: 20 });
  assert.deepEqual(values(1), { values: [], count: 0, sum: null, average: null, min: null, max: null });
  assert.deepEqual(values(2), { values: [null], count: 0, sum: null, average: null, min: null, max: null });
  assert.deepEqual(values(3), { values: [0], count: 1, sum: 0, average: 0, min: 0, max: 0 });
  assert.deepEqual(service.readPage(0, 20, source.id).records, records);
  assert.match(service.exportCsv(source.id, {}), /3,30,10,0,20/);
});

test('linked summary queries, full-set groups and projections follow source changes with revision guards', t => {
  const { service, target, source, amount, rows, link, fields } = setup(t);
  const records = service.createRecords(source.id, Array.from({ length: 601 }, (_, i) => ({ values: {
    [source.primaryFieldId]: `Group ${i}`, [link]: i < 501 ? [rows[1]!.id] : [rows[3]!.id],
  } }))).records;
  const view = service.createView(source.id, { name: 'Large', query: { filter: { conjunction: 'and', conditions: [{ fieldId: fields['sum'], operator: 'gte', value: 20 }] },
    sort: [{ fieldId: fields['sum'], direction: 'desc' }] } });
  assert.equal(service.queryView(source.id, view.id, {}).total, 100);
  const first = service.queryRecords(source.id, { fields: [fields['sum']], limit: 20 });
  assert.deepEqual(Object.keys(first.records[0]!.values), [fields['sum']]);
  const summary = service.summarizeRecords(source.id, { groupBy: fields['sum'], measures: [{ fieldId: fields['sum'], operation: 'sum' }] });
  assert.deepEqual(summary.totals, { count: 601, values: [7010] });
  assert.deepEqual(summary.groups.map(group => [group.key, group.count]), [[10, 501], [20, 100]]);
  service.updateBatch([{ id: rows[1]!.id, expectedVersion: 1, values: { [amount]: 30 } }], target.id);
  assert.throws(() => service.queryRecords(source.id, { expectedRevision: first.revision }), /changed/);
  assert.equal(service.queryView(source.id, view.id, {}).total, 601);
  const read = service.getRecord(source.id, records[0]!.id);
  assert.equal(read.version, records[0]!.version);
  assert.equal(read.values[fields['sum']!], 30);
  assert.equal(service.queryRecords(source.id, { search: '30' }).total, 502);
  service.updateBatch([{ id: read.id, expectedVersion: read.version, values: { [link]: [] } }], source.id);
  assert.equal(service.getRecord(source.id, read.id).values[fields['sum']!], null);
});

test('aggregate errors are explicit and consistent across records, queries, summaries and CSV', t => {
  const { service, target, source, amount, rows, link, fields } = setup(t);
  service.updateBatch([rows[0]!, rows[1]!].map(row => ({ id: row.id, expectedVersion: row.version, values: { [amount]: 1e308 } })), target.id);
  const record = service.createRecords(source.id, [{ values: { [link]: [rows[0]!.id, rows[1]!.id] } }]).records[0]!;
  assert.equal(record.values[fields['sum']!], null);
  assert.match(record.formulaErrors![fields['sum']!]!, /numeric range/);
  assert.equal(service.queryRecords(source.id, { filter: { conjunction: 'and', conditions: [{ fieldId: fields['sum'], operator: 'isEmpty' }] } }).total, 1);
  assert.deepEqual(service.summarizeRecords(source.id, { measures: [{ fieldId: fields['sum'], operation: 'sum' }] }).totals.values, [null]);
  assert.throws(() => service.exportCsv(source.id, {}), /calculation error/);
  const formulaTarget = service.createField(target.id, { expectedVersion: target.version, name: 'Ratio', type: 'formula', formula: { expression: `1 / [${amount}]`, resultType: 'number' } });
  const formula = formulaTarget.fields.at(-1)!;
  const changed = service.updateField(source.id, fields['sum']!, { expectedVersion: service.getTable(source.id).version, lookup: { relationFieldId: link, fieldId: formula.id, operation: 'sum' } });
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: 3, values: { [amount]: 0 } }], target.id);
  assert.match(service.getRecord(source.id, record.id).formulaErrors![fields['sum']!]!, /linked formula/);
  const projected = service.queryRecords(source.id, { fields: [source.primaryFieldId] }).records[0]!;
  assert.equal(projected.formulaErrors, undefined);
  assert.throws(() => service.updateField(target.id, formula.id, { expectedVersion: formulaTarget.version, formula: { expression: '"Label"', resultType: 'text' } }), /dependent linked summaries/);
  assert.equal(service.getTable(source.id).version, changed.version);
});

test('linked summaries validate numeric targets, remain read-only and preserve array lookup compatibility', t => {
  const { service, source, target, amount, link, fields } = setup(t);
  for (const lookup of [
    { relationFieldId: link, fieldId: target.primaryFieldId, operation: 'sum' },
    { relationFieldId: link, fieldId: amount, operation: 'median' },
  ]) assert.throws(() => service.createField(source.id, { expectedVersion: source.version, name: 'Invalid', type: 'lookup', lookup }));
  assert.equal(service.getTable(source.id).version, source.version);
  assert.throws(() => service.createRecords(source.id, [{ values: { [fields['sum']!]: 4 } }]), /read-only/);
  service.createView(source.id, { name: 'Only twenty', query: { filter: { conjunction: 'and', conditions: [{ fieldId: fields['sum'], operator: 'gt', value: 20 }] } } });
  assert.throws(() => service.updateField(source.id, fields['sum']!, { expectedVersion: source.version,
    lookup: { relationFieldId: link, fieldId: target.primaryFieldId, operation: 'values' } }), /view/);
  assert.equal(service.getTable(source.id).version, source.version);
  assert.throws(() => service.deleteField(target.id, amount, { expectedVersion: target.version }), /dependent lookup/);
});

test('version-ten migration preserves stored formulas, existing lookups and views across reopen', t => {
  const { data, store, service, source, rows, link } = setup(t);
  const record = service.createRecords(source.id, [{ values: { [link]: rows.map(row => row.id) } }]).records[0]!;
  const tables = service.listTables(), views = service.listViews(source.id);
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec('PRAGMA user_version = 10');
  db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.listTables(), tables);
  assert.deepEqual(reopened.listViews(source.id), views);
  assert.deepEqual(reopened.getRecord(source.id, record.id), record);
});

test('HTTP and SDK expose numeric lookup configuration and scalar results', async t => {
  const { service, source, rows, link, fields } = setup(t);
  const token = randomBytes(32).toString('hex'), server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const record = (await api.createRecords(source.id, [{ values: { [link]: rows.map(row => row.id) } }])).records[0]!;
  assert.equal(record.values[fields['average']!], 10);
  assert.equal((await api.queryRecords(source.id, { filter: { conjunction: 'and', conditions: [{ fieldId: fields['sum']!, operator: 'eq', value: 30 }] } })).total, 1);
  assert.equal((await api.getTable(source.id)).fields.find(field => field.id === fields['sum'])!.lookup!.operation, 'sum');
});
