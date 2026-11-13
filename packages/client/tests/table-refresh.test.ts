import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { ApiFailure, queryForView, type TableApi } from '../src/http-client.js';
import { TableModel } from '../src/table-model.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const service = new RecordService(fixture(t, { rows: 30, columns: 3 }).open());
  const api: TableApi = {
    getTable: async () => service.getTable(),
    readPage: async (offset, limit, query) => service.queryRecords('prototype', { ...query, offset, limit }),
    save: async updates => service.updateBatch(updates),
  };
  return { service, api };
}

test('a prepared refresh keeps the current rows visible until one atomic commit', async t => {
  const { service, api } = setup(t), model = new TableModel(api, 5, 2);
  await model.initialize();
  const before = model.getRecord(0)!, revision = model.getSnapshot(), generation = model.queryVersion;
  service.updateBatch([{ id: before.id, expectedVersion: before.version, values: { field_1: 'Changed elsewhere' } }]);
  const snapshot = await model.prepareRefresh({}, { start: 20, count: 10 });
  assert.deepEqual(model.getRecord(0), before);
  assert.equal(model.getSnapshot(), revision); assert.equal(model.queryVersion, generation);
  assert.equal(snapshot.pages.size, 2);
  let notifications = 0;
  model.subscribe(() => notifications++);
  assert.equal(model.commitRefresh(snapshot), true);
  assert.equal(notifications, 1);
  assert.equal(model.cacheStats.pages, 2); assert.equal(model.cacheStats.rows, 10);
  assert.equal(model.getRecord(20)!.id, 'record_21');
  assert.equal((await model.readRange(0, 1))[0]!.values['field_1'], 'Changed elsewhere');
  assert.equal(model.commitRefresh(snapshot), false, 'A committed candidate cannot be applied twice.');
});

test('editing while a refresh response is pending preserves the draft and its undo history', async t => {
  const { service, api } = setup(t);
  let held = false, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const model = new TableModel({ ...api, readPage: async (...args) => {
    const page = await api.readPage(...args);
    if (held) { started(); await gate; }
    return page;
  } });
  await model.initialize();
  const before = model.getRecord(0)!;
  service.updateBatch([{ id: before.id, expectedVersion: before.version, values: { field_1: 'Remote' } }]);
  held = true;
  const pending = model.prepareRefresh({}); await ready;
  model.applyEdits([{ row: 0, fieldId: 'field_1', value: 'Local 中文' }]);
  release(); const snapshot = await pending;
  assert.equal(model.commitRefresh(snapshot), false);
  assert.equal(model.getRecord(0)!.values['field_1'], 'Local 中文');
  assert.equal(model.getRecord(0)!.version, before.version);
  assert.equal(model.pendingCells, 1); assert.equal(model.canUndo, true);
  model.undo();
  assert.equal(model.pendingCells, 0); assert.equal(model.canRedo, true);
  assert.equal(model.commitRefresh(await model.prepareRefresh({})), false, 'Automatic refresh must retain local redo intent.');
  model.redo(); assert.equal(model.getRecord(0)!.values['field_1'], 'Local 中文');
});

test('query changes, disposal and explicit cancellation invalidate prepared refreshes', async t => {
  const { api } = setup(t), model = new TableModel(api);
  await model.initialize();
  const old = await model.prepareRefresh({});
  await model.setQuery({ search: 'absent' });
  assert.equal(model.commitRefresh(old), false); assert.equal(model.rowCount, 0);
  const controller = new AbortController();
  const cancelled = await model.prepareRefresh({}, { signal: controller.signal });
  controller.abort();
  assert.equal(model.commitRefresh(cancelled), false); assert.equal(model.rowCount, 0);
  const closed = await model.prepareRefresh({});
  model.dispose();
  assert.equal(model.commitRefresh(closed), false);
  await assert.rejects(model.prepareRefresh({}), /closed/);
});

