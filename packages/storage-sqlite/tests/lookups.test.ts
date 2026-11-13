import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { FieldCreate } from '../../contracts/src/index.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { fixture } from './helpers.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';
import { TableModel } from '../../client/src/table-model.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null);
  const store = data.open();
  const service = new RecordService(store);
  let target = service.createTable({ name: 'Projects' });
  for (const field of [
    { name: 'Budget', type: 'number', numberFormat: 'currency', currency: 'USD' },
    { name: 'Done', type: 'checkbox' }, { name: 'Due', type: 'date' },
    { name: 'Tags', type: 'multiSelect', options: [{ id: 'blue', name: '蓝色' }, { id: 'red', name: 'Red' }, { id: 'unused', name: 'Unused' }] },
  ] satisfies Array<Omit<FieldCreate, 'expectedVersion'>>) target = service.createField(target.id, { ...field, expectedVersion: target.version });
  const [name, budget, done, due, tags] = target.fields;
  const targets = service.createRecords(target.id, [
    { values: { [name!.id]: 'Alpha', [budget!.id]: 2, [done!.id]: false, [due!.id]: '2026-01-01', [tags!.id]: ['red', 'blue'] } },
    { values: { [name!.id]: '中文 Beta', [budget!.id]: 10, [done!.id]: true, [tags!.id]: ['blue'] } },
    { values: { [name!.id]: 'Empty' } },
  ]).records;
  let source = service.createTable({ name: 'Tasks' });
  source = service.createField(source.id, { expectedVersion: 1, name: 'Projects', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const relation = source.fields[1]!;
  for (const field of target.fields) source = service.createField(source.id, { expectedVersion: source.version,
    name: `Project ${field.name}`, type: 'lookup', lookup: { relationFieldId: relation.id, fieldId: field.id } });
  const lookups = source.fields.filter(field => field.type === 'lookup');
  const records = service.createRecords(source.id, [[targets[0]!.id, targets[1]!.id], [targets[1]!.id], [targets[2]!.id], []]
    .map(ids => ({ values: { [relation.id]: ids } }))).records;
  return { data, store, service, target, source, targets, relation, lookups, records };
}

test('lookups preserve typed values and link order without storing editable copies', t => {
  const { data, service, source, target, lookups, records, targets } = setup(t);
  const [name, budget, done, due, tags] = lookups;
  const first = records[0]!;
  assert.deepEqual(first.values[name!.id], ['Alpha', '中文 Beta']);
  assert.deepEqual(first.values[budget!.id], [2, 10]);
  assert.deepEqual(first.values[done!.id], [false, true]);
  assert.deepEqual(first.values[due!.id], ['2026-01-01', null]);
  assert.deepEqual(first.values[tags!.id], ['red', 'blue', 'blue']);
  assert.deepEqual(records[3]!.values[budget!.id], []);
  assert.equal(budget!.lookupResult!.currency, 'USD');
  const page = service.queryRecords(source.id, { limit: 1 });
  service.updateBatch([{ id: targets[0]!.id, expectedVersion: 1, values: { [target.fields[1]!.id]: 7 } }], target.id);
  assert.throws(() => service.queryRecords(source.id, { offset: 1, expectedRevision: page.revision }), code('DATA_CHANGED'));
  assert.equal(service.getRecord(source.id, first.id).version, first.version);
  assert.deepEqual(service.getRecord(source.id, first.id).values[budget!.id], [7, 10]);
  assert.deepEqual(new RecordService(data.open()).getRecord(source.id, first.id), service.getRecord(source.id, first.id));
});

test('computed fields reject explicit writes and malformed dependencies without partial changes', t => {
  const { service, source, target, relation, lookups, records } = setup(t);
  assert.throws(() => service.createRecords(source.id, [{ values: { [lookups[0]!.id]: null } }]), code('READ_ONLY_FIELD'));
  assert.throws(() => service.updateBatch([
    { id: records[0]!.id, expectedVersion: 1, values: { [source.primaryFieldId]: 'Should roll back' } },
    { id: records[1]!.id, expectedVersion: 1, values: { [lookups[0]!.id]: [] } },
  ], source.id), code('READ_ONLY_FIELD'));
  assert.equal(service.getRecord(source.id, records[0]!.id).values[source.primaryFieldId], null);
  for (const config of [
    { lookup: { relationFieldId: source.primaryFieldId, fieldId: target.primaryFieldId } },
    { lookup: { relationFieldId: relation.id, fieldId: 'missing' } },
    { lookup: { relationFieldId: relation.id, fieldId: target.primaryFieldId }, required: true },
    { lookup: { relationFieldId: relation.id, fieldId: target.primaryFieldId }, defaultValue: 'Invalid' },
  ]) assert.throws(() => service.createField(source.id, { expectedVersion: source.version, name: 'Invalid', type: 'lookup', ...config }), code('INVALID_SCHEMA'));
  assert.throws(() => service.updateTable(source.id, { expectedVersion: source.version, primaryFieldId: lookups[0]!.id }), code('INVALID_SCHEMA'));
  assert.throws(() => service.previewConversion(source.id, lookups[0]!.id, { expectedVersion: source.version, field: { name: 'Text', type: 'text' } }), code('CONVERSION_REQUIRED'));
  assert.equal(service.getTable(source.id).version, source.version);
});

test('lookup dependencies protect fields, conversions and saved query operands atomically', t => {
  const { service, source, target, relation, lookups, records } = setup(t);
  assert.throws(() => service.deleteField(source.id, relation.id, { expectedVersion: source.version }), code('LOOKUP_DEPENDENCY'));
  assert.throws(() => service.deleteField(target.id, target.fields[1]!.id, { expectedVersion: target.version }), code('LOOKUP_DEPENDENCY'));
  assert.throws(() => service.previewConversion(target.id, target.fields[1]!.id, { expectedVersion: target.version, field: { name: 'Budget text', type: 'text' } }), code('LOOKUP_DEPENDENCY'));
  const tags = target.fields[4]!;
  const view = service.createView(source.id, { name: 'Unused tag', query: { filter: { conjunction: 'and', conditions: [{ fieldId: lookups[4]!.id, operator: 'hasAny', value: ['unused'] }] } } });
  assert.throws(() => service.updateField(target.id, tags.id, { expectedVersion: target.version, options: tags.options!.slice(0, 2) }), code('VIEW_DEPENDENCY'));
  assert.equal(service.getTable(target.id).version, target.version);
  assert.equal(service.getTable(source.id).version, source.version);
  service.deleteView(source.id, view.id, { expectedVersion: view.version });
  const renamed = service.updateField(target.id, tags.id, { expectedVersion: target.version, options: tags.options!.map(option => ({ ...option, name: `${option.name} renamed` })) });
  const refreshed = service.getTable(source.id);
  assert.equal(refreshed.version, source.version + 1);
  assert.equal(refreshed.fields.find(field => field.id === lookups[4]!.id)!.lookupResult!.options![0]!.name, '蓝色 renamed');
  const withoutLookup = service.deleteField(source.id, lookups[1]!.id, { expectedVersion: refreshed.version });
  assert.equal(service.getRecord(source.id, records[0]!.id).version, records[0]!.version);
  service.deleteField(target.id, target.fields[1]!.id, { expectedVersion: renamed.version });
  assert.equal(service.getTable(source.id).version, withoutLookup.version + 1);
  service.deleteTable(source.id, { expectedVersion: service.getTable(source.id).version });
  service.deleteTable(target.id, { expectedVersion: service.getTable(target.id).version });
});

test('lookup queries compare typed members, search labels, project and sort by the first value through HTTP', async t => {
  const { service, source, target, targets, lookups, records } = setup(t);
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const query = (fieldId: string, operator: string, value?: unknown) => service.queryRecords(source.id, { filter: { conjunction: 'and', conditions: [{ fieldId, operator, ...(value !== undefined ? { value } : {}) }] } });
  assert.equal(query(lookups[1]!.id, 'gt', 5).total, 2);
  assert.equal(query(lookups[1]!.id, 'neq', 10).total, 2);
  assert.equal(query(lookups[1]!.id, 'isEmpty').total, 2);
  assert.equal(query(lookups[1]!.id, 'eq', null).total, 1);
  assert.equal(query(lookups[2]!.id, 'eq', false).total, 1);
  assert.equal(query(lookups[4]!.id, 'hasAny', ['red']).total, 1);
  assert.equal((await api.queryRecords(source.id, { search: '蓝色' })).total, 2);
  const projected = await api.queryRecords(source.id, { fields: [lookups[1]!.id], sort: [{ fieldId: lookups[1]!.id, direction: 'asc' }] });
  assert.deepEqual(projected.records.map(record => record.id), records.map(record => record.id));
  assert.deepEqual(Object.keys(projected.records[0]!.values), [lookups[1]!.id]);
  assert.deepEqual(projected.records[0]!.values[lookups[1]!.id], [2, 10]);
  const model = new TableModel(api.table(source.id));
  await model.initialize();
  await assert.rejects(model.clearCells([0], [source.primaryFieldId, lookups[1]!.id]), /read-only/);
  await assert.rejects(model.paste(0, 2, [['Overwritten']] ), /read-only/);
  assert.equal(model.pendingCells, 0);
  model.applyEdits([{ row: 0, fieldId: source.primaryFieldId, value: 'Keep draft' }]);
  await api.updateRecords(target.id, [{ id: targets[0]!.id, expectedVersion: 1, values: { [target.fields[1]!.id]: 99 } }]);
  await model.refresh();
  assert.equal(model.getRecord(0)!.values[source.primaryFieldId], 'Keep draft');
  assert.deepEqual(model.getRecord(0)!.values[lookups[1]!.id], [99, 10]);
});

test('version-five migration preserves existing linked records and views', t => {
  const data = fixture(t, null);
  const store = data.open();
  const service = new RecordService(store);
  let table = service.createTable({ name: 'Self linked' });
  table = service.createField(table.id, { expectedVersion: 1, name: 'Related', type: 'relation', relation: { tableId: table.id, multiple: true } });
  const record = service.createRecords(table.id, [{ values: {} }]).records[0]!;
  service.updateBatch([{ id: record.id, expectedVersion: 1, values: { [table.fields[1]!.id]: [record.id] } }], table.id);
  const before = service.getRecord(table.id, record.id);
  const views = service.listViews(table.id);
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec('DROP TABLE attachments; DROP TABLE field_sequences; DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; DROP TABLE field_lookups; ALTER TABLE records DROP COLUMN formula_errors_json; PRAGMA user_version = 5;');
  db.close();
  const migrated = new RecordService(data.open());
  assert.deepEqual(migrated.getRecord(table.id, record.id), before);
  assert.deepEqual(migrated.listViews(table.id), views);
});
