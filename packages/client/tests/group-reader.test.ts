import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { GroupReader } from '../src/group-reader.js';
import { TableModel } from '../src/table-model.js';
import type { GroupCollapse, GroupQuery, GroupLayout } from '../../contracts/src/index.js';

function setup(t: Parameters<typeof fixture>[0], count = 1407, collapse: GroupCollapse = { defaultCollapsed: false, exceptions: [] }) {
  const service = new RecordService(fixture(t, null).open());
  const table = service.createTable({ name: 'Group windows' }), name = table.primaryFieldId;
  const key = (index: number) => 'Group ' + String(index).padStart(4, '0');
  const records = service.createRecords(table.id, Array.from({ length: count }, (_, index) => ({
    values: { [name]: key(count - index - 1) },
  }))).records;
  const view = service.createView(table.id, { name: 'By name', groupBy: name });
  const first = service.queryView(table.id, view.id, {});
  const calls: GroupQuery[] = [];
  const api = { queryGroups: async (_id: string, input: GroupQuery, signal?: AbortSignal) => {
    signal?.throwIfAborted(); calls.push(input); return service.queryGroups(table.id, input);
  } };
  const context = { table, view, revision: first.revision, search: '', collapse };
  const reader = new GroupReader(api, context); t.after(() => reader.dispose());
  return { service, table, name, key, records, view, first, calls, api, context, reader };
}

test('group windows map deep rows with a bounded cache and keep held viewport snapshots usable', async t => {
  const { reader, calls } = setup(t), signal = new AbortController().signal;
  const first = await reader.readWindow(0, 30, signal);
  assert.equal(first.rowCount, 2815); assert.equal(first.expandedCount, 1407);
  assert.deepEqual(first.at(1), { kind: 'record', index: 0 });
  assert.equal(first.count(0, 30), 15);
  assert.equal(first.at(2300), undefined); assert.equal(first.count(2300, 3), undefined);
  assert.equal(first.before(first.rowCount), 1407);
  assert.equal(await reader.readWindow(3, 10, signal), first);
  assert.equal(calls.length, 1);
  for (let offset = 200; offset < 2800; offset += 200) {
    const rows = await reader.readWindow(offset, 30, signal);
    assert.equal(rows.at(offset)?.kind, 'group');
    assert.deepEqual(rows.at(offset + 1), { kind: 'record', index: offset / 2 });
    assert.equal(rows.position(offset / 2), offset + 1);
    assert.deepEqual(rows.indices(offset, 30), Array.from({ length: 15 }, (_, index) => offset / 2 + index));
    assert.ok(reader.cachedWindows <= 12);
  }
  assert.deepEqual(first.at(1), { kind: 'record', index: 0 }, 'A held viewport is independent of later cache eviction.');
  const past = await reader.readWindow(99999, 10, signal);
  assert.equal(past.rowCount, 2815); assert.deepEqual(past.groups, []);
});

test('expanded selections and paste skip distant collapsed headings while retaining source UUIDs', async t => {
  const collapse = { defaultCollapsed: true, exceptions: ['Group 0001', 'Group 1200'] };
  const { reader, calls, service, table, name, records, view } = setup(t, 1407, collapse);
  const signal = new AbortController().signal, rows = await reader.readWindow(0, 30, signal);
  assert.equal(rows.expandedCount, 2); assert.equal(rows.rowCount, 1410);
  const ranges = await reader.ranges([{ start: 0, count: rows.rowCount }], signal);
  assert.deepEqual(ranges, [{ start: 0, count: 2 }]);
  assert.deepEqual(await reader.indices(ranges, signal), [1, 1200]);
  assert.equal(calls.filter(call => call.window === 'displayRows').length, 1);
  assert.equal(calls.filter(call => call.window === 'expandedRecords').length, 1);
  await assert.rejects(reader.pasteIndices(1, 1, signal), /headings/);
  await assert.rejects(reader.pasteIndices(2, 3, signal), /exceed the expanded groups/);
  const model = new TableModel({ getTable: async () => service.getTable(table.id),
    readPage: async (offset, limit, query) => service.queryView(table.id, view.id, { ...query, offset, limit }),
    save: async updates => service.updateBatch(updates, table.id) }, 100, 2);
  t.after(() => model.dispose()); await model.initialize();
  assert.equal(model.pendingCells, 0);
  await model.pasteRows(await reader.pasteIndices(2, 2, signal), 0, [['First draft'], ['Last draft']]);
  assert.equal(model.pendingCells, 2);
  model.undo(); assert.equal(model.pendingCells, 0); model.redo();
  await model.save();
  const firstId = records.find(record => record.values[name] === 'Group 0001')!.id;
  const lastId = records.find(record => record.values[name] === 'Group 1200')!.id;
  assert.equal(service.getRecord(table.id, firstId).values[name], 'First draft');
  assert.equal(service.getRecord(table.id, lastId).values[name], 'Last draft');
  assert.equal(service.getRecord(table.id, records[0]!.id).version, 1);
  await assert.rejects(reader.readWindow(500, 30, signal), { code: 'DATA_CHANGED' });
  assert.deepEqual(rows.at(2), { kind: 'record', index: 1 });
});

test('group reads serialize requests, skip cancelled queued windows and recover after explicit read failures', async t => {
  const { service, table, context } = setup(t);
  let release!: () => void, arrived!: () => void, active = 0, maximum = 0, calls = 0, fail = false;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { arrived = resolve; });
  const api = { queryGroups: async (_id: string, input: GroupQuery, signal?: AbortSignal): Promise<GroupLayout> => {
    calls++; active++; maximum = Math.max(maximum, active);
    try {
      if (calls === 1) { arrived(); await held; }
      signal?.throwIfAborted();
      if (fail) throw new Error('Synthetic read outage');
      return service.queryGroups(table.id, input);
    } finally { active--; }
  } };
  const reader = new GroupReader(api, context); t.after(() => reader.dispose());
  const signal = new AbortController().signal, cancelled = new AbortController();
  const first = reader.readWindow(0, 20, signal); await entered;
  const rejected = assert.rejects(reader.readWindow(400, 20, cancelled.signal), { name: 'AbortError' });
  const third = reader.readWindow(800, 20, signal);
  cancelled.abort(); release(); await first; await rejected; await third;
  assert.equal(maximum, 1); assert.equal(calls, 2); assert.equal(reader.cachedWindows, 2);
  fail = true; await assert.rejects(reader.readWindow(1200, 20, signal), /Synthetic read outage/);
  assert.equal(reader.cachedWindows, 2);
  fail = false; assert.deepEqual((await reader.readWindow(1200, 20, signal)).at(1201), { kind: 'record', index: 600 });
  await assert.rejects(reader.readWindow(1200, 20, AbortSignal.abort()), { name: 'AbortError' });
});

test('disposed or cancelled late group responses cannot refill the cache', async t => {
  const { api, context } = setup(t);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { arrived = resolve; });
  const reader = new GroupReader({ queryGroups: async (id, input) => {
    const response = await api.queryGroups(id, input); arrived(); await held; return response;
  } }, context);
  t.after(() => reader.dispose());
  const response = reader.readWindow(0, 20, new AbortController().signal);
  const rejected = assert.rejects(response, { name: 'AbortError' });
  await entered; reader.dispose(); release(); await rejected;
  assert.equal(reader.cachedWindows, 0);
});