test('a conflicting or failed candidate leaves the displayed schema, pages and error state intact', async t => {
  const { api } = setup(t);
  let failure = false;
  const model = new TableModel({ ...api, readPage: async (...args) => {
    if (failure) throw new ApiFailure('DATA_CHANGED', 'Changed during refresh.', 409);
    return api.readPage(...args);
  } });
  await model.initialize();
  const table = model.table, row = model.getRecord(0), revision = model.getSnapshot();
  failure = true;
  await assert.rejects(model.prepareRefresh({}), { code: 'DATA_CHANGED' });
  assert.equal(model.table, table); assert.equal(model.getRecord(0), row);
  assert.equal(model.getSnapshot(), revision); assert.equal(model.error, undefined);
  assert.equal(model.cacheStats.inFlight, 0);
});

test('refresh reads follow page limits and clamp the visible window after rows disappear', async t => {
  const { service, api } = setup(t), reads: number[] = [];
  const model = new TableModel({ ...api, readPage: async (...args) => { reads.push(args[0]); return api.readPage(...args); } }, 5, 1);
  await model.initialize(); reads.length = 0;
  const snapshot = await model.prepareRefresh({}, { start: 27, count: 50 });
  assert.deepEqual(reads, [0, 25]); assert.equal(snapshot.pages.size, 1);
  assert.equal(model.commitRefresh(snapshot), true); assert.equal(model.getRecord(29)!.id, 'record_30');
  service.deleteRecords('prototype', service.queryRecords('prototype', {}).records.map(row => ({ id: row.id, expectedVersion: row.version })));
  reads.length = 0;
  assert.equal(model.commitRefresh(await model.prepareRefresh({}, { start: 27, count: 50 })), true);
  assert.equal(model.rowCount, 0); assert.deepEqual(reads, [0]); assert.equal(model.cacheStats.rows, 0);
});

test('resetting the query aborts a pending refresh read', async t => {
  const { api } = setup(t);
  let hold = false, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const model = new TableModel({ ...api, getTable: async signal => {
    if (hold) await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); started();
    });
    return api.getTable(signal);
  } });
  await model.initialize(); hold = true;
  const rejected = assert.rejects(model.prepareRefresh({}), { name: 'AbortError' });
  await ready; await model.setQuery({ search: 'absent' }); await rejected;
  assert.equal(model.rowCount, 0); assert.equal(model.cacheStats.inFlight, 0);
});

test('relative-date refresh applies a new date context without a data write and guards continuation pages', async t => {
  let now = new Date('2024-02-29T12:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Clock boundary' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  const due = table.fields[1]!.id;
  const rows = service.createRecords(table.id, ['2024-02-29', '2024-02-29', '2024-03-01', '2024-03-01'].map(value => ({ values: { [due]: value } }))).records;
  const view = service.createView(table.id, { name: 'Today', query: { filter: { conjunction: 'and', conditions: [
    { fieldId: due, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } },
  ] } } });
  const api: TableApi = {
    getTable: async () => service.getTable(table.id),
    readPage: async (offset, limit, query) => service.queryView(table.id, view.id, { ...query, offset, limit, expectedViewVersion: view.version }),
    save: async updates => service.updateBatch(updates, table.id),
  };
  const model = new TableModel(api, 1, 2), query = queryForView(view);
  await model.refresh(query);
  const revision = model.dataRevision, context = model.dateContext;
  assert.equal(model.getRecord(0)!.id, rows[0]!.id);
  now = new Date('2024-03-01T00:00:00Z');
  const snapshot = await model.prepareRefresh(query, { start: 1, count: 1 });
  assert.equal(snapshot.first.revision, revision); assert.notEqual(snapshot.first.dateContext, context);
  assert.equal(model.getRecord(0)!.id, rows[0]!.id);
  assert.equal(model.commitRefresh(snapshot), true);
  assert.equal(model.getRecord(0)!.id, rows[2]!.id); assert.equal(model.getRecord(1)!.id, rows[3]!.id);
  assert.equal(model.dateContext, snapshot.first.dateContext);
});
