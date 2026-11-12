import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import type { FieldCreate, FieldFilter, FilterGroup, RecordQuery } from '../../contracts/src/index.js';

function dataset(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  let table = service.createTable({ name: 'Query data' });
  const add = (input: Omit<FieldCreate, 'expectedVersion'>) => {
    table = service.createField(table.id, { ...input, expectedVersion: table.version });
    return table.fields.at(-1)!.id;
  };
  const name = table.primaryFieldId;
  const amount = add({ name: 'Amount', type: 'number' });
  const done = add({ name: 'Done', type: 'checkbox' });
  const stage = add({ name: 'Stage', type: 'singleSelect', options: [{ id: 'a', name: 'Zebra' }, { id: 'z', name: 'Alpha' }] });
  const tags = add({ name: 'Tags', type: 'multiSelect', options: [{ id: 'red', name: 'Red' }, { id: 'blue', name: '蓝色 🌱' }] });
  const rows = service.createRecords(table.id, [
    { values: { [name]: 'Alpha', [amount]: 10, [done]: true, [stage]: 'a', [tags]: ['red'] } },
    { values: { [name]: 'Bravo', [amount]: 2, [done]: false, [stage]: 'z', [tags]: [] } },
    { values: { [name]: '中文 🌱', [amount]: 10, [done]: false, [stage]: 'z', [tags]: ['red', 'blue'] } },
    { values: { [name]: "' OR 1=1 -- 100%", [amount]: null } },
  ]).records;
  const query = (query: RecordQuery) => service.queryRecords(table.id, query);
  return { data, service, table, rows, query, name, amount, done, stage, tags };
}

test('queries combine typed filters, stable numeric/label sorting, projection and exact counts', t => {
  const { query, rows, name, amount, stage, tags } = dataset(t);
  const filter: FilterGroup = { conjunction: 'and', conditions: [
    { fieldId: amount, operator: 'gte', value: 10 },
    { conjunction: 'or', conditions: [
      { fieldId: name, operator: 'contains', value: 'alpha' }, { fieldId: tags, operator: 'hasAny', value: ['blue'] },
    ] },
  ] };
  const result = query({ filter, sort: [{ fieldId: amount, direction: 'desc' }, { fieldId: name, direction: 'asc' }], fields: [name, amount], limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.records[0]!.id, rows[0]!.id);
  assert.deepEqual(Object.keys(result.records[0]!.values), [name, amount]);
  const next = query({ filter, offset: 1, limit: 1, expectedRevision: result.revision });
  assert.equal(next.records[0]!.id, rows[2]!.id);
  assert.deepEqual(query({ sort: [{ fieldId: amount, direction: 'asc' }] }).records.map(row => row.id), [rows[1]!.id, rows[0]!.id, rows[2]!.id, rows[3]!.id]);
  assert.deepEqual(query({ sort: [{ fieldId: stage, direction: 'asc' }] }).records.map(row => row.id), [rows[1]!.id, rows[2]!.id, rows[0]!.id, rows[3]!.id]);
  assert.deepEqual(query({ fields: [] }).records[0]!.values, {});
  assert.equal(query({ offset: 100 }).total, 4);
  assert.deepEqual(query({ offset: 100 }).records, []);
});

test('search and filter values remain literal and include Unicode and select labels', t => {
  const { query, rows, name, amount, done, stage, tags } = dataset(t);
  const matching = (condition: FieldFilter) => query({ filter: { conjunction: 'and', conditions: [condition] } }).records.map(row => row.id);
  assert.deepEqual(query({ search: '蓝色 🌱' }).records.map(row => row.id), [rows[2]!.id]);
  assert.deepEqual(query({ search: 'zebra' }).records.map(row => row.id), [rows[0]!.id]);
  assert.deepEqual(query({ search: "' OR 1=1 --" }).records.map(row => row.id), [rows[3]!.id]);
  assert.deepEqual(matching({ fieldId: name, operator: 'contains', value: '%' }), [rows[3]!.id]);
  assert.deepEqual(matching({ fieldId: done, operator: 'eq', value: false }), [rows[1]!.id, rows[2]!.id]);
  assert.deepEqual(matching({ fieldId: done, operator: 'isEmpty' }), [rows[3]!.id]);
  assert.deepEqual(matching({ fieldId: amount, operator: 'eq', value: null }), [rows[3]!.id]);
  assert.deepEqual(matching({ fieldId: amount, operator: 'neq', value: 10 }), [rows[1]!.id, rows[3]!.id]);
  assert.deepEqual(matching({ fieldId: tags, operator: 'isEmpty' }), [rows[1]!.id, rows[3]!.id]);
  assert.deepEqual(matching({ fieldId: tags, operator: 'isNotEmpty' }), [rows[0]!.id, rows[2]!.id]);
  assert.deepEqual(matching({ fieldId: tags, operator: 'hasAny', value: [] }), []);
  assert.deepEqual(matching({ fieldId: stage, operator: 'eq', value: 'z' }), [rows[1]!.id, rows[2]!.id]);
});

test('query revisions reject mixing pages after writes or schema changes and survive restart', t => {
  const { data, service, query, table, rows, amount } = dataset(t);
  const first = query({ limit: 2 });
  const second = query({ offset: 2, limit: 2, expectedRevision: first.revision });
  assert.equal(new Set([...first.records, ...second.records].map(row => row.id)).size, 4);
  const peer = new RecordService(data.open());
  peer.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [amount]: 5 } }], table.id);
  assert.throws(() => query({ offset: 2, expectedRevision: first.revision }), (error: unknown) => error instanceof ServiceError && error.code === 'DATA_CHANGED');
  const refreshed = query({});
  assert.equal(refreshed.revision, first.revision + 1);
  const beforeFailure = service.getTable(table.id).revision;
  assert.throws(() => peer.deleteRecords(table.id, [{ id: rows[1]!.id, expectedVersion: 1 }, { id: rows[2]!.id, expectedVersion: 99 }]), ServiceError);
  assert.equal(query({}).revision, beforeFailure);
  peer.updateTable(table.id, { expectedVersion: table.version, name: 'Renamed' });
  assert.throws(() => query({ expectedRevision: refreshed.revision }), /changed between pages/);
  assert.deepEqual(new RecordService(data.open()).queryRecords(table.id, {}), query({}));
});

