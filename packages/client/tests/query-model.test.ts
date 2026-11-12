import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { ApiFailure, createWorkspaceClient, queryForView } from '../src/http-client.js';
import { TableModel } from '../src/table-model.js';

async function workspace(t: Parameters<typeof fixture>[0]) {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Tasks' });
  table = service.createField(table.id, { expectedVersion: 1, name: 'Notes', type: 'text' });
  const records = service.createRecords(table.id, ['A', 'B', 'C'].map(name => ({ values: { [table.primaryFieldId]: name } }))).records;
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  return { api, service, table, records };
}

test('drafts follow record IDs through sorting and filtering and save while hidden', async t => {
  const { api, table, records } = await workspace(t);
  const model = new TableModel(api.table(table.id), 2, 1);
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: table.primaryFieldId, value: 'Z' }]);
  await model.setQuery({ sort: [{ fieldId: table.primaryFieldId, direction: 'desc' }] });
  assert.equal(model.getRecord(0)!.id, records[2]!.id);
  assert.equal(model.getRecord(0)!.values[table.primaryFieldId], 'C');
  const last = await model.readRange(2, 1);
  assert.equal(last[0]!.id, records[0]!.id);
  assert.equal(last[0]!.values[table.primaryFieldId], 'Z');
  await model.setQuery({ filter: { conjunction: 'and', conditions: [{ fieldId: table.primaryFieldId, operator: 'eq', value: 'B' }] } });
  assert.equal(model.rowCount, 1);
  assert.equal(model.getRecord(0)!.id, records[1]!.id);
  assert.equal(model.pendingRecords[0]!.id, records[0]!.id);
  await model.save();
  assert.equal((await api.getRecord(table.id, records[0]!.id)).values[table.primaryFieldId], 'Z');
  assert.equal(model.rowCount, 1);
  assert.equal(model.pendingCells, 0);
});

test('saved view paging detects configuration conflicts and refresh preserves drafts by identity', async t => {
  const { api, table, records } = await workspace(t);
  let view = await api.createView(table.id, { name: 'Descending', query: { sort: [{ fieldId: table.primaryFieldId, direction: 'desc' }] },
    columns: table.fields.map(field => ({ fieldId: field.id, hidden: field.id !== table.primaryFieldId, width: 240 })) });
  const model = new TableModel(api.table(table.id), 1, 2);
  await model.initialize();
  await model.setQuery(queryForView(view));
  assert.equal(model.getRecord(0)!.id, records[2]!.id);
  assert.deepEqual(model.fields.map(field => field.id), [table.primaryFieldId]);
  model.applyEdits([{ row: 0, fieldId: table.primaryFieldId, value: 'Draft C' }]);
  view = await api.updateView(table.id, view.id, { expectedVersion: view.version, query: {} });
  await assert.rejects(model.readRange(1, 1), error => error instanceof ApiFailure && error.code === 'VIEW_CONFLICT');
  assert.equal(model.stale, true);
  assert.equal(model.pendingCells, 1);
  await model.refresh(queryForView(view));
  assert.equal((await model.readRange(2, 1))[0]!.values[table.primaryFieldId], 'Draft C');
  await model.save();
  assert.equal((await api.getRecord(table.id, records[2]!.id)).values[table.primaryFieldId], 'Draft C');
  await model.setQuery(queryForView(view, 'Draft'));
  assert.equal(model.rowCount, 1);
});

test('a schema change between metadata and first page cannot populate a cache with incompatible values', async t => {
  const { api, table } = await workspace(t);
  const base = api.table(table.id);
  let race = true;
  const model = new TableModel({ ...base, getTable: async () => {
    const result = await base.getTable();
    if (race) {
      race = false;
      await api.updateField(table.id, table.primaryFieldId, { expectedVersion: result.version, name: 'Renamed' });
    }
    return result;
  } });
  await assert.rejects(model.initialize(), error => error instanceof ApiFailure && error.code === 'SCHEMA_CONFLICT');
  assert.equal(model.cacheStats.pages, 0);
  assert.equal(model.stale, true);
  await model.refresh();
  assert.equal(model.fields[0]!.name, 'Renamed');
  assert.equal(model.rowCount, 3);
});

test('paste uses visible field order and whole actions can be undone and redone', async t => {
  const { api, table } = await workspace(t);
  const model = new TableModel(api.table(table.id), 1, 1);
  await model.initialize();
  const note = table.fields[1]!.id;
  await model.setQuery({ fields: [note, table.primaryFieldId] });
  await model.paste(0, 0, [['First note', 'Renamed A'], ['Second note', 'Renamed B']]);
  assert.equal(model.pendingCells, 4);
  assert.equal(model.getRecord(0)!.values[note], 'First note');
  assert.equal(model.getRecord(1)!.values[table.primaryFieldId], 'Renamed B');
  await model.readRange(2, 1);
  model.undo();
  assert.equal(model.pendingCells, 0);
  assert.equal(model.canRedo, true);
  model.redo();
  assert.equal(model.pendingCells, 4);
  assert.equal(model.getRecord(0)!.values[note], 'First note');
  model.applyEdits([{ row: 0, fieldId: note, value: 'First note' }]);
  model.undo();
  assert.equal(model.pendingCells, 0);
  model.redo();
  await model.save();
  assert.equal(model.canUndo, false);
  assert.equal(model.canRedo, false);
});

