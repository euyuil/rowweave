import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import type { WorkspaceApi } from '../src/http-client.js';
import { prepareBoardSnapshot } from '../src/board-refresh.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Live board' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: ['todo', 'doing', 'done', 'empty'].map(id => ({ id, name: id })) });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Hidden', type: 'text' });
  const [name, status, amount, hidden] = table.fields.map(field => field.id) as [string, string, string, string];
  const records = service.createRecords(table.id, Array.from({ length: 100 }, (_, index) => ({ values: {
    [name]: 'Task ' + String(index).padStart(3, '0'), [status]: index < 70 ? 'todo' : index < 90 ? 'doing' : 'done',
    [amount]: index, [hidden]: 'Not in the card',
  } }))).records;
  const view = service.createView(table.id, { name: 'Status board', type: 'board', groupBy: status,
    columns: table.fields.map(field => ({ fieldId: field.id, hidden: field.id === hidden, width: 180 })) });
  assert.ok(view.type === 'board');
  const api: Pick<WorkspaceApi, 'summarizeRecords' | 'queryView'> = {
    summarizeRecords: async (id, input) => service.summarizeRecords(id, input),
    queryView: async (id, viewId, input) => service.queryView(id, viewId, input),
  };
  return { service, table, view, api, records, name, status, amount, hidden };
}

test('board snapshots fetch only nearby lane pages, project card fields and clamp removed pages', async t => {
  const { service, table, view, api, records, name, status, amount } = setup(t);
  const reads: Array<{ lane?: string | null; offset?: number; limit?: number }> = [];
  const measured = { ...api, queryView: async (...args: Parameters<typeof api.queryView>) => {
    reads.push(args[2]); return api.queryView(...args);
  } };
  const windows = [{ lane: 'todo', near: true, offset: 50 }, { lane: 'doing', near: false, offset: 0 },
    { lane: 'done', near: true, offset: 0 }, { lane: 'empty', near: true, offset: 0 }, { lane: 'removed', near: true, offset: 0 }];
  const first = service.queryView(table.id, view.id, { limit: 1 });
  const snapshot = await prepareBoardSnapshot(measured, table, view, first, '', windows, new AbortController().signal);
  assert.deepEqual(reads.map(read => [read.lane, read.offset, read.limit]), [['todo', 50, 25], ['done', 0, 25]]);
  assert.equal(snapshot.summary.totals.count, 100); assert.equal(snapshot.pages.get('todo')!.records.length, 20);
  assert.equal(snapshot.pages.get('todo')!.records[0]!.id, records[50]!.id);
  assert.deepEqual(Object.keys(snapshot.pages.get('todo')!.records[0]!.values).sort(), [name, status, amount].sort());
  assert.deepEqual(snapshot.windows.map(window => window.lane), ['todo', 'doing', 'done', 'empty']);
  service.deleteRecords(table.id, records.slice(40, 70).map(record => ({ id: record.id, expectedVersion: record.version })));
  reads.length = 0;
  const next = await prepareBoardSnapshot(measured, table, view, service.queryView(table.id, view.id, { limit: 1 }), '', windows, new AbortController().signal);
  assert.equal(next.windows[0]!.offset, 25); assert.equal(next.pages.get('todo')!.records.length, 15);
  assert.equal(next.pages.get('todo')!.records[0]!.id, records[25]!.id);
  assert.equal(snapshot.pages.get('todo')!.records[0]!.id, records[50]!.id, 'Preparing the next board does not mutate its displayed predecessor.');
  assert.deepEqual(reads.map(read => read.lane), ['todo', 'done']);
});

test('changes between summary and lane reads reject a board candidate without returning mixed revisions', async t => {
  const { service, table, view, api, records, name } = setup(t);
  let changed = false;
  const racing = { ...api, queryView: async (...args: Parameters<typeof api.queryView>) => {
    if (!changed) {
      changed = true;
      service.updateBatch([{ id: records[0]!.id, expectedVersion: records[0]!.version, values: { [name]: 'Remote edit' } }], table.id);
    }
    return api.queryView(...args);
  } };
  await assert.rejects(prepareBoardSnapshot(racing, table, view, service.queryView(table.id, view.id, { limit: 1 }), '',
    [{ lane: 'todo', near: true, offset: 0 }], new AbortController().signal), { code: 'DATA_CHANGED' });
  const fresh = await prepareBoardSnapshot(api, table, view, service.queryView(table.id, view.id, { limit: 1 }), '',
    [{ lane: 'todo', near: true, offset: 0 }], new AbortController().signal);
  assert.equal(fresh.pages.get('todo')!.records[0]!.values[name], 'Remote edit');
});

test('board preparation passes cancellation through the summary and pending lane read', async t => {
  const { service, table, view, api } = setup(t), controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = { ...api, summarizeRecords: async (...args: Parameters<typeof api.summarizeRecords>) => {
    assert.equal(args[2], controller.signal); return api.summarizeRecords(...args);
  }, queryView: async (...args: Parameters<typeof api.queryView>) => {
    assert.equal(args[3], controller.signal);
    return new Promise<Awaited<ReturnType<typeof api.queryView>>>((_resolve, reject) => {
      args[3]!.addEventListener('abort', () => reject(args[3]!.reason), { once: true }); started();
    });
  } };
  const rejected = assert.rejects(prepareBoardSnapshot(held, table, view, service.queryView(table.id, view.id, { limit: 1 }), '',
    [{ lane: 'todo', near: true, offset: 0 }], controller.signal), { name: 'AbortError' });
  await ready; controller.abort(); await rejected;
});

test('board snapshots reject an expired relative-date context and load the new period without a write', async t => {
  let now = new Date('2024-02-29T12:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Calendar board' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect', options: [{ id: 'todo', name: 'To do' }] });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  const status = table.fields[1]!.id, due = table.fields[2]!.id;
  const records = service.createRecords(table.id, ['2024-02-29', '2024-03-01'].map(date => ({ values: { [status]: 'todo', [due]: date } }))).records;
  const view = service.createView(table.id, { name: 'Today', type: 'board', groupBy: status,
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: due, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } }] } } });
  assert.ok(view.type === 'board');
  const api: Pick<WorkspaceApi, 'summarizeRecords' | 'queryView'> = {
    summarizeRecords: async (id, input) => service.summarizeRecords(id, input),
    queryView: async (id, viewId, input) => service.queryView(id, viewId, input),
  };
  const first = service.queryView(table.id, view.id, { limit: 1 }), windows = [{ lane: 'todo', near: true, offset: 0 }];
  const before = await prepareBoardSnapshot(api, table, view, first, '', windows, new AbortController().signal);
  assert.equal(before.pages.get('todo')!.records[0]!.id, records[0]!.id);
  now = new Date('2024-03-01T00:00:00Z');
  await assert.rejects(prepareBoardSnapshot(api, table, view, first, '', windows, new AbortController().signal), { code: 'DATA_CHANGED' });
  const next = await prepareBoardSnapshot(api, table, view, service.queryView(table.id, view.id, { limit: 1 }), '', windows, new AbortController().signal);
  assert.equal(next.summary.revision, before.summary.revision); assert.notEqual(next.summary.dateContext, before.summary.dateContext);
  assert.equal(next.pages.get('todo')!.records[0]!.id, records[1]!.id);
});
