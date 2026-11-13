import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import type { GroupPathCollapse, SummaryMeasure } from '../../contracts/src/index.js';
import { nestedGroupLayout } from '../src/nested-group-layout.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Nested groups' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'b', name: 'B first' }, { id: 'a', name: 'A second' }, { id: 'empty', name: 'Empty' }] });
  const status = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Category', type: 'text' });
  const category = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Number', type: 'number' });
  const number = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const amount = table.fields.at(-1)!.id;
  const values = [ ['a', 'Same', 0, 2], ['a', 'Same', 0, 3], ['a', 'Same', null, 5],
    ['a', 'Other', 1, 7], ['b', 'Same', 0, 11], [null, '', -1, 13] ];
  const records = service.createRecords(table.id, values.map((value, index) => ({ values: {
    [table.primaryFieldId]: 'Record ' + index, [status]: value[0]!, [category]: value[1]!, [number]: value[2]!, [amount]: value[3]!,
  } }))).records;
  const groupBy = [status, category, number];
  const measures: SummaryMeasure[] = [{ fieldId: amount, operation: 'sum' }, { fieldId: amount, operation: 'average' }];
  return { data, store, service, table, records, groupBy, measures, amount, status, category, number };
}

test('nested select ordering preserves literal option IDs at each grouping level', t => {
  const service = new RecordService(fixture(t, null).open());
  const ids = ['z ASC', "a' ASC", 'b\0 ASC', 'a'];
  let table = service.createTable({ name: 'Literal option IDs' });
  for (const name of ['First', 'Second']) table = service.createField(table.id, { expectedVersion: table.version, name, type: 'singleSelect',
    options: ids.map((id, index) => ({ id, name: `Choice ${index}` })) });
  const first = table.fields[1]!.id, second = table.fields[2]!.id, groupBy = [first, second];
  const records = service.createRecords(table.id, [...ids].reverse().flatMap(root => [...ids].reverse().map(child => ({
    values: { [first]: root, [second]: child },
  })))).records;
  const layout = service.queryGroups(table.id, { groupBy });
  assert.equal(layout.totalRecords, 16); assert.equal(layout.totalGroups, 21); assert.equal(layout.totalRows, 37);
  assert.deepEqual(layout.groups.filter(group => !group.leaf).map(group => [group.path, group.count]), [
    ...ids.map(id => [[id], 4]), [[null], 0],
  ]);
  assert.deepEqual(layout.groups.filter(group => group.leaf).map(group => group.path), ids.flatMap(root => ids.map(child => [root, child])));
  const page = service.queryRecords(table.id, { groupBy });
  assert.deepEqual(page.records.map(record => record.id), records.toReversed().map(record => record.id));
  for (const group of layout.groups.filter(group => group.leaf)) {
    const row = page.records[group.recordOffset]!;
    assert.deepEqual(group.path, [row.values[first], row.values[second]]);
  }
});

test('three-level windows preserve parent measures, configured root order and source record identities', t => {
  const { service, table, records, groupBy, measures, amount } = setup(t);
  const layout = service.queryGroups(table.id, { groupBy, measures });
  assert.equal(layout.totalRecords, 6); assert.equal(layout.totalGroups, 13); assert.equal(layout.totalRows, 19);
  assert.deepEqual(layout.groups.map(group => group.rowStart), [0, 1, 2, 4, 5, 6, 8, 9, 12, 14, 15, 16, 17]);
  assert.deepEqual(layout.groups.filter(group => group.path!.length === 1).map(group => [group.path, group.count, group.values]), [
    [['b'], 1, [11, 11]], [['a'], 4, [17, 4.25]], [['empty'], 0, [null, null]], [[null], 1, [13, 13]],
  ]);
  const leaves = layout.groups.filter(group => group.leaf);
  assert.deepEqual(leaves.map(group => [group.path, group.count, group.recordOffset]), [
    [['b', 'Same', 0], 1, 0], [['a', 'Other', 1], 1, 1], [['a', 'Same', 0], 2, 2], [['a', 'Same', null], 1, 4], [[null, '', -1], 1, 5],
  ]);
  const page = service.queryRecords(table.id, { groupBy, sort: [{ fieldId: amount, direction: 'desc' }] });
  assert.deepEqual(page.records.map(record => record.id), [4, 3, 1, 0, 2, 5].map(index => records[index]!.id));
  for (const group of leaves) {
    const page = service.queryRecords(table.id, { groupBy, offset: group.recordOffset, limit: group.count, expectedRevision: layout.revision });
    assert.ok(page.records.every(record => groupBy.every((field, index) => record.values[field] === group.path![index])));
  }
  const filtered = service.queryGroups(table.id, { groupBy, measures,
    filter: { conjunction: 'and', conditions: [{ fieldId: amount, operator: 'gt', value: 5 }] } });
  assert.equal(filtered.totalRecords, 3);
  assert.deepEqual(filtered.groups.find(group => JSON.stringify(group.path) === '["a"]')!.values, [7, 7]);
  assert.deepEqual(service.queryGroups(table.id, { groupBy, measures, search: 'absent' }).groups.map(group => group.path), [['b'], ['a'], ['empty'], [null]]);
});

