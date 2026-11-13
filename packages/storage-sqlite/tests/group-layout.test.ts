import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import type { GroupCollapse } from '../../contracts/src/index.js';

const code = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

test('bounded group windows cover complete datasets and preserve record offsets through collapse', t => {
  const service = new RecordService(fixture(t, null).open());
  const table = service.createTable({ name: 'Many groups' }), field = table.primaryFieldId;
  const keys = Array.from({ length: 1207 }, (_, index) => 'Group ' + String(index).padStart(4, '0'));
  const values = keys.flatMap(key => [key, key]);
  for (let offset = 0; offset < values.length; offset += 2000) {
    service.createRecords(table.id, values.slice(offset, offset + 2000).map(value => ({ values: { [field]: value } })));
  }
  const before = service.workspaceState({ tableId: table.id });
  const choices: GroupCollapse[] = [
    { defaultCollapsed: false, exceptions: [] }, { defaultCollapsed: true, exceptions: [] },
    { defaultCollapsed: true, exceptions: [keys[901]!, null] },
    { defaultCollapsed: false, exceptions: keys.filter((_, index) => index % 2 === 0) },
  ];
  for (const collapse of choices) {
    let rowStart = 0;
    const expected = [...keys, null].map((key, index) => {
      const count = key === null ? 0 : 2, collapsed = collapse.defaultCollapsed !== collapse.exceptions.includes(key);
      const group = { key, count, recordOffset: Math.min(index, keys.length) * 2, rowStart, expandedOffset: rowStart - index, collapsed };
      rowStart += 1 + (collapsed ? 0 : count); return group;
    });
    for (const offset of [0, 1, 500, 901, 1803, rowStart - 1, rowStart, rowStart + 100]) {
      const page = service.queryGroups(table.id, { groupBy: field, offset, limit: 31, collapse });
      assert.equal(page.window, 'displayRows');
      assert.equal(page.totalRecords, values.length); assert.equal(page.totalGroups, 1208); assert.equal(page.totalRows, rowStart);
      assert.deepEqual(page.groups.map(({ label: _label, ...group }) => group), expected.filter(group =>
        group.rowStart < offset + 31 && group.rowStart + 1 + (group.collapsed ? 0 : group.count) > offset));
      assert.ok(page.groups.length <= 31);
      for (const group of page.groups.filter(group => !group.collapsed && group.count)) {
        const records = service.queryRecords(table.id, { groupBy: field, offset: group.recordOffset, limit: group.count,
          expectedRevision: page.revision, fields: [field] });
        assert.deepEqual(records.records.map(record => record.values[field]), [group.key, group.key]);
      }
    }
    const expanded = expected.filter(group => !group.collapsed && group.count);
    const recordOffsets = expanded.flatMap(group => [group.recordOffset, group.recordOffset + 1]);
    for (const offset of [0, 1, 500, 901, recordOffsets.length - 1, recordOffsets.length].filter(offset => offset >= 0)) {
      const page = service.queryGroups(table.id, { groupBy: field, window: 'expandedRecords', offset, limit: 31, collapse });
      assert.equal(page.window, 'expandedRecords'); assert.equal(page.totalRows, rowStart);
      assert.equal(page.totalGroups, 1208); assert.equal(page.totalRecords, values.length);
      assert.deepEqual(page.groups.map(({ label: _label, ...group }) => group), expanded.filter(group =>
        group.expandedOffset < offset + 31 && group.expandedOffset + group.count > offset));
      const indices = page.groups.flatMap(group => Array.from({
        length: Math.min(offset + 31, group.expandedOffset + group.count) - Math.max(offset, group.expandedOffset),
      }, (_, index) => group.recordOffset + Math.max(0, offset - group.expandedOffset) + index));
      assert.deepEqual(indices, recordOffsets.slice(offset, offset + 31));
      assert.ok(page.groups.length <= 31);
    }
  }
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
});

test('group order uses typed raw values and keeps null distinct from empty text and false', t => {
  const service = new RecordService(fixture(t, null).open());
  for (const [type, input, expected] of [
    ['text', ['a', '', null, 'A', "a'\0", '中文🌱'], ['', 'A', 'a', "a'\0", '中文🌱', null]],
    ['number', [10, 2, -1, null, 0], [-1, 0, 2, 10, null]],
    ['checkbox', [true, null], [false, true, null]],
    ['date', ['2026-11-14', null, '2024-02-29'], ['2024-02-29', '2026-11-14', null]],
    ['datetime', ['2026-11-14T08:00:00+08:00', null, '2026-11-13T23:59:00Z'],
      ['2026-11-13T23:59:00.000Z', '2026-11-14T00:00:00.000Z', null]],
  ] as const) {
    let table = service.createTable({ name: type });
    table = service.createField(table.id, { expectedVersion: table.version, name: 'Group', type });
    const field = table.fields[1]!.id;
    service.createRecords(table.id, input.map(value => ({ values: { [field]: value } })));
    const layout = service.queryGroups(table.id, { groupBy: field });
    assert.deepEqual(layout.groups.map(group => group.key), expected);
    for (const group of layout.groups.filter(group => group.count)) {
      const row = service.queryRecords(table.id, { groupBy: field, offset: group.recordOffset, limit: 1 }).records[0]!;
      assert.equal(row.values[field], group.key);
    }
  }
});

