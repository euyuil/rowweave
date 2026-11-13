import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { SqliteRecordStore } from '../src/record-store.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
function setup(t: Parameters<typeof fixture>[0], multiple = true) {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  let projects = service.createTable({ name: 'Projects' });
  const rows = service.createRecords(projects.id, ['Alpha', 'Beta'].map(name => ({ values: { [projects.primaryFieldId]: name } }))).records;
  let tasks = service.createTable({ name: 'Tasks' });
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project', type: 'relation',
    relation: { tableId: projects.id, multiple: false }, reverseField: { name: 'Tasks', multiple, expectedVersion: projects.version } });
  projects = service.getTable(projects.id);
  return { data, service, projects, tasks, rows, link: tasks.fields[1]!, inverse: projects.fields[1]! };
}

test('two-way links update both values, labels, queries and versions from either side and survive restart', t => {
  const { data, service, projects, tasks, rows, link, inverse } = setup(t);
  assert.equal(link.relation!.inverseFieldId, inverse.id);
  assert.equal(inverse.relation!.inverseFieldId, link.id);
  const stale = service.queryRecords(projects.id, { limit: 1 });
  const task = service.createRecords(tasks.id, [{ values: { [tasks.primaryFieldId]: 'Prepare release', [link.id]: [rows[0]!.id] } }]).records[0]!;
  const project = service.getRecord(projects.id, rows[0]!.id);
  assert.deepEqual(project.values[inverse.id], [task.id]);
  assert.deepEqual(project.links![inverse.id], [{ id: task.id, label: 'Prepare release' }]);
  assert.equal(project.version, 2);
  assert.throws(() => service.queryRecords(projects.id, { offset: 1, expectedRevision: stale.revision }), code('DATA_CHANGED'));
  assert.equal(service.queryRecords(projects.id, { search: 'release' }).total, 1);
  assert.equal(service.queryRecords(projects.id, { filter: { conjunction: 'and', conditions: [{ fieldId: inverse.id, operator: 'hasAny', value: [task.id] }] } }).total, 1);
  assert.throws(() => service.updateBatch([{ id: project.id, expectedVersion: 1, values: { [inverse.id]: [] } }], projects.id), code('VERSION_CONFLICT'));
  service.updateBatch([{ id: project.id, expectedVersion: project.version, values: { [inverse.id]: [] } }], projects.id);
  const unlinked = service.getRecord(tasks.id, task.id);
  assert.deepEqual(unlinked.values[link.id], []);
  assert.equal(unlinked.version, 2);
  service.updateBatch([{ id: rows[1]!.id, expectedVersion: 1, values: { [inverse.id]: [task.id] } }], projects.id);
  const linked = service.getRecord(tasks.id, task.id);
  assert.deepEqual(linked.values[link.id], [rows[1]!.id]);
  assert.equal(linked.version, 3);
  assert.deepEqual(new RecordService(data.open()).getRecord(tasks.id, task.id), linked);
});

test('both schema versions and field constraints are checked before committing a pair', t => {
  const { service, projects, tasks } = setup(t);
  const before = service.listTables();
  const input = { expectedVersion: tasks.version, name: 'Other', type: 'relation', relation: { tableId: projects.id, multiple: true },
    reverseField: { name: 'Back', multiple: true, expectedVersion: projects.version } };
  assert.throws(() => service.createField(tasks.id, { ...input, reverseField: { ...input.reverseField, expectedVersion: 1 } }), code('SCHEMA_CONFLICT'));
  assert.throws(() => service.createField(tasks.id, { ...input, expectedVersion: 1 }), code('SCHEMA_CONFLICT'));
  assert.throws(() => service.createField(tasks.id, { ...input, reverseField: { ...input.reverseField, multiple: 'yes' } }), code('INVALID_SCHEMA'));
  assert.throws(() => service.createField(tasks.id, { ...input, relation: { ...input.relation, inverseFieldId: 'invented' } }), code('INVALID_SCHEMA'));
  assert.throws(() => service.createField(tasks.id, { ...input, type: 'text' }), code('INVALID_SCHEMA'));
  assert.deepEqual(service.listTables(), before);
  const paired = tasks.fields[1]!;
  assert.throws(() => service.updateField(tasks.id, paired.id, { expectedVersion: tasks.version, relation: { tableId: tasks.id, multiple: true } }), code('RELATION_DEPENDENCY'));
  const renamed = service.updateField(tasks.id, paired.id, { expectedVersion: tasks.version, name: 'Renamed', relation: { tableId: projects.id, multiple: true } });
  assert.equal(renamed.fields[1]!.relation!.inverseFieldId, paired.relation!.inverseFieldId);
});

