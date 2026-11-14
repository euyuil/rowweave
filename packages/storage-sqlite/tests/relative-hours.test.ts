import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { maxRelativeHours, type FilterGroup } from '../../contracts/src/index.js';
import { parseCsv } from '../../core/src/csv.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { SqliteRecordStore } from '../src/record-store.js';

const relative = (fieldId: string, period: 'pastHours' | 'nextHours', hours = 2, timeZone = 'UTC'): FilterGroup => ({
  conjunction: 'and', conditions: [{ fieldId, operator: 'relativeDate', relative: { period, hours, timeZone } }],
});

test('rolling hours include both precise endpoints and use elapsed time across offset transitions', t => {
  let now = new Date();
  const service = new RecordService(fixture(t, null, () => now).open());
  for (const [instant, zone] of [
    ['2026-03-08T07:30:42.123Z', 'America/New_York'],
    ['2026-11-01T06:30:42.123Z', 'America/New_York'],
    ['2026-10-03T15:45:42.123Z', 'Australia/Lord_Howe'],
    ['2026-01-01T00:00:42.123Z', 'Asia/Kathmandu'],
  ]) {
    now = new Date(instant!);
    let table = service.createTable({ name: `${zone} ${instant}` });
    table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
    const at = table.fields[1]!.id;
    const deltas = [-7_200_001, -7_200_000, -1, 0, 1, 7_200_000, 7_200_001];
    const records = service.createRecords(table.id, [...deltas.map(delta => ({ values: { [at]: new Date(now.getTime() + delta).toISOString() } })),
      { values: { [at]: null } }]).records;
    for (const [period, indices] of [['pastHours', [1, 2, 3]], ['nextHours', [3, 4, 5]]] as const) {
      const filter = relative(at, period, 2, zone);
      const page = service.queryRecords(table.id, { filter });
      assert.deepEqual(page.records.map(row => row.id), indices.map(index => records[index]!.id));
      assert.deepEqual(service.queryRecords(table.id, { filter: relative(at, period, 2, 'UTC') }).records, page.records);
      assert.equal(service.summarizeRecords(table.id, { filter, expectedDateContext: page.dateContext }).totals.count, 3);
    }
  }
});

test('rolling settings reject date-only fields and invalid or conflicting duration units', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Validation' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Day', type: 'date' });
  const at = table.fields[1]!.id, day = table.fields[2]!.id;
  for (const hours of [undefined, null, 0, -1, 0.5, maxRelativeHours + 1, '2', Infinity]) {
    assert.throws(() => service.queryRecords(table.id, { filter: { conjunction: 'and', conditions: [
      { fieldId: at, operator: 'relativeDate', relative: { period: 'pastHours', hours, timeZone: 'UTC' } },
    ] } }), { code: 'INVALID_QUERY' });
  }
  assert.equal(service.queryRecords(table.id, { filter: relative(at, 'pastHours', maxRelativeHours) }).total, 0);
  assert.throws(() => service.queryRecords(table.id, { filter: relative(day, 'pastHours') }), { code: 'INVALID_QUERY' });
  for (const settings of [
    { period: 'pastHours', hours: 2, days: 2 }, { period: 'today', hours: 2 }, { period: 'pastDays', days: 2, hours: 2 },
  ]) assert.throws(() => service.createView(table.id, { name: 'Invalid', query: { filter: { conjunction: 'and', conditions: [
    { fieldId: at, operator: 'relativeDate', relative: { ...settings, timeZone: 'UTC' } },
  ] } } }), { code: 'INVALID_QUERY' });
});

test('rolling continuations pin exact boundaries for sixty seconds and refresh without data writes', t => {
  let now = new Date('2026-03-08T07:30:42.123Z');
  const origin = now.getTime(), service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Rolling pages' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
  const at = table.fields[1]!.id;
  const records = service.createRecords(table.id, [-7_200_000, -1, 0, 1].map(delta => ({ values: {
    [at]: new Date(origin + delta).toISOString(), [table.primaryFieldId]: String(delta),
  } }))).records;
  const view = service.createView(table.id, { name: 'Past two hours', query: { filter: relative(at, 'pastHours') }, groupBy: [at, table.primaryFieldId] });
  const first = service.queryView(table.id, view.id, { limit: 1 });
  assert.equal(first.total, 3);
  const guard = { expectedRevision: first.revision, expectedDateContext: first.dateContext };
  const request = { tableId: table.id, viewId: view.id, dateContext: first.dateContext };
  const initial = service.workspaceState(request);
  now = new Date(origin + 59_999);
  assert.deepEqual(service.workspaceState(request), initial);
  assert.deepEqual(service.queryView(table.id, view.id, { ...guard, offset: 1 }).records.map(row => row.id), records.slice(1, 3).map(row => row.id));
  assert.equal(service.queryGroups(table.id, { viewId: view.id, ...guard }).totalRecords, 3);
  assert.equal(service.summarizeRecords(table.id, { viewId: view.id, ...guard }).totals.count, 3);
  const fresh = service.queryView(table.id, view.id, {});
  assert.notEqual(fresh.dateContext, first.dateContext);
  assert.deepEqual(fresh.records.map(row => row.id), records.slice(1).map(row => row.id));
  assert.equal([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].length, 4);
  now = new Date(origin + 60_000);
  assert.throws(() => service.queryView(table.id, view.id, guard), { code: 'DATA_CHANGED' });
  assert.throws(() => service.queryGroups(table.id, { viewId: view.id, ...guard }), { code: 'DATA_CHANGED' });
  assert.throws(() => service.summarizeRecords(table.id, { viewId: view.id, ...guard }), { code: 'DATA_CHANGED' });
  const current = service.workspaceState(request);
  assert.notEqual(current.table!.view!.dateContext, first.dateContext);
  assert.equal(current.table!.dataRevision, first.revision);
  now = new Date(origin - 1);
  assert.throws(() => service.queryView(table.id, view.id, guard), { code: 'DATA_CHANGED' });
  for (const dateContext of ['', 'invalid', 'h:NaN:' + 'a'.repeat(64)]) {
    assert.throws(() => service.workspaceState({ ...request, dateContext }), { code: 'INVALID_QUERY' });
    assert.throws(() => service.queryView(table.id, view.id, { expectedDateContext: dateContext }), { code: 'INVALID_QUERY' });
  }
  assert.throws(() => service.workspaceState({ dateContext: first.dateContext }), { code: 'INVALID_QUERY' });
});