test('malformed queries fail before SQL execution without changing the table', t => {
  const { service, table, amount, name } = dataset(t);
  let deep: FilterGroup = { conjunction: 'and', conditions: [] };
  for (let depth = 0; depth < 6; depth++) deep = { conjunction: 'and', conditions: [deep] };
  const invalid = [
    null, [], { limit: 501 }, { offset: -1 }, { fields: [name, name] }, { fields: ['unknown'] },
    { sort: [{ fieldId: name, direction: 'SQL' }] }, { sort: [{ fieldId: "' OR 1=1 --", direction: 'asc' }] },
    { filter: { conjunction: 'and', conditions: [{ fieldId: amount, operator: 'eq', value: '10' }] } },
    { filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'gt', value: 'A' }] } },
    { filter: { conjunction: 'and', conditions: [{ fieldId: amount, operator: 'contains', value: '1' }] } },
    { filter: deep }, { filter: { conjunction: 'and', conditions: Array.from({ length: 101 }, () => ({ fieldId: name, operator: 'isEmpty' })) } },
  ];
  const before = service.queryRecords(table.id, {});
  for (const input of invalid) assert.throws(() => service.queryRecords(table.id, input), ServiceError);
  assert.deepEqual(service.queryRecords(table.id, {}), before);
});

test('wide select schemas remain searchable without exhausting SQL bind parameters', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Wide selects' });
  const options = Array.from({ length: 200 }, (_, index) => ({ id: `option_${index}`, name: `Choice ${index}` }));
  for (let index = 0; index < 90; index++) {
    table = service.createField(table.id, { expectedVersion: table.version, name: `Select ${index}`, type: 'singleSelect', options });
  }
  const field = table.fields.at(-1)!;
  const row = service.createRecords(table.id, [{ values: { [field.id]: 'option_199' } }]).records[0]!;
  assert.deepEqual(service.queryRecords(table.id, { search: 'Choice 199' }).records.map(record => record.id), [row.id]);
});

test('version-two databases gain query revisions without losing existing values', t => {
  const data = fixture(t, null);
  const db = new DatabaseSync(data.path);
  db.exec(`CREATE TABLE tables (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, primary_field_id TEXT NOT NULL);
    CREATE TABLE fields (id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE, position INTEGER NOT NULL, definition_json TEXT NOT NULL);
    CREATE TABLE records (id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE, position INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, values_json TEXT NOT NULL, UNIQUE(table_id, position));
    INSERT INTO tables VALUES ('table', 'Existing', 7, 'name'); PRAGMA user_version = 2;`);
  db.prepare('INSERT INTO fields VALUES (?, ?, ?, ?)').run('name', 'table', 0, JSON.stringify({ id: 'name', name: 'Name', type: 'text' }));
  db.prepare('INSERT INTO records VALUES (?, ?, ?, ?, ?)').run('record', 'table', 0, 3, JSON.stringify({ name: 'Saved data' }));
  db.close();
  const service = new RecordService(data.open());
  const page = service.queryRecords('table', {});
  assert.equal(page.revision, 1);
  assert.equal(page.schemaVersion, 7);
  assert.deepEqual(page.records, [{ id: 'record', version: 3, values: { name: 'Saved data' } }]);
});