test('one-to-one batch swaps use final cardinality and failures roll back both sides', t => {
  const { service, projects, tasks, rows, link, inverse } = setup(t, false);
  const before = service.listTables();
  assert.throws(() => service.createRecords(tasks.id, [0, 1].map(() => ({ values: { [link.id]: [rows[0]!.id] } }))), code('INVALID_VALUE'));
  assert.deepEqual(service.listTables(), before);
  assert.equal(service.getRecord(projects.id, rows[0]!.id).values[inverse.id], undefined);
  const records = service.createRecords(tasks.id, rows.map(row => ({ values: { [link.id]: [row.id] } }))).records;
  const swap = records.map((record, index) => ({ id: record.id, expectedVersion: record.version, values: { [link.id]: [rows[1 - index]!.id] } }));
  assert.throws(() => service.updateBatch([swap[0], { ...swap[1], expectedVersion: 99 }], tasks.id), code('VERSION_CONFLICT'));
  assert.deepEqual(service.readPage(0, 10, tasks.id).records, records);
  service.updateBatch(swap, tasks.id);
  assert.deepEqual(service.getRecord(projects.id, rows[0]!.id).values[inverse.id], [records[1]!.id]);
  assert.deepEqual(service.getRecord(projects.id, rows[1]!.id).values[inverse.id], [records[0]!.id]);
  service.updateField(projects.id, inverse.id, { expectedVersion: projects.version, required: true });
  assert.throws(() => service.updateBatch([{ id: records[0]!.id, expectedVersion: 2, values: { [link.id]: [] } }], tasks.id), code('INVALID_VALUE'));
  assert.deepEqual(service.getRecord(tasks.id, records[0]!.id).values[link.id], [rows[1]!.id]);
});

test('self-linked pairs return synchronized values and reject inconsistent explicit assignments', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Hierarchy' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Parent', type: 'relation', relation: { tableId: table.id, multiple: false },
    reverseField: { name: 'Children', multiple: true, expectedVersion: table.version } });
  assert.equal(table.version, 2);
  const [parent, children] = [table.fields[1]!, table.fields[2]!];
  const rows = service.createRecords(table.id, [{ values: {} }, { values: {} }]).records;
  const first = rows[0]!, second = rows[1]!;
  const result = service.updateBatch([
    { id: first.id, expectedVersion: 1, values: { [parent.id]: [second.id] } },
    { id: second.id, expectedVersion: 1, values: { [table.primaryFieldId]: 'Parent record' } },
  ], table.id);
  assert.deepEqual(result.records[1]!.values[children.id], [first.id]);
  assert.equal(result.records[1]!.version, 2);
  assert.throws(() => service.updateBatch([
    { id: first.id, expectedVersion: 2, values: { [parent.id]: [] } },
    { id: second.id, expectedVersion: 2, values: { [children.id]: [first.id] } },
  ], table.id), code('INVALID_LINK'));
  assert.deepEqual(service.readPage(0, 10, table.id).records, result.records);
  service.deleteRecords(table.id, result.records.map(record => ({ id: record.id, expectedVersion: record.version })));
  assert.equal(service.getTable(table.id).total, 0);
});

test('record deletion unlinks the reverse field, while unrelated dependencies still roll back deletion', t => {
  const { service, projects, tasks, rows, link, inverse } = setup(t);
  const task = service.createRecords(tasks.id, [{ values: { [link.id]: [rows[0]!.id] } }]).records[0]!;
  let notes = service.createTable({ name: 'Notes' });
  notes = service.createField(notes.id, { expectedVersion: 1, name: 'Task', type: 'relation', relation: { tableId: tasks.id, multiple: true } });
  const note = service.createRecords(notes.id, [{ values: { [notes.fields[1]!.id]: [task.id] } }]).records[0]!;
  assert.throws(() => service.deleteRecords(tasks.id, [{ id: task.id, expectedVersion: 1 }]), code('RELATION_DEPENDENCY'));
  assert.deepEqual(service.getRecord(projects.id, rows[0]!.id).values[inverse.id], [task.id]);
  assert.equal(service.getRecord(projects.id, rows[0]!.id).version, 2);
  service.deleteRecords(notes.id, [{ id: note.id, expectedVersion: 1 }]);
  service.deleteRecords(tasks.id, [{ id: task.id, expectedVersion: 1 }]);
  assert.deepEqual(service.getRecord(projects.id, rows[0]!.id).values[inverse.id], []);
  assert.equal(service.getRecord(projects.id, rows[0]!.id).version, 3);
});

test('deleting one field preserves the other as one-way links with a new schema version', t => {
  const { service, projects, tasks, rows, link, inverse } = setup(t);
  const task = service.createRecords(tasks.id, [{ values: { [link.id]: [rows[0]!.id] } }]).records[0]!;
  service.deleteField(tasks.id, link.id, { expectedVersion: tasks.version });
  const target = service.getTable(projects.id);
  assert.equal(target.version, projects.version + 1);
  assert.equal(target.fields[1]!.relation!.inverseFieldId, undefined);
  assert.deepEqual(service.getRecord(projects.id, rows[0]!.id).values[inverse.id], [task.id]);
  assert.equal(service.getRecord(tasks.id, task.id).values[link.id], undefined);
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: 2, values: { [inverse.id]: [] } }], projects.id);
  service.deleteRecords(tasks.id, [{ id: task.id, expectedVersion: 2 }]);
});