test('typed paths distinguish same-name children and ancestor collapse clips every display and expanded window', t => {
  const { service, table, groupBy, measures } = setup(t);
  const choices: GroupPathCollapse[] = [
    { defaultCollapsed: false, exceptions: [] }, { defaultCollapsed: false, exceptions: [['a', 'Same']] },
    { defaultCollapsed: false, exceptions: [['a'], ['a', 'Same']] }, { defaultCollapsed: true, exceptions: [] },
    { defaultCollapsed: true, exceptions: [['a', 'Same']] },
    { defaultCollapsed: true, exceptions: [['b'], ['b', 'Same'], ['b', 'Same', 0]] },
  ];
  for (const collapse of choices) {
    const layout = service.queryGroups(table.id, { groupBy, measures, collapse });
    assert.equal(layout.totalGroups, layout.groups.length);
    const expanded = layout.groups.filter(group => group.leaf && !group.collapsed);
    assert.equal(layout.totalRows, layout.totalGroups + expanded.reduce((count, group) => count + group.count, 0));
    for (let offset = 0; offset <= layout.totalRows; offset++) {
      assert.deepEqual(service.queryGroups(table.id, { groupBy, measures, collapse, offset, limit: 1 }).groups,
        layout.groups.filter(group => group.rowStart < offset + 1 && group.rowStart + 1 + (group.leaf && !group.collapsed ? group.count : 0) > offset));
    }
    assert.deepEqual(service.queryGroups(table.id, { groupBy, measures, collapse, window: 'expandedRecords' }).groups, expanded);
  }
  const folded = service.queryGroups(table.id, { groupBy, collapse: choices[1] });
  assert.ok(folded.groups.some(group => group.leaf && group.path![0] === 'b' && group.path![1] === 'Same'));
  assert.ok(!folded.groups.some(group => group.leaf && group.path![0] === 'a' && group.path![1] === 'Same'));
});

test('nested grouping checks fields, path types and revision guards without accepting ambiguous paths', t => {
  const { service, store, table, groupBy, measures, records, amount } = setup(t);
  for (const invalid of [[], [...groupBy, amount], [groupBy[0], groupBy[0]], [groupBy[0], 'missing'], [false, groupBy[0]]]) {
    assert.throws(() => service.queryGroups(table.id, { groupBy: invalid }), ServiceError);
    assert.throws(() => service.queryRecords(table.id, { groupBy: invalid }), ServiceError);
  }
  for (const exceptions of [[], ['a'], [0], [null], [[true]], [['a', 'Same', false]], [['a', 'Same', 0, null]], [['a'], ['a']]]) {
    if (!exceptions.length) continue;
    assert.throws(() => service.queryGroups(table.id, { groupBy, collapse: { defaultCollapsed: false, exceptions } }), ServiceError);
  }
  assert.deepEqual(service.queryGroups(table.id, { groupBy: [groupBy[0]!] }), service.queryGroups(table.id, { groupBy: groupBy[0] }));
  const first = service.queryGroups(table.id, { groupBy, measures });
  service.updateBatch([{ id: records[0]!.id, expectedVersion: 1, values: { [amount]: 8 } }], table.id);
  assert.throws(() => service.queryGroups(table.id, { groupBy, expectedRevision: first.revision }), /changed between pages/);
  const current = service.updateField(table.id, amount, { expectedVersion: table.version, name: 'Budget' });
  assert.throws(() => store.queryGroups(table, { groupBy, offset: 0, limit: 20, window: 'displayRows', measures },
    { defaultCollapsed: false, exceptions: [] }), /schema changed/);
  assert.equal(service.queryGroups(table.id, { groupBy }).schemaVersion, current.version);
});