test('mixed calendar and rolling filters detect midnight even while the rolling anchor is valid', t => {
  let now = new Date('2026-12-31T23:59:50Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Calendar and hours' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
  const at = table.fields[1]!.id;
  const filter: FilterGroup = { conjunction: 'or', conditions: [relative(at, 'pastHours'), { fieldId: at,
    operator: 'relativeDate', relative: { period: 'thisYear', timeZone: 'UTC' } }] };
  const first = service.queryRecords(table.id, { filter });
  now = new Date('2027-01-01T00:00:00Z');
  assert.throws(() => service.queryRecords(table.id, { filter, expectedDateContext: first.dateContext }), { code: 'DATA_CHANGED' });
});

test('rolling timestamp lookups require one matching linked value and include service-owned creation times', t => {
  const now = new Date('2026-03-08T07:30:42.123Z'), service = new RecordService(fixture(t, null, () => now).open());
  let target = service.createTable({ name: 'Events' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'At', type: 'datetime' });
  const at = target.fields[1]!.id;
  const targets = service.createRecords(target.id, [-10_800_000, -3_600_000, 3_600_000].map(delta => ({ values: {
    [at]: new Date(now.getTime() + delta).toISOString(),
  } }))).records;
  let table = service.createTable({ name: 'Links' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Events', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Times', type: 'lookup', lookup: { relationFieldId: link, fieldId: at } });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Created', type: 'createdTime' });
  const lookup = table.fields[2]!.id, created = table.fields[3]!.id;
  const rows = service.createRecords(table.id, [[targets[0]!.id, targets[2]!.id], [targets[1]!.id], []]
    .map(ids => ({ values: { [link]: ids } }))).records;
  assert.deepEqual(service.queryRecords(table.id, { filter: relative(lookup, 'pastHours') }).records.map(row => row.id), [rows[1]!.id]);
  assert.equal(service.queryRecords(table.id, { filter: relative(created, 'pastHours', 1) }).total, 3);
});

test('format 33 preserves prior data and rolling filters survive restart, backup and schema checks', async t => {
  const now = new Date('2026-03-08T07:30:42.123Z'), data = fixture(t, null, () => now), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Hourly persistence' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
  const at = table.fields[1]!.id, row = service.createRecords(table.id, [{ values: { [at]: now.toISOString() } }]).records[0]!;
  const old = service.listViews(table.id)[0]!, history = service.recordHistory(table.id, row.id, {});
  store.close();
  const legacy = new DatabaseSync(data.path); legacy.exec('PRAGMA user_version = 32'); legacy.close();
  const upgraded = new RecordService(data.open());
  assert.deepEqual(upgraded.getView(table.id, old.id), old);
  assert.deepEqual(upgraded.getRecord(table.id, row.id), row);
  assert.deepEqual(upgraded.recordHistory(table.id, row.id, {}), history);
  const view = upgraded.createView(table.id, { name: 'Recent', query: { filter: relative(at, 'pastHours') } });
  assert.deepEqual(new RecordService(data.open()).getView(table.id, view.id), view);
  const backup = join(dirname(data.path), 'hours.sqlite'), restoredPath = join(dirname(data.path), 'hours-restored.sqlite');
  assert.equal((await backupWorkspace(data.path, backup)).version, 34);
  await restoreWorkspace(backup, restoredPath);
  const restoredStore = new SqliteRecordStore(restoredPath, null, () => now);
  try {
    const restored = new RecordService(restoredStore);
    assert.deepEqual(restored.getView(table.id, view.id), view);
    assert.equal(restored.queryView(table.id, view.id, {}).records[0]!.id, row.id);
  } finally { restoredStore.close(); }
  table = upgraded.updateField(table.id, at, { expectedVersion: table.version, name: 'Renamed time' });
  assert.deepEqual(upgraded.getView(table.id, view.id), view);
  assert.throws(() => upgraded.previewConversion(table.id, at, { expectedVersion: table.version, field: { name: 'Day', type: 'date' } }), /Update view/);
});
