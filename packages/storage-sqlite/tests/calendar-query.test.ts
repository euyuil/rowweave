import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';

function setup(t: Parameters<typeof fixture>[0], type: 'date' | 'datetime' = 'date', clock?: () => Date) {
  const data = fixture(t, null, clock), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Calendar' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Start', type });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'End', type });
  return { data, store, service, table, calendar: { startFieldId: table.fields[1]!.id, endFieldId: table.fields[2]!.id, timeZone: 'UTC' } };
}

test('calendar date buckets retain inclusive ranges, complete counts and bounded ordered previews', t => {
  const { service, table, calendar } = setup(t);
  const values = [
    ['A', '2026-11-01', null], ['B', '2026-11-01', '2026-11-03'], ['C', '2026-11-03', '2026-11-03'],
    ['D', null, '2026-11-07'], ['E', '2026-11-04', '2026-11-02'], ['F', '2026-10-01', '2026-10-02'],
    ['G', '2026-10-29', '2026-11-12'], ['H', '2026-11-02', null],
  ];
  const records = service.createRecords(table.id, values.map(([label, start, end]) => ({
    values: { [table.primaryFieldId]: label, [calendar.startFieldId]: start, [calendar.endFieldId]: end },
  }))).records;
  const byLabel = new Map(records.map(record => [record.values[table.primaryFieldId], record]));
  const before = service.workspaceState({ tableId: table.id });
  const request = { calendar, from: '2026-11-01', toExclusive: '2026-11-05', previewLimit: 2,
    sort: [{ fieldId: table.primaryFieldId, direction: 'asc' as const }], fields: [table.primaryFieldId] };
  const layout = service.queryCalendar(table.id, request);
  assert.equal(layout.totalRecords, 8); assert.equal(layout.scheduledRecords, 5);
  const expected = [['A', 'B', 'G'], ['B', 'G', 'H'], ['B', 'C', 'G'], ['G']];
  layout.days.forEach((day, index) => {
    assert.equal(day.count, expected[index]!.length);
    assert.deepEqual(day.records.map(record => record.id), expected[index]!.slice(0, 2).map(label => byLabel.get(label)!.id));
    for (let offset = 0; offset <= day.count; offset++) {
      const page = service.queryCalendarRecords(table.id, { calendar, sort: request.sort, fields: request.fields,
        bucket: { kind: 'day', date: day.date }, offset, limit: 1, expectedRevision: layout.revision });
      assert.equal(page.total, day.count);
      assert.deepEqual(page.records.map(record => record.id), expected[index]!.slice(offset, offset + 1).map(label => byLabel.get(label)!.id));
      page.records.forEach(record => assert.deepEqual(Object.keys(record.values), [table.primaryFieldId]));
    }
  });
  for (const [kind, label] of [['unscheduled', 'D'], ['invalid', 'E']] as const) {
    assert.equal(layout[kind].count, 1);
    assert.equal(layout[kind].records[0]!.id, byLabel.get(label)!.id);
    assert.equal(service.queryCalendarRecords(table.id, { calendar, bucket: { kind } }).records[0]!.id, byLabel.get(label)!.id);
  }
  const counts = service.queryCalendar(table.id, { ...request, previewLimit: 0 });
  assert.deepEqual(counts.days.map(day => day.count), [3, 3, 3, 1]);
  assert.ok([...counts.days, counts.invalid, counts.unscheduled].every(bucket => !bucket.records.length));
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  assert.deepEqual(service.queryRecords(table.id, {}).records, records);
});

