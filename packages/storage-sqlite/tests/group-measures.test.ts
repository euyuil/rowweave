import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import type { SummaryMeasure } from '../../contracts/src/index.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
const measuresFor = (fieldId: string): SummaryMeasure[] => ['sum', 'average', 'min', 'max'].map(operation =>
  ({ fieldId, operation: operation as SummaryMeasure['operation'] }));

test('group measures cover complete groups independently of windows, collapse and restart', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Large measured groups' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const groupBy = table.primaryFieldId, amount = table.fields[1]!.id, measures = measuresFor(amount);
  service.createRecords(table.id, Array.from({ length: 1001 }, (_, index) => ({ values: { [groupBy]: 'A', [amount]: index + 1 } })));
  service.createRecords(table.id, [{ values: { [groupBy]: 'B', [amount]: -4 } }]);
  const before = service.workspaceState({ tableId: table.id });
  for (const input of [{ offset: 500, limit: 1 }, { window: 'expandedRecords', offset: 900, limit: 1 },
    { limit: 1, collapse: { defaultCollapsed: true, exceptions: [] } }]) {
    const result = service.queryGroups(table.id, { groupBy, measures, ...input });
    assert.equal(result.groups.length, 1); assert.equal(result.totalRecords, 1002);
    assert.equal(result.groups[0]!.count, 1001); assert.equal(result.groups[0]!.recordOffset, 0);
    assert.deepEqual(result.groups[0]!.values, [501501, 501, 1, 1001]);
  }
  const deep = service.queryGroups(table.id, { groupBy, measures, window: 'expandedRecords', offset: 1001, limit: 1 });
  assert.equal(deep.groups[0]!.key, 'B'); assert.deepEqual(deep.groups[0]!.values, [-4, -4, -4, -4]);
  assert.equal(service.queryGroups(table.id, { groupBy, offset: 500, limit: 1 }).groups[0]!.values, undefined);
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  store.close();
  assert.deepEqual(new RecordService(data.open()).queryGroups(table.id, { groupBy, measures, window: 'expandedRecords', offset: 1001, limit: 1 }), deep);
});

test('group measures honor saved filters, empty headings, nulls, zero and requested operation order', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Measured statuses' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'a', name: 'A' }, { id: 'empty', name: 'Empty' }, { id: 'b', name: 'B' }] });
  const name = table.primaryFieldId, amount = table.fields[1]!.id, status = table.fields[2]!.id;
  service.createRecords(table.id, [10, null, 0, -2, 4, 999].map((value, index) => ({ values: {
    [name]: index === 5 ? 'Excluded' : 'Included', [amount]: value, [status]: index < 3 ? 'a' : index === 4 ? null : 'b',
  } })));
  const view = service.createView(table.id, { name: 'Measured', groupBy: status, query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'neq', value: 'Excluded' }] },
  } });
  const measures = [...measuresFor(amount), { fieldId: amount, operation: 'sum' as const }];
  const result = service.queryGroups(table.id, { viewId: view.id, measures, collapse: { defaultCollapsed: true, exceptions: [] } });
  assert.deepEqual(result.groups.map(group => [group.key, group.count, group.values]), [
    ['a', 3, [10, 5, 0, 10, 10]], ['empty', 0, [null, null, null, null, null]],
    ['b', 1, [-2, -2, -2, -2, -2]], [null, 1, [4, 4, 4, 4, 4]],
  ]);
  const empty = service.queryGroups(table.id, { viewId: view.id, measures, search: 'missing' });
  assert.equal(empty.totalRecords, 0); assert.equal(empty.groups.length, 4);
  assert.ok(empty.groups.every(group => group.values!.every(value => value === null)));
  const allNull = service.queryGroups(table.id, { groupBy: status, measures,
    filter: { conjunction: 'and', conditions: [{ fieldId: amount, operator: 'isEmpty' }] } });
  assert.equal(allNull.groups[0]!.count, 1); assert.deepEqual(allNull.groups[0]!.values, [null, null, null, null, null]);
});

