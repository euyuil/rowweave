import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { LiveHistory } from '../src/live-history.js';
import { TableModel } from '../src/table-model.js';

test('live edits support consecutive undo and redo without undoing another field', async t => {
  const service = new RecordService(fixture(t).open()), table = service.getTable();
  const history = new LiveHistory(async updates => service.updateBatch(updates));
  const read = () => service.getRecord(table.id, 'record_1');
  const original = read();
  await history.commit(table, [{ record: read(), values: { field_1: 'One' } }]);
  await history.commit(table, [{ record: read(), values: { field_1: 'Two' } }]);
  service.updateBatch([{ id: original.id, expectedVersion: read().version, values: { field_2: 'Other user' } }]);
  await history.move(); assert.equal(read().values['field_1'], 'One');
  await history.move(); assert.equal(read().values['field_1'], original.values['field_1']);
  assert.equal(read().values['field_2'], 'Other user');
  await history.move(true); await history.move(true);
  assert.equal(read().values['field_1'], 'Two');
  assert.equal(read().values['field_2'], 'Other user');
  await history.move();
  await history.commit(table, [{ record: read(), values: { field_1: 'New branch' } }]);
  assert.equal(history.canRedo, false);
});

test('unchanged typed values neither write nor interrupt the undo and redo chain', async t => {
  const service = new RecordService(fixture(t).open()), table = service.getTable();
  let writes = 0;
  const history = new LiveHistory(async updates => { writes++; return service.updateBatch(updates); });
  const read = () => service.getRecord(table.id, 'record_1');
  await history.commit(table, [{ record: read(), values: { field_1: 'One' } }]);
  await history.commit(table, [{ record: read(), values: { field_1: 'One' } }]);
  assert.equal(writes, 1);
  await history.move();
  const original = read();
  await history.commit(table, [{ record: original, values: { field_1: original.values['field_1']! } }]);
  assert.equal(history.canRedo, true);
  await history.move(true);
  assert.equal(read().values['field_1'], 'One');
  assert.equal(writes, 3);
});

test('same-cell conflicts, including change-and-change-back, reject an entire undo batch', async t => {
  const service = new RecordService(fixture(t).open()), table = service.getTable();
  const history = new LiveHistory(async updates => service.updateBatch(updates));
  const read = (id = 'record_1') => service.getRecord(table.id, id);
  await history.commit(table, ['record_1', 'record_2'].map(id => ({ record: read(id), values: { field_1: 'Mine' } })));
  for (const value of ['Theirs', 'Mine']) service.updateBatch([{ id: 'record_2', expectedVersion: read('record_2').version, values: { field_1: value } }]);
  await assert.rejects(history.move(), { code: 'VERSION_CONFLICT' });
  assert.equal(read().values['field_1'], 'Mine');
  assert.equal(read('record_2').values['field_1'], 'Mine');
  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
});

test('undoing a later local edit cannot hide an intervening external change-and-change-back', async t => {
  const service = new RecordService(fixture(t).open()), table = service.getTable();
  const history = new LiveHistory(async updates => service.updateBatch(updates));
  const read = () => service.getRecord(table.id, 'record_1');
  await history.commit(table, [{ record: read(), values: { field_1: 'Mine' } }]);
  for (const value of ['Theirs', 'Mine']) service.updateBatch([{ id: 'record_1', expectedVersion: read().version, values: { field_1: value } }]);
  await history.commit(table, [{ record: read(), values: { field_1: 'Later' } }]);
  await history.move(); assert.equal(read().values['field_1'], 'Mine');
  await assert.rejects(history.move(), { code: 'VERSION_CONFLICT' });
  assert.equal(read().values['field_1'], 'Mine');
});

test('external changes to other fields between local edits preserve consecutive undo', async t => {
  const service = new RecordService(fixture(t).open()), table = service.getTable();
  const history = new LiveHistory(async updates => service.updateBatch(updates));
  const read = () => service.getRecord(table.id, 'record_1'), original = read();
  await history.commit(table, [{ record: read(), values: { field_1: 'First' } }]);
  service.updateBatch([{ id: 'record_1', expectedVersion: read().version, values: { field_2: 'Theirs' } }]);
  await history.commit(table, [{ record: read(), values: { field_1: 'Second' } }]);
  await history.move(); await history.move();
  assert.equal(read().values['field_1'], original.values['field_1']);
  assert.equal(read().values['field_2'], 'Theirs');
});

test('stale clients can edit independent fields but cannot bypass schema or value guards', async t => {
  const service = new RecordService(fixture(t).open()), table = service.getTable();
  const original = service.getRecord(table.id, 'record_1');
  const first = new LiveHistory(async updates => service.updateBatch(updates));
  const second = new LiveHistory(async updates => service.updateBatch(updates));
  await first.commit(table, [{ record: original, values: { field_1: 'First' } }]);
  await second.commit(table, [{ record: original, values: { field_2: 'Second' } }]);
  assert.equal(service.getRecord(table.id, original.id).values['field_1'], 'First');
  await assert.rejects(second.commit(table, [{ record: original, values: { field_1: 'Stale' } }]), { code: 'VERSION_CONFLICT' });
  service.updateTable(table.id, { expectedVersion: table.version, name: 'New schema version' });
  await assert.rejects(first.move(), { code: 'SCHEMA_CONFLICT' });
});

test('live saves retain cached rows, selection generation and failed drafts', async t => {
  const service = new RecordService(fixture(t).open());
  let reject = false;
  const model = new TableModel({ getTable: async () => service.getTable(),
    readPage: async (offset, limit, query) => service.queryRecords('prototype', { ...query, offset, limit }),
    save: async updates => { if (reject) throw new Error('Connection lost'); return service.updateBatch(updates); } });
  await model.initialize();
  const generation = model.queryVersion;
  model.applyEdits([{ row: 0, fieldId: 'field_1', value: 'Automatic' }]);
  await model.saveLive();
  assert.equal(model.queryVersion, generation);
  assert.equal(model.getRecord(0)!.values['field_1'], 'Automatic');
  assert.equal(model.pendingCells, 0);
  assert.equal(model.liveHistory.canUndo, true);
  reject = true;
  model.applyEdits([{ row: 0, fieldId: 'field_1', value: 'Keep me' }]);
  await assert.rejects(model.saveLive(), /Connection lost/);
  assert.equal(model.pendingCells, 1);
  assert.equal(model.getRecord(0)!.values['field_1'], 'Keep me');
});

test('navigation can await an acknowledged live write without submitting it twice', async t => {
  const service = new RecordService(fixture(t).open());
  let release!: () => void, writes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const model = new TableModel({ getTable: async () => service.getTable(),
    readPage: async (offset, limit, query) => service.queryRecords('prototype', { ...query, offset, limit }),
    save: async updates => { writes++; await held; return service.updateBatch(updates); } });
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: 'field_1', value: 'Before switching' }]);
  const saved = model.saveLive();
  let idle = false;
  const waiting = model.waitForWrite().then(() => { idle = true; });
  await Promise.resolve(); assert.equal(idle, false);
  release(); await saved; await waiting;
  assert.equal(idle, true); assert.equal(writes, 1); assert.equal(model.pendingCells, 0);
});
