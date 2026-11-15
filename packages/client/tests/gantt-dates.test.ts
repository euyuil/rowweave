import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { ganttActions, ganttBar, ganttInterval, ganttRange, ganttStart } from '../src/gantt-dates.js';
import type { GanttConfig, RowRecord } from '../../contracts/src/index.js';

test('timeline geometry bounds day/week windows and preserves inclusive dates and exceptional records', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Dates' });
  for (const name of ['Start', 'End']) table = service.createField(table.id, { expectedVersion: table.version, name, type: 'date' });
  const start = table.fields[1]!.id, end = table.fields[2]!.id;
  const config: GanttConfig = { startFieldId: start, endFieldId: end, timeZone: 'UTC', scale: 'day' };
  const record = (from: string | null, to: string | null): RowRecord => ({ id: 'record', version: 1, values: { [start]: from, [end]: to } });
  const range = ganttRange('2024-02-28', 'day');
  const span = ganttInterval(table, config, record('2024-02-27', '2024-02-29')); assert.ok(span.kind === 'scheduled');
  assert.equal(range.dayCount, 42);
  assert.deepEqual(ganttBar(range, span), { kind: 'visible', left: 0, width: 80, clippedStart: true, clippedEnd: false });
  assert.deepEqual(ganttBar(range, { kind: 'scheduled', from: '2024-02-26', to: '2024-02-27', point: false }), { kind: 'before' });
  assert.deepEqual(ganttBar(range, { kind: 'scheduled', from: '2024-04-10', to: '2024-04-10', point: false }), { kind: 'after' });
  assert.deepEqual(ganttInterval(table, config, record(null, null)), { kind: 'unscheduled' });
  assert.deepEqual(ganttInterval(table, config, record('2024-02-29', '2024-02-28')), { kind: 'invalid' });
  assert.deepEqual(ganttInterval(table, config, { ...record(null, null), formulaErrors: { [start]: 'Invalid date' } }), { kind: 'invalid' });
  assert.equal(ganttRange(ganttStart('9999-12-31', 'week'), 'week').dayCount, 168);
  assert.equal(ganttStart('0001-01-01', 'day', -1), '0001-01-01');
});

test('timeline timestamps retain half-open boundaries, DST folds, points and readonly capabilities', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Times' });
  for (const field of [{ name: 'Start', type: 'datetime' }, { name: 'End', type: 'datetime' }, { name: 'Created', type: 'createdTime' }]) {
    table = service.createField(table.id, { ...field, expectedVersion: table.version });
  }
  const start = table.fields[1]!.id, end = table.fields[2]!.id, created = table.fields[3]!.id;
  const config: GanttConfig = { startFieldId: start, endFieldId: end, timeZone: 'UTC', scale: 'day' };
  const record = (from: string, to: string | null): RowRecord => ({ id: 'record', version: 1, values: { [start]: from, [end]: to, [created]: from } });
  assert.deepEqual(ganttInterval(table, config, record('2024-02-28T18:00:00.000Z', '2024-03-01T00:00:00.000Z')),
    { kind: 'scheduled', from: '2024-02-28', to: '2024-02-29', point: false });
  assert.deepEqual(ganttInterval(table, { ...config, timeZone: 'America/New_York' }, record('2025-11-02T05:30:00.000Z', '2025-11-02T06:15:00.000Z')),
    { kind: 'scheduled', from: '2025-11-02', to: '2025-11-02', point: false });
  const point = record('2024-02-28T18:00:00.000Z', null);
  assert.deepEqual(ganttInterval(table, config, point), { kind: 'scheduled', from: '2024-02-28', to: '2024-02-28', point: true });
  assert.deepEqual(ganttActions(table, { ...config, startFieldId: created }, point), { move: false, resizeStart: false, resizeEnd: true });
  assert.deepEqual(ganttActions(table, { ...config, endFieldId: created }, point), { move: false, resizeStart: true, resizeEnd: false });
  assert.deepEqual(ganttActions(table, { ...config, endFieldId: start }, point), { move: true, resizeStart: false, resizeEnd: false });
});
