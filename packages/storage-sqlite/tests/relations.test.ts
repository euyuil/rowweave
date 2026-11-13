import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  const projects = service.createTable({ name: 'Projects' });
  const targets = service.createRecords(projects.id, ['Zebra', '中文 🌱', 'Alpha'].map(name => ({ values: { [projects.primaryFieldId]: name } }))).records;
  let tasks = service.createTable({ name: 'Tasks' });
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Projects', type: 'relation', relation: { tableId: projects.id, multiple: true } });
  return { data, service, projects, targets, tasks, link: tasks.fields[1]! };
}

test('linked records retain ordered IDs, labels, defaults and identity through renaming and restart', t => {
  const { data, service, projects, targets, tasks, link } = setup(t);
  service.updateField(tasks.id, link.id, { expectedVersion: tasks.version, defaultValue: [targets[1]!.id] });
  const records = service.createRecords(tasks.id, [{ values: { [link.id]: [targets[2]!.id, targets[0]!.id] } }, { values: {} }]).records;
  assert.deepEqual(records[0]!.links![link.id], [targets[2], targets[0]].map(record => ({ id: record!.id, label: record!.values[projects.primaryFieldId] })));
  assert.deepEqual(records[1]!.values[link.id], [targets[1]!.id]);
  const page = service.queryRecords(tasks.id, { limit: 1 });
  service.updateBatch([{ id: targets[0]!.id, expectedVersion: 1, values: { [projects.primaryFieldId]: 'Renamed' } }], projects.id);
  assert.throws(() => service.queryRecords(tasks.id, { offset: 1, expectedRevision: page.revision }), code('DATA_CHANGED'));
  const next = service.getRecord(tasks.id, records[0]!.id);
  assert.equal(next.links![link.id]![1]!.label, 'Renamed');
  assert.deepEqual(next.values, records[0]!.values);
  assert.equal(next.version, records[0]!.version);
  const restarted = new RecordService(data.open());
  assert.deepEqual(restarted.getRecord(tasks.id, next.id), next);
  assert.equal(restarted.readPage(0, 10, tasks.id).records[1]!.links![link.id]![0]!.label, '中文 🌱');
});

test('invalid links and late batch conflicts roll back values, edges and revisions', t => {
  const { service, projects, targets, tasks, link } = setup(t);
  const records = service.createRecords(tasks.id, [{ values: {} }, { values: {} }]).records;
  const before = service.getTable(tasks.id);
  for (const invalid of [[targets[0]!.id, targets[0]!.id], ['missing'], [records[0]!.id], [1]]) {
    assert.throws(() => service.updateBatch([
      { id: records[0]!.id, expectedVersion: 1, values: { [link.id]: [targets[0]!.id] } },
      { id: records[1]!.id, expectedVersion: 1, values: { [link.id]: invalid } },
    ], tasks.id));
    assert.deepEqual(service.getTable(tasks.id), before);
    assert.deepEqual(service.readPage(0, 10, tasks.id).records, records);
  }
  assert.throws(() => service.updateBatch([
    { id: records[0]!.id, expectedVersion: 1, values: { [link.id]: [targets[0]!.id] } },
    { id: records[1]!.id, expectedVersion: 99, values: { [link.id]: [targets[1]!.id] } },
  ], tasks.id), code('VERSION_CONFLICT'));
  service.deleteRecords(projects.id, [{ id: targets[0]!.id, expectedVersion: 1 }]);
  assert.equal(service.getRecord(tasks.id, records[0]!.id).values[link.id], null);
});

test('relationship schema constraints prevent retargeting live links and invalid cardinality', t => {
  const { service, projects, targets, tasks, link } = setup(t);
  const record = service.createRecords(tasks.id, [{ values: { [link.id]: targets.slice(0, 2).map(record => record.id) } }]).records[0]!;
  assert.throws(() => service.updateField(tasks.id, link.id, { expectedVersion: tasks.version, relation: { tableId: 'missing', multiple: true } }), code('INVALID_SCHEMA'));
  assert.throws(() => service.updateField(tasks.id, link.id, { expectedVersion: tasks.version, relation: { tableId: tasks.id, multiple: true } }), code('RELATION_DEPENDENCY'));
  assert.throws(() => service.updateField(tasks.id, link.id, { expectedVersion: tasks.version, relation: { tableId: projects.id, multiple: false } }), code('INVALID_VALUE'));
  assert.throws(() => service.updateTable(tasks.id, { expectedVersion: tasks.version, primaryFieldId: link.id }), code('INVALID_SCHEMA'));
  assert.throws(() => service.previewConversion(tasks.id, link.id, { expectedVersion: tasks.version, field: { name: 'Text', type: 'text' } }), code('CONVERSION_REQUIRED'));
  service.updateBatch([{ id: record.id, expectedVersion: 1, values: { [link.id]: [targets[0]!.id] } }], tasks.id);
  const next = service.updateField(tasks.id, link.id, { expectedVersion: tasks.version, relation: { tableId: projects.id, multiple: false } });
  assert.equal(next.fields[1]!.relation!.multiple, false);
  assert.throws(() => service.createRecords(tasks.id, [{ values: { [link.id]: targets.slice(0, 2).map(record => record.id) } }]), code('INVALID_VALUE'));
});

