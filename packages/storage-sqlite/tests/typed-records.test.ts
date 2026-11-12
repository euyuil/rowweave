import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import type { FieldCreate, Table } from '../../contracts/src/index.js';

function addField(service: RecordService, table: Table, field: Omit<FieldCreate, 'expectedVersion'>) {
  return service.createField(table.id, { ...field, expectedVersion: service.getTable(table.id).version }).fields.at(-1)!;
}

test('typed records apply defaults, normalize timestamps and preserve values across restart', t => {
  const data = fixture(t, null);
  const store = data.open();
  const service = new RecordService(store);
  const table = service.createTable({ name: 'Tasks' });
  const count = addField(service, table, { name: 'Count', type: 'number', required: true, defaultValue: 0 });
  const done = addField(service, table, { name: 'Done', type: 'checkbox', defaultValue: false });
  const day = addField(service, table, { name: 'Due date', type: 'date' });
  const time = addField(service, table, { name: 'Time', type: 'datetime' });
  const notes = addField(service, table, { name: 'Notes', type: 'multiline' });
  const status = addField(service, table, { name: 'Status', type: 'singleSelect', options: [{ name: 'Ready', color: '#2255aa' }] });
  const tags = addField(service, table, { name: 'Tags', type: 'multiSelect', options: [{ name: '中文 🌱' }, { name: 'Second' }] });
  const first = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Task A',
    [day.id]: '2024-02-29', [time.id]: '2026-11-12T12:00:00+08:00', [notes.id]: 'Line 1\nLine 2',
    [status.id]: status.options![0]!.id, [tags.id]: tags.options!.map(option => option.id) } }]).records[0]!;
  assert.equal(first.values[count.id], 0);
  assert.equal(first.values[done.id], false);
  assert.equal(first.values[time.id], '2026-11-12T04:00:00.000Z');
  assert.equal(first.version, 1);
  const second = service.createRecords(table.id, [{ values: { ...first.values, [table.primaryFieldId]: '' } }]).records[0]!;
  assert.notEqual(first.id, second.id);
  assert.equal(second.values[table.primaryFieldId], '');
  assert.deepEqual(service.getRecord(table.id, first.id), first);
  const beforeRename = service.getTable(table.id);
  service.updateField(table.id, status.id, { expectedVersion: beforeRename.version,
    options: [{ ...status.options![0], name: 'In progress' }] });
  assert.deepEqual(service.getRecord(table.id, first.id), first);
  store.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.readPage(0, 10, table.id).records, [first, second]);
  assert.equal(reopened.getTable(table.id).fields.find(field => field.id === status.id)!.options![0]!.name, 'In progress');
});

test('invalid typed batches and constraints cannot partially change records or schema', t => {
  const service = new RecordService(fixture(t, null).open());
  const table = service.createTable({ name: 'Typed' });
  const amount = addField(service, table, { name: 'Amount', type: 'number' });
  const day = addField(service, table, { name: 'Day', type: 'date' });
  const status = addField(service, table, { name: 'Status', type: 'singleSelect', options: [{ name: 'Ready' }, { name: 'Done' }] });
  const invalidValues = [
    { [amount.id]: '12' }, { [amount.id]: Infinity }, { [day.id]: '2025-02-29' },
    { [day.id]: '2026-13-01' }, { [status.id]: 'missing' }, { unknown: 'field' },
  ];
  for (const values of invalidValues) {
    assert.throws(() => service.createRecords(table.id, [{ values: { [amount.id]: 12 } }, { values }]), ServiceError);
    assert.equal(service.getTable(table.id).total, 0);
  }
  const rows = service.createRecords(table.id, [{ values: { [amount.id]: 12, [status.id]: status.options![0]!.id } }, { values: {} }]).records;
  const schema = service.getTable(table.id);
  assert.throws(() => service.updateField(table.id, amount.id, { expectedVersion: schema.version, required: true }), /Record .*value is required/);
  assert.throws(() => service.updateField(table.id, status.id, { expectedVersion: schema.version, options: [status.options![1]] }), ServiceError);
  assert.throws(() => addField(service, table, { name: 'Required later', type: 'text', required: true }), /Add this field as optional/);
  assert.throws(() => service.updateField(table.id, amount.id, { expectedVersion: schema.version, type: 'text' }), /explicit conversion/);
  assert.deepEqual(service.getTable(table.id), schema);
  assert.throws(() => service.updateBatch([
    { id: rows[0]!.id, expectedVersion: 1, values: { [amount.id]: 99 } },
    { id: rows[1]!.id, expectedVersion: 1, values: { [day.id]: 'bad date' } },
  ], table.id), ServiceError);
  assert.deepEqual(service.readPage(0, 10, table.id).records, rows);
  service.updateBatch([{ id: rows[1]!.id, expectedVersion: 1, values: { [amount.id]: 0 } }], table.id);
  const required = service.updateField(table.id, amount.id, { expectedVersion: schema.version, required: true });
  assert.throws(() => service.createRecords(table.id, [{ values: {} }]), /value is required/);
  service.updateField(table.id, amount.id, { expectedVersion: required.version, defaultValue: 3 });
  assert.equal(service.createRecords(table.id, [{ values: {} }]).records[0]!.values[amount.id], 3);
});

test('number precision can return to automatic formatting without changing stored values', t => {
  const service = new RecordService(fixture(t, null).open());
  const table = service.createTable({ name: 'Amounts' });
  const amount = addField(service, table, { name: 'Amount', type: 'number', precision: 2 });
  const row = service.createRecords(table.id, [{ values: { [amount.id]: 1.23456 } }]).records[0]!;
  const updated = service.updateField(table.id, amount.id, { expectedVersion: 2, precision: null });
  assert.equal(updated.fields.find(field => field.id === amount.id)!.precision, undefined);
  assert.deepEqual(service.getRecord(table.id, row.id), row);
});

test('record deletion is versioned, atomic and scoped without reusing record identities', t => {
  const data = fixture(t);
  const service = new RecordService(data.open());
  const before = service.readPage(0, 12).records;
  assert.throws(() => service.deleteRecords('prototype', [
    { id: 'record_1', expectedVersion: 1 }, { id: 'record_2', expectedVersion: 99 },
  ]), /changed/);
  assert.deepEqual(service.readPage(0, 12).records, before);
  assert.throws(() => service.deleteRecords('prototype', [{ id: 'record_1', expectedVersion: 1 }, { id: 'record_1', expectedVersion: 1 }]), ServiceError);
  const other = service.createTable({ name: 'Other' });
  assert.throws(() => service.deleteRecords(other.id, [{ id: 'record_1', expectedVersion: 1 }]), /does not exist/);
  assert.deepEqual(service.deleteRecords('prototype', [{ id: 'record_1', expectedVersion: 1 }, { id: 'record_12', expectedVersion: 1 }]), {
    deleted: ['record_1', 'record_12'],
  });
  const appended = service.createRecords('prototype', [{ values: { field_1: 'New row' } }]).records[0]!;
  assert.ok(!before.some(row => row.id === appended.id));
  assert.deepEqual(service.readPage(0, 12).records, [...before.slice(1, -1), appended]);
  assert.equal(service.getTable().total, 11);
});
