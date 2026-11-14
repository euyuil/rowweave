import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import type { RecordSchedule, RowRecord } from '../../contracts/src/index.js';

function setup(t: Parameters<typeof fixture>[0], type: 'date' | 'datetime' = 'date', timeZone = 'UTC') {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Schedules' });
  for (const name of ['Start', 'End']) table = service.createField(table.id, { expectedVersion: table.version, name, type });
  const [name, start, end] = table.fields.map(field => field.id) as [string, string, string];
  const view = service.createView(table.id, { name: 'Plan', type: 'calendar', calendar: { startFieldId: start, endFieldId: end, timeZone } });
  assert.ok(view.type === 'calendar');
  const create = (from: string | null, to: string | null = null) => service.createRecords(table.id,
    [{ values: { [name]: 'Release', [start]: from, [end]: to } }]).records[0]!;
  const change = (record: RowRecord, action: RecordSchedule['action'], days: number) => service.rescheduleRecord(table.id, view.id, record.id,
    { expectedVersion: record.version, expectedViewVersion: view.version, action, days });
  return { data, store, service, table, name, start, end, view, create, change };
}

test('date scheduling preserves identity, unrelated values, history, undo and restart', t => {
  const { data, store, service, table, start, end, view, create, change } = setup(t);
  const original = create('2024-02-28', '2024-03-02');
  const moved = change(original, 'move', 1);
  assert.equal(moved.records[0]!.id, original.id);
  assert.equal(moved.records[0]!.version, original.version + 1);
  assert.deepEqual(moved.records[0]!.values, { ...original.values, [start]: '2024-02-29', [end]: '2024-03-03' });
  assert.ok(moved.batchId);
  const resizedEnd = change(moved.records[0]!, 'resizeEnd', -1).records[0]!;
  assert.equal(resizedEnd.values[end], '2024-03-02');
  const resizedStart = change(resizedEnd, 'resizeStart', 1);
  assert.equal(resizedStart.records[0]!.values[start], '2024-03-01');
  service.undoRecordBatch(table.id, resizedStart.batchId!);
  const restored = service.getRecord(table.id, original.id);
  assert.equal(restored.values[start], '2024-02-29'); assert.equal(restored.values[end], '2024-03-02');
  const point = create('2024-02-28');
  const movedPoint = change(point, 'move', 1).records[0]!;
  assert.equal(movedPoint.values[start], '2024-02-29'); assert.equal(movedPoint.values[end], null);
  assert.equal(change(movedPoint, 'resizeEnd', 1).records[0]!.values[end], '2024-03-01');
  const state = service.workspaceState({ tableId: table.id }), before = service.getRecord(table.id, original.id);
  assert.throws(() => change(before, 'resizeStart', 4), { code: 'INVALID_SCHEDULE' });
  assert.deepEqual(service.workspaceState({ tableId: table.id }), state);
  assert.deepEqual(service.getRecord(table.id, original.id), before);
  store.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getRecord(table.id, original.id), before);
  assert.deepEqual(reopened.getView(table.id, view.id), view);
  assert.ok(reopened.recordBatches(table.id, {}).batches.some(batch => batch.id === moved.batchId));
});

