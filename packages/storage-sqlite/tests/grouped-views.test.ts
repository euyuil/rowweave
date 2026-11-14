import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fixture, removeWorkspaceState } from './helpers.js';
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
  assert.throws(() => service.previewConversion(table.id, status, { expectedVersion: updated.version,
    field: { name: 'Phase', type: 'multiSelect', options: updated.fields[1]!.options } }), /Update view/);
  for (const groupBy of ['', false, 'missing']) {
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
  removeWorkspaceState(db); db.exec('DROP TABLE attachments; DROP TABLE field_sequences; DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; PRAGMA user_version = 13;');
  db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getRecord(table.id, row.id), row);
  assert.deepEqual(reopened.getTable(table.id), schema);
  assert.deepEqual(reopened.getView(table.id, view.id), saved);
});

test('saved scalar groups preserve typed order, filters, CSV and restart semantics', t => {
  const data = fixture(t, null), service = new RecordService(data.open());
  for (const [type, values, expected] of [
    ['text', ['a', '', 'A', null], ['', 'A', 'a', null]],
    ['multiline', ['b\nnext', 'A', null], ['A', 'b\nnext', null]],
    ['number', [10, -2, 0, null], [-2, 0, 10, null]],
    ['date', ['2026-11-14', null, '2024-02-29'], ['2024-02-29', '2026-11-14', null]],
    ['datetime', ['2026-11-14T08:00:00+08:00', null, '2026-11-13T23:59:00Z'],
      ['2026-11-13T23:59:00.000Z', '2026-11-14T00:00:00.000Z', null]],
    ['url', ['https://example.com/b', null, 'https://example.com/a'], ['https://example.com/a', 'https://example.com/b', null]],
  ] as const) {
    let table = service.createTable({ name: 'Scalar ' + type });
    table = service.createField(table.id, { expectedVersion: table.version, name: 'Group', type });
    const field = table.fields[1]!.id;
    service.createRecords(table.id, values.map((value, index) => ({ values: { [table.primaryFieldId]: 'Row ' + index, [field]: value } })));
    service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Excluded', [field]: values[0] } }]);
    const view = service.createView(table.id, { name: 'By group', groupBy: field, query: {
      filter: { conjunction: 'and', conditions: [{ fieldId: table.primaryFieldId, operator: 'neq', value: 'Excluded' }] },
      sort: [{ fieldId: table.primaryFieldId, direction: 'desc' }],
    } });
    const page = service.queryView(table.id, view.id, {});
    assert.deepEqual(page.records.map(record => record.values[field]), expected);
    const layout = service.queryGroups(table.id, { viewId: view.id });
    assert.deepEqual(layout.groups.map(group => group.key), expected);
    assert.deepEqual([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].slice(1).map(row => row.cells[0]!.text),
      page.records.map(record => record.values[table.primaryFieldId]));
    const reopened = new RecordService(data.open());
    assert.deepEqual(reopened.getView(table.id, view.id), view);
    assert.deepEqual(reopened.queryGroups(table.id, { viewId: view.id }), layout);
    assert.deepEqual(reopened.queryView(table.id, view.id, {}), page);
  }
});

test('grouped scalar conversions retain field and record IDs and reject array groups', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Conversions' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Group', type: 'text' });
  const field = table.fields[1]!.id;
  const records = service.createRecords(table.id, ['10', '2'].map(value => ({ values: { [field]: value } }))).records;
  const view = service.createView(table.id, { name: 'Grouped', groupBy: field });
  assert.deepEqual(service.queryView(table.id, view.id, {}).records.map(record => record.id), records.map(record => record.id));
  table = service.applyConversion(table.id, field, { expectedVersion: table.version, field: { name: 'Amount', type: 'number' } });
  assert.equal(service.getView(table.id, view.id).groupBy, field);
  assert.deepEqual(service.queryView(table.id, view.id, {}).records.map(record => record.id), [...records].reverse().map(record => record.id));
  assert.deepEqual(service.queryGroups(table.id, { viewId: view.id }).groups.map(group => group.key), [2, 10, null]);
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Tags', type: 'multiSelect', options: [] });
  assert.throws(() => service.createView(table.id, { name: 'Invalid', groupBy: table.fields.at(-1)!.id }), /scalar field/);
  assert.throws(() => service.deleteField(table.id, field, { expectedVersion: table.version }), /Update view/);
});

test('format 29 migration preserves existing schema, records, history and view versions', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  const table = service.createTable({ name: 'Existing' });
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Preserved' } }]).records[0]!;
  const view = service.listViews(table.id)[0]!;
  const saved = service.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Custom', rowHeight: 48 });
  const schema = service.getTable(table.id);
  const state = service.workspaceState({ tableId: table.id, viewId: view.id }), history = service.recordHistory(table.id, record.id, {});
  store.close();
  const db = new DatabaseSync(data.path); db.exec('PRAGMA user_version = 28'); db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(table.id), schema);
  assert.deepEqual(reopened.getRecord(table.id, record.id), record);
  assert.deepEqual(reopened.getView(table.id, view.id), saved);
  assert.deepEqual(reopened.workspaceState({ tableId: table.id, viewId: view.id }), state);
  assert.deepEqual(reopened.recordHistory(table.id, record.id, {}), history);
  const check = new DatabaseSync(data.path);
  try { assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 35); } finally { check.close(); }
  const grouped = reopened.updateView(table.id, view.id, { expectedVersion: saved.version, groupBy: table.primaryFieldId });
  assert.equal(reopened.queryGroups(table.id, { viewId: grouped.id }).groups[0]!.key, 'Preserved');
});
