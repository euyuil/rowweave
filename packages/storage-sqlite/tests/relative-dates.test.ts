import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import type { FilterGroup, RelativeDateFilter } from '../../contracts/src/index.js';
import { parseCsv } from '../../core/src/csv.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient, ApiFailure } from '../../client/src/http-client.js';
import { TableModel } from '../../client/src/table-model.js';

const relative = (fieldId: string, period: RelativeDateFilter['period'], timeZone = 'UTC', days?: number): FilterGroup => ({
  conjunction: 'and', conditions: [{ fieldId, operator: 'relativeDate', relative: { period, timeZone, ...(days === undefined ? {} : { days }) } }],
});

test('timestamp periods include their first instant and exclude the next calendar boundary across offset transitions', t => {
  const cases = [
    ['2026-03-08T16:00:00Z', 'America/New_York', 'today', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01T16:00:00Z', 'America/New_York', 'today', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
    ['2026-10-04T12:00:00Z', 'Australia/Lord_Howe', 'today', '2026-10-03T13:30:00Z', '2026-10-04T13:00:00Z'],
    ['2026-01-01T08:00:00Z', 'Asia/Kathmandu', 'today', '2025-12-31T18:15:00Z', '2026-01-01T18:15:00Z'],
    ['2015-10-18T16:00:00Z', 'America/Sao_Paulo', 'today', '2015-10-18T03:00:00Z', '2015-10-19T02:00:00Z'],
    ['2010-11-07T16:00:00Z', 'America/St_Johns', 'today', '2010-11-07T02:30:00Z', '2010-11-08T03:30:00Z'],
    ['2011-12-30T18:00:00Z', 'Pacific/Apia', 'today', '2011-12-30T10:00:00Z', '2011-12-31T10:00:00Z'],
    ['2026-01-01T12:00:00Z', 'UTC', 'thisWeek', '2025-12-29T00:00:00Z', '2026-01-05T00:00:00Z'],
    ['2024-03-15T12:00:00Z', 'UTC', 'lastMonth', '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'],
  ] as const;
  let now = new Date();
  const service = new RecordService(fixture(t, null, () => now).open());
  for (const [instant, zone, period, start, end] of cases) {
    now = new Date(instant);
    let table = service.createTable({ name: `${zone} ${period}` });
    table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
    const fieldId = table.fields[1]!.id;
    const records = service.createRecords(table.id, [Date.parse(start) - 1, Date.parse(start), Date.parse(end) - 1, Date.parse(end), null]
      .map(value => ({ values: { [fieldId]: value === null ? null : new Date(value).toISOString() } }))).records;
    const query = { filter: relative(fieldId, period, zone) };
    const page = service.queryRecords(table.id, query);
    assert.deepEqual(page.records.map(record => record.id), [records[1]!.id, records[2]!.id], `${zone} ${period}`);
    assert.equal(service.summarizeRecords(table.id, query).totals.count, 2);
    const view = service.createView(table.id, { name: 'Relative', query });
    assert.equal([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].length, 3);
    assert.match(page.dateContext!, /^[a-f0-9]{64}$/);
  }
});

test('date-only periods use the selected zone, calendar weeks and inclusive day counts without persisting fixed dates', t => {
  let now = new Date('2026-01-04T23:30:00Z');
  const data = fixture(t, null, () => now), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Schedule' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  const due = table.fields[1]!.id;
  const dates = ['2025-12-28', '2025-12-29', '2025-12-31', '2026-01-01', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-11', '2026-01-12', '2026-02-01', null];
  service.createRecords(table.id, dates.map(value => ({ values: { [due]: value } })));
  const values = (period: RelativeDateFilter['period'], zone = 'UTC', days?: number) => service.queryRecords(table.id, {
    filter: relative(due, period, zone, days),
  }).records.map(record => record.values[due]);
  assert.deepEqual(values('today'), ['2026-01-04']);
  assert.deepEqual(values('today', 'Asia/Shanghai'), ['2026-01-05']);
  assert.deepEqual(values('yesterday'), ['2026-01-03']);
  assert.deepEqual(values('tomorrow'), ['2026-01-05']);
  assert.deepEqual(values('pastDays', 'UTC', 2), ['2026-01-03', '2026-01-04']);
  assert.deepEqual(values('nextDays', 'UTC', 2), ['2026-01-04', '2026-01-05']);
  assert.deepEqual(values('lastWeek'), ['2025-12-28']);
  assert.deepEqual(values('thisWeek'), dates.slice(1, 6));
  assert.deepEqual(values('nextWeek'), dates.slice(6, 9));
  assert.deepEqual(values('thisMonth'), dates.slice(3, 10));
  assert.deepEqual(values('nextMonth'), ['2026-02-01']);
  const filter: FilterGroup = { conjunction: 'or', conditions: [relative(due, 'today'), { fieldId: due, operator: 'isEmpty' }] };
  const view = service.createView(table.id, { name: 'Today or unscheduled', query: { filter, sort: [{ fieldId: due, direction: 'asc' }] } });
  assert.deepEqual(service.queryView(table.id, view.id, {}).records.map(record => record.values[due]), ['2026-01-04', null]);
  const db = new DatabaseSync(data.path);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'index' AND name LIKE 'rowweave_view_%'").get()!['n'], 0);
  db.exec('DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; PRAGMA user_version = 14;'); db.close();
  const versions = service.getTable(table.id);
  store.close();
  now = new Date('2026-01-05T00:00:00Z');
  const restarted = new RecordService(data.open());
  assert.deepEqual(restarted.getTable(table.id), versions);
  assert.deepEqual(restarted.getView(table.id, view.id), view);
  assert.deepEqual(restarted.queryView(table.id, view.id, {}).records.map(record => record.values[due]), ['2026-01-05', null]);
  assert.throws(() => restarted.previewConversion(table.id, due, { expectedVersion: table.version, field: { name: 'Due', type: 'text' } }), /Update view/);
});

test('HTTP paging, editing batches, grouped summaries and board lanes reject a changed date context while retaining drafts', async t => {
  let now = new Date('2026-05-07T23:59:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Calendar queue' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  const due = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'State', type: 'singleSelect', options: [{ id: 'open', name: 'Open' }] });
  const state = table.fields[2]!.id;
  service.createRecords(table.id, Array.from({ length: 604 }, (_, i) => ({ values: {
    [table.primaryFieldId]: `Task ${i}`, [due]: i < 602 ? '2026-05-07' : '2026-05-08', [state]: 'open',
  } })));
  const query = { filter: relative(due, 'today') };
  const view = service.createView(table.id, { name: 'Today', query, groupBy: state });
  const board = service.createView(table.id, { name: 'Today board', type: 'board', groupBy: state, query });
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token }); t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const first = await api.queryView(table.id, view.id, { limit: 500 });
  const guard = { expectedRevision: first.revision, expectedDateContext: first.dateContext! };
  assert.equal((await api.queryView(table.id, view.id, { ...guard, offset: 500 })).records.length, 100);
  const summary = await api.summarizeRecords(table.id, { viewId: view.id, groupBy: state, ...guard });
  assert.equal(summary.totals.count, 602); assert.equal(summary.dateContext, first.dateContext);
  assert.equal((await api.queryView(table.id, board.id, { ...guard, lane: 'open' })).total, 602);
  const model = new TableModel(api.table(table.id), 100, 2); t.after(() => model.dispose());
  await model.initialize(); await model.setQuery({ view: { id: view.id, version: view.version } });
  assert.equal(model.dateContext, first.dateContext);
  model.applyEdits([{ row: 0, fieldId: table.primaryFieldId, value: 'Retained draft' }]);
  now = new Date('2026-05-08T00:00:00Z');
  const stale = (error: unknown) => error instanceof ApiFailure && error.code === 'DATA_CHANGED';
  await assert.rejects(api.queryView(table.id, view.id, { ...guard, offset: 500 }), stale);
  await assert.rejects(api.summarizeRecords(table.id, { viewId: view.id, ...guard }), stale);
  await assert.rejects(api.queryView(table.id, board.id, { ...guard, lane: 'open' }), stale);
  await assert.rejects(model.readRange(500, 1), stale);
  await assert.rejects(model.paste(100, 0, Array.from({ length: 501 }, () => ['Not staged'])), stale);
  assert.equal(model.stale, true); assert.equal(model.pendingCells, 1);
  assert.equal(model.getRecord(0)!.values[table.primaryFieldId], 'Retained draft');
  await model.refresh();
  assert.equal(model.rowCount, 2); assert.equal(model.pendingCells, 1); assert.equal(model.stale, false);
  assert.notEqual(model.dateContext, first.dateContext); assert.equal(model.dataRevision, first.revision);
  assert.equal([...parseCsv(await api.exportCsv(table.id, { viewId: view.id }))].length, 3);
  await model.setQuery({}); assert.equal(model.dateContext, undefined);
});

