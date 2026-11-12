import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { TableModel } from '../src/table-model.js';
import { cellDisplay, cellText } from '../src/cell-values.js';

test('typed paste converts a whole rectangle and retains earlier drafts on an invalid cell', async t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Typed paste' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number', numberFormat: 'currency', currency: 'USD', precision: 2 });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Tags', type: 'multiSelect', options: [{ name: '中文 🌱' }] });
  service.createRecords(table.id, [{ values: {} }, { values: {} }]);
  const model = new TableModel({ getTable: async () => service.getTable(table.id),
    readPage: async (offset, limit) => service.readPage(offset, limit, table.id),
    save: async updates => service.updateBatch(updates, table.id) });
  await model.initialize();
  await model.paste(0, 0, [['First', '12.5', '["中文 🌱"]'], ['Second', '0', '[]']]);
  assert.equal(model.getRecord(0)!.values[table.fields[1]!.id], 12.5);
  const pending = model.pendingCells;
  await assert.rejects(model.paste(0, 0, [['Would replace', '99'], ['Invalid', 'NaN']]));
  assert.equal(model.pendingCells, pending);
  assert.equal(model.getRecord(0)!.values[table.fields[0]!.id], 'First');
  assert.equal(cellText(table.fields[2]!, model.getRecord(0)!.values[table.fields[2]!.id]), '["中文 🌱"]');
  assert.equal(cellDisplay(table.fields[1]!, 12.5), '$12.50');
  await model.save();
  await model.paste(0, 2, [['["中文 🌱"]']]);
  assert.equal(model.pendingCells, 0);
});
