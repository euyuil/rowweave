import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture, removeWorkspaceState } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

test('workspace state separates catalog, schema, data and saved-view changes', t => {
  const service = new RecordService(fixture(t, null).open());
  const empty = service.workspaceState({});
  let table = service.createTable({ name: 'State' });
  const view = service.listViews(table.id)[0]!;
  const request = { tableId: table.id, viewId: view.id };
  const created = service.workspaceState(request);
  assert.equal(created.catalogRevision, empty.catalogRevision + 1);
  assert.equal(created.table!.schemaVersion, table.version);
  assert.equal(created.table!.dataRevision, table.revision);
  assert.deepEqual(created.table!.view, { id: view.id, version: view.version });
  assert.equal(service.workspaceState({ tableId: table.id }).table!.view, undefined);
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Saved' } }]).records[0]!;
  const data = service.workspaceState(request);
  assert.equal(data.catalogRevision, created.catalogRevision);
  assert.equal(data.table!.schemaVersion, created.table!.schemaVersion);
  assert.equal(data.table!.viewsRevision, created.table!.viewsRevision);
  assert.ok(data.table!.dataRevision > created.table!.dataRevision);
  const renamedView = service.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Renamed view' });
  const changedView = service.workspaceState(request);
  assert.equal(changedView.catalogRevision, data.catalogRevision);
  assert.equal(changedView.table!.dataRevision, data.table!.dataRevision);
  assert.ok(changedView.table!.viewsRevision > data.table!.viewsRevision);
  assert.equal(changedView.table!.view!.version, renamedView.version);
  assert.throws(() => service.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Stale' }), { code: 'VIEW_CONFLICT' });
  assert.deepEqual(service.workspaceState(request), changedView);
  table = service.updateTable(table.id, { expectedVersion: table.version, name: 'Renamed table' });
  const renamed = service.workspaceState(request);
  assert.equal(renamed.catalogRevision, changedView.catalogRevision + 1);
  assert.equal(renamed.table!.schemaVersion, table.version);
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const schema = service.workspaceState(request);
  assert.equal(schema.catalogRevision, renamed.catalogRevision);
  assert.ok(schema.table!.viewsRevision > renamed.table!.viewsRevision, 'A reconciled view must invalidate saved-view state.');
  assert.equal(schema.table!.view!.version, service.getView(table.id, view.id).version);
  const extra = service.createView(table.id, { name: 'Extra' });
  const extraState = service.workspaceState({ tableId: table.id });
  assert.ok(extraState.table!.viewsRevision > schema.table!.viewsRevision);
  service.deleteView(table.id, extra.id, { expectedVersion: extra.version });
  assert.ok(service.workspaceState({ tableId: table.id }).table!.viewsRevision > extraState.table!.viewsRevision);
  assert.equal(service.workspaceState({ tableId: table.id, viewId: extra.id }).table!.view, null);
  const other = service.createTable({ name: 'Other' });
  assert.equal(service.workspaceState({ tableId: other.id, viewId: view.id }).table!.view, null);
  assert.deepEqual(service.getRecord(table.id, record.id), record);
  const beforeDelete = service.workspaceState(request);
  service.deleteTable(table.id, { expectedVersion: table.version });
  assert.deepEqual(service.workspaceState(request), { catalogRevision: beforeDelete.catalogRevision + 1, table: null });
  assert.equal(service.workspaceState({}).table, undefined);
});

test('state reads retain a committed snapshot during another writer and counters roll back atomically', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  const table = service.createTable({ name: 'Before' }), view = service.listViews(table.id)[0]!;
  const request = { tableId: table.id, viewId: view.id }, before = service.workspaceState(request);
  const connection = new DatabaseSync(data.path);
  try {
    connection.exec('BEGIN IMMEDIATE');
    connection.prepare('UPDATE tables SET name = ?, version = version + 1 WHERE id = ?').run('Uncommitted', table.id);
    connection.prepare('UPDATE views SET name = ?, version = version + 1 WHERE id = ?').run('Uncommitted', view.id);
    assert.deepEqual(service.workspaceState(request), before);
    connection.exec('ROLLBACK');
    assert.deepEqual(service.workspaceState(request), before);
  } finally { connection.close(); }
  const another = new RecordService(data.open());
  another.updateTable(table.id, { expectedVersion: table.version, name: 'Committed' });
  assert.equal(service.workspaceState(request).catalogRevision, before.catalogRevision + 1);
  const saved = service.workspaceState(request), history = service.recordBatches(table.id, {});
  for (let index = 0; index < 10; index++) assert.deepEqual(service.workspaceState(request), saved);
  assert.deepEqual(service.recordBatches(table.id, {}), history);
});