test('revealing another field retains its stored value alongside an existing projected draft', async t => {
  const { api, table, records } = await workspace(t);
  const note = table.fields[1]!.id;
  await api.updateRecords(table.id, [{ id: records[0]!.id, expectedVersion: 1, values: { [note]: 'Existing note' } }]);
  const model = new TableModel(api.table(table.id));
  await model.initialize();
  await model.setQuery({ fields: [table.primaryFieldId] });
  model.applyEdits([{ row: 0, fieldId: table.primaryFieldId, value: 'Renamed' }]);
  await model.setQuery({ fields: [note, table.primaryFieldId] });
  assert.equal(model.getRecord(0)!.values[note], 'Existing note');
  model.applyEdits([{ row: 0, fieldId: note, value: 'Existing note' }]);
  assert.equal(model.pendingCells, 1);
  await model.save();
  assert.equal((await api.getRecord(table.id, records[0]!.id)).values[note], 'Existing note');
});

test('external changes stop stale paging and refresh retains conflicting drafts by ID', async t => {
  const { api, service, table, records } = await workspace(t);
  const model = new TableModel(api.table(table.id), 1, 1);
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: table.primaryFieldId, value: 'Draft' }]);
  service.updateBatch([{ id: records[0]!.id, expectedVersion: 1, values: { [table.primaryFieldId]: 'Peer' } }], table.id);
  await assert.rejects(model.readRange(1, 1), (error: unknown) => error instanceof ApiFailure && error.code === 'DATA_CHANGED');
  assert.equal(model.stale, true);
  assert.equal(model.pendingCells, 1);
  await model.refresh();
  assert.equal(model.stale, false);
  assert.equal(model.conflicted, true);
  assert.equal(model.getRecord(0)!.values[table.primaryFieldId], 'Draft');
  await assert.rejects(model.save(), ApiFailure);
  assert.equal(model.pendingCells, 1);
  await model.discardAndReload();
  assert.equal(model.getRecord(0)!.values[table.primaryFieldId], 'Peer');
});

test('an in-flight range never combines records from different query orders', async t => {
  const { api, table, records } = await workspace(t);
  const base = api.table(table.id);
  let release: (() => void) | undefined;
  let pause = true;
  const model = new TableModel({ ...base, readPage: async (offset, limit, query, signal) => {
    const page = await base.readPage(offset, limit, query, signal);
    if (pause && offset === 1) {
      pause = false;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return page;
  } }, 1, 2);
  await model.initialize();
  const range = model.readRange(0, 3);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await model.setQuery({ sort: [{ fieldId: table.primaryFieldId, direction: 'desc' }] });
  release();
  assert.deepEqual((await range).map(record => record.id), records.map(record => record.id).reverse());
});

test('a committed save is not reported as failed when the following refresh cannot connect', async t => {
  const { api, table, records } = await workspace(t);
  const base = api.table(table.id);
  let failRefresh = false;
  const model = new TableModel({ ...base, getTable: async () => {
    if (failRefresh) throw new Error('Offline');
    return base.getTable();
  } });
  await model.initialize();
  model.applyEdits([{ row: 0, fieldId: table.primaryFieldId, value: 'Saved once' }]);
  failRefresh = true;
  await model.save();
  assert.equal(model.pendingCells, 0);
  assert.match(model.error!, /Changes saved, but refreshing failed/);
  await model.save();
  assert.equal((await api.getRecord(table.id, records[0]!.id)).version, 2);
});

test('history stays bounded across large pasted actions and cache eviction', async t => {
  const service = new RecordService(fixture(t, { rows: 1_100, columns: 20 }).open());
  const model = new TableModel({ getTable: async () => service.getTable(),
    readPage: async (offset, limit, query) => service.queryRecords('prototype', { ...query, offset, limit }),
    save: async updates => service.updateBatch(updates) }, 100, 2);
  await model.initialize();
  for (let action = 0; action < 7; action++) {
    await model.paste(0, 0, Array.from({ length: 1_000 }, () => Array.from({ length: 10 }, () => `Value ${action}`)));
  }
  assert.equal(model.cacheStats.historyCells, 60_000);
  assert.ok(model.cacheStats.rows <= 200);
  for (let action = 0; action < 6; action++) model.undo();
  assert.equal(model.canUndo, false);
  assert.equal(model.getRecord(999)!.values['field_10'], 'Value 0');
  assert.equal(model.pendingCells, 10_000);
});

test('disposing a table aborts its outstanding read instead of starting replacement requests', async t => {
  const { api, table } = await workspace(t);
  let signal: AbortSignal | undefined;
  let reads = 0;
  const model = new TableModel({ ...api.table(table.id), readPage: async (_offset, _limit, _query, requestSignal) => {
    reads++;
    signal = requestSignal;
    return new Promise((_resolve, reject) => requestSignal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } });
  const initializing = model.initialize();
  while (!signal) await new Promise(resolve => setImmediate(resolve));
  model.dispose();
  await assert.rejects(initializing, /Aborted/);
  assert.equal(signal.aborted, true);
  assert.equal(reads, 1);
});