test('nested boolean and linked numeric keys retain typed zero paths and computed measures', t => {
  const service = new RecordService(fixture(t, null).open());
  let target = service.createTable({ name: 'Amounts' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number' });
  const amount = target.fields[1]!.id;
  const targets = service.createRecords(target.id, [0, 2, 10].map(value => ({ values: { [amount]: value } }))).records;
  let table = service.createTable({ name: 'Linked nested groups' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Done', type: 'checkbox' });
  const done = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Links', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Total', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } });
  const total = table.fields.at(-1)!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Inverse', type: 'formula', formula: { expression: '1 / [' + total + ']', resultType: 'number' } });
  const inverse = table.fields.at(-1)!.id;
  service.createRecords(table.id, targets.map(row => ({ values: { [done]: false, [link]: [row.id] } })));
  const groupBy = [done, total], measures = [{ fieldId: total, operation: 'sum' }, { fieldId: inverse, operation: 'average' }];
  const layout = service.queryGroups(table.id, { groupBy, measures });
  assert.deepEqual(layout.groups.map(group => [group.path, group.values]), [
    [[false], [12, 0.3]], [[false, 0], [0, null]], [[false, 2], [2, 0.5]], [[false, 10], [10, 0.1]], [[true], [null, null]], [[null], [null, null]],
  ]);
  const sparse = service.queryGroups(table.id, { groupBy, measures, window: 'expandedRecords',
    collapse: { defaultCollapsed: true, exceptions: [[false], [false, 0]] } });
  assert.deepEqual(sparse.groups.map(group => [group.path, group.count, group.expandedOffset]), [[[false, 0], 1, 0]]);
  service.updateBatch([{ id: targets[0]!.id, expectedVersion: 1, values: { [amount]: 4 } }], target.id);
  assert.throws(() => service.queryGroups(table.id, { groupBy, expectedRevision: layout.revision }), /changed between pages/);
  assert.deepEqual(service.queryGroups(table.id, { groupBy, measures }).groups[0]!.values, [16, (0.25 + 0.5 + 0.1) / 3]);
});

test('nested measures report parent overflow without rejecting finite unrelated windows', t => {
  const { service, table, status, category, number, amount, groupBy, measures } = setup(t);
  service.createRecords(table.id, ['Overflow A', 'Overflow B'].map(value => ({ values: {
    [status]: 'a', [category]: value, [number]: 0, [amount]: 1e308,
  } })));
  assert.throws(() => service.queryGroups(table.id, { groupBy, measures, offset: 1, limit: 1,
    collapse: { defaultCollapsed: true, exceptions: [] } }), (error: unknown) => error instanceof ServiceError && error.code === 'SUMMARY_OVERFLOW');
  assert.deepEqual(service.queryGroups(table.id, { groupBy, measures, limit: 1 }).groups[0]!.values, [11, 11]);
  const leaf = service.queryGroups(table.id, { groupBy, measures, offset: 3, limit: 1,
    filter: { conjunction: 'and', conditions: [{ fieldId: category, operator: 'contains', value: 'Overflow' }] } }).groups[0]!;
  assert.deepEqual(leaf.path, ['a', 'Overflow A', 0]); assert.deepEqual(leaf.values, [1e308, 1e308]);
});

test('nested timestamp paths normalize offsets and preserve relative-date continuation guards', t => {
  let now = new Date('2026-11-14T00:00:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  let table = service.createTable({ name: 'Dated groups' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Due', type: 'datetime' });
  const due = table.fields[1]!.id, name = table.primaryFieldId, groupBy = [name, due];
  service.createRecords(table.id, ['2026-11-14T08:00:00+08:00', '2026-11-30T00:00:00Z'].map(value => ({ values: { [name]: 'A', [due]: value } })));
  const first = service.queryGroups(table.id, { groupBy, window: 'expandedRecords',
    collapse: { defaultCollapsed: true, exceptions: [['A'], ['A', '2026-11-14T08:00:00+08:00']] } });
  assert.deepEqual(first.groups.map(group => group.path), [['A', '2026-11-14T00:00:00.000Z']]);
  assert.throws(() => service.queryGroups(table.id, { groupBy, collapse: { defaultCollapsed: false,
    exceptions: [['A', '2026-11-14T08:00:00+08:00'], ['A', '2026-11-14T00:00:00Z']] } }), /distinct typed group paths/);
  const filter = { conjunction: 'and', conditions: [{ fieldId: due, operator: 'relativeDate', relative: { period: 'thisMonth', timeZone: 'Asia/Shanghai' } }] };
  const month = service.queryGroups(table.id, { groupBy, filter }); assert.equal(month.totalRecords, 2);
  now = new Date('2026-12-01T00:00:00Z');
  assert.throws(() => service.queryGroups(table.id, { groupBy, filter, expectedDateContext: month.dateContext }), /relative date range changed/);
  assert.equal(service.queryGroups(table.id, { groupBy, filter }).totalRecords, 0);
});

