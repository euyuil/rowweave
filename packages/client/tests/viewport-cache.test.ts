import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { maxBatchRecords } from '../../contracts/src/index.js';
import { ApiFailure, queryForView, type TableApi } from '../src/http-client.js';
import { TableModel } from '../src/table-model.js';
import { GroupedRows } from '../src/grouped-rows.js';

const prototypeApi = (service: RecordService): TableApi => ({
  getTable: async () => service.getTable(),
  readPage: async (offset, limit, query) => service.queryRecords('prototype', { ...query, offset, limit }),
  save: async updates => service.updateBatch(updates),
});

test('fragmented grouped viewports retain saved rows beyond the page cache and overlay current undoable edits', async t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Fragmented viewport' });
  const options = Array.from({ length: 14 }, (_, index) => [
    { id: 'heavy' + index, name: 'Hidden ' + index }, { id: 'shown' + index, name: 'Visible ' + index },
  ]).flat();
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Group', type: 'singleSelect', options });
  const field = table.fields[1]!;
  service.createRecords(table.id, options.flatMap(option => Array.from({ length: option.id.startsWith('heavy') ? 100 : 1 }, (_, index) => ({
    values: { [table.primaryFieldId]: option.name + ' record ' + index, [field.id]: option.id },
  }))));
  const view = service.createView(table.id, { name: 'Fragmented', groupBy: field.id });
  const summary = service.summarizeRecords(table.id, { viewId: view.id, expectedViewVersion: view.version, groupBy: field.id, limit: 500 });
  const groups = new GroupedRows(field, summary, new Set(options.filter(option => option.id.startsWith('heavy')).map(option => JSON.stringify(option.id))));
  const model = new TableModel({ getTable: async () => service.getTable(table.id),
    readPage: async (offset, limit, query) => service.queryView(table.id, view.id, { ...query, offset, limit, expectedViewVersion: view.version }),
    save: async updates => service.updateBatch(updates, table.id) });
  t.after(() => model.dispose());
  await model.refresh(queryForView(view));
  const visible = groups.indices(0, 50);
  assert.equal(groups.rowCount, 43); assert.equal(visible.length, 14);
  await model.readViewport(visible);
  assert.equal(model.cacheStats.pages, 12); assert.equal(model.cacheStats.visibleRows, 14);
  assert.deepEqual(visible.map(index => model.getRecord(index)?.values[table.primaryFieldId]),
    Array.from({ length: 14 }, (_, index) => `Visible ${index} record 0`));
  await model.readRange(0, 100);
  assert.ok(visible.every(index => model.getRecord(index)), 'Unrelated reads must not evict visible records.');
  const first = model.getRecord(visible[0]!)!;
  model.applyEdits([{ row: visible[0]!, fieldId: table.primaryFieldId, value: 'Pinned draft 中文' }]);
  await model.readViewport(visible);
  model.undo(); assert.equal(model.getRecord(visible[0]!)!.values[table.primaryFieldId], 'Visible 0 record 0');
  model.redo(); assert.equal(model.getRecord(visible[0]!)!.values[table.primaryFieldId], 'Pinned draft 中文');
  await model.save();
  assert.equal(service.getRecord(table.id, first.id).values[table.primaryFieldId], 'Pinned draft 中文');
  assert.equal(service.getRecord(table.id, first.id).version, first.version + 1);
  assert.equal(model.cacheStats.visibleRows, 0, 'Saving invalidates the old window with the query cache.');
  await model.readViewport(visible);
  assert.equal(model.getRecord(visible[0]!)!.id, first.id);
  await model.readViewport([]); assert.equal(model.cacheStats.visibleRows, 0);
});

test('a late viewport read cannot replace a newer window even when it evicts the newer page', async t => {
  const service = new RecordService(fixture(t, { rows: 3, columns: 2 }).open()), api = prototypeApi(service);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const model = new TableModel({ ...api, readPage: async (...args) => {
    const result = await api.readPage(...args);
    if (args[0] === 1) { started(); await held; }
    return result;
  } }, 1, 1);
  t.after(() => model.dispose());
  await model.initialize();
  const previous = model.readViewport([1]); await ready;
  await model.readViewport([2]); release(); await previous;
  assert.equal(model.cacheStats.pages, 1); assert.equal(model.cacheStats.visibleRows, 1);
  assert.equal(model.getRecord(2)!.id, 'record_3');
  await model.readViewport([]);
  assert.equal(model.getRecord(2), undefined, 'The newer record was retained by its window, not the evicted page.');
});

test('query changes invalidate retained rows and interrupt an in-flight viewport', async t => {
  const service = new RecordService(fixture(t, { rows: 3, columns: 2 }).open()), api = prototypeApi(service);
  let hold = false, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const model = new TableModel({ ...api, readPage: async (...args) => {
    if (hold) {
      hold = false;
      await new Promise<void>((_resolve, reject) => {
        args[3]!.addEventListener('abort', () => reject(args[3]!.reason), { once: true }); started();
      });
    }
    return api.readPage(...args);
  } }, 1, 1);
  t.after(() => model.dispose());
  await model.initialize(); await model.readViewport([0]);
  hold = true; const previous = model.readViewport([1]); await ready;
  await model.setQuery({ search: 'absent' }); await previous;
  assert.equal(model.rowCount, 0); assert.equal(model.cacheStats.visibleRows, 0);
  assert.equal(model.getRecord(0), undefined); assert.equal(model.cacheStats.inFlight, 0);
});

test('failed and oversized windows preserve retained rows, and disposal releases them', async t => {
  const service = new RecordService(fixture(t, { rows: 3, columns: 2 }).open()), api = prototypeApi(service);
  let reads = 0, fail = false;
  const model = new TableModel({ ...api, readPage: async (...args) => {
    reads++;
    if (fail) throw new ApiFailure('UNAVAILABLE', 'Could not read the next page.', 503);
    return api.readPage(...args);
  } }, 1, 1);
  await model.initialize(); await model.readViewport([0]); const original = model.getRecord(0);
  const before = reads;
  await assert.rejects(model.readViewport(Array(maxBatchRecords + 1).fill(1)), /too large/);
  assert.equal(reads, before); assert.equal(model.cacheStats.visibleRows, 1);
  fail = true; await assert.rejects(model.readViewport([1]), { code: 'UNAVAILABLE' });
  assert.equal(model.getRecord(0), original); assert.equal(model.cacheStats.visibleRows, 1);
  model.dispose(); assert.equal(model.cacheStats.visibleRows, 0);
});
