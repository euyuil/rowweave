import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createHttpClient, ApiFailure, type TableApi } from '../src/http-client.js';
import { TableModel } from '../src/table-model.js';

function apiFor(t: Parameters<typeof fixture>[0], rows = 30): TableApi {
  const service = new RecordService(fixture(t, { rows, columns: 20 }).open());
  return {
    getTable: async () => service.getTable(),
    readPage: async (offset, limit, query) => service.queryRecords('prototype', { ...query, offset, limit }),
    save: async updates => service.updateBatch(updates),
  };
}

test('page requests are deduplicated and the cache stays bounded without dropping edits', async t => {
  const api = apiFor(t);
  let reads = 0;
  const model = new TableModel({
    ...api, readPage: async (offset, limit, query) => { reads++; return api.readPage(offset, limit, query); },
  }, 5, 2);
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: 'field_1', value: 'Unsaved' }]);
  await Promise.all([model.readRange(5, 5), model.readRange(5, 5)]);
  assert.equal(reads, 2);
  await model.readRange(10, 15);
  assert.equal(model.cacheStats.pages, 2);
  assert.equal(model.cacheStats.rows, 10);
  assert.equal(model.getRecord(0)?.values['field_1'], 'Unsaved');
  assert.equal(model.pendingCells, 1);
  await model.save();
  assert.equal((await model.readRange(0, 1))[0]?.values['field_1'], 'Unsaved');
  assert.equal(model.pendingCells, 0);
});

test('failed and conflicting saves preserve drafts until an explicit discard', async t => {
  const api = apiFor(t);
  let rejectSave = true;
  const model = new TableModel({ ...api, save: async updates => {
    if (rejectSave) throw new ApiFailure('VERSION_CONFLICT', 'Changed elsewhere.', 409);
    return api.save(updates);
  } });
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: 'field_1', value: 'Draft' }]);
  await assert.rejects(model.save(), ApiFailure);
  assert.equal(model.pendingCells, 1);
  assert.equal(model.saving, false);
  assert.equal(model.conflicted, true);
  assert.equal(model.getRecord(0)?.values['field_1'], 'Draft');
  rejectSave = false;
  await model.save();
  assert.equal(model.getRecord(0)?.version, 2);
  model.applyEdits([{ row: 0, fieldId: 'field_1', value: 'Discard this' }]);
  await model.discardAndReload();
  assert.equal(model.getRecord(0)?.values['field_1'], 'Draft');
  assert.equal(model.error, undefined);
});

test('paste stages a whole 1000 by 10 rectangle even when larger than the cache', async t => {
  const api = apiFor(t, 1_100);
  const reads: number[] = [];
  const model = new TableModel({ ...api, readPage: (...args) => { reads.push(args[1]); return api.readPage(...args); } }, 100, 2);
  await model.initialize();
  const cells = Array.from({ length: 1_000 }, (_, row) =>
    Array.from({ length: 10 }, (_, col) => `粘贴 🌱 ${row}/${col}`));
  await model.paste(0, 0, cells);
  assert.equal(model.pendingCells, 10_000);
  assert.ok(reads.length <= 3, 'Large paste should not repeat metadata/count work for every display page.');
  assert.ok(reads.every(limit => limit <= 500));
  assert.ok(model.cacheStats.rows <= 200);
  assert.equal(model.getRecord(999)?.values['field_10'], '粘贴 🌱 999/9');
  await assert.rejects(model.paste(1_099, 0, [['a'], ['b']]));
  assert.equal(model.pendingCells, 10_000);
  await model.save();
  const records = await model.readRange(995, 5);
  assert.equal(records[4]?.values['field_10'], '粘贴 🌱 999/9');
});

test('a revision change during a large paste preserves existing drafts without partially staging rows', async t => {
  const service = new RecordService(fixture(t, { rows: 700, columns: 20 }).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createHttpClient({ url: server.url, token });
  const model = new TableModel({ ...api, readPage: async (offset, limit, query, signal) => {
    if (offset === 500) await api.save([{ id: 'record_700', expectedVersion: 1, values: { field_1: 'Changed elsewhere' } }]);
    return api.readPage(offset, limit, query, signal);
  } });
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: 'field_2', value: 'Keep this draft' }]);
  await assert.rejects(model.paste(0, 0, Array.from({ length: 600 }, () => ['New value'])),
    (error: unknown) => error instanceof ApiFailure && error.code === 'DATA_CHANGED');
  assert.equal(model.pendingCells, 1);
  assert.equal(model.getRecord(0)!.values['field_2'], 'Keep this draft');
  assert.equal(model.stale, true);
  assert.equal(model.cacheStats.inFlight, 0);
  assert.notEqual(service.readPage(0, 1).records[0]!.values['field_1'], 'New value');
});