test('timestamp moves preserve elapsed duration through DST while resize follows local dates', t => {
  const { change, create, start, end } = setup(t, 'datetime', 'America/New_York');
  for (const [from, to, expectedStart, expectedEnd] of [
    ['2025-03-08T17:00:00.000Z', '2025-03-09T16:00:00.000Z', '2025-03-09T16:00:00.000Z', '2025-03-10T15:00:00.000Z'],
    ['2025-11-02T05:30:00.000Z', '2025-11-02T06:15:00.000Z', '2025-11-03T06:30:00.000Z', '2025-11-03T07:15:00.000Z'],
    ['2025-03-08T07:30:00.000Z', '2025-03-08T07:30:00.000Z', '2025-03-09T07:30:00.000Z', '2025-03-09T07:30:00.000Z'],
  ]) {
    const record = change(create(from!, to!), 'move', 1).records[0]!;
    assert.equal(record.values[start], expectedStart); assert.equal(record.values[end], expectedEnd);
    assert.equal(Date.parse(record.values[end] as string) - Date.parse(record.values[start] as string), Date.parse(to!) - Date.parse(from!));
  }
  const point = create('2025-03-08T17:00:00.000Z');
  const extended = change(point, 'resizeEnd', 1).records[0]!;
  assert.equal(extended.values[start], point.values[start]); assert.equal(extended.values[end], '2025-03-09T16:00:00.000Z');
  assert.throws(() => change(extended, 'resizeEnd', -2), { code: 'INVALID_SCHEDULE' });
  const apia = setup(t, 'datetime', 'Pacific/Apia'), skipped = apia.create('2011-12-29T22:00:00.000Z');
  assert.throws(() => apia.change(skipped, 'move', 1), { code: 'INVALID_SCHEDULE' });
  assert.deepEqual(apia.service.getRecord(apia.table.id, skipped.id), skipped);
});

test('scheduling rejects missing starts, invalid ranges, readonly writes and invalid requests without writes', t => {
  const { service, table, view, create, change, start, end } = setup(t);
  const missing = create(null), reversed = create('2024-03-02', '2024-02-28'), edge = create('9999-12-31');
  const before = service.workspaceState({ tableId: table.id });
  assert.throws(() => change(missing, 'move', 1), { code: 'INVALID_SCHEDULE' });
  assert.throws(() => change(reversed, 'move', 1), { code: 'INVALID_SCHEDULE' });
  assert.throws(() => change(edge, 'move', 1), { code: 'INVALID_VALUE' });
  const valid = { action: 'move', days: 1, expectedVersion: edge.version, expectedViewVersion: view.version };
  for (const input of [null, [], {}, { ...valid, days: 0 }, { ...valid, days: 0.5 }, { ...valid, days: '1' },
    { ...valid, days: Infinity }, { ...valid, days: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, action: 'copy' },
    { ...valid, expectedVersion: 0 }, { ...valid, expectedViewVersion: 0 }]) {
    assert.throws(() => service.rescheduleRecord(table.id, view.id, edge.id, input));
  }
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  assert.deepEqual(service.getRecord(table.id, edge.id), edge);
  const same = service.updateView(table.id, view.id, { expectedVersion: view.version, calendar: { startFieldId: start, endFieldId: start, timeZone: 'UTC' } });
  assert.throws(() => service.rescheduleRecord(table.id, same.id, reversed.id, { ...valid, expectedViewVersion: same.version, action: 'resizeEnd' }), { code: 'INVALID_SCHEDULE' });
  const simple = service.updateView(table.id, view.id, { expectedVersion: same.version, calendar: { startFieldId: start, timeZone: 'UTC' } });
  const moved = service.rescheduleRecord(table.id, simple.id, reversed.id, { ...valid, expectedVersion: reversed.version, expectedViewVersion: simple.version });
  assert.equal(moved.records[0]!.values[end], reversed.values[end]);

  const automatic = setup(t, 'datetime');
  const updated = automatic.service.createField(automatic.table.id, { expectedVersion: automatic.table.version, name: 'Created', type: 'createdTime' });
  const createdId = updated.fields.at(-1)!.id, record = automatic.create('2024-01-01T00:00:00.000Z');
  let readonly = automatic.service.createView(updated.id, { name: 'Automatic dates', type: 'calendar',
    calendar: { startFieldId: createdId, endFieldId: automatic.end, timeZone: 'UTC' } });
  const attempt = () => automatic.service.rescheduleRecord(updated.id, readonly.id, record.id,
    { expectedVersion: record.version, expectedViewVersion: readonly.version, action: 'move', days: 1 });
  assert.throws(attempt, { code: 'READ_ONLY_FIELD' });
  readonly = automatic.service.updateView(updated.id, readonly.id, { expectedVersion: readonly.version,
    calendar: { startFieldId: automatic.start, endFieldId: createdId, timeZone: 'UTC' } });
  assert.throws(attempt, { code: 'READ_ONLY_FIELD' });
  assert.deepEqual(automatic.service.getRecord(updated.id, record.id), record);
  readonly = automatic.service.updateView(updated.id, readonly.id, { expectedVersion: readonly.version,
    calendar: { startFieldId: createdId, endFieldId: automatic.end, timeZone: 'UTC' } });
  const extended = automatic.service.rescheduleRecord(updated.id, readonly.id, record.id,
    { expectedVersion: record.version, expectedViewVersion: readonly.version, action: 'resizeEnd', days: 1 }).records[0]!;
  assert.equal(extended.values[createdId], record.values[createdId]);
  assert.equal(Date.parse(extended.values[automatic.end] as string) - Date.parse(record.values[createdId] as string), 86_400_000);
});

