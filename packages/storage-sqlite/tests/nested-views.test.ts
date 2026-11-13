import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { parseCsv } from '../../core/src/csv.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Nested views' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'b', name: 'B first' }, { id: 'a', name: 'A second' }, { id: 'empty', name: 'Empty' }] });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Category', type: 'text' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const [name, status, category, amount] = table.fields.map(field => field.id) as [string, string, string, string];
  const rows = service.createRecords(table.id, [
    ['A', 'a', 'Same', 1], ['B', 'b', 'Same', 2], ['C', 'a', 'Same', 3], ['D', 'a', '', 4], ['Excluded', 'b', '', 5],
  ].map(values => ({ values: { [name]: values[0]!, [status]: values[1]!, [category]: values[2]!, [amount]: values[3]! } }))).records;
  const view = service.createView(table.id, { name: 'By status and category', groupBy: [status, category],
    groupMeasures: [{ fieldId: amount, operation: 'sum' }], query: {
      filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'neq', value: 'Excluded' }] },
      sort: [{ fieldId: amount, direction: 'desc' }],
    } });
  return { data, store, service, table, name, status, category, amount, rows, view };
}

test('saved nested views align bounded groups, record order, CSV, restart and backup', async t => {
  const { data, service, table, status, category, rows, view } = setup(t);
  const first = service.queryView(table.id, view.id, { limit: 2 });
  const second = service.queryView(table.id, view.id, { offset: 2, expectedRevision: first.revision });
  assert.deepEqual([...first.records, ...second.records].map(record => record.id), [1, 3, 2, 0].map(index => rows[index]!.id));
  const query = { viewId: view.id, expectedViewVersion: view.version, expectedRevision: first.revision };
  const layout = service.queryGroups(table.id, query);
  assert.deepEqual(layout.groups.filter(group => group.path!.length === 1).map(group => [group.path, group.count, group.values]), [
    [['b'], 1, [2]], [['a'], 3, [8]], [['empty'], 0, [null]], [[null], 0, [null]],
  ]);
  assert.deepEqual(service.queryGroups(table.id, { ...query, groupBy: [status, category] }), layout);
  assert.throws(() => service.queryGroups(table.id, { ...query, groupBy: [category, status] }), { code: 'INVALID_QUERY' });
  assert.throws(() => service.queryGroups(table.id, { ...query, groupBy: null }), { code: 'INVALID_QUERY' });
  assert.deepEqual([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].slice(1).map(row => row.cells[0]!.text), ['B', 'D', 'C', 'A']);
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getView(table.id, view.id), view);
  assert.deepEqual(reopened.queryGroups(table.id, query), layout);
  const backup = data.path + '.backup', restored = data.path + '.restored';
  t.after(async () => { await Promise.all([backup, restored].map(path => rm(path, { force: true }))); });
  assert.equal((await backupWorkspace(data.path, backup)).version, 31);
  await restoreWorkspace(backup, restored);
  const db = new DatabaseSync(restored);
  try {
    assert.deepEqual(JSON.parse(db.prepare('SELECT config_json FROM views WHERE id = ?').get(view.id)!['config_json'] as string).groupBy, [status, category]);
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE ?").all('rowweave_view_' + table.id + '_%').length);
  } finally { db.close(); }
});