test('relative lookup comparisons require one linked value inside the complete range', t => {
  const service = new RecordService(fixture(t, null, () => new Date('2026-06-15T12:00:00Z')).open());
  let events = service.createTable({ name: 'Events' });
  events = service.createField(events.id, { expectedVersion: events.version, name: 'At', type: 'datetime' });
  const at = events.fields[1]!.id;
  const targets = service.createRecords(events.id, ['2026-06-14T23:59:59Z', '2026-06-16T00:00:00Z', '2026-06-15T12:00:00Z']
    .map(value => ({ values: { [at]: value } }))).records;
  let source = service.createTable({ name: 'Projects' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Events', type: 'relation', relation: { tableId: events.id, multiple: true } });
  const link = source.fields[1]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Dates', type: 'lookup', lookup: { relationFieldId: link, fieldId: at } });
  const lookup = source.fields[2]!.id;
  const rows = service.createRecords(source.id, [[targets[0]!.id, targets[1]!.id], [targets[2]!.id], []].map(ids => ({ values: { [link]: ids } }))).records;
  const filter = relative(lookup, 'today');
  assert.deepEqual(service.queryRecords(source.id, { filter }).records.map(row => row.id), [rows[1]!.id]);
  assert.equal(service.summarizeRecords(source.id, { filter }).totals.count, 1);
});

test('relative date input rejects incompatible fields, invalid zones and ambiguous or unbounded day counts', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Dates' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  const due = table.fields[1]!.id;
  const invalid = (condition: unknown) => assert.throws(() => service.queryRecords(table.id, { filter: { conjunction: 'and', conditions: [condition] } }),
    (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_QUERY');
  for (const settings of [null, {}, { period: 'today', timeZone: 'Invalid/Zone' }, { period: 'today', timeZone: '+08:00' },
    { period: 'today', timeZone: 'UTC', days: 2 }, { period: 'unknown', timeZone: 'UTC' },
    ...[undefined, 0, -1, 1.2, 3661, '7'].map(days => ({ period: 'pastDays', timeZone: 'UTC', days }))]) {
    invalid({ fieldId: due, operator: 'relativeDate', relative: settings });
  }
  invalid({ fieldId: table.primaryFieldId, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } });
  invalid({ fieldId: due, operator: 'relativeDate', value: null, relative: { period: 'today', timeZone: 'UTC' } });
  assert.throws(() => service.queryRecords(table.id, { expectedDateContext: 'invalid' }), /expectedDateContext/);
});