test('defaults and CSV imports synchronize reverse links and enforce capacity atomically', t => {
  const { service, projects, tasks, rows, link, inverse } = setup(t, false);
  const table = service.updateField(tasks.id, link.id, { expectedVersion: tasks.version, defaultValue: [rows[0]!.id] });
  const input = { expectedVersion: table.version, hasHeader: true, csv: 'Name\nFirst\nSecond' };
  const before = service.listTables();
  assert.equal(service.previewCsv(tasks.id, input).invalid, 0);
  assert.deepEqual(service.listTables(), before);
  assert.throws(() => service.importCsv(tasks.id, input), code('INVALID_VALUE'));
  assert.deepEqual(service.listTables(), before);
  service.importCsv(tasks.id, { ...input, csv: 'Name\nFirst' });
  const record = service.readPage(0, 1, tasks.id).records[0]!;
  assert.deepEqual(service.getRecord(projects.id, rows[0]!.id).values[inverse.id], [record.id]);
  assert.deepEqual(record.values[link.id], [rows[0]!.id]);
  assert.throws(() => service.deleteRecords(projects.id, [{ id: rows[0]!.id, expectedVersion: 2 }]), code('RELATION_DEPENDENCY'));
});

test('HTTP and SDK expose both field identities and live reverse lookup results', async t => {
  const { service, projects, tasks, rows, link, inverse } = setup(t);
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const target = await api.createField(projects.id, { expectedVersion: projects.version, name: 'Task names', type: 'lookup', lookup: { relationFieldId: inverse.id, fieldId: tasks.primaryFieldId } });
  const lookup = target.fields[2]!;
  const task = (await api.createRecords(tasks.id, [{ values: { [tasks.primaryFieldId]: 'Live name', [link.id]: [rows[0]!.id] } }])).records[0]!;
  assert.deepEqual((await api.getRecord(projects.id, rows[0]!.id)).values[lookup.id], ['Live name']);
  await api.updateRecords(projects.id, [{ id: rows[0]!.id, expectedVersion: 2, values: { [inverse.id]: [] } }]);
  assert.deepEqual((await api.getRecord(tasks.id, task.id)).values[link.id], []);
  assert.deepEqual((await api.getRecord(projects.id, rows[0]!.id)).values[lookup.id], []);
  const source = await api.getTable(tasks.id);
  const next = await api.createField(tasks.id, { expectedVersion: source.version, name: 'Another link', type: 'relation', relation: { tableId: projects.id, multiple: true },
    reverseField: { name: 'Another reverse', multiple: true, expectedVersion: target.version } });
  assert.equal((await api.getTable(projects.id)).fields.at(-1)!.relation!.inverseFieldId, next.fields.at(-1)!.id);
});

test('format eleven migration keeps existing values and schemas while protecting two-way semantics', t => {
  const data = fixture(t, null);
  const store = data.open();
  const service = new RecordService(store);
  const table = service.createTable({ name: 'Existing' });
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Preserved' } }]).records[0]!;
  const schema = service.getTable(table.id);
  store.close();
  const previous = new DatabaseSync(data.path);
  previous.exec('PRAGMA user_version = 11;');
  previous.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(table.id), schema);
  assert.deepEqual(reopened.getRecord(table.id, record.id), record);
  const current = new DatabaseSync(data.path);
  assert.equal(current.prepare('PRAGMA user_version').get()!['user_version'], 13);
  current.close();
});

test('backup restoration preserves paired identities and subsequent reverse writes', async t => {
  const { data, service, projects, tasks, rows, link, inverse } = setup(t);
  const task = service.createRecords(tasks.id, [{ values: { [link.id]: [rows[0]!.id] } }]).records[0]!;
  const backup = join(dirname(data.path), 'paired-backup.sqlite');
  const restoredPath = join(dirname(data.path), 'paired-restored.sqlite');
  await backupWorkspace(data.path, backup);
  await restoreWorkspace(backup, restoredPath);
  const store = new SqliteRecordStore(restoredPath);
  try {
    const restored = new RecordService(store);
    assert.deepEqual(restored.listTables(), service.listTables());
    restored.updateBatch([{ id: rows[0]!.id, expectedVersion: 2, values: { [inverse.id]: [] } }], projects.id);
    assert.deepEqual(restored.getRecord(tasks.id, task.id).values[link.id], []);
    assert.deepEqual(service.getRecord(tasks.id, task.id).values[link.id], [rows[0]!.id]);
  } finally { store.close(); }
});
