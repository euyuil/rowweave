import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { prepareGanttSnapshot } from '../src/gantt-refresh.js';
import type { WorkspaceApi } from '../src/http-client.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Timeline pages' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Start', type: 'date' });
  const name = table.primaryFieldId, start = table.fields[1]!.id;
  const records = service.createRecords(table.id, Array.from({ length: 125 }, (_, index) => ({ values: {
    [name]: 'Task ' + String(index).padStart(3, '0'), [start]: '2024-02-29' } }))).records;
  const view = service.createView(table.id, { name: 'Plan', type: 'gantt', gantt: { startFieldId: start, timeZone: 'UTC', scale: 'day' },
    query: { sort: [{ fieldId: name, direction: 'asc' }] }, columns: table.fields.map(field => ({ fieldId: field.id, width: 180, hidden: field.id === start })) });
  assert.ok(view.type === 'gantt');
  const api: Pick<WorkspaceApi, 'queryView'> = { queryView: async (id, viewId, input) => service.queryView(id, viewId, input) };
  const first = () => service.queryView(table.id, view.id, { limit: 1 });
  return { service, table, name, start, records, view, api, first };
}

test('timeline snapshots load only a projected page and clamp a deleted last page', async t => {
  const { service, table, name, start, records, view, api, first } = setup(t);
  const controller = new AbortController();
  const measured = { queryView: async (...args: Parameters<typeof api.queryView>) => {
    assert.equal(args[3], controller.signal); assert.equal(args[2].limit, 50);
    assert.deepEqual(args[2].fields, [name, start]); return api.queryView(...args);
  } };
  const snapshot = await prepareGanttSnapshot(measured, table, view, first(), '', { offset: 100 }, controller.signal);
  assert.equal(snapshot.page.total, 125); assert.equal(snapshot.page.records.length, 25); assert.equal(snapshot.page.records[0]!.id, records[100]!.id);
  assert.equal(snapshot.page.records[0]!.values[start], '2024-02-29');
  service.deleteRecords(table.id, records.slice(80).map(record => ({ id: record.id, expectedVersion: record.version })));
  const next = await prepareGanttSnapshot(measured, table, view, first(), '', snapshot.window, controller.signal);
  assert.equal(next.window.offset, 50); assert.equal(next.page.records.length, 30); assert.equal(next.page.records[0]!.id, records[50]!.id);
  assert.equal(snapshot.page.records[0]!.id, records[100]!.id);
});

test('timeline snapshots reject mixed data/view/schema revisions and forward cancellation', async t => {
  const { service, table, name, records, view, api, first } = setup(t);
  const old = first();
  service.updateBatch([{ id: records[0]!.id, expectedVersion: records[0]!.version, values: { [name]: 'Updated' } }], table.id);
  await assert.rejects(prepareGanttSnapshot(api, table, view, old, '', { offset: 0 }, new AbortController().signal), { code: 'DATA_CHANGED' });
  const changedSchema = { queryView: async (...args: Parameters<typeof api.queryView>) => ({ ...await api.queryView(...args), schemaVersion: table.version + 1 }) };
  await assert.rejects(prepareGanttSnapshot(changedSchema, table, view, first(), '', { offset: 0 }, new AbortController().signal), { code: 'SCHEMA_CONFLICT' });
  const controller = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held: Pick<WorkspaceApi, 'queryView'> = { queryView: async (_id, _viewId, _input, signal) => {
    assert.equal(signal, controller.signal);
    return new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); started(); });
  } };
  const cancelled = assert.rejects(prepareGanttSnapshot(held, table, view, first(), '', { offset: 0 }, controller.signal), { name: 'AbortError' });
  await ready; controller.abort(); await cancelled;
  const current = first(); service.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Changed' });
  await assert.rejects(prepareGanttSnapshot(api, table, view, current, '', { offset: 0 }, new AbortController().signal), { code: 'VIEW_CONFLICT' });
});
