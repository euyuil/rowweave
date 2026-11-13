import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { summarize } from '../src/record-summary.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';
import { startServer } from '../../../apps/server/src/http-server.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  let table = service.createTable({ name: 'Summary data' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'open', name: 'Open' }, { id: 'done', name: 'Done' }] });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Checked', type: 'checkbox' });
  const [name, amount, status, checked] = table.fields.map(field => field.id) as [string, string, string, string];
  const rows = service.createRecords(table.id, [10, 0, null, 4, -2].map((value, index) => ({ values: {
    [name]: ['Alpha', 'Alpha', '', null, "' OR 1=1 --"][index]!, [amount]: value,
    [status]: index < 3 ? 'open' : 'done', [checked]: index === 0 ? true : index === 1 ? false : null,
  } }))).records;
  const measures = (['sum', 'average', 'min', 'max'] as const).map(operation => ({ fieldId: amount, operation }));
  return { data, service, table, name, amount, status, checked, rows, measures };
}

test('summaries aggregate all matching values, retain null/empty groups and use stable select identities', t => {
  const { service, table, amount, status, checked, name, measures } = setup(t);
  const result = service.summarizeRecords(table.id, { groupBy: status, measures });
  assert.deepEqual(result.totals, { count: 5, values: [12, 3, -2, 10] });
  assert.deepEqual(result.groups, [
    { key: 'done', label: 'Done', count: 2, values: [2, 1, -2, 4] },
    { key: 'open', label: 'Open', count: 3, values: [10, 5, 0, 10] },
  ]);
  const text = service.summarizeRecords(table.id, { groupBy: name });
  assert.equal(text.groups.find(group => group.key === null)!.count, 1);
  assert.equal(text.groups.find(group => group.key === '')!.count, 1);
  assert.deepEqual(service.summarizeRecords(table.id, { groupBy: checked }).groups.map(group => group.key), [false, true, null]);
  assert.deepEqual(service.summarizeRecords(table.id, { search: "' OR 1=1 --", measures }).totals, { count: 1, values: [-2, -2, -2, -2] });
  const empty = service.summarizeRecords(table.id, { search: 'missing', measures });
  assert.deepEqual(empty.totals, { count: 0, values: [null, null, null, null] });
  assert.deepEqual(service.summarizeRecords(table.id, { filter: { conjunction: 'and', conditions: [{ fieldId: amount, operator: 'isEmpty' }] }, measures }).totals,
    { count: 1, values: [null, null, null, null] });
  service.updateField(table.id, status, { expectedVersion: table.version, options: [{ id: 'open', name: 'Active' }, { id: 'done', name: 'Done' }] });
  const renamed = service.summarizeRecords(table.id, { groupBy: status });
  assert.equal(renamed.groups[0]!.key, 'open');
  assert.equal(renamed.groups[0]!.label, 'Active');
});

test('summary pages count beyond record page limits and reject changed data or saved views', t => {
  const { service, table, name, amount, measures, rows } = setup(t);
  service.createRecords(table.id, Array.from({ length: 600 }, (_, i) => ({ values: { [name]: `Group ${i}`, [amount]: 1 } })));
  const first = service.summarizeRecords(table.id, { groupBy: name, measures, limit: 2 });
  assert.equal(first.totals.count, 605);
  assert.equal(first.totals.values[0], 612);
  assert.equal(first.groupCount, 604);
  assert.equal(first.groups.length, 2);
  const next = service.summarizeRecords(table.id, { groupBy: name, measures, limit: 2, offset: 2, expectedRevision: first.revision });
  assert.deepEqual(next.totals, first.totals);
  assert.ok(next.groups.every(group => !first.groups.some(previous => previous.key === group.key)));
  const pastEnd = service.summarizeRecords(table.id, { groupBy: name, measures, offset: 604 });
  assert.deepEqual(pastEnd.totals, first.totals);
  assert.equal(pastEnd.groupCount, 604);
  assert.deepEqual(pastEnd.groups, []);
  const view = service.createView(table.id, { name: 'Positive', query: { filter: { conjunction: 'and',
    conditions: [{ fieldId: amount, operator: 'gt', value: 3 }] } } });
  assert.deepEqual(service.summarizeRecords(table.id, { viewId: view.id, expectedViewVersion: view.version, measures }).totals,
    { count: 2, values: [14, 7, 4, 10] });
  service.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Renamed' });
  assert.throws(() => service.summarizeRecords(table.id, { viewId: view.id, expectedViewVersion: view.version }), code('VIEW_CONFLICT'));
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: rows[0]!.version, values: { [amount]: 20 } }], table.id);
  assert.throws(() => service.summarizeRecords(table.id, { groupBy: name, offset: 2, expectedRevision: first.revision }), code('DATA_CHANGED'));
});

