import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rm } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { parseCsv } from '../../core/src/csv.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Calendar views' });
  for (const field of [{ name: 'Start', type: 'date' }, { name: 'End', type: 'date' },
    { name: 'Time', type: 'datetime' }, { name: 'Status', type: 'singleSelect', options: [{ id: 'todo', name: 'To do' }] }]) {
    table = service.createField(table.id, { ...field, expectedVersion: table.version });
  }
  const [name, start, end, time, status] = table.fields.map(field => field.id) as [string, string, string, string, string];
  const calendar = { startFieldId: start, endFieldId: end, timeZone: 'Asia/Shanghai' };
  const records = service.createRecords(table.id, [
    { values: { [name]: 'C', [start]: '2026-11-01', [end]: '2026-11-03' } },
    { values: { [name]: 'A', [start]: '2026-11-02' } },
    { values: { [name]: 'B' } },
    { values: { [name]: 'Excluded', [start]: '2026-11-02' } },
  ]).records;
  return { data, store, service, table, name, start, end, time, status, calendar, records };
}

test('saved calendars share query settings, projections, bucket order, CSV and restart', t => {
  const { data, store, service, table, name, calendar, records } = setup(t);
  const view = service.createView(table.id, { name: 'Schedule', type: 'calendar', calendar,
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'neq', value: 'Excluded' }] },
      sort: [{ fieldId: name, direction: 'asc' }] },
    columns: table.fields.map(field => ({ fieldId: field.id, width: 180, hidden: field.id !== name })),
  });
  assert.equal(view.type, 'calendar'); assert.deepEqual(view.calendar, calendar);
  const input = { viewId: view.id, expectedViewVersion: view.version, from: '2026-11-01', toExclusive: '2026-11-04', fields: [name] };
  const layout = service.queryCalendar(table.id, input);
  assert.deepEqual(layout.days.map(day => day.count), [1, 2, 1]);
  assert.equal(layout.totalRecords, 3); assert.equal(layout.unscheduled.count, 1);
  assert.deepEqual(layout.days[1]!.records.map(record => record.id), [records[1]!.id, records[0]!.id]);
  assert.deepEqual(Object.keys(layout.days[1]!.records[0]!.values), [name]);
  assert.deepEqual(service.queryCalendar(table.id, { ...input, calendar }), layout);
  const page = service.queryCalendarRecords(table.id, { viewId: view.id, expectedViewVersion: view.version,
    expectedRevision: layout.revision, bucket: { kind: 'day', date: '2026-11-02' }, offset: 1, limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.records[0]!.id, records[0]!.id);
  assert.deepEqual(service.queryView(table.id, view.id, {}).records.map(record => record.id), [records[1]!.id, records[2]!.id, records[0]!.id]);
  assert.deepEqual([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].slice(1).map(row => row.cells[0]!.text), ['A', 'B', 'C']);
  assert.equal(service.queryCalendar(table.id, { ...input, search: 'A' }).totalRecords, 1);
  store.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getView(table.id, view.id), view);
  assert.deepEqual(reopened.queryCalendar(table.id, input), layout);
  const updated = reopened.updateView(table.id, view.id, { expectedVersion: view.version, calendar: { ...calendar, timeZone: 'UTC' } });
  assert.equal(updated.calendar!.timeZone, 'UTC');
  assert.throws(() => reopened.queryCalendar(table.id, input), { code: 'VIEW_CONFLICT' });
  assert.throws(() => reopened.queryCalendar(table.id, { ...input, expectedViewVersion: updated.version, calendar }), { code: 'INVALID_QUERY' });
});