test('saved group layouts retain option order, empty headings, filters and record sorting', t => {
  const store = fixture(t, null).open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Tasks' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'z', name: 'Z first' }, { id: 'empty', name: 'Empty' }, { id: 'a', name: 'A last' }] });
  const status = table.fields[1]!.id, name = table.primaryFieldId;
  service.createRecords(table.id, ['B', 'C', 'A', 'Excluded'].map((value, index) => ({ values: { [name]: value, [status]: index === 2 ? 'a' : 'z' } })));
  const view = service.createView(table.id, { name: 'Grouped', groupBy: status, query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'neq', value: 'Excluded' }] },
    sort: [{ fieldId: name, direction: 'desc' }],
  } });
  const layout = service.queryGroups(table.id, { viewId: view.id, expectedViewVersion: view.version });
  assert.deepEqual(layout.groups.map(group => [group.key, group.count, group.recordOffset, group.rowStart]),
    [['z', 2, 0, 0], ['empty', 0, 2, 3], ['a', 1, 2, 4], [null, 0, 3, 6]]);
  assert.equal(layout.viewId, view.id); assert.equal(layout.viewVersion, view.version);
  assert.deepEqual(service.queryView(table.id, view.id, { offset: layout.groups[0]!.recordOffset, limit: 2,
    expectedRevision: layout.revision }).records.map(row => row.values[name]), ['C', 'B']);
  assert.equal(service.queryGroups(table.id, { viewId: view.id, search: 'C' }).totalRecords, 1);
  const empty = service.queryGroups(table.id, { viewId: view.id, search: 'missing' });
  assert.equal(empty.totalRecords, 0); assert.equal(empty.totalRows, 4); assert.equal(empty.groups.length, 4);
  const current = service.updateField(table.id, status, { expectedVersion: table.version,
    options: [{ id: 'a', name: 'Renamed' }, { id: 'z', name: 'Next' }, { id: 'empty', name: 'Empty' }] });
  assert.deepEqual(service.queryGroups(table.id, { viewId: view.id }).groups.slice(0, 2).map(group => [group.key, group.label]), [['a', 'Renamed'], ['z', 'Next']]);
  assert.throws(() => service.queryGroups(table.id, { viewId: view.id, expectedRevision: layout.revision }), code('DATA_CHANGED'));
  assert.throws(() => store.queryGroups(table, { groupBy: status, offset: 0, limit: 20, window: 'displayRows' }, { defaultCollapsed: false, exceptions: [] }), code('SCHEMA_CONFLICT'));
  assert.equal(service.getTable(table.id).version, current.version);
  service.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Updated' });
  assert.throws(() => service.queryGroups(table.id, { viewId: view.id, expectedViewVersion: view.version }), code('VIEW_CONFLICT'));
});

test('group reads validate scalar fields, normalized exceptions, limits and saved-view semantics', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Validation' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Tags', type: 'multiSelect', options: [{ id: 'a', name: 'A' }] });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
  const field = table.primaryFieldId, tags = table.fields[1]!.id, at = table.fields[2]!.id;
  for (const input of [{}, { groupBy: tags }, { groupBy: 'missing' }, { groupBy: field, limit: 501 }, { groupBy: field, offset: -1 },
    { groupBy: field, collapse: { defaultCollapsed: 1, exceptions: [] } },
    { groupBy: field, collapse: { defaultCollapsed: true, exceptions: [null, null] } },
    { groupBy: field, collapse: { defaultCollapsed: false, exceptions: Array(100001).fill('x') } },
    { groupBy: at, collapse: { defaultCollapsed: false, exceptions: ['2026-11-14T08:00:00+08:00', '2026-11-14T00:00:00Z'] } },
    { viewId: service.listViews(table.id)[0]!.id }, { groupBy: field, expectedViewVersion: 1 }]) {
    assert.throws(() => service.queryGroups(table.id, input), ServiceError);
  }
  assert.throws(() => service.queryRecords(table.id, { groupBy: tags }), code('INVALID_QUERY'));
  for (const window of [null, '', 'records', 1]) {
    assert.throws(() => service.queryGroups(table.id, { groupBy: field, window }), code('INVALID_QUERY'));
  }
  assert.throws(() => service.queryGroups(table.id, { groupBy: field, collapse: { defaultCollapsed: false, exceptions: [1] } }), code('INVALID_VALUE'));
  service.createRecords(table.id, [{ values: { [at]: '2026-11-14T00:00:00Z' } }]);
  assert.equal(service.queryGroups(table.id, { groupBy: at,
    collapse: { defaultCollapsed: false, exceptions: ['2026-11-14T08:00:00+08:00'] } }).groups[0]!.collapsed, true);
});

