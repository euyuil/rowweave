import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';

test('conversion preview reports failures without writes and failed apply rolls back every record', t => {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  const table = service.createTable({ name: 'Amounts' });
  const id = table.primaryFieldId;
  const rows = service.createRecords(table.id, [
    { values: { [id]: '12.5' } }, { values: { [id]: 'invalid' } }, { values: { [id]: '' } }, { values: { [id]: null } },
  ]).records;
  const input = { expectedVersion: 1, field: { name: 'Amount', type: 'number', precision: 2 } };
  const preview = service.previewConversion(table.id, id, input);
  assert.equal(preview.total, 4);
  assert.equal(preview.changed, 2);
  assert.equal(preview.invalid, 1);
  assert.equal(preview.issues[0]!.recordId, rows[1]!.id);
  assert.deepEqual(preview.samples.map(sample => [sample.before, sample.after]), [['12.5', 12.5], ['', null]]);
  assert.deepEqual(service.readPage(0, 10, table.id).records, rows);
  assert.throws(() => service.applyConversion(table.id, id, input), /could not be converted/);
  assert.deepEqual(service.readPage(0, 10, table.id).records, rows);
  assert.equal(service.getTable(table.id).version, 1);
  service.updateBatch([{ id: rows[1]!.id, expectedVersion: 1, values: { [id]: '25' } }], table.id);
  const converted = service.applyConversion(table.id, id, input);
  assert.equal(converted.version, 2);
  assert.equal(converted.fields[0]!.id, id);
  assert.equal(converted.fields[0]!.type, 'number');
  const result = service.readPage(0, 10, table.id).records;
  assert.deepEqual(result.map(row => row.values[id]), [12.5, 25, null, null]);
  assert.deepEqual(result.map(row => row.version), [2, 3, 2, 1]);
  assert.deepEqual(new RecordService(data.open()).readPage(0, 10, table.id).records, result);
  assert.throws(() => service.applyConversion(table.id, id, input), /schema changed/);
});

test('conversion apply rechecks records changed since preview and bounds preview examples', t => {
  const service = new RecordService(fixture(t, null).open());
  const table = service.createTable({ name: 'Import' });
  const id = table.primaryFieldId;
  const rows = service.createRecords(table.id, Array.from({ length: 50 }, (_, index) => ({ values: { [id]: String(index) } }))).records;
  const input = { expectedVersion: 1, field: { name: 'Number', type: 'number' } };
  const preview = service.previewConversion(table.id, id, input);
  assert.equal(preview.invalid, 0);
  assert.equal(preview.changed, 50);
  assert.equal(preview.samples.length, 10);
  service.updateBatch(rows.slice(25).map(row => ({ id: row.id, expectedVersion: 1, values: { [id]: 'Cannot convert' } })), table.id);
  const current = service.readPage(0, 100, table.id).records;
  const changed = service.previewConversion(table.id, id, input);
  assert.equal(changed.invalid, 25);
  assert.equal(changed.issues.length, 20);
  assert.throws(() => service.applyConversion(table.id, id, input), /25 records/);
  assert.deepEqual(service.readPage(0, 100, table.id).records, current);
});

test('select conversions preserve labels and reject collapsing multiple selected options', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Status' });
  table = service.createField(table.id, { expectedVersion: 1, name: 'Status', type: 'multiSelect',
    options: [{ id: 'ready', name: 'Ready' }, { id: 'done', name: 'Done' }] });
  const field = table.fields[1]!;
  const rows = service.createRecords(table.id, [{ values: { [field.id]: ['ready', 'done'] } }]).records;
  const single = { expectedVersion: 2, field: { name: 'Status', type: 'singleSelect', options: field.options } };
  assert.equal(service.previewConversion(table.id, field.id, single).invalid, 1);
  assert.throws(() => service.applyConversion(table.id, field.id, single), /Multiple selected options/);
  service.applyConversion(table.id, field.id, { expectedVersion: 2, field: { name: 'Labels', type: 'text' } });
  assert.equal(service.getRecord(table.id, rows[0]!.id).values[field.id], '["Ready","Done"]');
  service.applyConversion(table.id, field.id, { expectedVersion: 3, field: { name: 'Status', type: 'multiSelect', options: field.options } });
  assert.deepEqual(service.getRecord(table.id, rows[0]!.id).values[field.id], ['ready', 'done']);
  const current = service.getRecord(table.id, rows[0]!.id);
  service.updateBatch([{ id: current.id, expectedVersion: current.version, values: { [field.id]: ['ready'] } }], table.id);
  service.applyConversion(table.id, field.id, { expectedVersion: 4,
    field: { name: 'Status', type: 'singleSelect', options: [{ id: 'ready', name: 'Renamed' }] } });
  assert.equal(service.getRecord(table.id, current.id).values[field.id], 'ready');
  service.applyConversion(table.id, field.id, { expectedVersion: 5,
    field: { name: 'Status', type: 'multiSelect', options: [{ id: 'ready', name: 'Renamed again' }] } });
  assert.deepEqual(service.getRecord(table.id, current.id).values[field.id], ['ready']);
});
