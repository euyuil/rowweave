import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';

const hasCode = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

test('tables and fields retain identities through rename, reorder, primary changes and restart', t => {
  const data = fixture(t, null);
  const store = data.open();
  const service = new RecordService(store);
  assert.deepEqual(service.listTables(), []);
  const first = service.createTable({ name: '项目 🌱' });
  const second = service.createTable({ name: 'Tasks' });
  const added = service.createField(first.id, { expectedVersion: 1, name: 'Notes', type: 'text' });
  const original = added.fields[0]!;
  const notes = added.fields[1]!;
  const renamed = service.updateField(first.id, notes.id, { expectedVersion: 2, name: 'Details' });
  assert.equal(renamed.fields[1]!.id, notes.id);
  const reordered = service.updateTable(first.id, { expectedVersion: 3, name: 'Projects',
    primaryFieldId: notes.id, fieldOrder: [notes.id, original.id] });
  assert.equal(reordered.id, first.id);
  assert.equal(reordered.version, 4);
  assert.equal(reordered.primaryFieldId, notes.id);
  assert.deepEqual(reordered.fields.map(field => field.id), [notes.id, original.id]);
  assert.deepEqual(service.getTable(second.id), second);
  store.close();
  assert.deepEqual(data.open().getTable(first.id), reordered);
});

test('schema conflicts and malformed operations leave metadata and record values unchanged', t => {
  const data = fixture(t);
  const service = new RecordService(data.open());
  const peer = new RecordService(data.open());
  const table = service.getTable();
  const renamed = peer.updateTable(table.id, { expectedVersion: 1, name: 'Changed elsewhere' });
  assert.throws(() => service.createField(table.id, { expectedVersion: 1, name: 'Stale', type: 'text' }), hasCode('SCHEMA_CONFLICT'));
  for (const update of [
    { expectedVersion: 2, fieldOrder: ['field_1', 'field_1', 'field_2'] },
    { expectedVersion: 2, primaryFieldId: 'missing' },
    { expectedVersion: 2, name: '   ' },
    { expectedVersion: 0, name: 'Invalid version' },
  ]) assert.throws(() => service.updateTable(table.id, update), hasCode('INVALID_SCHEMA'));
  assert.throws(() => service.deleteField(table.id, table.primaryFieldId, { expectedVersion: 2 }), hasCode('INVALID_SCHEMA'));
  assert.deepEqual(service.getTable(), renamed);
  const before = service.readPage(0, 12);
  const result = service.deleteField(table.id, 'field_2', { expectedVersion: 2 });
  assert.equal(result.version, 3);
  for (const [index, row] of service.readPage(0, 12).records.entries()) {
    assert.equal('field_2' in row.values, false);
    assert.equal(row.values['field_1'], before.records[index]!.values['field_1']);
    assert.equal(row.version, before.records[index]!.version + 1);
  }
  assert.throws(() => service.updateBatch([{ id: 'record_1', expectedVersion: 2, values: { field_2: 'Deleted' } }]), hasCode('INVALID_BATCH'));
});

test('record operations are scoped to their table and deleting the prototype never reseeds it', t => {
  const data = fixture(t);
  const store = data.open();
  const service = new RecordService(store);
  const second = service.createTable({ name: 'Other table' });
  assert.deepEqual(service.readPage(0, 10, second.id).records, []);
  assert.throws(() => service.updateBatch([{ id: 'record_1', expectedVersion: 1,
    values: { [second.primaryFieldId]: 'Wrong table' } }], second.id), hasCode('RECORD_NOT_FOUND'));
  assert.throws(() => service.deleteTable('prototype', { expectedVersion: 99 }), hasCode('SCHEMA_CONFLICT'));
  service.deleteTable('prototype', { expectedVersion: 1 });
  assert.deepEqual(service.listTables(), [second]);
  store.close();
  const reopened = data.open();
  assert.deepEqual(reopened.listTables(), [second]);
  const check = new DatabaseSync(data.path, { readOnly: true });
  try {
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM records').get()!['total'], 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM fields').get()!['total'], 1);
    assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { check.close(); }
});

test('version-one migration preserves schema, ordering, record IDs, values and versions', t => {
  const data = fixture(t, null);
  const legacy = new DatabaseSync(data.path);
  const fields = [{ id: 'field_1', name: 'Name', type: 'text' }, { id: 'field_2', name: 'Notes', type: 'text' }];
  const values = { field_1: '保存的项目 🌱', field_2: 'line 1\nline 2' };
  legacy.exec(`CREATE TABLE table_metadata (id TEXT PRIMARY KEY, fields_json TEXT NOT NULL);
    CREATE TABLE records (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE,
      version INTEGER NOT NULL DEFAULT 1, values_json TEXT NOT NULL);
    PRAGMA user_version = 1;`);
  legacy.prepare('INSERT INTO table_metadata VALUES (?, ?)').run('prototype', JSON.stringify(fields));
  legacy.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run('record_7', 6, 4, JSON.stringify(values));
  legacy.close();
  const store = data.open();
  assert.deepEqual(store.getTable().fields, fields);
  assert.equal(store.getTable().total, 1);
  assert.deepEqual(store.readPage(0, 10).records, [{ id: 'record_7', version: 4, values }]);
  store.close();
  assert.deepEqual(data.open().readPage(0, 10).records, [{ id: 'record_7', version: 4, values }]);
});

test('failed migration rolls back the old schema and unsupported versions are not replaced', t => {
  const data = fixture(t, null);
  const legacy = new DatabaseSync(data.path);
  legacy.exec(`CREATE TABLE table_metadata (id TEXT PRIMARY KEY, fields_json TEXT NOT NULL);
    CREATE TABLE records (id TEXT PRIMARY KEY, position INTEGER, version INTEGER, values_json TEXT);
    INSERT INTO table_metadata VALUES ('prototype', 'invalid json');
    PRAGMA user_version = 1;`);
  legacy.close();
  assert.throws(() => data.open(), SyntaxError);
  const check = new DatabaseSync(data.path);
  try {
    assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 1);
    assert.equal(check.prepare("SELECT name FROM sqlite_schema WHERE name = 'records'").get()!['name'], 'records');
    assert.equal(check.prepare("SELECT name FROM sqlite_schema WHERE name = 'tables'").get(), undefined);
    check.exec('PRAGMA user_version = 99;');
  } finally { check.close(); }
  assert.throws(() => data.open(), /Unsupported database version: 99/);
});