test('calendar timestamps use local day boundaries, exclusive ends and point events through offset changes and skipped dates', t => {
  const { service, table, calendar } = setup(t, 'datetime');
  for (const [date, timeZone, startText, endText] of [
    ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
    ['2026-10-04', 'Australia/Lord_Howe', '2026-10-03T13:30:00.000Z', '2026-10-04T13:00:00.000Z'],
    ['2011-12-30', 'Pacific/Apia', '2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z'],
    ['2026-01-01', 'Asia/Kathmandu', '2025-12-31T18:15:00.000Z', '2026-01-01T18:15:00.000Z'],
  ]) {
    const start = Date.parse(startText!), end = Date.parse(endText!);
    const times = [null, ...new Set([start - 1, start, start + 1, end - 1, end, end + 1])];
    const values = times.flatMap(a => times.map(b => [a, b]));
    const batch = service.createRecords(table.id, values.map(([a, b]) => ({ values: {
      [calendar.startFieldId]: a === null ? null : new Date(a!).toISOString(),
      [calendar.endFieldId]: b === null ? null : new Date(b!).toISOString(),
    } }))).records;
    const expected = batch.filter((_, index) => {
      const [a, b] = values[index]!;
      return a !== null && b !== undefined && (b === null || b >= a!) && start < end &&
        (b === null || b === a ? a! >= start && a! < end : a! < end && b > start);
    });
    const filter = { conjunction: 'and', conditions: [{ fieldId: table.primaryFieldId, operator: 'isEmpty' }] };
    const request = { calendar: { ...calendar, timeZone }, bucket: { kind: 'day', date }, filter, limit: 500 };
    const page = service.queryCalendarRecords(table.id, request);
    assert.deepEqual(page.records.map(record => record.id), expected.map(record => record.id), timeZone);
    assert.equal(page.total, expected.length);
    const toExclusive = new Date(Date.parse(date! + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    const layout = service.queryCalendar(table.id, { calendar: request.calendar, from: date, toExclusive, previewLimit: 5 });
    assert.equal(layout.days[0]!.count, expected.length);
    assert.equal(layout.scheduledRecords, expected.length);
    assert.deepEqual(layout.days[0]!.records.map(record => record.id), expected.slice(0, 5).map(record => record.id));
    service.deleteRecords(table.id, batch.map(record => ({ id: record.id, expectedVersion: record.version })));
  }
});

test('calendar previews stay bounded when a thousand intervals occupy every visible day', t => {
  const { service, table, calendar } = setup(t);
  const records = service.createRecords(table.id, Array.from({ length: 1200 }, (_, index) => ({ values: {
    [table.primaryFieldId]: String(index),
    [calendar.startFieldId]: index < 1000 ? '2020-01-01' : index < 1100 ? null : '2026-12-01',
    [calendar.endFieldId]: index < 1000 ? '2030-01-01' : index < 1100 ? null : '2026-01-01',
  } }))).records;
  const layout = service.queryCalendar(table.id, { calendar, from: '2026-01-01', toExclusive: '2026-03-04', previewLimit: 5 });
  assert.equal(layout.days.length, 62);
  assert.equal(layout.totalRecords, 1200); assert.equal(layout.scheduledRecords, 1000);
  assert.equal(layout.unscheduled.count, 100); assert.equal(layout.invalid.count, 100);
  for (const day of layout.days) {
    assert.equal(day.count, 1000);
    assert.deepEqual(day.records, records.slice(0, 5));
  }
  assert.equal([...layout.days, layout.unscheduled, layout.invalid].reduce((count, bucket) => count + bucket.records.length, 0), 320);
  const last = service.queryCalendarRecords(table.id, { calendar, bucket: { kind: 'day', date: '2026-02-28' }, offset: 999, limit: 500 });
  assert.equal(last.total, 1000); assert.deepEqual(last.records, [records[999]]);
});

test('calendar queries retain saved filters, projection and view guards across edits and restart', t => {
  const { data, store, service, table, calendar } = setup(t);
  const records = service.createRecords(table.id, [
    { values: { [table.primaryFieldId]: 'keep B', [calendar.startFieldId]: '2026-11-01' } },
    { values: { [table.primaryFieldId]: 'skip', [calendar.startFieldId]: '2026-11-01' } },
    { values: { [table.primaryFieldId]: 'keep A', [calendar.startFieldId]: '2026-11-01' } },
  ]).records;
  const view = service.createView(table.id, { name: 'Keep', type: 'grid', query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: table.primaryFieldId, operator: 'contains', value: 'keep' }] },
    sort: [{ fieldId: table.primaryFieldId, direction: 'asc' }],
  } });
  const request = { calendar, viewId: view.id, expectedViewVersion: view.version, fields: [table.primaryFieldId],
    from: '2026-11-01', toExclusive: '2026-11-02' };
  const layout = service.queryCalendar(table.id, request);
  assert.equal(layout.totalRecords, 2); assert.equal(layout.viewVersion, view.version);
  assert.deepEqual(layout.days[0]!.records.map(row => row.id), [records[2]!.id, records[0]!.id]);
  assert.ok(layout.days[0]!.records.every(row => Object.keys(row.values).length === 1));
  assert.throws(() => service.queryCalendar(table.id, { ...request, filter: { conjunction: 'and', conditions: [] } }), { code: 'INVALID_QUERY' });
  assert.throws(() => service.queryCalendar(table.id, { ...request, sort: [] }), { code: 'INVALID_QUERY' });
  assert.equal(service.queryCalendar(table.id, { ...request, search: 'keep A' }).totalRecords, 1);
  store.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.queryCalendar(table.id, request), layout);
  reopened.updateBatch([{ id: records[0]!.id, expectedVersion: records[0]!.version, values: { [calendar.startFieldId]: '2026-11-02' } }], table.id);
  assert.throws(() => reopened.queryCalendarRecords(table.id, { ...request, bucket: { kind: 'day', date: '2026-11-01' },
    expectedRevision: layout.revision }), { code: 'DATA_CHANGED' });
  reopened.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Renamed view' });
  assert.throws(() => reopened.queryCalendar(table.id, request), { code: 'VIEW_CONFLICT' });
  const renamed = reopened.updateField(table.id, calendar.startFieldId, { expectedVersion: table.version, name: 'When' });
  const current = reopened.queryCalendar(table.id, { calendar, from: '2026-11-01', toExclusive: '2026-11-03' });
  assert.equal(current.schemaVersion, renamed.version); assert.equal(current.scheduledRecords, 3);
  reopened.deleteField(table.id, calendar.endFieldId, { expectedVersion: renamed.version });
  assert.throws(() => reopened.queryCalendar(table.id, { calendar, from: '2026-11-01', toExclusive: '2026-11-03' }), { code: 'INVALID_QUERY' });
});

