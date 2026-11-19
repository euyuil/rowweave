import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { fieldColumn, recordTable } from '../src/record-tables.js';
import { maxFields, type Field } from '../../contracts/src/index.js';

const hasCode = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

test('a fresh workspace starts empty unless a fixture is explicitly requested', t => {
  const data = fixture(t, null);
  const store = new SqliteRecordStore(data.path);
  try { assert.deepEqual(store.listTables(), []); }
  finally { store.close(); }
  assert.deepEqual(data.open().listTables(), []);
});

test('each table stores its own records and column changes are visible in SQLite', t => {
  const data = fixture(t, null), service = new RecordService(data.open());
  let first = service.createTable({ name: 'Invoices' });
  const second = service.createTable({ name: 'Suppliers' });
  const text = '客户\0🚀';
  const row = service.createRecords(first.id, [{ values: { [first.primaryFieldId]: text } }]).records[0]!;
  const other = service.createRecords(second.id, [{ values: { [second.primaryFieldId]: 'Other' } }]).records[0]!;
  const db = new DatabaseSync(data.path, { readOnly: true });
  try {
    const columns = () => db.prepare(`PRAGMA table_info(${recordTable(first.id)})`).all().map(column => column['name']);
    const alphabet = '0123456789bcdfghjkmnpqrstvwxz';
    for (const [id, prefix] of [[first.id, 'tbl'], [first.primaryFieldId, 'fld'], [row.id, 'rec']]) {
      assert.match(id!, new RegExp(`^${prefix}_[${alphabet}]{27}$`));
      const uuid = Array.from(id!.slice(4)).reduce((value, digit) => value * 29n + BigInt(alphabet.indexOf(digit)), 0n);
      assert.equal(uuid >> 76n & 15n, 7n);
      assert.equal(uuid >> 62n & 3n, 2n);
    }
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name GLOB 'tbl_*'").all()
      .map(item => item['name']), [first.id, second.id]);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'records'").get(), undefined);
    assert.equal(db.prepare(`SELECT id FROM ${recordTable(first.id)}`).get()!['id'], row.id);
    assert.equal(db.prepare(`SELECT id FROM ${recordTable(second.id)}`).get()!['id'], other.id);

    first = service.createField(first.id, { expectedVersion: first.version, name: 'Amount', type: 'number' });
    const amount = first.fields.at(-1)!.id;
    assert.ok(columns().includes(amount));
    assert.equal(Object.hasOwn(service.getRecord(first.id, row.id).values, amount), false);
    const saved = service.updateBatch([{ id: row.id, expectedVersion: row.version, values: { [amount]: Number.MAX_VALUE } }], first.id).records[0]!;
    const raw = db.prepare(`SELECT ${fieldColumn(amount)} AS amount, typeof(${fieldColumn(amount)}) AS type FROM ${recordTable(first.id)}`).get()!;
    assert.deepEqual({ ...raw }, { amount: Number.MAX_VALUE, type: 'real' });
    assert.deepEqual(service.getRecord(first.id, row.id), saved);
    service.createView(first.id, { name: 'Amounts', query: { sort: [{ fieldId: amount, direction: 'asc' }] } });
    first = service.deleteField(first.id, amount, { expectedVersion: first.version });
    assert.ok(!columns().includes(amount));
    const [last] = service.recordHistory(first.id, row.id, {}).changes;
    const history = service.recordChange(first.id, row.id, last!.id);
    assert.equal(history.before!.values[amount], Number.MAX_VALUE);
    assert.equal(Object.hasOwn(history.after!.values, amount), false);
    service.deleteTable(first.id, { expectedVersion: first.version });
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(first.id), undefined);
    assert.deepEqual(service.getRecord(second.id, other.id), other);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('the full field limit retains scalar types, arrays and explicit nulls in records and history', t => {
  const store = fixture(t, null).open();
  const primaryFieldId = 'field_0';
  const fields: Field[] = Array.from({ length: maxFields }, (_, index) => ({ id: `field_${index}`, name: `Field ${index}`, type: 'text' }));
  fields[3]!.type = 'checkbox';
  fields[4]!.type = 'number';
  fields[5] = { ...fields[5]!, type: 'multiSelect', options: [{ id: 'choice', name: 'Choice' }] };
  const table = store.createTable({ id: 'wide', name: 'Wide', version: 1, revision: 1, total: 0, primaryFieldId, fields });
  const values = Object.fromEntries(fields.map((field, index) => [field.id, `Value ${index}`]));
  const row = store.createRecords(table, [{ ...values, [primaryFieldId]: '\uD800', field_1: null, field_2: '', field_3: false, field_4: 1, field_5: ['choice'] }]).records[0]!;
  assert.deepEqual(store.getRecord(table.id, row.id), row);
  const change = store.recordHistory(table.id, row.id, {}).changes[0]!;
  assert.deepEqual(store.recordChange(table.id, row.id, change.id).after, row);
});

test('opening an earlier workspace rejects its format and leaves the file intact', t => {
  const data = fixture(t, null), old = new DatabaseSync(data.path);
  old.exec(`CREATE TABLE record_ids (id TEXT PRIMARY KEY, table_id TEXT);
    INSERT INTO record_ids VALUES ('original', 'example'); PRAGMA user_version = 39`);
  old.close();
  const before = readFileSync(data.path);
  assert.throws(() => data.open(), /Unsupported database version: 39.*Create a new RowWeave workspace/);
  assert.deepEqual(readFileSync(data.path), before);
});

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
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM record_ids').get()!['total'], 0);
    assert.equal(check.prepare('SELECT COUNT(*) AS total FROM fields').get()!['total'], 1);
    assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { check.close(); }
});
