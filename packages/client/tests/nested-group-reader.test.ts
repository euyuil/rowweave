import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { GroupReader } from '../src/group-reader.js';
import { GroupRows } from '../src/group-rows.js';
import { TableModel } from '../src/table-model.js';
import type { GroupQuery } from '../../contracts/src/index.js';

test('nested row mapping distinguishes parent spans, hidden descendants and identically named children', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Nested mapping' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Child', type: 'text' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Done', type: 'checkbox' });
  const [root, child, done] = table.fields.map(field => field.id) as [string, string, string];
  service.createRecords(table.id, [['A', 'Same', false], ['A', 'Same', true], ['B', 'Same', false], ['B', 'Other', false]]
    .map(values => ({ values: { [root]: values[0]!, [child]: values[1]!, [done]: values[2]! } })));
  const layout = service.queryGroups(table.id, { groupBy: [root, child, done] });
  const rows = new GroupRows(table.fields, layout);
  assert.equal(rows.rowCount, 14); assert.equal(rows.expandedCount, 4);
  assert.deepEqual(rows.indices(0, 14), [0, 1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map(index => rows.position(index)), [3, 5, 9, 12]);
  assert.deepEqual(rows.groups.filter(group => group.label === 'Same').map(group => [group.key, group.ancestors]), [
    ['["A","Same"]', ['A']], ['["B","Same"]', ['B']],
  ]);
  assert.equal(rows.groups.find(group => group.label === 'Unchecked')!.ancestors.join('/'), 'A/Same');
  assert.equal(rows.count(0, 3), 0); assert.equal(rows.count(0, 6), 2); assert.equal(rows.count(6, 7), 2);
  const parentOnly = new GroupRows(table.fields, layout, layout.groups.slice(0, 1));
  assert.equal(parentOnly.at(1), undefined); assert.equal(parentOnly.position(0), undefined);
  const collapsed = new GroupRows(table.fields, service.queryGroups(table.id, { groupBy: [root, child, done],
    collapse: { defaultCollapsed: false, exceptions: [['A', 'Same'], ['B', 'Other', false]] } }));
  assert.equal(collapsed.rowCount, 9); assert.equal(collapsed.expandedCount, 1);
  assert.deepEqual(collapsed.indices(0, 9), [3]); assert.equal(collapsed.position(3), 7);
  for (const index of [0, 1, 2]) assert.equal(collapsed.position(index), undefined);
  assert.deepEqual(collapsed.at(7), { kind: 'record', index: 3 });
});

test('nested reader windows and sparse paste preserve source UUIDs across distant hidden ancestors', async t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Nested pages' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Child', type: 'text' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Number', type: 'number' });
  const [name, child, number] = table.fields.map(field => field.id) as [string, string, string];
  const key = (index: number) => 'Root ' + String(index).padStart(3, '0');
  const records = service.createRecords(table.id, Array.from({ length: 607 }, (_, index) => ({ values: {
    [name]: key(606 - index), [child]: 'Same', [number]: 0,
  } }))).records;
  const view = service.createView(table.id, { name: 'Three levels', groupBy: [name, child, number] });
  const first = service.queryView(table.id, view.id, { limit: 1 }), calls: GroupQuery[] = [];
  const api = { queryGroups: async (_id: string, input: GroupQuery) => { calls.push(input); return service.queryGroups(table.id, input); } };
  const base = { table, view, revision: first.revision, search: '' };
  const signal = new AbortController().signal;
  const expanded = new GroupReader(api, { ...base, collapse: { defaultCollapsed: false, exceptions: [] } });
  t.after(() => expanded.dispose());
  for (const offset of [0, 199, 399, 1200, 2400]) {
    const rows = await expanded.readWindow(offset, 30, signal);
    for (let row = offset; row < Math.min(offset + 30, rows.rowCount); row++) {
      assert.equal(rows.at(row)?.kind, row % 4 === 3 ? 'record' : 'group');
      if (row % 4 === 3) assert.deepEqual(rows.at(row), { kind: 'record', index: Math.floor(row / 4) });
    }
  }
  const reader = new GroupReader(api, { ...base, collapse: { defaultCollapsed: true,
    exceptions: [1, 605].flatMap(index => [[key(index)], [key(index), 'Same'], [key(index), 'Same', 0]]) } });
  t.after(() => reader.dispose());
  const rows = await reader.readWindow(0, 15, signal);
  assert.equal(rows.expandedCount, 2); assert.equal(rows.rowCount, 614);
  assert.deepEqual(rows.at(4), { kind: 'record', index: 1 });
  assert.deepEqual(await reader.indices(await reader.ranges([{ start: 0, count: 614 }], signal), signal), [1, 605]);
  await assert.rejects(reader.pasteIndices(2, 1, signal), /headings/);
  assert.deepEqual(await reader.pasteIndices(4, 2, signal), [1, 605]);
  const model = new TableModel({ getTable: async () => table,
    readPage: async (offset, limit, query) => service.queryView(table.id, view.id, { ...query, offset, limit }),
    save: async updates => service.updateBatch(updates, table.id) }, 100, 2);
  t.after(() => model.dispose()); await model.initialize();
  await model.pasteRows(await reader.pasteIndices(4, 2, signal), 0, [['Moved first'], ['Moved last']]);
  model.undo(); assert.equal(model.pendingCells, 0); model.redo(); await model.save();
  assert.equal(service.getRecord(table.id, records[605]!.id).values[name], 'Moved first');
  assert.equal(service.getRecord(table.id, records[1]!.id).values[name], 'Moved last');
  assert.equal(service.getRecord(table.id, records[0]!.id).version, 1);
  await assert.rejects(reader.readWindow(400, 20, signal), { code: 'DATA_CHANGED' });
  assert.ok(calls.every(call => call.limit! <= 500));
});