test('calendar formula errors are invalid while automatic timestamps remain schedulable and projections retain only selected errors', t => {
  const { service, table: initial } = setup(t, 'date', () => new Date('2026-11-01T12:00:00Z'));
  let table = service.createField(initial.id, { expectedVersion: initial.version, name: 'Day', type: 'number' });
  const day = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Planned', type: 'formula',
    formula: { expression: 'DATE(2026, 11, [' + day + '])', resultType: 'date' } });
  const planned = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Created', type: 'createdTime' });
  const created = table.fields.at(-1)!.id;
  const records = service.createRecords(table.id, [1, 32, 2].map(value => ({ values: { [day]: value } }))).records;
  assert.ok(records[1]!.formulaErrors?.[planned]);
  const request = { calendar: { startFieldId: planned, timeZone: 'UTC' }, from: '2026-11-01', toExclusive: '2026-11-03' };
  const layout = service.queryCalendar(table.id, request);
  assert.equal(layout.scheduledRecords, 2); assert.equal(layout.invalid.count, 1); assert.equal(layout.unscheduled.count, 0);
  assert.equal(layout.invalid.records[0]!.id, records[1]!.id);
  assert.ok(layout.invalid.records[0]!.formulaErrors?.[planned]);
  const projected = service.queryCalendarRecords(table.id, { calendar: request.calendar, bucket: { kind: 'invalid' }, fields: [table.primaryFieldId] });
  assert.equal(projected.records[0]!.formulaErrors, undefined);
  assert.deepEqual(Object.keys(projected.records[0]!.values), [table.primaryFieldId]);
  const automatic = service.queryCalendar(table.id, { ...request, calendar: { startFieldId: created, timeZone: 'America/New_York' } });
  assert.equal(automatic.days[0]!.count, 3); assert.equal(automatic.invalid.count, 0);
});

test('calendar reads preserve linked filters and projected record details without accepting array dates as start fields', t => {
  const { service, table: initial, calendar } = setup(t);
  let target = service.createTable({ name: 'Owners' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Capacity', type: 'number' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Available', type: 'date' });
  const [low, high] = service.createRecords(target.id, [2, 8].map(value => ({ values: {
    [target.primaryFieldId]: 'Owner ' + value, [target.fields[1]!.id]: value, [target.fields[2]!.id]: '2026-11-01',
  } }))).records;
  let table = service.createField(initial.id, { expectedVersion: initial.version, name: 'Owner', type: 'relation', relation: { tableId: target.id, multiple: false } });
  const relation = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Capacity', type: 'lookup',
    lookup: { relationFieldId: relation, fieldId: target.fields[1]!.id, operation: 'sum' } });
  const capacity = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Dates', type: 'lookup',
    lookup: { relationFieldId: relation, fieldId: target.fields[2]!.id } });
  const dates = table.fields.at(-1)!.id;
  const records = service.createRecords(table.id, [low!, high!].map(owner => ({ values: {
    [calendar.startFieldId]: '2026-11-01', [relation]: [owner.id],
  } }))).records;
  const request = { calendar, from: '2026-11-01', toExclusive: '2026-11-02', fields: [relation, capacity],
    filter: { conjunction: 'and', conditions: [{ fieldId: capacity, operator: 'gt', value: 5 }] },
    sort: [{ fieldId: capacity, direction: 'desc' }] };
  const layout = service.queryCalendar(table.id, request);
  assert.equal(layout.totalRecords, 1); assert.equal(layout.days[0]!.records[0]!.id, records[1]!.id);
  assert.deepEqual(layout.days[0]!.records[0]!.values, { [relation]: [high!.id], [capacity]: 8 });
  assert.deepEqual(layout.days[0]!.records[0]!.links, { [relation]: [{ id: high!.id, label: 'Owner 8' }] });
  assert.equal(service.queryCalendarRecords(table.id, { ...request, bucket: { kind: 'day', date: '2026-11-01' } }).total, 1);
  assert.throws(() => service.queryCalendar(table.id, { ...request, calendar: { startFieldId: dates, timeZone: 'UTC' } }), { code: 'INVALID_QUERY' });
  service.updateBatch([{ id: high!.id, expectedVersion: high!.version, values: { [target.fields[1]!.id]: 1 } }], target.id);
  assert.throws(() => service.queryCalendar(table.id, { ...request, expectedRevision: layout.revision }), { code: 'DATA_CHANGED' });
  assert.equal(service.queryCalendar(table.id, request).totalRecords, 0);
});