test('saved nested group dependencies validate every level and preserve stable IDs through schema changes', t => {
  const { service, table: original, status, category, amount, view } = setup(t);
  let table = service.updateField(original.id, category, { expectedVersion: original.version, name: 'Renamed category' });
  assert.deepEqual(service.getView(table.id, view.id).groupBy, [status, category]);
  assert.equal(service.getView(table.id, view.id).version, view.version, 'A label-only schema edit must not rewrite unchanged view configuration.');
  assert.throws(() => service.deleteField(table.id, category, { expectedVersion: table.version }), { code: 'VIEW_DEPENDENCY' });
  assert.throws(() => service.previewConversion(table.id, category, { expectedVersion: table.version,
    field: { name: 'Categories', type: 'multiSelect', options: [] } }), { code: 'VIEW_DEPENDENCY' });
  const current = service.getView(table.id, view.id);
  for (const groupBy of [[], [status, status], [status, 'missing'], [status, category, amount, table.primaryFieldId], false]) {
    assert.throws(() => service.updateView(table.id, view.id, { expectedVersion: current.version, groupBy }), { code: 'INVALID_VIEW' });
  }
  assert.throws(() => service.createView(table.id, { name: 'Invalid board', type: 'board', groupBy: [status] }), { code: 'INVALID_VIEW' });
  const single = service.updateView(table.id, view.id, { expectedVersion: current.version, groupBy: [status] });
  assert.equal(single.groupBy, status);
  assert.deepEqual(service.queryGroups(table.id, { viewId: view.id, groupBy: [status] }), service.queryGroups(table.id, { viewId: view.id }));
  assert.throws(() => service.queryGroups(table.id, { viewId: view.id, expectedViewVersion: current.version }), { code: 'VIEW_CONFLICT' });
  table = service.deleteField(table.id, category, { expectedVersion: table.version });
  assert.ok(!table.fields.some(field => field.id === category));
  const updated = service.getView(table.id, view.id);
  const cleared = service.updateView(table.id, view.id, { expectedVersion: updated.version, groupBy: null });
  assert.equal(cleared.groupBy, undefined); assert.equal(cleared.groupMeasures, undefined);
});

test('nested saved groups can read a linked scalar at a later level without creating a cross-table index', t => {
  const { service, table: original, status, view } = setup(t);
  let target = service.createTable({ name: 'Owners' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Rank', type: 'number' });
  const rank = target.fields[1]!.id;
  const owner = service.createRecords(target.id, [{ values: { [rank]: 0 } }]).records[0]!;
  let table = service.createField(original.id, { expectedVersion: original.version, name: 'Owner', type: 'relation',
    relation: { tableId: target.id, multiple: false } });
  const relation = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Owner rank', type: 'lookup',
    lookup: { relationFieldId: relation, fieldId: rank, operation: 'sum' } });
  const lookup = table.fields.at(-1)!.id, record = service.queryRecords(table.id, {}).records[0]!;
  service.updateBatch([{ id: record.id, expectedVersion: record.version, values: { [relation]: [owner.id] } }], table.id);
  const current = service.getView(table.id, view.id);
  const saved = service.updateView(table.id, view.id, { expectedVersion: current.version, groupBy: [status, lookup] });
  const layout = service.queryGroups(table.id, { viewId: saved.id });
  assert.ok(layout.groups.some(group => group.path!.length === 2 && group.key === 0));
  service.updateBatch([{ id: owner.id, expectedVersion: owner.version, values: { [rank]: 7 } }], target.id);
  assert.throws(() => service.queryGroups(table.id, { viewId: saved.id, expectedRevision: layout.revision }), { code: 'DATA_CHANGED' });
  assert.ok(service.queryGroups(table.id, { viewId: saved.id }).groups.some(group => group.key === 7));
});

test('format 31 preserves scalar views, UUIDs and history when upgrading format 30', t => {
  const { data, store, service, table, status, view, rows } = setup(t);
  const scalar = service.updateView(table.id, view.id, { expectedVersion: view.version, groupBy: status });
  const history = service.recordHistory(table.id, rows[0]!.id, {}), state = service.workspaceState({ tableId: table.id, viewId: view.id });
  store.close();
  const db = new DatabaseSync(data.path); db.exec('PRAGMA user_version = 30'); db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getView(table.id, view.id), scalar);
  assert.deepEqual(reopened.getRecord(table.id, rows[0]!.id), rows[0]);
  assert.deepEqual(reopened.recordHistory(table.id, rows[0]!.id, {}), history);
  assert.deepEqual(reopened.workspaceState({ tableId: table.id, viewId: view.id }), state);
  const nested = reopened.updateView(table.id, view.id, { expectedVersion: scalar.version, groupBy: [status, table.primaryFieldId] });
  assert.ok(reopened.queryGroups(table.id, { viewId: nested.id }).groups.some(group => group.path!.length === 2));
});
