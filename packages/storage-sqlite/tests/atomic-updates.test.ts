import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import type { RecordUpdate } from '../../contracts/src/index.js';

test('a conflict on the last record rolls back every earlier write', t => {
  const data = fixture(t);
  const store = data.open();
  const peer = new RecordService(data.open());
  const service = new RecordService(store);
  const before = store.readPage(0, 2).records;
  peer.updateBatch([{ id: 'record_2', expectedVersion: 1, values: { field_1: 'Peer change' } }]);
  assert.throws(() => service.updateBatch([
    { id: 'record_1', expectedVersion: 1, values: { field_1: 'Must roll back' } },
    { id: 'record_2', expectedVersion: 1, values: { field_1: 'Stale edit' } },
  ]), (error: unknown) => error instanceof ServiceError && error.code === 'VERSION_CONFLICT');
  assert.deepEqual(store.readPage(0, 1).records[0], before[0]);
  assert.equal(store.readPage(1, 1).records[0]?.values['field_1'], 'Peer change');
});

test('unknown records and invalid fields never partially mutate a batch', t => {
  const store = fixture(t).open();
  const service = new RecordService(store);
  const before = store.readPage(0, 2);
  const valid = { id: 'record_1', expectedVersion: 1, values: { field_1: 'Pending' } };
  for (const invalid of [
    { id: 'missing', expectedVersion: 1, values: { field_1: 'Unknown record' } },
    { id: 'record_2', expectedVersion: 1, values: { unknown: 'Unknown field' } },
    { id: 'record_2', expectedVersion: 1, values: { field_1: 42 } },
    { id: 'record_2', expectedVersion: 1, values: { field_1: 'x'.repeat(10_001) } },
    { id: 'record_2', expectedVersion: 0, values: { field_1: 'Invalid version' } },
    valid,
  ]) {
    assert.throws(() => service.updateBatch([valid, invalid]), ServiceError);
    assert.deepEqual(store.readPage(0, 2), before);
  }
});

test('a 1000 by 10 batch persists Unicode, empty strings and nulls after restart', t => {
  const data = fixture(t, { rows: 1_200, columns: 20 });
  const store = data.open();
  const service = new RecordService(store);
  const updates: RecordUpdate[] = Array.from({ length: 1_000 }, (_, row) => ({
    id: `record_${row + 1}`, expectedVersion: 1,
    values: Object.fromEntries(Array.from({ length: 10 }, (_, col) => [
      `field_${col + 1}`, col === 0 ? null : col === 1 ? '' : `批量 🌱 ${row} / ${col}`,
    ])),
  }));
  const result = service.updateBatch(updates);
  assert.equal(result.records.length, 1_000);
  assert.equal(result.records[999]?.version, 2);
  store.close();
  const reopened = data.open();
  assert.deepEqual(reopened.readPage(500, 500).records, result.records.slice(500));
  assert.equal(reopened.readPage(1_000, 1).records[0]?.version, 1);
});
