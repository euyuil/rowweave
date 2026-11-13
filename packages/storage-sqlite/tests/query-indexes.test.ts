import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import type { FieldCreate, ViewQuery } from '../../contracts/src/index.js';
import { parseQuery } from '../../core/src/record-query.js';
import { querySql } from '../src/query-sql.js';

function dataset(t: Parameters<typeof fixture>[0]) {
  let db: DatabaseSync;
  t.after(() => db.close());
  const data = fixture(t, null);
  const store = data.open();
  const service = new RecordService(store);
  let table = service.createTable({ name: 'Indexed views' });
  const add = (input: Omit<FieldCreate, 'expectedVersion'>) => {
    table = service.createField(table.id, { ...input, expectedVersion: table.version });
    return table.fields.at(-1)!.id;
  };
  const amount = add({ name: 'Amount', type: 'number' });
  const done = add({ name: 'Done', type: 'checkbox' });
  const name = table.primaryFieldId;
  db = new DatabaseSync(data.path);
  const indexes = () => db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND name GLOB 'rowweave_view_*' ORDER BY name").all();
  return { data, store, service, table, amount, done, name, db, indexes, add };
}

test('saved queries use shared indexes for rows and counts, maintain writes, and release unused indexes', t => {
  const { service, table, amount, done, name, db, indexes } = dataset(t);
  const rows = service.createRecords(table.id, Array.from({ length: 2000 }, (_, index) => ({
    values: { [name]: `Row ${index}`, [amount]: index, [done]: index % 2 === 0 },
  }))).records;
  const query: ViewQuery = {
    filter: { conjunction: 'and', conditions: [
      { fieldId: amount, operator: 'gte', value: 1900 }, { fieldId: done, operator: 'eq', value: true },
    ] }, sort: [{ fieldId: name, direction: 'desc' }],
  };
  const before = service.queryRecords(table.id, query);
  const view = service.createView(table.id, { name: 'High amounts', query });
  const duplicate = service.createView(table.id, { name: 'Same query', query });
  assert.equal(indexes().length, 1);
  const originalIndexes = indexes();
  assert.deepEqual(service.queryRecords(table.id, query), before);
  assert.equal(service.queryView(table.id, view.id, {}).total, 50);
  const sql = querySql(table, parseQuery(table, query), new Map());
  for (const statement of [
    `SELECT r.id, r.version, r.values_json FROM records r WHERE ${sql.where} ORDER BY ${sql.order} LIMIT 100`,
    `SELECT COUNT(*) FROM records r WHERE ${sql.where}`,
  ]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(sql.parameters);
    assert.ok(plan.some(row => String(row['detail']).includes('rowweave_view_')), JSON.stringify(plan));
  }
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [amount]: 2000 } }], table.id);
  assert.equal(service.queryView(table.id, view.id, {}).total, 51);
  service.deleteRecords(table.id, [{ id: rows[1900]!.id, expectedVersion: 1 }]);
  assert.equal(service.queryView(table.id, view.id, {}).total, 50);
  service.deleteView(table.id, view.id, { expectedVersion: 1 });
  assert.equal(indexes().length, 1);
  service.updateView(table.id, duplicate.id, { expectedVersion: 1, query: { sort: [{ fieldId: amount, direction: 'asc' }] } });
  assert.equal(indexes().length, 1);
  assert.notDeepEqual(indexes(), originalIndexes);
  service.deleteTable(table.id, { expectedVersion: table.version });
  assert.equal(indexes().length, 0);
});

test('indexed predicates preserve quotes, nulls, empty arrays, and NUL text without executing SQL input', t => {
  const { service, table, name, amount, indexes, add } = dataset(t);
  const tags = add({ name: 'Tags', type: 'multiSelect', options: [{ id: 'a', name: 'Alpha' }] });
  const text = "O'Brien\0'); DROP TABLE records; -- 🌱";
  const rows = service.createRecords(table.id, [
    { values: { [name]: text, [tags]: [] } }, { values: { [name]: 'Other', [amount]: 1, [tags]: ['a'] } },
  ]).records;
  for (const query of [
    { filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'eq', value: text }] } },
    { filter: { conjunction: 'or', conditions: [{ fieldId: amount, operator: 'eq', value: null }, { fieldId: tags, operator: 'isEmpty' }] } },
    { filter: { conjunction: 'and', conditions: [{ fieldId: tags, operator: 'hasAny', value: ['a'] }] } },
    { search: 'Alpha' },
  ] satisfies ViewQuery[]) {
    const before = service.queryRecords(table.id, query);
    const view = service.createView(table.id, { name: 'Literal query', query });
    assert.deepEqual(service.queryView(table.id, view.id, {}).records, before.records);
    assert.equal(before.total, 1);
  }
  assert.equal(indexes().length, 2);
  assert.deepEqual(service.getRecord(table.id, rows[0]!.id), rows[0]);
});