test('linked records and defaults restrict deletion until references are explicitly removed', t => {
  const { service, projects, targets, tasks, link } = setup(t);
  const record = service.createRecords(tasks.id, [{ values: { [link.id]: [targets[1]!.id] } }]).records[0]!;
  assert.throws(() => service.deleteRecords(projects.id, targets.slice(0, 2).map(record => ({ id: record.id, expectedVersion: 1 }))), code('RELATION_DEPENDENCY'));
  assert.equal(service.getTable(projects.id).total, 3);
  assert.deepEqual(service.getRecord(tasks.id, record.id).values[link.id], [targets[1]!.id]);
  let schema = service.updateField(tasks.id, link.id, { expectedVersion: tasks.version, defaultValue: [targets[0]!.id] });
  assert.throws(() => service.deleteRecords(projects.id, [{ id: targets[0]!.id, expectedVersion: 1 }]), code('RELATION_DEPENDENCY'));
  service.deleteRecords(tasks.id, [{ id: record.id, expectedVersion: 1 }]);
  service.deleteRecords(projects.id, [{ id: targets[1]!.id, expectedVersion: 1 }]);
  assert.throws(() => service.deleteTable(projects.id, { expectedVersion: projects.version }), code('RELATION_DEPENDENCY'));
  schema = service.deleteField(tasks.id, link.id, { expectedVersion: schema.version });
  service.deleteTable(projects.id, { expectedVersion: projects.version });
  assert.equal(service.getTable(tasks.id).version, schema.version);
});

test('self-linked closed record sets can be deleted atomically without order dependence', t => {
  const { service, tasks } = setup(t);
  const table = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Related', type: 'relation', relation: { tableId: tasks.id, multiple: true } });
  const field = table.fields[2]!;
  const records = service.createRecords(table.id, [{ values: {} }, { values: {} }]).records;
  service.updateBatch(records.map((record, index) => ({ id: record.id, expectedVersion: 1, values: { [field.id]: [records[1 - index]!.id] } })), table.id);
  assert.throws(() => service.deleteRecords(table.id, [{ id: records[0]!.id, expectedVersion: 2 }]), code('RELATION_DEPENDENCY'));
  service.deleteRecords(table.id, records.map(record => ({ id: record.id, expectedVersion: 2 })));
  assert.equal(service.getTable(table.id).total, 0);
  service.deleteTable(table.id, { expectedVersion: table.version });
});

test('relation queries match IDs, search primary labels and sort deterministically through HTTP', async t => {
  const { service, projects, targets, tasks, link } = setup(t);
  const records = service.createRecords(tasks.id, [targets[0]!.id, targets[1]!.id, targets[2]!.id, null].map(id => ({ values: { [link.id]: id ? [id] : [] } }))).records;
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  assert.deepEqual((await api.queryRecords(tasks.id, { search: '中文' })).records.map(record => record.id), [records[1]!.id]);
  assert.deepEqual((await api.queryRecords(tasks.id, { sort: [{ fieldId: link.id, direction: 'asc' }] })).records.map(record => record.id), [records[2], records[0], records[1], records[3]].map(record => record!.id));
  assert.equal((await api.queryRecords(tasks.id, { filter: { conjunction: 'and', conditions: [{ fieldId: link.id, operator: 'isEmpty' }] } })).total, 1);
  assert.equal((await api.queryRecords(tasks.id, { filter: { conjunction: 'and', conditions: [{ fieldId: link.id, operator: 'hasAny', value: [targets[1]!.id, targets[2]!.id] }] } })).total, 2);
  const projected = await api.queryRecords(tasks.id, { recordIds: [records[0]!.id], fields: [tasks.primaryFieldId] });
  assert.equal(projected.records[0]!.links, undefined);
  assert.equal((await api.queryRecords(projects.id, { recordIds: [targets[1]!.id] })).records[0]!.id, targets[1]!.id);
  await assert.rejects(api.queryRecords(projects.id, { recordIds: ['duplicate', 'duplicate'] }), /unique record IDs/);
});

test('version-four migration preserves schemas, records and saved views', t => {
  const data = fixture(t);
  const store = data.open();
  const table = store.getTable();
  const records = store.readPage(0, 12);
  const views = store.listViews(table.id);
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec('DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; DROP TABLE field_lookups; DROP TABLE relation_edges; DROP TABLE field_relations; ALTER TABLE records DROP COLUMN formula_errors_json; PRAGMA user_version = 4;');
  db.close();
  const migrated = data.open();
  assert.deepEqual(migrated.getTable(), table);
  assert.deepEqual(migrated.readPage(0, 12), records);
  assert.deepEqual(migrated.listViews(table.id), views);
});