test('calendar dependencies retain field identities and block incompatible schema changes atomically', t => {
  const { service, table, start, end, calendar } = setup(t);
  const view = service.createView(table.id, { name: 'Schedule', type: 'calendar', calendar });
  const renamed = service.updateField(table.id, start, { expectedVersion: table.version, name: 'Begins' });
  assert.deepEqual(service.getView(table.id, view.id).calendar, calendar);
  for (const fieldId of [start, end]) {
    assert.throws(() => service.deleteField(table.id, fieldId, { expectedVersion: renamed.version }), { code: 'VIEW_DEPENDENCY' });
    assert.throws(() => service.applyConversion(table.id, fieldId, { expectedVersion: renamed.version, field: { type: 'text' } }), { code: 'VIEW_DEPENDENCY' });
    assert.deepEqual(service.getTable(table.id), renamed);
  }
  const current = service.getView(table.id, view.id);
  service.updateView(table.id, view.id, { expectedVersion: current.version, calendar: { startFieldId: start, timeZone: 'UTC' } });
  const withoutEnd = service.deleteField(table.id, end, { expectedVersion: renamed.version });
  assert.ok(!withoutEnd.fields.some(field => field.id === end));
  assert.equal(service.queryCalendar(table.id, { viewId: view.id, from: '2026-11-01', toExclusive: '2026-11-04' }).scheduledRecords, 3);
});

test('calendar settings reject invalid input and view conversion clears irrelevant configuration', t => {
  const { service, table, name, start, time, status, calendar } = setup(t);
  const before = service.listViews(table.id);
  for (const config of [undefined, null, {}, { ...calendar, startFieldId: name }, { ...calendar, startFieldId: 'missing' },
    { ...calendar, endFieldId: time }, { ...calendar, timeZone: '' }, { ...calendar, timeZone: 'Missing/Zone' }]) {
    assert.throws(() => service.createView(table.id, { name: 'Invalid', type: 'calendar', calendar: config }), { code: 'INVALID_VIEW' });
  }
  assert.deepEqual(service.listViews(table.id), before);
  assert.throws(() => service.createView(table.id, { name: 'Invalid', type: 'calendar', calendar, groupBy: status }), { code: 'INVALID_VIEW' });
  assert.throws(() => service.createView(table.id, { name: 'Invalid', type: 'grid', calendar }), { code: 'INVALID_VIEW' });
  let view = service.createView(table.id, { name: 'Convert', type: 'board', groupBy: status });
  view = service.updateView(table.id, view.id, { expectedVersion: view.version, type: 'calendar', calendar });
  assert.equal(view.groupBy, undefined); assert.deepEqual(view.calendar, calendar);
  assert.throws(() => service.queryView(table.id, view.id, { lane: 'todo' }), { code: 'INVALID_QUERY' });
  assert.throws(() => service.queryCalendar(table.id, { viewId: view.id, calendar: { startFieldId: start, timeZone: 'UTC' },
    from: '2026-11-01', toExclusive: '2026-11-03' }), { code: 'INVALID_QUERY' });
  view = service.updateView(table.id, view.id, { expectedVersion: view.version, type: 'grid', groupBy: status });
  assert.equal(view.calendar, undefined); assert.equal(view.groupBy, status);
  assert.throws(() => service.queryCalendar(table.id, { viewId: view.id, from: '2026-11-01', toExclusive: '2026-11-03' }), { code: 'INVALID_QUERY' });
  assert.equal(service.queryCalendar(table.id, { viewId: view.id, calendar, from: '2026-11-01', toExclusive: '2026-11-03' }).scheduledRecords, 3);
});

test('format 35 preserves earlier workspaces and saved calendars survive backup and restore', async t => {
  const { data, store, service, table, calendar } = setup(t);
  const previousViews = service.listViews(table.id), previousRecords = service.queryRecords(table.id, {});
  store.close();
  const old = new DatabaseSync(data.path); old.exec('PRAGMA user_version = 34'); old.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.listViews(table.id), previousViews);
  assert.deepEqual(reopened.queryRecords(table.id, {}), previousRecords);
  const view = reopened.createView(table.id, { name: 'Backed-up schedule', type: 'calendar', calendar });
  const backup = data.path + '.backup', restored = data.path + '.restored';
  t.after(async () => { await Promise.all([backup, restored].map(path => rm(path, { force: true }))); });
  assert.equal((await backupWorkspace(data.path, backup)).version, 35);
  await restoreWorkspace(backup, restored);
  const db = new DatabaseSync(restored);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 35);
    const config = JSON.parse(db.prepare('SELECT config_json FROM views WHERE id = ?').get(view.id)!['config_json'] as string);
    assert.equal(config.type, 'calendar'); assert.deepEqual(config.calendar, calendar);
  } finally { db.close(); }
});