test('group measures support formulas and linked summaries with dependency and overflow errors', t => {
  const service = new RecordService(fixture(t, null).open());
  let target = service.createTable({ name: 'Measured targets' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number' });
  const amount = target.fields[1]!.id;
  const targets = service.createRecords(target.id, [10, 2, 0].map(value => ({ values: { [amount]: value } }))).records;
  let table = service.createTable({ name: 'Measured sources' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Links', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const relation = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Total', type: 'lookup', lookup: { relationFieldId: relation, fieldId: amount, operation: 'sum' } });
  const total = table.fields[2]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Inverse', type: 'formula', formula: { expression: '1 / [' + total + ']', resultType: 'number' } });
  const inverse = table.fields[3]!.id;
  service.createRecords(table.id, targets.map(row => ({ values: { [table.primaryFieldId]: 'All', [relation]: [row.id] } })));
  const measures = [{ fieldId: total, operation: 'sum' }, { fieldId: inverse, operation: 'average' }];
  const result = service.queryGroups(table.id, { groupBy: table.primaryFieldId, measures });
  assert.equal(result.groups[0]!.count, 3); assert.deepEqual(result.groups[0]!.values, [12, 0.3]);
  assert.deepEqual(service.queryGroups(table.id, { groupBy: total, measures: measuresFor(total) }).groups.map(group => [group.key, group.values]),
    [[0, [0, 0, 0, 0]], [2, [2, 2, 2, 2]], [10, [10, 10, 10, 10]], [null, [null, null, null, null]]]);
  service.updateBatch([{ id: targets[0]!.id, expectedVersion: 1, values: { [amount]: 5 } }], target.id);
  assert.throws(() => service.queryGroups(table.id, { groupBy: table.primaryFieldId, measures, expectedRevision: result.revision }), code('DATA_CHANGED'));
  assert.deepEqual(service.queryGroups(table.id, { groupBy: table.primaryFieldId, measures }).groups[0]!.values, [7, 0.35]);
  service.createRecords(target.id, [1e308, 1e308].map(value => ({ values: { [target.primaryFieldId]: 'Overflow', [amount]: value } })));
  assert.throws(() => service.queryGroups(target.id, { groupBy: target.primaryFieldId, measures: measuresFor(amount) }), code('SUMMARY_OVERFLOW'));
  service.createRecords(target.id, ['Finite A', 'Finite B'].map(value => ({ values: { [target.primaryFieldId]: value, [amount]: 1e308 } })));
  const finite = service.queryGroups(target.id, { groupBy: target.primaryFieldId, search: 'Finite', measures: measuresFor(amount) });
  assert.deepEqual(finite.groups.slice(0, 2).map(group => group.values), Array(2).fill([1e308, 1e308, 1e308, 1e308]));
  for (const measures of [null, {}, Array(13).fill({ fieldId: total, operation: 'sum' }), [{ fieldId: relation, operation: 'sum' }],
    [{ fieldId: 'missing', operation: 'sum' }], [{ fieldId: total, operation: 'median' }]]) {
    assert.throws(() => service.queryGroups(table.id, { groupBy: table.primaryFieldId, measures }), code('INVALID_SUMMARY'));
  }
});

test('HTTP measured windows retain saved-view and date-context guards without writes', async t => {
  let now = new Date('2026-11-14T12:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open()), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token }); t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  let table = await api.createTable({ name: 'Measured dates' });
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Serial', type: 'autoNumber' });
  const due = table.fields[1]!.id, serial = table.fields[2]!.id;
  await api.createRecords(table.id, [14, 14, 15].map(day => ({ values: { [due]: '2026-11-' + day } })));
  const view = await api.createView(table.id, { name: 'Today', groupBy: due, query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: due, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } }] },
  } });
  const input = { viewId: view.id, expectedViewVersion: view.version, measures: measuresFor(serial), limit: 1 };
  const before = service.workspaceState({ tableId: table.id }), page = await api.queryGroups(table.id, input);
  assert.deepEqual(page.groups[0]!.values, [3, 1.5, 1, 2]); assert.ok(page.dateContext);
  assert.deepEqual(await api.queryGroups(table.id, { ...input, expectedDateContext: page.dateContext!, expectedRevision: page.revision }), page);
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  await assert.rejects(api.queryGroups(table.id, input, AbortSignal.abort()), { name: 'AbortError' });
  now = new Date('2026-11-15T12:00:00Z');
  await assert.rejects(api.queryGroups(table.id, { ...input, expectedDateContext: page.dateContext! }), { code: 'DATA_CHANGED' });
  assert.deepEqual((await api.queryGroups(table.id, input)).groups[0]!.values, [3, 3, 3, 3]);
  await api.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Renamed' });
  await assert.rejects(api.queryGroups(table.id, input), { code: 'VIEW_CONFLICT' });
});
