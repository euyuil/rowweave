import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { parseCsv } from '../../core/src/csv.js';
import { querySql } from '../src/query-sql.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), service = new RecordService(data.open());
  let table = service.createTable({ name: 'Tasks' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'planned', name: 'Z planned' }, { id: 'done', name: 'A done' }] });
  const status = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const amount = table.fields[2]!.id;
  const view = service.createView(table.id, { name: 'Grouped', groupBy: status, query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: table.primaryFieldId, operator: 'contains', value: 'Task' }] },
    sort: [{ fieldId: amount, direction: 'desc' }],
  } });
  return { data, service, table, status, amount, view };
}

test('grouped grids order options before record sorts and keep pagination, summary and CSV consistent', t => {
  const { data, service, table, status, amount, view } = setup(t);
  const rows = service.createRecords(table.id, Array.from({ length: 607 }, (_, i) => ({ values: {
    [table.primaryFieldId]: i === 606 ? 'Excluded' : `Task ${i}`, [status]: i < 3 ? null : i < 5 ? 'done' : 'planned', [amount]: i,
  } }))).records;
  const first = service.queryView(table.id, view.id, { limit: 500, fields: [table.primaryFieldId] });
  assert.equal(first.total, 606);
  assert.equal(first.records[0]!.id, rows[605]!.id);
  assert.deepEqual(Object.keys(first.records[0]!.values), [table.primaryFieldId]);
  const next = service.queryView(table.id, view.id, { offset: 500, limit: 500, expectedRevision: first.revision });
  assert.equal(next.records.length, 106);
  assert.deepEqual(next.records.slice(-5).map(row => row.id), [4, 3, 2, 1, 0].map(index => rows[index]!.id));
  const summary = service.summarizeRecords(table.id, { viewId: view.id, groupBy: status, expectedRevision: first.revision });
  assert.equal(summary.groups.find(group => group.key === 'planned')!.count, 601);
  const csv = [...parseCsv(service.exportCsv(table.id, { viewId: view.id }))];
  assert.equal(csv.length, 607);
  assert.equal(csv[1]!.cells[0]!.text, 'Task 605');
  assert.equal(csv.at(-1)!.cells[0]!.text, 'Task 0');
  assert.equal(service.queryView(table.id, view.id, { search: 'Task 3', limit: 500 }).records.at(-1)!.id, rows[3]!.id);
  const db = new DatabaseSync(data.path);
  try {
    const sql = querySql(table, { ...view.query, groupBy: status, offset: 0, limit: 100 }, new Map());
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT r.id FROM records r WHERE ${sql.where} ORDER BY ${sql.order} LIMIT 100`).all(sql.parameters);
    assert.ok(plan.some(row => String(row['detail']).includes('rowweave_view_')));
    assert.ok(plan.every(row => !String(row['detail']).includes('TEMP B-TREE')));
  } finally { db.close(); }
  service.updateBatch([{ id: rows[605]!.id, expectedVersion: 1, values: { [status]: 'done' } }], table.id);
  assert.equal(service.queryView(table.id, view.id, {}).records[0]!.id, rows[604]!.id);
  assert.throws(() => service.queryView(table.id, view.id, { offset: 500, expectedRevision: first.revision }), /changed between pages/);
  assert.throws(() => service.updateBatch([{ id: rows[605]!.id, expectedVersion: 1, values: { [status]: null } }], table.id), /changed/);
  assert.deepEqual(new RecordService(data.open()).queryView(table.id, view.id, {}), service.queryView(table.id, view.id, {}));
});

test('grouping survives renames, follows option order and prevents incompatible schema changes', t => {
  const { service, table, status, view } = setup(t);
  const rows = service.createRecords(table.id, ['planned', 'done'].map(value => ({ values: { [table.primaryFieldId]: 'Task', [status]: value } }))).records;
  const updated = service.updateField(table.id, status, { expectedVersion: table.version, name: 'Phase',
    options: [{ id: 'done', name: 'Complete' }, { id: 'planned', name: 'Planned' }] });
  assert.equal(service.queryView(table.id, view.id, {}).records[0]!.id, rows[1]!.id);
  assert.throws(() => service.deleteField(table.id, status, { expectedVersion: updated.version }), /Update view/);
  assert.throws(() => service.previewConversion(table.id, status, { expectedVersion: updated.version, field: { name: 'Phase', type: 'text' } }), /Update view/);
  for (const groupBy of ['', false, table.primaryFieldId, 'missing']) {
    assert.throws(() => service.createView(table.id, { name: 'Invalid', groupBy }), ServiceError);
  }
  const current = service.getView(table.id, view.id);
  const ungrouped = service.updateView(table.id, view.id, { expectedVersion: current.version, groupBy: null });
  assert.equal(ungrouped.groupBy, undefined);
  assert.throws(() => service.updateView(table.id, view.id, { expectedVersion: current.version, groupBy: status }), /view changed/);
  service.deleteField(table.id, status, { expectedVersion: updated.version });
});

test('checkbox groups distinguish false, true and missing values through HTTP and SDK', async t => {
  const data = fixture(t, null), service = new RecordService(data.open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  let table = await api.createTable({ name: 'Checklist' });
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Done', type: 'checkbox' });
  const done = table.fields[1]!.id;
  const view = await api.createView(table.id, { name: 'Grouped', type: 'grid', groupBy: done });
  await api.createRecords(table.id, [null, true, false].map(value => ({ values: { [done]: value } })));
  assert.deepEqual((await api.queryView(table.id, view.id, {})).records.map(record => record.values[done]), [false, true, null]);
  assert.equal((await api.summarizeRecords(table.id, { viewId: view.id, groupBy: done })).groupCount, 3);
  assert.equal((await api.updateView(table.id, view.id, { expectedVersion: 1, groupBy: null })).groupBy, undefined);
});

test('format thirteen migration retains existing view, schema and record versions', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  const table = service.createTable({ name: 'Existing' });
  const row = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Preserved' } }]).records[0]!;
  const view = service.listViews(table.id)[0]!;
  const saved = service.updateView(table.id, view.id, { expectedVersion: view.version, rowHeight: 48, frozenColumns: 1 });
  const schema = service.getTable(table.id);
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec('DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; PRAGMA user_version = 13;');
  db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getRecord(table.id, row.id), row);
  assert.deepEqual(reopened.getTable(table.id), schema);
  assert.deepEqual(reopened.getView(table.id, view.id), saved);
});
