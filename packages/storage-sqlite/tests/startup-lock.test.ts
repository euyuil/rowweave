import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';

test('workspace opening waits for a temporary lock before initializing WAL and preserves saved records', async t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  const table = service.createTable({ name: 'Retained workspace' });
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Saved 中文 🌱' } }]).records[0]!;
  store.close();
  const locker = new Worker(new URL('./sqlite-lock-worker.js', import.meta.url), { workerData: data.path });
  try {
    await once(locker, 'message');
    const exited = once(locker, 'exit');
    locker.postMessage('release shortly');
    const reopened = new RecordService(data.open());
    assert.deepEqual(reopened.getRecord(table.id, record.id), record);
    assert.equal(reopened.getTable(table.id).name, 'Retained workspace');
    await exited;
  } finally { await locker.terminate(); }
});
