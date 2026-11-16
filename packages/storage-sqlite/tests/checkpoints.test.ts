import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';

test('background checkpoint scheduling follows durable commits and excludes reads and rolled-back writes', t => {
  let connection!: DatabaseSync;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    connection = this;
    return exec.call(this, sql);
  });
  const data = fixture(t, null), store = data.open(), database = connection;
  const service = new RecordService(store), observer = data.open(), other = new RecordService(observer);
  const table = service.createTable({ name: 'Durable writes' });
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Before' } }]).records[0]!;
  assert.equal(database.prepare('PRAGMA wal_autocheckpoint').get()!['wal_autocheckpoint'], 1000);
  let calls = 0;
  store.useBackgroundCheckpoints(() => {
    calls++;
    assert.equal(other.getRecord(table.id, record.id).values[table.primaryFieldId], 'Committed');
  });
  assert.equal(database.prepare('PRAGMA synchronous').get()!['synchronous'], 2);
  assert.equal(database.prepare('PRAGMA wal_autocheckpoint').get()!['wal_autocheckpoint'], 0);
  const saved = service.updateBatch([{ id: record.id, expectedVersion: record.version, values: { [table.primaryFieldId]: 'Committed' } }], table.id);
  assert.equal(calls, 1);
  assert.deepEqual(other.getRecord(table.id, record.id), saved.records[0]);
  const history = service.recordBatches(table.id, {});
  service.queryRecords(table.id, {}); service.workspaceState({ tableId: table.id });
  assert.equal(calls, 1);
  assert.throws(() => service.updateBatch([
    { id: record.id, expectedVersion: record.version + 1, values: { [table.primaryFieldId]: 'Must roll back' } },
    { id: 'missing-record', expectedVersion: 1, values: { [table.primaryFieldId]: 'Missing' } },
  ], table.id), { code: 'RECORD_NOT_FOUND' });
  assert.equal(calls, 1);
  assert.deepEqual(service.recordBatches(table.id, {}), history);
  assert.deepEqual(other.getRecord(table.id, record.id), saved.records[0]);
});
