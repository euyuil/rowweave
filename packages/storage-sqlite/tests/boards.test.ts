import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  let table = service.createTable({ name: 'Tasks' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }] });
  const status = table.fields[1]!.id;
  const board = service.createView(table.id, { name: 'By status', type: 'board', groupBy: status,
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: table.primaryFieldId, operator: 'contains', value: 'Task' }] } } });
  return { data, service, table, status, board };
}

test('board lanes combine saved filters and search, preserve option IDs and reject stale pagination', t => {
  const { service, table, status, board } = setup(t);
  const rows = service.createRecords(table.id, Array.from({ length: 605 }, (_, i) => ({ values: {
    [table.primaryFieldId]: i === 604 ? 'Excluded' : `Task ${i}`, [status]: i < 602 ? 'todo' : null,
  } }))).records;
  const first = service.queryView(table.id, board.id, { lane: 'todo', limit: 20 });
  assert.equal(first.total, 602);
  assert.equal(first.records.length, 20);
  assert.equal(service.queryView(table.id, board.id, { lane: null }).total, 2);
  assert.equal(service.queryView(table.id, board.id, { lane: 'done' }).total, 0);
  assert.equal(service.queryView(table.id, board.id, { lane: 'todo', search: 'Task 601' }).total, 1);
  assert.equal(service.queryView(table.id, board.id, { lane: 'todo', offset: 600, expectedRevision: first.revision }).records.length, 2);
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: rows[0]!.version, values: { [status]: 'done' } }], table.id);
  assert.equal(service.queryView(table.id, board.id, { lane: 'done' }).total, 1);
  assert.throws(() => service.updateBatch([{ id: rows[0]!.id, expectedVersion: rows[0]!.version, values: { [status]: null } }], table.id), /changed/);
  assert.throws(() => service.queryView(table.id, board.id, { lane: 'todo', offset: 20, expectedRevision: first.revision }),
    (error: unknown) => error instanceof ServiceError && error.code === 'DATA_CHANGED');
  service.updateField(table.id, status, { expectedVersion: table.version, options: [{ id: 'todo', name: 'Planned' }, { id: 'done', name: 'Finished' }] });
  assert.equal(service.queryView(table.id, board.id, { lane: 'done' }).records[0]!.id, rows[0]!.id);
  const summary = service.summarizeRecords(table.id, { viewId: board.id, groupBy: status });
  assert.equal(summary.groups.find(group => group.key === 'done')!.label, 'Finished');
});

test('boards validate grouping and lanes, preserve maximum-size filters, and block incompatible schema changes', t => {
  const { service, table, status, board } = setup(t);
  const grid = service.listViews(table.id)[0]!;
  for (const input of [{ type: 'calendar' }, { type: 'board' }, { type: 'board', groupBy: table.primaryFieldId },
    { type: 'board', groupBy: 'missing' }, { type: 'grid', groupBy: table.primaryFieldId }]) {
    assert.throws(() => service.createView(table.id, { name: 'Invalid', ...input }), ServiceError);
  }
  for (const lane of ['missing', '', 1, false]) assert.throws(() => service.queryView(table.id, board.id, { lane }), ServiceError);
  assert.throws(() => service.queryView(table.id, grid.id, { lane: null }), /board view/);
  assert.throws(() => service.deleteField(table.id, status, { expectedVersion: table.version }), /Update view/);
  assert.throws(() => service.previewConversion(table.id, status, { expectedVersion: table.version, field: { name: 'Status', type: 'text' } }), /Update view/);
  assert.deepEqual(service.getTable(table.id), table);
  const many = service.updateView(table.id, board.id, { expectedVersion: board.version, query: { filter: {
    conjunction: 'and', conditions: Array.from({ length: 100 }, () => ({ fieldId: table.primaryFieldId, operator: 'isNotEmpty' })),
  } } });
  assert.equal(service.queryView(table.id, many.id, { lane: null }).total, 0);
  assert.throws(() => service.queryView(table.id, many.id, { lane: null, expectedViewVersion: board.version }), /view changed/);
  const restoredGrid = service.updateView(table.id, many.id, { expectedVersion: many.version, type: 'grid' });
  assert.equal(restoredGrid.groupBy, undefined);
  service.deleteField(table.id, status, { expectedVersion: table.version });
});

test('version-eight migration retains custom display settings and creates grid views without changing data', t => {
  const { data, service, table } = setup(t);
  const grid = service.listViews(table.id)[0]!;
  const changed = service.updateView(table.id, grid.id, { expectedVersion: grid.version, rowHeight: 64, frozenColumns: 1 });
  const db = new DatabaseSync(data.path);
  db.exec("DELETE FROM views WHERE json_extract(config_json, '$.type') = 'board'; UPDATE views SET config_json = json_remove(config_json, '$.type'); ALTER TABLE records DROP COLUMN formula_errors_json; PRAGMA user_version = 8;");
  db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getView(table.id, grid.id), changed);
  assert.deepEqual(reopened.getTable(table.id), table);
});

test('HTTP and SDK create boards, query lanes and reject conflicting moves', async t => {
  const { service, table, status } = setup(t);
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const board = await api.createView(table.id, { name: 'Board', type: 'board', groupBy: status });
  const record = (await api.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Task', [status]: 'todo' } }])).records[0]!;
  assert.equal((await api.queryView(table.id, board.id, { lane: 'todo' })).total, 1);
  await api.updateRecords(table.id, [{ id: record.id, expectedVersion: record.version, values: { [status]: 'done' } }]);
  assert.equal((await api.queryView(table.id, board.id, { lane: 'done' })).total, 1);
  await assert.rejects(api.updateRecords(table.id, [{ id: record.id, expectedVersion: record.version, values: { [status]: 'todo' } }]), { code: 'VERSION_CONFLICT' });
});
