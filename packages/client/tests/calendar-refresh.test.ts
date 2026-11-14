import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import type { WorkspaceApi } from '../src/http-client.js';
import { calendarMonthRange, prepareCalendarSnapshot } from '../src/calendar-refresh.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Live calendar' });
  for (const field of [{ name: 'Start', type: 'date' }, { name: 'Amount', type: 'number' }, { name: 'Hidden', type: 'text' }]) {
    table = service.createField(table.id, { ...field, expectedVersion: table.version });
  }
  const [name, start, amount, hidden] = table.fields.map(field => field.id) as [string, string, string, string];
  const records = service.createRecords(table.id, Array.from({ length: 72 }, (_, i) => ({ values: {
    [name]: 'Task ' + String(i).padStart(3, '0'), [start]: i < 70 ? '2024-02-29' : null, [amount]: i, [hidden]: 'Not projected',
  } }))).records;
  const view = service.createView(table.id, { name: 'Schedule', type: 'calendar', calendar: { startFieldId: start, timeZone: 'UTC' },
    columns: table.fields.map(field => ({ fieldId: field.id, width: 180, hidden: field.id === hidden })) });
  assert.ok(view.type === 'calendar');
  const api: Pick<WorkspaceApi, 'queryCalendar' | 'queryCalendarRecords'> = {
    queryCalendar: async (id, input) => service.queryCalendar(id, input),
    queryCalendarRecords: async (id, input) => service.queryCalendarRecords(id, input),
  };
  const first = () => service.queryView(table.id, view.id, { limit: 1 });
  return { service, table, view, api, records, name, start, amount, first };
}

test('calendar month windows start on Monday and include leap dates and adjacent months', () => {
  assert.deepEqual(calendarMonthRange('2024-02'), { from: '2024-01-29', toExclusive: '2024-03-11' });
  assert.deepEqual(calendarMonthRange('2024-01'), { from: '2024-01-01', toExclusive: '2024-02-12' });
  assert.deepEqual(calendarMonthRange('2026-12'), { from: '2026-11-30', toExclusive: '2027-01-11' });
});

test('calendar snapshots bound previews and pages, project fields and clamp a removed last page', async t => {
  const { service, table, view, api, records, name, start, amount, first } = setup(t);
  const reads: unknown[] = [];
  const measured = { ...api, queryCalendarRecords: async (...args: Parameters<typeof api.queryCalendarRecords>) => {
    reads.push(args[1]); return api.queryCalendarRecords(...args);
  } };
  const window = { month: '2024-02', bucket: { kind: 'day' as const, date: '2024-02-29' }, offset: 50 };
  const snapshot = await prepareCalendarSnapshot(measured, table, view, first(), '', window, new AbortController().signal);
  assert.equal(snapshot.layout.days.length, 42);
  assert.equal(snapshot.layout.days.find(day => day.date === window.bucket.date)!.records.length, 2);
  assert.equal(snapshot.layout.unscheduled.count, 2); assert.equal(snapshot.layout.totalRecords, 72);
  assert.equal(snapshot.page!.records.length, 20); assert.equal(snapshot.page!.records[0]!.id, records[50]!.id);
  assert.deepEqual(Object.keys(snapshot.page!.records[0]!.values).sort(), [name, start, amount].sort());
  assert.equal(reads.length, 1);
  service.deleteRecords(table.id, records.slice(40, 70).map(record => ({ id: record.id, expectedVersion: record.version })));
  const next = await prepareCalendarSnapshot(measured, table, view, first(), '', window, new AbortController().signal);
  assert.equal(next.window.offset, 25); assert.equal(next.page!.records.length, 15);
  assert.equal(next.page!.records[0]!.id, records[25]!.id);
  assert.equal(snapshot.page!.records[0]!.id, records[50]!.id, 'Preparing a replacement does not mutate the displayed snapshot.');
  const empty = await prepareCalendarSnapshot(measured, table, view, first(), '', { ...window, bucket: { kind: 'invalid' } }, new AbortController().signal);
  assert.equal(empty.window.offset, 0); assert.equal(empty.page, undefined); assert.equal(reads.length, 2);
});