test('calculated and linked scalar groups agree with record pages and follow dependency changes', t => {
  const service = new RecordService(fixture(t, null).open());
  let target = service.createTable({ name: 'Amounts' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number' });
  const amount = target.fields[1]!.id;
  const linked = service.createRecords(target.id, [10, 2].map(value => ({ values: { [amount]: value } }))).records;
  let table = service.createTable({ name: 'Calculated groups' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Link', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Sum', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } });
  const sum = table.fields[2]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Double', type: 'formula', formula: { expression: '[' + sum + '] * 2', resultType: 'number' } });
  const double = table.fields[3]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Serial', type: 'autoNumber' });
  const serial = table.fields[4]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Created', type: 'createdTime' });
  const created = table.fields[5]!.id;
  const records = service.createRecords(table.id, [...linked.map(row => [row.id]), []].map(ids => ({ values: { [link]: ids } }))).records;
  for (const groupBy of [sum, double, serial, created]) {
    const layout = service.queryGroups(table.id, { groupBy });
    for (const group of layout.groups.filter(group => group.count)) {
      const page = service.queryRecords(table.id, { groupBy, offset: group.recordOffset, limit: group.count, fields: [groupBy],
        expectedRevision: layout.revision });
      assert.deepEqual(page.records.map(row => row.values[groupBy]), Array(group.count).fill(group.key));
    }
  }
  const before = service.queryGroups(table.id, { groupBy: sum, collapse: { defaultCollapsed: true, exceptions: [2] } });
  assert.deepEqual(before.groups.map(group => [group.key, group.count, group.collapsed]), [[2, 1, false], [10, 1, true], [null, 1, true]]);
  service.updateBatch([{ id: linked[0]!.id, expectedVersion: 1, values: { [amount]: 1 } }], target.id);
  assert.throws(() => service.queryGroups(table.id, { groupBy: sum, expectedRevision: before.revision }), code('DATA_CHANGED'));
  const filter = { conjunction: 'and', conditions: [{ fieldId: sum, operator: 'gte', value: 2 }] };
  assert.deepEqual(service.queryGroups(table.id, { groupBy: sum, filter }).groups.map(group => [group.key, group.count]), [[2, 1], [null, 0]]);
  assert.equal(service.queryRecords(table.id, { groupBy: sum }).records[0]!.id, records[0]!.id);
  assert.equal(service.queryGroups(table.id, { groupBy: double }).groups[0]!.key, 2);
  assert.throws(() => service.queryGroups(table.id, { groupBy: link }), code('INVALID_QUERY'));
});

test('HTTP group windows share date and data guards with record pages and support cancellation', async t => {
  let now = new Date('2026-11-14T12:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  const token = randomBytes(32).toString('hex'), server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  let table = await api.createTable({ name: 'Dates' });
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'date' });
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Done', type: 'checkbox' });
  const due = table.fields[1]!.id, done = table.fields[2]!.id;
  await api.createRecords(table.id, [false, true].map((value, index) => ({ values: { [done]: value, [due]: '2026-11-' + (14 + index) } })));
  const view = await api.createView(table.id, { name: 'Today', groupBy: done, query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: due, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } }] },
  } });
  const page = await api.queryGroups(table.id, { viewId: view.id, limit: 1 });
  const guard = { expectedViewVersion: view.version, expectedRevision: page.revision, expectedDateContext: page.dateContext! };
  assert.equal(page.totalRecords, 1); assert.deepEqual(page.groups.map(group => group.key), [false]); assert.ok(page.dateContext);
  assert.equal((await api.queryView(table.id, view.id, guard)).dateContext, page.dateContext);
  const expanded = await api.queryGroups(table.id, { viewId: view.id, window: 'expandedRecords', ...guard });
  assert.deepEqual(expanded.groups, page.groups); assert.equal(expanded.groups[0]!.expandedOffset, 0);
  assert.deepEqual((await api.queryGroups(table.id, { viewId: view.id, offset: 1, limit: 1, ...guard })).groups, page.groups);
  for (const input of [{ viewId: view.id, groupBy: due }, { viewId: view.id, filter: view.query.filter! }]) {
    await assert.rejects(api.queryGroups(table.id, input), { code: 'INVALID_QUERY' });
  }
  await assert.rejects(api.queryGroups(table.id, { groupBy: due }, AbortSignal.abort()), { name: 'AbortError' });
  now = new Date('2026-11-15T12:00:00Z');
  await assert.rejects(api.queryGroups(table.id, { viewId: view.id, ...guard }), { code: 'DATA_CHANGED' });
  await assert.rejects(api.queryGroups(table.id, { viewId: view.id, window: 'expandedRecords', ...guard }), { code: 'DATA_CHANGED' });
  assert.equal((await api.queryGroups(table.id, { viewId: view.id })).groups[1]!.count, 1);
  const current = await api.queryGroups(table.id, { groupBy: due });
  await api.createRecords(table.id, [{ values: {} }]);
  await assert.rejects(api.queryGroups(table.id, { groupBy: due, expectedRevision: current.revision }), { code: 'DATA_CHANGED' });
});