test('nested null leaves share their root headings with configured empty seeds', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Null leaves' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'a', name: 'A' }, { id: 'empty', name: 'Empty' }] });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Done', type: 'checkbox' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Number', type: 'number' });
  const [, status, done, number] = table.fields.map(field => field.id) as [string, string, string, string];
  const records = service.createRecords(table.id, [
    { values: { [status]: 'a', [done]: null, [number]: null } },
    { values: { [status]: 'a', [done]: false, [number]: 0 } },
    { values: { [status]: null, [done]: null, [number]: null } },
  ]).records;
  const groupBy = [status, done, number];
  const layout = service.queryGroups(table.id, { groupBy, measures: [{ fieldId: number, operation: 'sum' }] });
  assert.equal(layout.totalGroups, 9); assert.equal(layout.totalRows, 12); assert.equal(layout.totalRecords, 3);
  assert.deepEqual(layout.groups.map(group => group.path), [
    ['a'], ['a', false], ['a', false, 0], ['a', null], ['a', null, null], ['empty'], [null], [null, null], [null, null, null],
  ]);
  assert.deepEqual(layout.groups.filter(group => group.path!.length === 1).map(group => [group.count, group.values]), [[2, [0]], [0, [null]], [1, [null]]]);
  assert.deepEqual(service.queryRecords(table.id, { groupBy }).records.map(record => record.id), [records[1]!.id, records[0]!.id, records[2]!.id]);
  const collapse = { defaultCollapsed: true, exceptions: [['a'], ['a', null], ['a', null, null]] };
  const sparse = service.queryGroups(table.id, { groupBy, collapse, window: 'expandedRecords' });
  assert.equal(sparse.totalGroups, 6); assert.equal(sparse.totalRows, 7);
  assert.deepEqual(sparse.groups.map(group => [group.path, group.count, group.recordOffset, group.rowStart]), [[['a', null, null], 1, 1, 3]]);
});

test('nested measures retain the count snapshot when another connection commits between reads', t => {
  const { data, service, table, groupBy, measures, records, amount } = setup(t);
  const reader = new DatabaseSync(data.path), prepare = reader.prepare.bind(reader);
  let reads = 0;
  reader.prepare = sql => {
    if (++reads === 2) {
      service.updateBatch([{ id: records[0]!.id, expectedVersion: records[0]!.version, values: { [amount]: 100 } }], table.id);
      service.createRecords(table.id, [{ values: { [groupBy[0]!]: 'a', [groupBy[1]!]: 'Same', [groupBy[2]!]: 0, [amount]: 200 } }]);
    }
    return prepare(sql);
  };
  const snapshot = service.getTable(table.id);
  reader.exec('BEGIN');
  try {
    const layout = nestedGroupLayout(reader, snapshot, groupBy.map(id => table.fields.find(field => field.id === id)!),
      { defaultCollapsed: false, exceptions: [] }, 'r.table_id = :table', { ':table': table.id }, 0, 100, 'displayRows', measures);
    assert.equal(reads, 2); assert.equal(layout.totalRecords, 6); assert.equal(layout.revision, snapshot.revision);
    assert.deepEqual(layout.groups.find(group => JSON.stringify(group.path) === '["a"]')!.values, [17, 4.25]);
    assert.deepEqual(layout.groups.find(group => JSON.stringify(group.path) === '["a","Same",0]')!.values, [5, 2.5]);
  } finally { reader.exec('ROLLBACK'); reader.close(); }
  const fresh = service.queryGroups(table.id, { groupBy, measures });
  assert.equal(fresh.totalRecords, 7);
  assert.deepEqual(fresh.groups.find(group => JSON.stringify(group.path) === '["a"]')!.values, [315, 63]);
  assert.throws(() => service.queryGroups(table.id, { groupBy, expectedRevision: snapshot.revision }), { code: 'DATA_CHANGED' });
});

test('parent numeric measures use complete SQLite aggregates across many distinct leaves', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Complete numeric measures' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Leaf', type: 'number' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const [root, leaf, amount] = table.fields.map(field => field.id) as [string, string, string];
  service.createRecords(table.id, [1e16, 1, -1e16, 0.5, -0.25].map((value, index) => ({ values: { [root]: 'A', [leaf]: index, [amount]: value } })));
  const measures: SummaryMeasure[] = ['sum', 'average', 'min', 'max'].map(operation => ({ fieldId: amount, operation: operation as SummaryMeasure['operation'] }));
  const expected = service.summarizeRecords(table.id, { measures }).totals.values;
  assert.deepEqual(expected, [1.25, 0.25, -1e16, 1e16]);
  for (const collapse of [{ defaultCollapsed: false, exceptions: [] }, { defaultCollapsed: false, exceptions: [['A']] }]) {
    const result = service.queryGroups(table.id, { groupBy: [root, leaf], measures, collapse, limit: 1 });
    assert.deepEqual(result.groups[0]!.values, expected);
    assert.equal(result.groups[0]!.count, 5);
  }
});