test('switching queries aborts a batch read and a late response cannot stage into the new order', async t => {
  const api = apiFor(t, 700);
  let release: (() => void) | undefined;
  let batchSignal: AbortSignal | undefined;
  const model = new TableModel({ ...api, readPage: async (offset, limit, query, signal) => {
    const snapshot = await api.readPage(offset, limit, query, signal);
    if (limit > 100) {
      batchSignal = signal;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return snapshot;
  } });
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: 'field_2', value: 'Keep this draft' }]);
  const pasting = model.paste(0, 0, Array.from({ length: 600 }, () => ['New value']));
  const rejected = assert.rejects(pasting, /query changed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(release);
  await model.setQuery({ sort: [{ fieldId: 'field_1', direction: 'desc' }] });
  assert.equal(batchSignal!.aborted, true);
  release();
  await rejected;
  assert.equal(model.pendingCells, 1);
  assert.equal(model.pendingRecords[0]!.values['field_2'], 'Keep this draft');
  assert.equal(model.cacheStats.inFlight, 0);
  assert.notEqual(model.getRecord(0)!.id, 'record_1');
});

test('clear loads the entire selection, supports one-step undo, and bounds work before reading', async t => {
  const api = apiFor(t, 1_100);
  let reads = 0;
  const model = new TableModel({ ...api, readPage: async (...args) => { reads++; return api.readPage(...args); } }, 100, 2);
  await model.initialize();
  const rows = Array.from({ length: 1_000 }, (_, index) => index);
  const fields = model.fields.slice(0, 10).map(field => field.id);
  await model.clearCells(rows, fields);
  assert.equal(model.pendingCells, 10_000);
  assert.ok(model.cacheStats.rows <= 200);
  assert.equal(model.getRecord(999)!.values['field_10'], '');
  model.undo();
  assert.equal(model.pendingCells, 0);
  model.redo();
  assert.equal(model.pendingCells, 10_000);
  const previousReads = reads;
  await assert.rejects(model.clearCells(Array.from({ length: 2_001 }, (_, i) => i), fields), /2,000 rows/);
  await assert.rejects(model.clearCells(rows, [...fields, ...fields, ...fields]), /20,000 cells/);
  assert.equal(reads, previousReads);
  assert.equal(model.pendingCells, 10_000);
  await model.save();
  assert.equal((await model.readRange(999, 1))[0]!.values['field_10'], '');
  assert.notEqual((await model.readRange(1_000, 1))[0]!.values['field_10'], '');
});

test('a late page response cannot overwrite the result of a successful save', async t => {
  const api = apiFor(t);
  let release: (() => void) | undefined;
  let pause = false;
  const model = new TableModel({
    ...api, readPage: async (offset, limit, query) => {
      const snapshot = await api.readPage(offset, limit, query);
      if (pause && offset === 0) {
        pause = false;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return snapshot;
    },
  }, 5, 1);
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: 'field_1', value: 'Newest value' }]);
  await model.readRange(5, 5);
  pause = true;
  const reading = model.readRange(0, 5);
  await new Promise(resolve => setImmediate(resolve));
  await model.save();
  assert.ok(release);
  release();
  await reading;
  assert.equal(model.getRecord(0)?.values['field_1'], 'Newest value');
  assert.equal(model.getRecord(0)?.version, 2);
});

test('the client completes a real HTTP read-edit-save-reload cycle', async t => {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service: new RecordService(fixture(t).open()), token });
  t.after(() => server.close());
  const model = new TableModel(createHttpClient({ url: server.url, token }));
  await model.initialize();
  model.applyEdits([{ row: 1, fieldId: 'field_2', value: 'Round trip' }]);
  await model.save();
  await model.discardAndReload();
  assert.equal(model.getRecord(1)?.values['field_2'], 'Round trip');
  assert.equal(model.getRecord(1)?.version, 2);
});