test('calendar dates remain calendar dates and timestamp bounds handle normalized extended years', t => {
  const dates = setup(t);
  dates.service.createRecords(dates.table.id, [{ values: { [dates.calendar.startFieldId]: '2011-12-30' } }]);
  const skipped = dates.service.queryCalendar(dates.table.id, { calendar: { ...dates.calendar, timeZone: 'Pacific/Apia' },
    from: '2011-12-30', toExclusive: '2011-12-31' });
  assert.equal(skipped.days[0]!.count, 1);
  const { service, table, calendar } = setup(t, 'datetime');
  const records = service.createRecords(table.id, [
    ['0000-01-01T00:00:00+14:00', '0000-01-01T01:00:00Z'],
    ['9999-12-31T23:00:00-14:00', null],
    ['9999-12-31T22:00:00Z', '9999-12-31T23:00:00-14:00'],
  ].map(([start, end]) => ({ values: { [calendar.startFieldId]: start, [calendar.endFieldId]: end } }))).records;
  assert.match(records[0]!.values[calendar.startFieldId] as string, /^-000001/);
  assert.match(records[1]!.values[calendar.startFieldId] as string, /^\+010000/);
  assert.deepEqual(service.queryCalendar(table.id, { calendar, from: '0000-01-01', toExclusive: '0000-01-02' }).days[0]!.records, [records[0]]);
  assert.deepEqual(service.queryCalendarRecords(table.id, { calendar, bucket: { kind: 'day', date: '9999-12-31' } }).records, [records[2]]);
});

test('calendar boundary validation rejects incompatible fields, invalid windows and stale relative-date continuation', t => {
  let now = new Date('2026-11-01T12:00:00Z');
  const { service, table, calendar } = setup(t, 'date', () => now);
  const request = { calendar, from: '2026-11-01', toExclusive: '2026-11-03' };
  const mixed = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' }).fields.at(-1)!.id;
  for (const patch of [
    { calendar: null }, { calendar: { ...calendar, startFieldId: table.primaryFieldId } },
    { calendar: { ...calendar, endFieldId: mixed } }, { calendar: { ...calendar, timeZone: 'No/Such_Zone' } },
    { from: '2026-02-30' }, { toExclusive: '2026-11-01' }, { toExclusive: '2027-02-01' },
    { previewLimit: -1 }, { previewLimit: 6 }, { previewLimit: 0.5 }, { previewLimit: null },
  ]) assert.throws(() => service.queryCalendar(table.id, { ...request, ...patch }), { code: 'INVALID_QUERY' });
  for (const bucket of [null, {}, { kind: 'other' }, { kind: 'day', date: '2026-02-30' }, { kind: 'invalid', date: '2026-11-01' }]) {
    assert.throws(() => service.queryCalendarRecords(table.id, { calendar, bucket }), { code: 'INVALID_QUERY' });
  }
  assert.throws(() => service.queryCalendarRecords(table.id, { calendar, bucket: { kind: 'unscheduled' }, limit: 501 }), { code: 'INVALID_QUERY' });
  service.createRecords(table.id, [{ values: { [calendar.startFieldId]: '2026-11-01' } }]);
  const filter = { conjunction: 'and', conditions: [{ fieldId: calendar.startFieldId, operator: 'relativeDate',
    relative: { period: 'today', timeZone: 'UTC' } }] };
  const layout = service.queryCalendar(table.id, { ...request, filter });
  assert.equal(layout.scheduledRecords, 1); assert.ok(layout.dateContext);
  const page = { calendar, filter, bucket: { kind: 'day', date: '2026-11-01' },
    expectedRevision: layout.revision, expectedDateContext: layout.dateContext };
  assert.equal(service.queryCalendarRecords(table.id, page).total, 1);
  now = new Date('2026-11-02T00:00:00Z');
  assert.throws(() => service.queryCalendarRecords(table.id, page), { code: 'DATA_CHANGED' });
  assert.equal(service.queryCalendar(table.id, { ...request, filter }).scheduledRecords, 0);
});
