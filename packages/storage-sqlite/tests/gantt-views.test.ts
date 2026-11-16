import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { parseCsv } from '../../core/src/csv.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Timeline' });
  for (const field of [{ name: 'Start', type: 'date' }, { name: 'End', type: 'date' }, { name: 'At', type: 'datetime' }]) {
    table = service.createField(table.id, { ...field, expectedVersion: table.version });
  }
  const [name, start, end, time] = table.fields.map(field => field.id) as [string, string, string, string];
  const gantt = { startFieldId: start, endFieldId: end, timeZone: 'Asia/Shanghai', scale: 'day' as const };
  return { data, store, service, table, name, start, end, time, gantt };
}

test('saved Gantt settings share bounded queries, calendar reads, scheduling, CSV and restart', t => {
  const { data, store, service, table, name, start, end, gantt } = setup(t);
  const rows = service.createRecords(table.id, [
    { values: { [name]: 'Alpha', [start]: '2024-02-28', [end]: '2024-03-01' } },
    { values: { [name]: 'Beta', [start]: '2024-02-29' } }, { values: { [name]: 'Excluded', [start]: '2024-02-29' } },
  ]).records;
  let view = service.createView(table.id, { name: 'Roadmap', type: 'gantt', gantt,
    columns: table.fields.map(field => ({ fieldId: field.id, width: 180, hidden: field.id !== name })),
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'neq', value: 'Excluded' }] }, sort: [{ fieldId: name, direction: 'asc' }] } });
  assert.equal(view.type, 'gantt'); assert.deepEqual(view.gantt, gantt);
  const page = service.queryView(table.id, view.id, { offset: 1, limit: 1, expectedViewVersion: view.version });
  assert.equal(page.total, 2); assert.equal(page.records[0]!.id, rows[1]!.id); assert.deepEqual(Object.keys(page.records[0]!.values), [name]);
  assert.deepEqual([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].slice(1).map(row => row.cells[0]!.text), ['Alpha', 'Beta']);
  const layout = service.queryCalendar(table.id, { viewId: view.id, from: '2024-02-28', toExclusive: '2024-03-02' });
  assert.deepEqual(layout.days.map(day => day.count), [1, 2, 1]);
  assert.throws(() => service.queryCalendar(table.id, { viewId: view.id, calendar: { ...gantt, timeZone: 'UTC' },
    from: '2024-02-28', toExclusive: '2024-03-02' }), { code: 'INVALID_QUERY' });
  const moved = service.rescheduleRecord(table.id, view.id, rows[0]!.id,
    { expectedVersion: rows[0]!.version, expectedViewVersion: view.version, action: 'move', days: 1 });
  assert.equal(moved.records[0]!.values[start], '2024-02-29'); assert.equal(moved.records[0]!.values[end], '2024-03-02');
  const previousVersion = view.version;
  view = service.updateView(table.id, view.id, { expectedVersion: view.version, gantt: { ...gantt, scale: 'week' } });
  assert.throws(() => service.queryView(table.id, view.id, { expectedViewVersion: previousVersion }), { code: 'VIEW_CONFLICT' });
  store.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getView(table.id, view.id), view);
  assert.equal(reopened.getRecord(table.id, rows[0]!.id).values[end], '2024-03-02');
});

test('Gantt configuration validates dependencies and conversion clears obsolete settings', t => {
  const { service, table, name, start, end, time, gantt } = setup(t);
  const before = service.workspaceState({ tableId: table.id });
  for (const config of [undefined, null, {}, { ...gantt, scale: undefined }, { ...gantt, scale: 'month' },
    { ...gantt, startFieldId: name }, { ...gantt, endFieldId: time }, { ...gantt, timeZone: 'Missing/Zone' }]) {
    assert.throws(() => service.createView(table.id, { name: 'Invalid', type: 'gantt', gantt: config }), { code: 'INVALID_VIEW' });
  }
  assert.throws(() => service.createView(table.id, { name: 'Grouped timeline', type: 'gantt', gantt, groupBy: name }), { code: 'INVALID_VIEW' });
  assert.throws(() => service.createView(table.id, { name: 'Grid', type: 'grid', gantt }), { code: 'INVALID_VIEW' });
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  let view = service.createView(table.id, { name: 'Plan', type: 'gantt', gantt });
  const renamed = service.updateField(table.id, start, { expectedVersion: table.version, name: 'Begins' });
  assert.deepEqual(service.getView(table.id, view.id).gantt, gantt);
  for (const field of [start, end]) {
    assert.throws(() => service.deleteField(table.id, field, { expectedVersion: renamed.version }), { code: 'VIEW_DEPENDENCY' });
    assert.throws(() => service.applyConversion(table.id, field, { expectedVersion: renamed.version, field: { type: 'text' } }), { code: 'VIEW_DEPENDENCY' });
  }
  view = service.getView(table.id, view.id);
  view = service.updateView(table.id, view.id, { expectedVersion: view.version, type: 'calendar', calendar: { startFieldId: start, timeZone: 'UTC' } });
  assert.equal(view.gantt, undefined); assert.equal(view.type, 'calendar');
  view = service.updateView(table.id, view.id, { expectedVersion: view.version, type: 'gantt', gantt });
  assert.equal(view.calendar, undefined);
  view = service.updateView(table.id, view.id, { expectedVersion: view.version, type: 'grid' });
  assert.equal(view.gantt, undefined); assert.equal(view.calendar, undefined);
  service.deleteField(table.id, end, { expectedVersion: renamed.version });
});

test('format 36 preserves existing calendars and Gantt settings survive backup and restore', async t => {
  const { data, store, service, table, start, gantt } = setup(t);
  service.createView(table.id, { name: 'Calendar', type: 'calendar', calendar: { startFieldId: start, timeZone: 'UTC' } });
  const before = service.listViews(table.id), state = service.workspaceState({ tableId: table.id });
  store.close();
  const previous = new DatabaseSync(data.path); previous.exec('PRAGMA user_version = 35'); previous.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.listViews(table.id), before); assert.deepEqual(reopened.workspaceState({ tableId: table.id }), state);
  const view = reopened.createView(table.id, { name: 'Gantt', type: 'gantt', gantt });
  const backup = data.path + '.backup', restored = data.path + '.restored';
  assert.equal((await backupWorkspace(data.path, backup)).version, 38);
  await restoreWorkspace(backup, restored);
  const db = new DatabaseSync(restored);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 38);
    const config = JSON.parse(db.prepare('SELECT config_json FROM views WHERE id = ?').get(view.id)!['config_json'] as string);
    assert.equal(config.type, 'gantt'); assert.deepEqual(config.gantt, gantt);
  } finally { db.close(); }
});