test('calendar snapshots reject mixed data, view and schema versions', async t => {
  const { service, table, view, api, records, name, first } = setup(t);
  const window = { month: '2024-02', bucket: { kind: 'day' as const, date: '2024-02-29' }, offset: 0 };
  const racing = { ...api, queryCalendarRecords: async (...args: Parameters<typeof api.queryCalendarRecords>) => {
    service.updateBatch([{ id: records[0]!.id, expectedVersion: records[0]!.version, values: { [name]: 'Remote edit' } }], table.id);
    return api.queryCalendarRecords(...args);
  } };
  await assert.rejects(prepareCalendarSnapshot(racing, table, view, first(), '', window, new AbortController().signal), { code: 'DATA_CHANGED' });
  const fresh = await prepareCalendarSnapshot(api, table, view, first(), '', window, new AbortController().signal);
  assert.equal(fresh.page!.records[0]!.values[name], 'Remote edit');
  const mismatched = { ...api, queryCalendar: async (...args: Parameters<typeof api.queryCalendar>) => ({ ...await api.queryCalendar(...args), schemaVersion: table.version + 1 }) };
  await assert.rejects(prepareCalendarSnapshot(mismatched, table, view, first(), '', window, new AbortController().signal), { code: 'SCHEMA_CONFLICT' });
  service.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Updated' });
  await assert.rejects(prepareCalendarSnapshot(api, table, view, first(), '', window, new AbortController().signal), { code: 'VIEW_CONFLICT' });
});

test('calendar preparation forwards cancellation to the layout and pending bucket read', async t => {
  const { table, view, api, first } = setup(t), controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = { ...api, queryCalendar: async (...args: Parameters<typeof api.queryCalendar>) => {
    assert.equal(args[2], controller.signal); return api.queryCalendar(...args);
  }, queryCalendarRecords: async (...args: Parameters<typeof api.queryCalendarRecords>) => {
    assert.equal(args[2], controller.signal);
    return new Promise<Awaited<ReturnType<typeof api.queryCalendarRecords>>>((_resolve, reject) => {
      args[2]!.addEventListener('abort', () => reject(args[2]!.reason), { once: true }); started();
    });
  } };
  const rejected = assert.rejects(prepareCalendarSnapshot(held, table, view, first(), '',
    { month: '2024-02', bucket: { kind: 'unscheduled' }, offset: 0 }, controller.signal), { name: 'AbortError' });
  await ready; controller.abort(); await rejected;
});

test('calendar snapshots reject expired relative-date context and show the next day without a write', async t => {
  let now = new Date('2024-02-29T12:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Today' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  const due = table.fields[1]!.id;
  const records = service.createRecords(table.id, ['2024-02-29', '2024-03-01'].map(date => ({ values: { [due]: date } }))).records;
  const view = service.createView(table.id, { name: 'Today', type: 'calendar', calendar: { startFieldId: due, timeZone: 'UTC' },
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: due, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } }] } } });
  assert.ok(view.type === 'calendar');
  const api: Pick<WorkspaceApi, 'queryCalendar' | 'queryCalendarRecords'> = {
    queryCalendar: async (id, input) => service.queryCalendar(id, input), queryCalendarRecords: async (id, input) => service.queryCalendarRecords(id, input),
  };
  const first = service.queryView(table.id, view.id, { limit: 1 }), window = { month: '2024-02', offset: 0 };
  const before = await prepareCalendarSnapshot(api, table, view, first, '', window, new AbortController().signal);
  assert.equal(before.layout.days.flatMap(day => day.records)[0]!.id, records[0]!.id);
  now = new Date('2024-03-01T00:00:00Z');
  await assert.rejects(prepareCalendarSnapshot(api, table, view, first, '', window, new AbortController().signal), { code: 'DATA_CHANGED' });
  const next = await prepareCalendarSnapshot(api, table, view, service.queryView(table.id, view.id, { limit: 1 }), '', window, new AbortController().signal);
  assert.equal(next.layout.revision, before.layout.revision); assert.notEqual(next.layout.dateContext, before.layout.dateContext);
  assert.equal(next.layout.days.flatMap(day => day.records)[0]!.id, records[1]!.id);
});