test('scheduling checks record, saved view and schema versions inside the write transaction', t => {
  const { data, store, service, table, view, create, change, start } = setup(t);
  const record = create('2024-02-28', '2024-03-02');
  const moved = change(record, 'move', 1).records[0]!;
  assert.throws(() => change(record, 'move', 1), { code: 'VERSION_CONFLICT' });
  const peer = new RecordService(data.open());
  const changedView = peer.updateView(table.id, view.id, { expectedVersion: view.version, name: 'New plan' });
  const input: RecordSchedule = { expectedVersion: moved.version, expectedViewVersion: view.version, action: 'move', days: 1 };
  const state = service.workspaceState({ tableId: table.id });
  assert.throws(() => service.rescheduleRecord(table.id, view.id, moved.id, input), { code: 'VIEW_CONFLICT' });
  assert.throws(() => store.rescheduleRecord(table, view, moved.id, input), { code: 'VIEW_CONFLICT' });
  assert.deepEqual(service.workspaceState({ tableId: table.id }), state);
  assert.ok(changedView.type === 'calendar');
  peer.createField(table.id, { expectedVersion: table.version, name: 'Notes', type: 'text' });
  const afterSchema = service.getRecord(table.id, record.id);
  assert.throws(() => store.rescheduleRecord(table, changedView, moved.id, { ...input, expectedViewVersion: changedView.version }), { code: 'SCHEMA_CONFLICT' });
  assert.deepEqual(service.getRecord(table.id, record.id), afterSchema);
  const grid = service.listViews(table.id).find(view => view.type === 'grid')!;
  assert.throws(() => service.rescheduleRecord(table.id, grid.id, record.id, { ...input, expectedViewVersion: grid.version }), { code: 'INVALID_SCHEDULE' });
  peer.updateBatch([{ id: moved.id, expectedVersion: moved.version, values: { [start]: null } }], table.id);
  const currentView = service.getView(table.id, view.id);
  assert.throws(() => service.rescheduleRecord(table.id, view.id, moved.id, { ...input, expectedViewVersion: currentView.version }), { code: 'VERSION_CONFLICT' });
});

test('scheduling surfaces calculated date errors without changing source records', t => {
  const { service, table, start } = setup(t);
  let updated = service.createField(table.id, { expectedVersion: table.version, name: 'Day', type: 'number' });
  const day = updated.fields.at(-1)!.id;
  updated = service.createField(table.id, { expectedVersion: updated.version, name: 'Calculated end', type: 'formula',
    formula: { expression: 'DATE(2026, 11, [' + day + '])', resultType: 'date' } });
  const end = updated.fields.at(-1)!.id;
  const view = service.createView(table.id, { name: 'Calculated plan', type: 'calendar', calendar: { startFieldId: start, endFieldId: end, timeZone: 'UTC' } });
  const record = service.createRecords(table.id, [{ values: { [start]: '2026-11-01', [day]: 40 } }]).records[0]!;
  assert.ok(record.formulaErrors?.[end]);
  assert.throws(() => service.rescheduleRecord(table.id, view.id, record.id,
    { expectedVersion: record.version, expectedViewVersion: view.version, action: 'move', days: 1 }), { code: 'INVALID_SCHEDULE' });
  assert.deepEqual(service.getRecord(table.id, record.id), record);
});
