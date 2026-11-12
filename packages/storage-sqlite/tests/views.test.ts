import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';

test('saved views persist query and column settings and detect changed continuation views', t => {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  let table = service.createTable({ name: 'Projects' });
  table = service.createField(table.id, { expectedVersion: 1, name: 'Amount', type: 'number' });
  const name = table.primaryFieldId;
  const amount = table.fields[1]!.id;
  service.createRecords(table.id, ['A', 'B', 'C'].map((value, index) => ({ values: { [name]: value, [amount]: index === 1 ? 1 : 2 } })));
  assert.equal(service.listViews(table.id).length, 1);
  assert.equal(service.listViews(table.id)[0]!.columns.length, 2);
  const view = service.createView(table.id, { name: 'Important',
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: amount, operator: 'gte', value: 2 }] }, sort: [{ fieldId: name, direction: 'desc' }] },
    columns: [{ fieldId: amount, width: 120, hidden: true }, { fieldId: name, width: 260, hidden: false }] });
  const first = service.queryView(table.id, view.id, { limit: 1 });
  assert.equal(first.total, 2);
  assert.deepEqual(first.records[0]!.values, { [name]: 'C' });
  assert.equal(first.viewVersion, 1);
  const peer = new RecordService(data.open());
  assert.deepEqual(peer.getView(table.id, view.id), view);
  const next = service.queryView(table.id, view.id, { offset: 1, expectedRevision: first.revision, expectedViewVersion: 1 });
  assert.deepEqual(next.records[0]!.values, { [name]: 'A' });
  const changed = peer.updateView(table.id, view.id, { expectedVersion: 1, name: 'Renamed', query: {} });
  assert.equal(changed.id, view.id);
  assert.equal(changed.version, 2);
  assert.throws(() => service.updateView(table.id, view.id, { expectedVersion: 1, name: 'Stale' }), /view changed/);
  assert.throws(() => service.queryView(table.id, view.id, { offset: 1, expectedRevision: first.revision, expectedViewVersion: 1 }), /view changed/);
  assert.equal(service.queryView(table.id, view.id, {}).total, 3);
  assert.equal(service.queryView(table.id, view.id, { search: 'B' }).total, 1);
});

test('schema changes reconcile columns and deleted predicates without breaking intentional empty groups', t => {
  const service = new RecordService(fixture(t).open());
  const table = service.getTable();
  const view = service.createView(table.id, { name: 'Only field 2',
    columns: table.fields.map(field => ({ fieldId: field.id, width: 180, hidden: field.id !== 'field_2' })),
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: 'field_2', operator: 'contains', value: 'Row' }] }, sort: [{ fieldId: 'field_2', direction: 'asc' }] } });
  service.deleteField(table.id, 'field_2', { expectedVersion: 1 });
  const updated = service.getView(table.id, view.id);
  assert.equal(updated.version, 2);
  assert.deepEqual(updated.query, { sort: [] });
  assert.equal(updated.columns.find(column => column.fieldId === table.primaryFieldId)!.hidden, false);
  assert.equal(service.queryView(table.id, view.id, {}).total, 12);
  const empty = service.createView(table.id, { name: 'Nothing', query: { filter: { conjunction: 'or', conditions: [] } } });
  service.updateField(table.id, table.primaryFieldId, { expectedVersion: 2, name: 'Renamed' });
  assert.equal(service.queryView(table.id, empty.id, {}).total, 0);
  const added = service.createField(table.id, { expectedVersion: 3, name: 'New', type: 'text' });
  for (const current of service.listViews(table.id)) {
    assert.deepEqual(current.columns.at(-1), { fieldId: added.fields.at(-1)!.id, width: 180, hidden: false });
  }
});

test('view dependencies prevent incompatible schema conversion and option removal atomically', t => {
  const service = new RecordService(fixture(t, null).open());
  const table = service.createTable({ name: 'Amounts' });
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: '10' } }]).records[0]!;
  const view = service.createView(table.id, { name: 'Contains one', query: { filter: {
    conjunction: 'and', conditions: [{ fieldId: table.primaryFieldId, operator: 'contains', value: '1' }],
  } } });
  const conversion = { expectedVersion: 1, field: { name: 'Amount', type: 'number' } };
  assert.throws(() => service.previewConversion(table.id, table.primaryFieldId, conversion), /Update view "Contains one"/);
  assert.throws(() => service.applyConversion(table.id, table.primaryFieldId, conversion), /Update view "Contains one"/);
  assert.deepEqual(service.getRecord(table.id, record.id), record);
  service.updateView(table.id, view.id, { expectedVersion: 1, query: {} });
  service.applyConversion(table.id, table.primaryFieldId, conversion);
  const added = service.createField(table.id, { expectedVersion: 2, name: 'Status', type: 'singleSelect', options: [{ id: 'ready', name: 'Ready' }] });
  const status = added.fields[1]!;
  service.createView(table.id, { name: 'Ready items', query: { filter: { conjunction: 'and', conditions: [{ fieldId: status.id, operator: 'eq', value: 'ready' }] } } });
  assert.throws(() => service.updateField(table.id, status.id, { expectedVersion: 3, options: [] }), /Update view "Ready items"/);
  assert.deepEqual(service.getTable(table.id), added);
});

test('view validation, deletion and table ownership keep usable configurations', t => {
  const service = new RecordService(fixture(t).open());
  const table = service.getTable();
  const initial = service.listViews(table.id)[0]!;
  const invalid = [
    { name: '' }, { name: 'Bad', query: null }, { name: 'Bad', columns: [] },
    { name: 'Bad', columns: initial.columns.map(column => ({ ...column, hidden: true })) },
    { name: 'Bad', columns: initial.columns.map(column => ({ ...column, width: 0 })) },
    { name: 'Bad', query: { sort: [{ fieldId: 'missing', direction: 'asc' }] } },
  ];
  for (const input of invalid) assert.throws(() => service.createView(table.id, input), ServiceError);
  assert.throws(() => service.deleteView(table.id, initial.id, { expectedVersion: initial.version }), /at least one view/);
  const other = service.createTable({ name: 'Other' });
  assert.throws(() => service.getView(other.id, initial.id), /does not exist/);
  const second = service.createView(table.id, { name: 'Second' });
  assert.throws(() => service.deleteView(table.id, second.id, { expectedVersion: 99 }), /view changed/);
  service.deleteView(table.id, second.id, { expectedVersion: 1 });
  assert.deepEqual(service.listViews(table.id), [initial]);
  service.deleteTable(table.id, { expectedVersion: table.version });
  assert.equal(service.listViews(other.id).length, 1);
});

test('version-three workspaces receive an initial view while preserving records and revisions', t => {
  const data = fixture(t);
  const store = data.open();
  const before = store.getTable();
  const records = store.readPage(0, 12);
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec('DROP TABLE field_lookups; DROP TABLE relation_edges; DROP TABLE field_relations; DROP TABLE views; ALTER TABLE records DROP COLUMN formula_errors_json; PRAGMA user_version = 3;');
  db.close();
  const reopened = data.open();
  assert.deepEqual(reopened.getTable(), before);
  assert.deepEqual(reopened.readPage(0, 12), records);
  assert.equal(reopened.listViews(before.id)[0]!.name, 'All records');
  assert.deepEqual(reopened.listViews(before.id)[0]!.columns.map(column => column.fieldId), before.fields.map(field => field.id));
});