test('relative-date state changes at the saved filter boundary without loading records or changing revisions', t => {
  let now = new Date('2024-02-29T15:59:59Z');
  const store = fixture(t, null, () => now).open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Relative state' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'When', type: 'datetime' });
  const view = service.createView(table.id, { name: 'Today', query: { filter: { conjunction: 'and', conditions: [{ conjunction: 'or', conditions: [
    { fieldId: table.fields[1]!.id, operator: 'relativeDate', relative: { period: 'today', timeZone: 'Asia/Shanghai' } },
  ] }] } } });
  const request = { tableId: table.id, viewId: view.id };
  const before = service.workspaceState(request);
  assert.equal(before.table!.view!.dateContext, service.queryView(table.id, view.id, {}).dateContext);
  now = new Date('2024-02-29T16:00:00Z');
  const expected = service.queryView(table.id, view.id, {}).dateContext;
  const ordinaryView = service.listViews(table.id)[0]!.id;
  t.mock.method(store, 'getTable', () => { throw new Error('State must not load the complete table or count its records.'); });
  const after = service.workspaceState(request);
  assert.notEqual(after.table!.view!.dateContext, before.table!.view!.dateContext);
  assert.equal(after.table!.view!.dateContext, expected);
  assert.deepEqual(after, { ...before, table: { ...before.table!, view: { ...before.table!.view!, dateContext: expected! } } });
  assert.equal(service.workspaceState({ tableId: table.id, viewId: ordinaryView }).table!.view!.dateContext, undefined);
});

test('another connection exposes linked-label edits and clock calculation revisions in state', t => {
  let now = new Date('2024-01-01T00:00:00Z');
  const data = fixture(t, null, () => now), service = new RecordService(data.open());
  const target = service.createTable({ name: 'Projects' });
  const project = service.createRecords(target.id, [{ values: { [target.primaryFieldId]: 'First' } }]).records[0]!;
  let source = service.createTable({ name: 'Tasks' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Project', type: 'relation', relation: { tableId: target.id, multiple: false } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
  service.createRecords(source.id, [{ values: { [source.fields[1]!.id]: [project.id] } }]);
  const another = new RecordService(data.open()), request = { tableId: source.id }, before = service.workspaceState(request);
  another.updateBatch([{ id: project.id, expectedVersion: project.version, values: { [target.primaryFieldId]: 'Second' } }], target.id);
  const linked = service.workspaceState(request);
  assert.ok(linked.table!.dataRevision > before.table!.dataRevision);
  assert.equal(linked.catalogRevision, before.catalogRevision);
  now = new Date('2024-01-01T00:01:00Z');
  assert.equal(another.refreshCalculations().changedRecords, 1);
  const calculated = service.workspaceState(request);
  assert.ok(calculated.table!.dataRevision > linked.table!.dataRevision);
  assert.equal(calculated.table!.schemaVersion, linked.table!.schemaVersion);
  assert.equal(calculated.table!.viewsRevision, linked.table!.viewsRevision);
});

test('format 28 migration preserves saved identities and versions and state survives restart and backup', async t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  const table = service.createTable({ name: 'Existing' });
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Preserved' } }]).records[0]!;
  const schema = service.getTable(table.id), views = service.listViews(table.id), history = service.recordHistory(table.id, record.id, {});
  store.close();
  const db = new DatabaseSync(data.path);
  removeWorkspaceState(db); db.exec('PRAGMA user_version = 27'); db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(table.id), schema);
  assert.deepEqual(reopened.getRecord(table.id, record.id), record);
  assert.deepEqual(reopened.listViews(table.id), views);
  assert.deepEqual(reopened.recordHistory(table.id, record.id, {}), history);
  const request = { tableId: table.id, viewId: views[0]!.id }, state = reopened.workspaceState(request);
  assert.equal(state.catalogRevision, 1); assert.equal(state.table!.viewsRevision, 1);
  assert.deepEqual(new RecordService(data.open()).workspaceState(request), state);
  const backup = join(dirname(data.path), 'backup.sqlite'), restored = join(dirname(data.path), 'restored.sqlite');
  assert.equal((await backupWorkspace(data.path, backup)).version, 32);
  assert.equal((await restoreWorkspace(backup, restored)).version, 32);
  const copy = new SqliteRecordStore(restored);
  try {
    assert.deepEqual(copy.workspaceState(request), state);
    assert.deepEqual(copy.getRecord(table.id, record.id), record);
  } finally { copy.close(); }
});
