import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { parseCsv } from '../../core/src/csv.js';
import type { FilterGroup, RelativeDateFilter } from '../../contracts/src/index.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { dirname, join } from 'node:path';

const relative = (fieldId: string, period: RelativeDateFilter['period'], timeZone = 'UTC'): FilterGroup => ({
  conjunction: 'and', conditions: [{ fieldId, operator: 'relativeDate', relative: { period, timeZone } }],
});

test('relative years include complete leap years and use the chosen local calendar year', t => {
  let now = new Date('2024-06-15T12:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Annual dates' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  const due = table.fields[1]!.id;
  const dates = ['2023-01-01', '2023-12-31', '2024-01-01', '2024-02-29', '2024-12-31', '2025-01-01', '2025-12-31', '2026-01-01', null];
  service.createRecords(table.id, dates.map(value => ({ values: { [due]: value } })));
  const values = (period: RelativeDateFilter['period'], zone = 'UTC') => service.queryRecords(table.id, { filter: relative(due, period, zone) })
    .records.map(row => row.values[due]);
  assert.deepEqual(values('lastYear'), dates.slice(0, 2));
  assert.deepEqual(values('thisYear'), dates.slice(2, 5));
  assert.deepEqual(values('nextYear'), dates.slice(5, 7));
  now = new Date('2024-12-31T12:00:00Z');
  assert.deepEqual(values('thisYear', 'Pacific/Kiritimati'), dates.slice(5, 7));
  assert.deepEqual(values('thisYear', 'Pacific/Honolulu'), dates.slice(2, 5));
  assert.deepEqual(values('lastYear', 'Pacific/Kiritimati'), dates.slice(2, 5));
  for (const period of ['thisYear', 'lastYear', 'nextYear']) assert.throws(() => service.queryRecords(table.id, {
    filter: { conjunction: 'and', conditions: [{ fieldId: due, operator: 'relativeDate', relative: { period, timeZone: 'UTC', days: 1 } }] },
  }), { code: 'INVALID_QUERY' });
});

test('timestamp year ranges include their first instant and exclude the following year in named zones', t => {
  let now = new Date();
  const service = new RecordService(fixture(t, null, () => now).open());
  for (const [instant, zone, period, start, end] of [
    ['2024-07-01T12:00:00Z', 'America/New_York', 'thisYear', '2024-01-01T05:00:00Z', '2025-01-01T05:00:00Z'],
    ['2025-07-01T12:00:00Z', 'Asia/Kathmandu', 'lastYear', '2023-12-31T18:15:00Z', '2024-12-31T18:15:00Z'],
    ['2023-12-01T12:00:00Z', 'Australia/Lord_Howe', 'nextYear', '2023-12-31T13:00:00Z', '2024-12-31T13:00:00Z'],
  ] as const) {
    now = new Date(instant);
    let table = service.createTable({ name: zone });
    table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
    const at = table.fields[1]!.id;
    const records = service.createRecords(table.id, [Date.parse(start) - 1, Date.parse(start), Date.parse(end) - 1, Date.parse(end), null]
      .map(value => ({ values: { [at]: value === null ? null : new Date(value).toISOString() } }))).records;
    const filter = relative(at, period, zone);
    assert.deepEqual(service.queryRecords(table.id, { filter }).records.map(row => row.id), [records[1]!.id, records[2]!.id]);
    assert.equal(service.summarizeRecords(table.id, { filter }).totals.count, 2);
  }
});

test('saved year filters share context across views, grouping, CSV and year-boundary state changes', t => {
  let now = new Date('2024-07-01T12:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Annual work' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
  const due = table.fields[1]!.id, at = table.fields[2]!.id;
  const records = service.createRecords(table.id, ['2024-01-01', '2024-02-29', '2024-12-31', '2025-01-01'].map(value => ({ values: {
    [table.primaryFieldId]: value, [due]: value, [at]: `${value}T12:00:00Z`,
  } }))).records;
  const view = service.createView(table.id, { name: 'This year', groupBy: [due, table.primaryFieldId], query: { filter: relative(due, 'thisYear') } });
  const first = service.queryView(table.id, view.id, { limit: 1 }), state = service.workspaceState({ tableId: table.id, viewId: view.id });
  assert.equal(first.total, 3);
  assert.equal(state.table!.view!.dateContext, first.dateContext);
  const guard = { expectedRevision: first.revision, expectedDateContext: first.dateContext };
  now = new Date('2024-12-31T23:59:59.999Z');
  assert.deepEqual(service.workspaceState({ tableId: table.id, viewId: view.id }), state);
  assert.equal(service.queryView(table.id, view.id, { ...guard, offset: 1, limit: 1 }).records[0]!.id, records[1]!.id);
  assert.equal(service.queryGroups(table.id, { viewId: view.id, ...guard }).totalRecords, 3);
  assert.equal(service.summarizeRecords(table.id, { viewId: view.id, ...guard }).totals.count, 3);
  assert.equal([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].length, 4);
  now = new Date('2025-01-01T00:00:00Z');
  assert.throws(() => service.queryView(table.id, view.id, guard), { code: 'DATA_CHANGED' });
  assert.throws(() => service.queryGroups(table.id, { viewId: view.id, ...guard }), { code: 'DATA_CHANGED' });
  assert.throws(() => service.summarizeRecords(table.id, { viewId: view.id, ...guard }), { code: 'DATA_CHANGED' });
  const after = service.workspaceState({ tableId: table.id, viewId: view.id });
  assert.notEqual(after.table!.view!.dateContext, first.dateContext);
  assert.deepEqual({ ...after.table!.view!, dateContext: first.dateContext }, state.table!.view);
  assert.equal(after.table!.dataRevision, state.table!.dataRevision);
  assert.deepEqual(service.queryView(table.id, view.id, {}).records.map(row => row.id), [records[3]!.id]);
  assert.equal([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].length, 2);
});

test('format 32 preserves prior views and year rules survive restart, backup and schema changes', async t => {
  const now = new Date('2024-07-01T00:00:00Z'), data = fixture(t, null, () => now), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Annual persistence' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  const due = table.fields[1]!.id, row = service.createRecords(table.id, [{ values: { [due]: '2024-02-29' } }]).records[0]!;
  const old = service.createView(table.id, { name: 'Existing month', query: { filter: relative(due, 'thisMonth') } });
  const before = service.workspaceState({ tableId: table.id, viewId: old.id }), history = service.recordHistory(table.id, row.id, {});
  store.close();
  const legacy = new DatabaseSync(data.path); legacy.exec('PRAGMA user_version = 31'); legacy.close();
  const upgraded = new RecordService(data.open());
  assert.deepEqual(upgraded.getView(table.id, old.id), old);
  assert.deepEqual(upgraded.getRecord(table.id, row.id), row);
  assert.deepEqual(upgraded.workspaceState({ tableId: table.id, viewId: old.id }), before);
  assert.deepEqual(upgraded.recordHistory(table.id, row.id, {}), history);
  const view = upgraded.createView(table.id, { name: 'This year', query: { filter: relative(due, 'thisYear') } });
  assert.deepEqual(new RecordService(data.open()).getView(table.id, view.id), view);
  const backup = join(dirname(data.path), 'years.sqlite'), restoredPath = join(dirname(data.path), 'years-restored.sqlite');
  assert.equal((await backupWorkspace(data.path, backup)).version, 34);
  await restoreWorkspace(backup, restoredPath);
  const restoredStore = new SqliteRecordStore(restoredPath, null, () => now);
  try {
    const restored = new RecordService(restoredStore);
    assert.deepEqual(restored.getView(table.id, view.id), view);
    assert.equal(restored.queryView(table.id, view.id, {}).records[0]!.id, row.id);
  } finally { restoredStore.close(); }
  table = upgraded.updateField(table.id, due, { expectedVersion: table.version, name: 'Renamed date' });
  assert.deepEqual(upgraded.getView(table.id, view.id), view);
  assert.throws(() => upgraded.previewConversion(table.id, due, { expectedVersion: table.version, field: { name: 'Text', type: 'text' } }), /Update view/);
});
