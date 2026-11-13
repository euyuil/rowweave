import test from 'node:test';
import assert from 'node:assert/strict';
import type { Field, GroupLayout } from '../../contracts/src/index.js';
import { GroupRows } from '../src/group-rows.js';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { TableModel } from '../src/table-model.js';

test('windowed group mapping keeps million-row offsets without materializing records', () => {
  const field: Field = { id: 'status', name: 'Status', type: 'singleSelect', required: false,
    options: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }, { id: 'empty', name: 'Empty' }] };
  const layout: GroupLayout = { revision: 1, schemaVersion: 1, totalRecords: 1000004, totalGroups: 4,
    totalRows: 8, offset: 0, window: 'displayRows', groups: [
      { key: 'first', label: 'First', count: 1000000, recordOffset: 0, rowStart: 0, expandedOffset: 0, collapsed: true },
      { key: 'second', label: 'Second', count: 3, recordOffset: 1000000, rowStart: 1, expandedOffset: 0, collapsed: false },
      { key: 'empty', label: 'Empty', count: 0, recordOffset: 1000003, rowStart: 5, expandedOffset: 3, collapsed: false },
      { key: null, label: '', count: 1, recordOffset: 1000003, rowStart: 6, expandedOffset: 3, collapsed: false },
    ] };
  const rows = new GroupRows(field, layout);
  assert.equal(rows.rowCount, 8);
  assert.deepEqual(rows.indices(0, 8), [1000000, 1000001, 1000002, 1000003]);
  assert.equal(rows.count(0, 8), 4);
  assert.deepEqual(rows.at(2), { kind: 'record', index: 1000000 });
  assert.equal(rows.position(999999), undefined);
  assert.equal(rows.position(1000000), 2); assert.equal(rows.position(1000003), 7);
  assert.equal(rows.position(1000004), undefined); assert.equal(rows.position(-1), undefined);
  assert.equal(rows.at(8), undefined);
  const window = new GroupRows(field, layout, layout.groups.slice(1, 2));
  assert.equal(window.count(1, 2), 1); assert.equal(window.count(1, 6), undefined);
  assert.equal(window.at(6), undefined, 'Unloaded groups cannot reuse the preceding group offset.');
  assert.equal(window.before(8), 4, 'Global totals remain available beyond the cached window.');
});

test('checkbox grouping keeps false, true and null distinct', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Checkbox groups' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Done', type: 'checkbox' });
  const field = table.fields[1]!;
  service.createRecords(table.id, [true, null, false].map(value => ({ values: { [field.id]: value } })));
  const rows = new GroupRows(field, service.queryGroups(table.id, { groupBy: field.id, collapse: { defaultCollapsed: false, exceptions: [false] } }));
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
