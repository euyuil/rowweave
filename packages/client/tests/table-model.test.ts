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
  const model = new TableModel(apiFor(t, 1_100), 100, 2);
  await model.initialize();
  const cells = Array.from({ length: 1_000 }, (_, row) =>
    Array.from({ length: 10 }, (_, col) => `粘贴 🌱 ${row}/${col}`));
  await model.paste(0, 0, cells);
  assert.equal(model.pendingCells, 10_000);
  assert.ok(model.cacheStats.rows <= 200);
  assert.equal(model.getRecord(999)?.values['field_10'], '粘贴 🌱 999/9');
  await assert.rejects(model.paste(1_099, 0, [['a'], ['b']]));
  assert.equal(model.pendingCells, 10_000);
  await model.save();
  const records = await model.readRange(995, 5);
  assert.equal(records[4]?.values['field_10'], '粘贴 🌱 999/9');
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