test('select label changes rebuild sorting/search indexes and failed conversions roll back index changes', t => {
  const { service, table, indexes, add } = dataset(t);
  const stage = add({ name: 'Stage', type: 'singleSelect', options: [{ id: 'a', name: 'Zebra' }, { id: 'b', name: 'Alpha' }] });
  const rows = service.createRecords(table.id, [{ values: { [stage]: 'a' } }, { values: { [stage]: 'b' } }, { values: {} }]).records;
  const sorted = service.createView(table.id, { name: 'By label', query: { sort: [{ fieldId: stage, direction: 'asc' }] } });
  const searched = service.createView(table.id, { name: 'Find label', query: { search: 'Alpha' } });
  const ids = () => service.queryView(table.id, sorted.id, {}).records.map(row => row.id);
  assert.deepEqual(ids(), [rows[1]!.id, rows[0]!.id, rows[2]!.id]);
  const originalIndexes = indexes();
  let changed = service.updateField(table.id, stage, { expectedVersion: 4, options: [{ id: 'a', name: "A'\0 🌱" }, { id: 'b', name: 'Zulu' }] });
  assert.deepEqual(ids(), [rows[0]!.id, rows[1]!.id, rows[2]!.id]);
  assert.equal(service.queryView(table.id, searched.id, {}).total, 0);
  assert.notDeepEqual(indexes(), originalIndexes);
  const beforeFailure = indexes();
  assert.throws(() => service.applyConversion(table.id, stage, {
    expectedVersion: changed.version, field: { name: 'Stage', type: 'number' },
  }), /could not be converted/);
  assert.deepEqual(indexes(), beforeFailure);
  assert.deepEqual(ids(), [rows[0]!.id, rows[1]!.id, rows[2]!.id]);
  changed = service.applyConversion(table.id, stage, { expectedVersion: changed.version, field: { name: 'Stage', type: 'text' } });
  assert.deepEqual(ids(), [rows[0]!.id, rows[1]!.id, rows[2]!.id]);
  assert.equal(service.getRecord(table.id, rows[0]!.id).values[stage], "A'\0 🌱");
  service.deleteField(table.id, stage, { expectedVersion: changed.version });
  assert.equal(indexes().length, 1);
  assert.equal(service.queryView(table.id, sorted.id, {}).total, 3);
});

test('version-six migration builds saved-query indexes and preserves records, views, and revisions', t => {
  const { data, store, service, table, amount, name, db, indexes } = dataset(t);
  service.createRecords(table.id, [{ values: { [name]: 'Kept', [amount]: 42 } }]);
  const view = service.createView(table.id, { name: 'Sorted', query: { sort: [{ fieldId: amount, direction: 'desc' }] } });
  const before = service.queryView(table.id, view.id, {});
  store.close();
  for (const index of indexes()) db.exec(`DROP INDEX "${index['name']}"`);
  db.exec('DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; ALTER TABLE records DROP COLUMN formula_errors_json; PRAGMA user_version = 6;');
  const reopened = new RecordService(data.open());
  assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 20);
  assert.equal(indexes().length, 1);
  assert.deepEqual(reopened.getView(table.id, view.id), view);
  assert.deepEqual(reopened.queryView(table.id, view.id, {}), before);
});

test('a corrupt saved view aborts migration without leaving indexes or advancing the database version', t => {
  const { data, store, service, table, amount, db, indexes } = dataset(t);
  service.createView(table.id, { name: 'Sorted', query: { sort: [{ fieldId: amount, direction: 'asc' }] } });
  const other = service.createTable({ name: 'Damaged metadata' });
  store.close();
  for (const index of indexes()) db.exec(`DROP INDEX "${index['name']}"`);
  db.prepare("UPDATE views SET config_json = 'invalid json' WHERE table_id = ?").run(other.id);
  db.exec('DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; ALTER TABLE records DROP COLUMN formula_errors_json; PRAGMA user_version = 6;');
  assert.throws(() => data.open(), /JSON/);
  assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 6);
  assert.equal(indexes().length, 0);
});
