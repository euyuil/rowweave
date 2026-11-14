import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { maxRelativeDays, type FilterGroup } from '../../contracts/src/index.js';
import { parseCsv } from '../../core/src/csv.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { SqliteRecordStore } from '../src/record-store.js';

const relative = (fieldId: string, period: 'pastBusinessDays' | 'nextBusinessDays', days = 5, timeZone = 'UTC'): FilterGroup => ({
  conjunction: 'and', conditions: [{ fieldId, operator: 'relativeDate', relative: { period, days, timeZone } }],
});

function weekdays(day: string, count: number, direction: -1 | 1): string[] {
  const dates: string[] = [], cursor = new Date(day + 'T12:00:00Z');
  while (dates.length < count) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + direction);
  }
  return dates.sort();
}

test('business dates count weekdays across weekends, leap days and years while retaining public holidays', t => {
  let now = new Date();
  const service = new RecordService(fixture(t, null, () => now).open());
  for (const first of ['2024-02-25', '2026-12-25']) {
    let table = service.createTable({ name: first });
    table = service.createField(table.id, { expectedVersion: table.version, name: 'Day', type: 'date' });
    const day = table.fields[1]!.id, base = Date.parse(first + 'T12:00:00Z');
    const dates = Array.from({ length: 50 }, (_, index) => new Date(base + (index - 20) * 86_400_000).toISOString().slice(0, 10));
    service.createRecords(table.id, dates.map(date => ({ values: { [day]: date } })));
    for (let offset = 0; offset < 14; offset++) {
      now = new Date(base + offset * 86_400_000);
      for (const count of [1, 2, 5, 6, 10]) for (const [period, direction] of [['pastBusinessDays', -1], ['nextBusinessDays', 1]] as const) {
        assert.deepEqual(service.queryRecords(table.id, { filter: relative(day, period, count) }).records.map(row => row.values[day]),
          weekdays(now.toISOString().slice(0, 10), count, direction), `${first} offset ${offset} ${period} ${count}`);
      }
    }
  }
});

test('business timestamp queries match local weekdays through DST, skipped dates and historical offsets', t => {
  let now = new Date();
  const service = new RecordService(fixture(t, null, () => now).open());
  for (const [instant, zone, boundaries] of [
    ['2026-03-06T12:00:00Z', 'America/New_York', ['2026-03-06T05:00:00Z', '2026-03-09T04:00:00Z', '2026-03-13T04:00:00Z']],
    ['2026-10-30T12:00:00Z', 'America/New_York', ['2026-10-30T04:00:00Z', '2026-11-02T05:00:00Z', '2026-11-06T05:00:00Z']],
    ['2026-10-02T12:00:00Z', 'Australia/Lord_Howe', ['2026-10-01T13:30:00Z', '2026-10-04T13:00:00Z']],
    ['2026-01-02T12:00:00Z', 'Asia/Kathmandu', ['2026-01-01T18:15:00Z', '2026-01-08T18:15:00Z']],
    ['2011-12-30T12:00:00Z', 'Pacific/Apia', ['2011-12-30T10:00:00Z', '2012-01-01T10:00:00Z']],
    ['2015-10-16T12:00:00Z', 'America/Sao_Paulo', ['2015-10-16T03:00:00Z', '2015-10-19T02:00:00Z']],
    ['1900-01-01T12:00:00Z', 'Europe/Paris', ['1899-12-31T23:50:39Z', '1900-01-05T23:50:39Z']],
  ] as const) {
    now = new Date(instant);
    let table = service.createTable({ name: `${zone} ${instant}` });
    table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
    const at = table.fields[1]!.id;
    const values = new Set(Array.from({ length: 481 }, (_, i) => new Date(now.getTime() + (i - 240) * 3_600_000).toISOString()));
    for (const boundary of boundaries) for (const delta of [-1, 0, 1]) values.add(new Date(Date.parse(boundary) + delta).toISOString());
    const rows = service.createRecords(table.id, [...values].sort().map(value => ({ values: { [at]: value } }))).records;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDate = (value: string) => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
      return `${parts['year']}-${parts['month']}-${parts['day']}`;
    };
    for (const count of [1, 5]) for (const [period, direction] of [['pastBusinessDays', -1], ['nextBusinessDays', 1]] as const) {
      const dates = new Set(weekdays(localDate(instant), count, direction));
      const expected = rows.filter(row => dates.has(localDate(row.values[at] as string))).map(row => row.id);
      const filter = relative(at, period, count, zone), actual = service.queryRecords(table.id, { filter, limit: 500 });
      assert.deepEqual(actual.records.map(row => row.id), expected, `${zone} ${period}`);
      assert.equal(service.summarizeRecords(table.id, { filter, expectedDateContext: actual.dateContext }).totals.count, expected.length);
    }
  }
});