test('grouped summaries weight averages by non-null records and preserve empty result semantics', t => {
  const { service, table, amount, status, measures } = setup(t);
  service.createRecords(table.id, [{ values: { [amount]: 8, [status]: 'done' } }]);
  const result = service.summarizeRecords(table.id, { groupBy: status, measures });
  assert.deepEqual(result.totals, { count: 6, values: [20, 4, -2, 10] });
  assert.deepEqual(result.groups.map(group => group.values), [[10, 10 / 3, -2, 8], [10, 5, 0, 10]]);
  const empty = service.summarizeRecords(table.id, { groupBy: status, measures, search: 'missing' });
  assert.deepEqual(empty.totals, { count: 0, values: [null, null, null, null] });
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.groupCount, 0);
});

test('grouped summary pagination evaluates the record filter once for totals and groups', t => {
  const { data, table, status, measures } = setup(t);
  const db = new DatabaseSync(data.path, { readOnly: true });
  let visited = 0;
  db.function('observeRow', () => { visited++; return 1; });
  try {
    for (const offset of [0, 1, 2]) {
      visited = 0;
      const result = summarize(db, table, { groupBy: status, measures },
        'r.table_id = :table AND observeRow()', { ':table': table.id }, offset, 1);
      assert.equal(visited, 5);
      assert.deepEqual(result.totals, { count: 5, values: [12, 3, -2, 10] });
      assert.equal(result.groupCount, 2);
      assert.equal(result.groups.length, offset < 2 ? 1 : 0);
    }
  } finally { db.close(); }
});

test('grouped summary overflow remains explicit even when the overall total is finite', t => {
  const { service, table, amount, status } = setup(t);
  service.createRecords(table.id, [-1e308, 1e308, -1e308, 1e308].map((value, i) => ({ values: {
    [amount]: value, [status]: i % 2 === 0 ? 'open' : 'done',
  } })));
  const measures = [{ fieldId: amount, operation: 'sum' }];
  assert.ok(Number.isFinite(service.summarizeRecords(table.id, { measures }).totals.values[0]));
  assert.throws(() => service.summarizeRecords(table.id, { groupBy: status, measures }), code('SUMMARY_OVERFLOW'));
});

test('summaries validate aggregate types, bounds and finite numeric results at the service boundary', t => {
  const { service, table, name, amount, measures } = setup(t);
  for (const input of [{ groupBy: 'missing' }, { measures: [{ fieldId: name, operation: 'sum' }] },
    { measures: [{ fieldId: amount, operation: 'execute' }] }, { measures: Array(13).fill(measures[0]) },
    { viewId: 12 }, { measures: 'sum' }, { measures: null }]) {
    assert.throws(() => service.summarizeRecords(table.id, input), code('INVALID_SUMMARY'));
  }
  for (const input of [{ limit: 501 }, { offset: -1 }, { expectedRevision: 0 }]) {
    assert.throws(() => service.summarizeRecords(table.id, input), code('INVALID_QUERY'));
  }
  const updated = service.createField(table.id, { expectedVersion: table.version, name: 'Tags', type: 'multiSelect', options: [] });
  assert.throws(() => service.summarizeRecords(table.id, { groupBy: updated.fields.at(-1)!.id }), code('INVALID_SUMMARY'));
  service.createRecords(table.id, [1e308, 1e308].map(value => ({ values: { [amount]: value } })));
  assert.throws(() => service.summarizeRecords(table.id, { measures }), code('SUMMARY_OVERFLOW'));
});

test('HTTP and SDK summaries share view filters, group pagination and validation', async t => {
  const { service, table, status, measures } = setup(t);
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const result = await api.summarizeRecords(table.id, { groupBy: status, measures, limit: 1 });
  assert.equal(result.totals.count, 5);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groupCount, 2);
  assert.equal((await api.summarizeRecords(table.id, { groupBy: status, offset: 1, expectedRevision: result.revision })).groups[0]!.key, 'open');
  await assert.rejects(api.summarizeRecords(table.id, { groupBy: 'missing' }), { code: 'INVALID_SUMMARY' });
});
