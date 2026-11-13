import test from 'node:test';
import assert from 'node:assert/strict';
import type { Field, RecordSummary } from '../../contracts/src/index.js';
import { GroupedRows } from '../src/grouped-rows.js';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { TableModel } from '../src/table-model.js';

test('group row mapping skips collapsed records and headers without materializing the dataset', () => {
  const field: Field = { id: 'status', name: 'Status', type: 'singleSelect', required: false,
    options: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }, { id: 'empty', name: 'Empty' }] };
  const summary: RecordSummary = { totals: { count: 1000004, values: [] }, revision: 1, schemaVersion: 1, groupCount: 3, offset: 0,
    groups: [{ key: 'second', label: 'Second', count: 3, values: [] }, { key: null, label: '', count: 1, values: [] },
      { key: 'first', label: 'First', count: 1000000, values: [] }] };
  const expanded = new GroupedRows(field, summary, new Set());
  assert.equal(expanded.rowCount, 1000008);
  assert.equal(expanded.at(0)?.kind, 'group');
  assert.deepEqual(expanded.at(1000000), { kind: 'record', index: 999999 });
  assert.equal(expanded.at(1000001)?.kind, 'group');
  assert.deepEqual(expanded.pasteIndices(1000000, 3), [999999, 1000000, 1000001]);
  const collapsed = new GroupedRows(field, summary, new Set(['"first"']));
  assert.equal(collapsed.rowCount, 8);
  assert.deepEqual(collapsed.indices(0, 8), [1000000, 1000001, 1000002, 1000003]);
  assert.equal(collapsed.count(0, 8), 4);
  assert.deepEqual(collapsed.at(2), { kind: 'record', index: 1000000 });
  assert.equal(expanded.position(999999), 1000000);
  assert.equal(collapsed.position(999999), undefined);
  assert.equal(collapsed.position(1000000), 2);
  assert.equal(collapsed.position(1000003), 7);
  assert.equal(collapsed.position(1000004), undefined);
  assert.equal(collapsed.position(-1), undefined);
  assert.deepEqual(collapsed.pasteIndices(4, 2), [1000002, 1000003]);
  assert.throws(() => collapsed.pasteIndices(0, 1), /headings/);
  assert.throws(() => collapsed.pasteIndices(7, 2), /expanded groups/);
  assert.equal(collapsed.at(8), undefined);
  assert.equal(new GroupedRows(field, summary, new Set(['"first"', '"second"', 'null'])).count(0, 8), 0);
});

test('checkbox grouping keeps false, true and null distinct', () => {
  const field: Field = { id: 'done', name: 'Done', type: 'checkbox', required: false };
  const rows = new GroupedRows(field, { totals: { count: 3, values: [] }, revision: 1, schemaVersion: 1, groupCount: 3, offset: 0,
    groups: [true, null, false].map(key => ({ key, label: '', count: 1, values: [] })) }, new Set(['false']));
  assert.deepEqual(rows.groups.map(group => group.label), ['Unchecked', 'Checked', 'No value']);
  assert.deepEqual(rows.indices(0, rows.rowCount), [1, 2]);
});

test('noncontiguous paste preserves record identities, atomic validation and undo across unloaded pages', async t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Grouped edits' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const amount = table.fields[1]!.id;
  const records = service.createRecords(table.id, Array.from({ length: 1105 }, (_, index) => ({ values: { [table.primaryFieldId]: String(index), [amount]: index } }))).records;
  const model = new TableModel({ getTable: async () => service.getTable(table.id),
    readPage: async (offset, limit, query) => service.queryRecords(table.id, { ...query, offset, limit }),
    save: async updates => service.updateBatch(updates, table.id) }, 100, 2);
  t.after(() => model.dispose());
  await model.initialize();
  await model.pasteRows([3, 1001, 1104], 0, [['Three', '30'], ['Thousand', '40'], ['Last', '50']]);
  assert.equal(model.pendingCells, 6);
  assert.ok(model.cacheStats.pages <= 2);
  await assert.rejects(model.pasteRows([3, 1104], 0, [['Wrong', '0'], ['Wrong', 'NaN']]));
  assert.equal(model.pendingCells, 6);
  await assert.rejects(model.pasteRows([3, 3], 0, [['A'], ['B']]));
  model.undo();
  assert.equal(model.pendingCells, 0);
  model.redo();
  assert.equal(model.pendingCells, 6);
  await model.save();
  assert.equal(service.getRecord(table.id, records[3]!.id).values[amount], 30);
  assert.equal(service.getRecord(table.id, records[1001]!.id).values[amount], 40);
  assert.equal(service.getRecord(table.id, records[1104]!.id).values[amount], 50);
  assert.equal(service.getRecord(table.id, records[500]!.id).version, 1);
});