test('business-day contexts remain stable over unchanged weekends and guard nested pages, summaries and CSV', t => {
  let now = new Date('2026-11-13T12:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Business contexts' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Day', type: 'date' });
  const day = table.fields[1]!.id;
  const rows = service.createRecords(table.id, Array.from({ length: 22 }, (_, i) => {
    const date = new Date(Date.parse('2026-11-06T12:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
    return { values: { [day]: date, [table.primaryFieldId]: date } };
  })).records;
  const past = service.createView(table.id, { name: 'Past workdays', query: { filter: relative(day, 'pastBusinessDays') }, groupBy: [day, table.primaryFieldId] });
  const future = service.createView(table.id, { name: 'Next workdays', query: { filter: relative(day, 'nextBusinessDays') } });
  const first = service.queryView(table.id, past.id, { limit: 1 }), next = service.queryView(table.id, future.id, {});
  const guard = { expectedRevision: first.revision, expectedDateContext: first.dateContext }, stateRequest = { tableId: table.id, viewId: past.id };
  const state = service.workspaceState(stateRequest);
  assert.equal(first.total, 5);
  now = new Date('2026-11-14T12:00:00Z');
  assert.deepEqual(service.workspaceState(stateRequest), state);
  assert.throws(() => service.queryView(table.id, future.id, { expectedDateContext: next.dateContext }), { code: 'DATA_CHANGED' });
  const weekendNext = service.queryView(table.id, future.id, {});
  now = new Date('2026-11-15T12:00:00Z');
  assert.deepEqual(service.workspaceState(stateRequest), state);
  assert.equal(service.queryView(table.id, future.id, { expectedDateContext: weekendNext.dateContext }).dateContext, weekendNext.dateContext);
  assert.deepEqual(service.queryView(table.id, past.id, { ...guard, offset: 1 }).records.map(row => row.values[day]), ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  assert.equal(service.queryGroups(table.id, { viewId: past.id, ...guard }).totalRecords, 5);
  assert.equal(service.summarizeRecords(table.id, { viewId: past.id, ...guard }).totals.count, 5);
  assert.equal([...parseCsv(service.exportCsv(table.id, { viewId: past.id }))].length, 6);
  now = new Date('2026-11-16T00:00:00Z');
  assert.throws(() => service.queryView(table.id, past.id, guard), { code: 'DATA_CHANGED' });
  assert.throws(() => service.queryGroups(table.id, { viewId: past.id, ...guard }), { code: 'DATA_CHANGED' });
  assert.throws(() => service.summarizeRecords(table.id, { viewId: past.id, ...guard }), { code: 'DATA_CHANGED' });
  const current = service.queryView(table.id, past.id, {});
  assert.deepEqual(current.records.map(row => row.id), rows.filter(row => ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'].includes(row.values[day] as string)).map(row => row.id));
  assert.equal(current.revision, first.revision);
  assert.equal(service.queryView(table.id, future.id, { expectedDateContext: weekendNext.dateContext }).dateContext, weekendNext.dateContext);
});

test('business filters validate bounded whole-day counts and match one complete linked weekday', t => {
  const now = new Date('2026-11-16T12:00:00Z'), service = new RecordService(fixture(t, null, () => now).open());
  let target = service.createTable({ name: 'Events' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'At', type: 'datetime' });
  const at = target.fields[1]!.id;
  for (const period of ['pastBusinessDays', 'nextBusinessDays']) for (const days of [undefined, 0, -1, 1.2, maxRelativeDays + 1, '5']) {
    assert.throws(() => service.queryRecords(target.id, { filter: { conjunction: 'and', conditions: [
      { fieldId: at, operator: 'relativeDate', relative: { period, days, timeZone: 'UTC' } },
    ] } }), { code: 'INVALID_QUERY' });
  }
  assert.equal(service.queryRecords(target.id, { filter: relative(at, 'pastBusinessDays', maxRelativeDays) }).total, 0);
  assert.throws(() => service.queryRecords(target.id, { filter: { conjunction: 'and', conditions: [
    { fieldId: at, operator: 'relativeDate', relative: { period: 'pastBusinessDays', days: 5, hours: 2, timeZone: 'UTC' } },
  ] } }), { code: 'INVALID_QUERY' });
  const targets = service.createRecords(target.id, ['2026-11-09', '2026-11-14', '2026-11-12'].map(day => ({ values: { [at]: day + 'T12:00:00Z' } }))).records;
  let source = service.createTable({ name: 'Linked work' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Events', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = source.fields[1]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Times', type: 'lookup', lookup: { relationFieldId: link, fieldId: at } });
  const lookup = source.fields[2]!.id;
  const rows = service.createRecords(source.id, [[targets[0]!.id, targets[1]!.id], [targets[2]!.id], []].map(ids => ({ values: { [link]: ids } }))).records;
  assert.deepEqual(service.queryRecords(source.id, { filter: relative(lookup, 'pastBusinessDays') }).records.map(row => row.id), [rows[1]!.id]);
});

test('the maximum business-day window includes its first and last weekday and excludes adjacent dates', t => {
  const now = new Date('2026-11-16T12:00:00Z'), service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Long working range' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Day', type: 'date' });
  const day = table.fields[1]!.id;
  for (const [period, direction] of [['pastBusinessDays', -1], ['nextBusinessDays', 1]] as const) {
    const dates = weekdays('2026-11-16', maxRelativeDays, direction), first = dates[0]!, last = dates.at(-1)!;
    const before = new Date(Date.parse(first + 'T12:00:00Z') - 86_400_000).toISOString().slice(0, 10);
    const after = new Date(Date.parse(last + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    const rows = service.createRecords(table.id, [before, first, last, after].map(value => ({ values: { [day]: value } }))).records;
    assert.deepEqual(service.queryRecords(table.id, { recordIds: rows.map(row => row.id), filter: relative(day, period, maxRelativeDays) }).records.map(row => row.id), [rows[1]!.id, rows[2]!.id]);
  }
});

test('format 34 preserves prior views and business-day settings survive restart, backup and schema changes', async t => {
  const now = new Date('2026-11-16T12:00:00Z'), data = fixture(t, null, () => now), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Workday persistence' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Day', type: 'date' });
  const day = table.fields[1]!.id, row = service.createRecords(table.id, [{ values: { [day]: '2026-11-16' } }]).records[0]!;
  const old = service.listViews(table.id)[0]!, history = service.recordHistory(table.id, row.id, {});
  store.close();
  const legacy = new DatabaseSync(data.path); legacy.exec('PRAGMA user_version = 33'); legacy.close();
  const upgraded = new RecordService(data.open());
  assert.deepEqual(upgraded.getView(table.id, old.id), old);
  assert.deepEqual(upgraded.getRecord(table.id, row.id), row);
  assert.deepEqual(upgraded.recordHistory(table.id, row.id, {}), history);
  const view = upgraded.createView(table.id, { name: 'Workdays', query: { filter: relative(day, 'pastBusinessDays') } });
  assert.deepEqual(new RecordService(data.open()).getView(table.id, view.id), view);
  const backup = join(dirname(data.path), 'business.sqlite'), restoredPath = join(dirname(data.path), 'business-restored.sqlite');
  assert.equal((await backupWorkspace(data.path, backup)).version, 35);
  await restoreWorkspace(backup, restoredPath);
  const restoredStore = new SqliteRecordStore(restoredPath, null, () => now);
  try {
    const restored = new RecordService(restoredStore);
    assert.deepEqual(restored.getView(table.id, view.id), view);
    assert.equal(restored.queryView(table.id, view.id, {}).records[0]!.id, row.id);
  } finally { restoredStore.close(); }
  table = upgraded.updateField(table.id, day, { expectedVersion: table.version, name: 'Renamed day' });
  assert.deepEqual(upgraded.getView(table.id, view.id), view);
  assert.throws(() => upgraded.previewConversion(table.id, day, { expectedVersion: table.version, field: { name: 'Text', type: 'text' } }), /Update view/);
});
