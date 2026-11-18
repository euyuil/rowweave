import { workspaceFormat } from '../src/migrations.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { lookupElementField, valueField, type FieldCreate } from '../../contracts/src/index.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { cellDisplay, cellText } from '../../client/src/cell-values.js';
import { filterOperators } from '../../ui/src/filter-draft.js';
import { selectedOptions } from '../../ui/src/select-colors.js';
import { fixture } from './helpers.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { SqliteRecordStore } from '../src/record-store.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;

function setup(t: Parameters<typeof fixture>[0], clock?: () => Date) {
  const data = fixture(t, null, clock), store = data.open(), service = new RecordService(store);
  const leaf = service.createTable({ name: 'Items' });
  const middle = service.createTable({ name: 'Collections' });
  const root = service.createTable({ name: 'Portfolios' });
  const add = (tableId: string, field: Omit<FieldCreate, 'expectedVersion'>) => service.createField(tableId, {
    ...field, expectedVersion: service.getTable(tableId).version,
  }).fields.at(-1)!;
  const innerLink = add(middle.id, { name: 'Items', type: 'relation', relation: { tableId: leaf.id, multiple: true } });
  const outerLink = add(root.id, { name: 'Collections', type: 'relation', relation: { tableId: middle.id, multiple: true } });
  const inner = (fieldId: string, operation?: 'sum' | 'count') => add(middle.id, { name: 'Inner ' + fieldId, type: 'lookup',
    lookup: { relationFieldId: innerLink.id, fieldId, ...(operation ? { operation } : {}) } });
  const outer = (fieldId: string, operation?: 'sum' | 'count' | 'average' | 'min' | 'max') => add(root.id, { name: 'Outer ' + fieldId, type: 'lookup',
    lookup: { relationFieldId: outerLink.id, fieldId, ...(operation ? { operation } : {}) } });
  return { data, store, service, leaf, middle, root, add, innerLink, outerLink, inner, outer };
}

test('chained lookup values flatten in link order and summaries use numeric members without losing types', t => {
  const { service, leaf, middle, root, add, innerLink, outerLink, inner, outer } = setup(t);
  const amount = add(leaf.id, { name: 'Amount', type: 'number', numberFormat: 'currency', currency: 'USD' });
  const flag = add(leaf.id, { name: 'Flag', type: 'checkbox' });
  const amountValues = inner(amount.id), flags = inner(flag.id), names = inner(leaf.primaryFieldId);
  const total = inner(amount.id, 'sum'), count = inner(amount.id, 'count');
  const rootAmounts = outer(amountValues.id), rootFlags = outer(flags.id), rootNames = outer(names.id);
  const rootTotals = outer(total.id), rootCounts = outer(count.id);
  const summaries = ['sum', 'count', 'average', 'min', 'max'].map(operation => outer(amountValues.id, operation as 'sum'));
  const totalOfTotals = outer(total.id, 'sum');
  const leaves = service.createRecords(leaf.id, [
    { values: { [leaf.primaryFieldId]: '1', [amount.id]: 2, [flag.id]: true } },
    { values: { [leaf.primaryFieldId]: '中文', [amount.id]: 0, [flag.id]: false } },
    { values: {} },
  ]).records;
  const middles = service.createRecords(middle.id, [[leaves[0]!.id, leaves[1]!.id], [leaves[2]!.id, leaves[0]!.id], []]
    .map(ids => ({ values: { [innerLink.id]: ids } }))).records;
  const [record, empty] = service.createRecords(root.id, [{ values: { [outerLink.id]: [middles[1]!.id, middles[2]!.id, middles[0]!.id] } }, { values: {} }]).records;
  assert.deepEqual(record!.values[rootAmounts.id], [null, 2, 2, 0]);
  assert.deepEqual(record!.values[rootFlags.id], [null, true, true, false]);
  assert.deepEqual(record!.values[rootNames.id], [null, '1', '1', '中文']);
  assert.deepEqual(record!.values[rootTotals.id], [2, null, 2]);
  assert.deepEqual(record!.values[rootCounts.id], [1, 0, 2]);
  assert.deepEqual(summaries.map(field => record!.values[field.id]), [4, 3, 4 / 3, 0, 2]);
  assert.equal(record!.values[totalOfTotals.id], 4);
  assert.deepEqual(empty!.values[rootAmounts.id], []);
  assert.deepEqual(summaries.map(field => empty!.values[field.id]), [null, 0, null, null, null]);
  const schema = service.getTable(root.id);
  assert.equal(schema.fields.find(field => field.id === rootAmounts.id)!.lookupResult!.lookupResult!.currency, 'USD');
  const page = service.queryRecords(root.id, { limit: 1 });
  service.updateBatch([{ id: leaves[0]!.id, expectedVersion: leaves[0]!.version, values: { [amount.id]: 5 } }], leaf.id);
  assert.deepEqual(service.getRecord(root.id, record!.id).values[rootAmounts.id], [null, 5, 5, 0]);
  assert.throws(() => service.queryRecords(root.id, { offset: 1, expectedRevision: page.revision }), (error: unknown) => error instanceof ServiceError && error.code === 'DATA_CHANGED');
});

test('chained lookup schemas reject pure and mixed cycles while allowing table cycles without field cycles', t => {
  const { service, leaf, middle, root, add, inner, outer } = setup(t);
  const amount = add(leaf.id, { name: 'Amount', type: 'number' });
  const innerValues = inner(amount.id), values = outer(innerValues.id);
  const back = add(leaf.id, { name: 'Portfolios', type: 'relation', relation: { tableId: root.id, multiple: true } });
  const backValues = add(leaf.id, { name: 'Portfolio amounts', type: 'lookup', lookup: { relationFieldId: back.id, fieldId: values.id } });
  const formula = add(leaf.id, { name: 'Portfolio sum', type: 'formula', formula: { resultType: 'number', expression: `ARRAYSUM([${JSON.stringify(backValues.id)}])` } });
  const tables = () => [leaf, middle, root].map(table => service.getTable(table.id));
  const before = tables();
  for (const fieldId of [backValues.id, formula.id]) {
    assert.throws(() => service.updateField(middle.id, innerValues.id, { expectedVersion: service.getTable(middle.id).version,
      lookup: { ...innerValues.lookup!, fieldId } }), code('INVALID_FORMULA'));
    assert.deepEqual(tables(), before);
  }
  assert.equal(lookupElementField(service.getTable(leaf.id).fields.find(field => field.id === backValues.id)!).type, 'number');
  assert.throws(() => service.deleteField(middle.id, innerValues.id, { expectedVersion: service.getTable(middle.id).version }), code('LOOKUP_DEPENDENCY'));
  service.updateField(leaf.id, amount.id, { expectedVersion: service.getTable(leaf.id).version, name: 'Renamed amount' });
  tables().forEach((table, index) => assert.equal(table.version, before[index]!.version + 1));
});

test('same-table lookup cycles return domain errors without mutating schema or records', t => {
  const { service, leaf, add } = setup(t);
  const amount = add(leaf.id, { name: 'Amount', type: 'number' });
  const link = add(leaf.id, { name: 'Related', type: 'relation', relation: { tableId: leaf.id, multiple: true } });
  const first = add(leaf.id, { name: 'First', type: 'lookup', lookup: { relationFieldId: link.id, fieldId: amount.id } });
  const second = add(leaf.id, { name: 'Second', type: 'lookup', lookup: { relationFieldId: link.id, fieldId: first.id } });
  const item = service.createRecords(leaf.id, [{ values: { [amount.id]: 5 } }]).records[0]!;
  service.createRecords(leaf.id, [{ values: { [link.id]: [item.id] } }]);
  const schema = service.getTable(leaf.id), page = service.queryRecords(leaf.id, {});
  for (const fieldId of [first.id, second.id]) {
    assert.throws(() => service.updateField(leaf.id, first.id, { expectedVersion: schema.version,
      lookup: { relationFieldId: link.id, fieldId } }), code('INVALID_FORMULA'));
    assert.deepEqual(service.getTable(leaf.id), schema);
    assert.deepEqual(service.queryRecords(leaf.id, {}), page);
  }
});

test('changing an intermediate lookup operation updates result shape, formulas and saved summary queries', t => {
  const { service, leaf, middle, root, add, innerLink, outerLink, inner, outer } = setup(t);
  const amount = add(leaf.id, { name: 'Amount', type: 'number' }), first = inner(amount.id), second = outer(first.id), sum = outer(first.id, 'sum');
  const length = add(root.id, { name: 'Length', type: 'formula', formula: { expression: `ARRAYLEN([${JSON.stringify(second.id)}])`, resultType: 'number' } });
  const items = service.createRecords(leaf.id, [3, 5].map(value => ({ values: { [amount.id]: value } }))).records;
  const collection = service.createRecords(middle.id, [{ values: { [innerLink.id]: items.map(record => record.id) } }]).records[0]!;
  const record = service.createRecords(root.id, [{ values: { [outerLink.id]: [collection.id] } }]).records[0]!;
  assert.deepEqual(record.values[second.id], [3, 5]); assert.equal(record.values[length.id], 2);
  const view = service.createView(root.id, { name: 'Totals', groupBy: sum.id, query: { sort: [{ fieldId: sum.id, direction: 'desc' }] } });
  service.updateField(middle.id, first.id, { expectedVersion: service.getTable(middle.id).version, lookup: { ...first.lookup!, operation: 'sum' } });
  const after = service.getRecord(root.id, record.id);
  assert.deepEqual(after.values[second.id], [8]); assert.equal(after.values[length.id], 1); assert.equal(after.version, record.version + 1);
  assert.equal(service.queryView(root.id, view.id, {}).records[0]!.values[sum.id], 8);
  const before = service.getTable(root.id);
  assert.throws(() => service.updateField(root.id, sum.id, { expectedVersion: before.version, lookup: { ...sum.lookup!, operation: 'values' } }), code('VIEW_DEPENDENCY'));
  assert.deepEqual(service.getTable(root.id), before);
});

test('chained date and boolean members retain typed filters and CSV output', t => {
  const { service, leaf, middle, root, add, innerLink, outerLink, inner, outer } = setup(t, () => new Date('2026-11-16T12:00:00Z'));
  const date = add(leaf.id, { name: 'Date', type: 'date' }), flag = add(leaf.id, { name: 'Flag', type: 'checkbox' });
  const dates = outer(inner(date.id).id), flags = outer(inner(flag.id).id);
  const items = service.createRecords(leaf.id, [
    { values: { [date.id]: '2026-11-15', [flag.id]: false } }, { values: { [date.id]: '2026-11-16', [flag.id]: true } },
  ]).records;
  const collection = service.createRecords(middle.id, [{ values: { [innerLink.id]: items.map(record => record.id) } }]).records[0]!;
  const record = service.createRecords(root.id, [{ values: { [outerLink.id]: [collection.id] } }]).records[0]!;
  for (const condition of [
    { fieldId: flags.id, operator: 'eq', value: false },
    { fieldId: dates.id, operator: 'gte', value: '2026-11-16' },
    { fieldId: dates.id, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } },
  ]) assert.deepEqual(service.queryRecords(root.id, { filter: { conjunction: 'and', conditions: [condition] } }).records.map(record => record.id), [record.id]);
  const csv = service.exportCsv(root.id, {});
  assert.match(csv, /2026-11-15/); assert.match(csv, /2026-11-16/); assert.match(csv, /\[false,true\]/);
});

test('numeric result changes and saved view operands are validated through every lookup level atomically', t => {
  const { service, leaf, middle, root, add, inner, outer } = setup(t);
  const formula = add(leaf.id, { name: 'Value', type: 'formula', formula: { expression: '1', resultType: 'number' } });
  const values = inner(formula.id), outerValues = outer(values.id), sum = outer(values.id, 'sum');
  const tables = () => [leaf, middle, root].map(table => service.getTable(table.id));
  let before = tables();
  const change = () => service.updateField(leaf.id, formula.id, { expectedVersion: service.getTable(leaf.id).version, formula: { expression: '"text"', resultType: 'text' } });
  assert.throws(change, code('LOOKUP_DEPENDENCY')); assert.deepEqual(tables(), before);
  service.deleteField(root.id, sum.id, { expectedVersion: service.getTable(root.id).version });
  const view = service.createView(root.id, { name: 'Numeric filter', query: { filter: { conjunction: 'and', conditions: [{ fieldId: outerValues.id, operator: 'gt', value: 0 }] } } });
  before = tables();
  assert.throws(change, code('VIEW_DEPENDENCY')); assert.deepEqual(tables(), before);
  service.deleteView(root.id, view.id, { expectedVersion: view.version });
  change();
  const after = tables();
  after.forEach((table, index) => assert.equal(table.version, before[index]!.version + 1));
  assert.equal(lookupElementField(after[2]!.fields.find(field => field.id === outerValues.id)!).type, 'text');
  assert.deepEqual(filterOperators(after[2]!.fields.find(field => field.id === outerValues.id)!), ['eq', 'neq', 'contains', 'isEmpty', 'isNotEmpty']);
});

test('nested select and attachment values retain labels, colors, owning tables and query behavior', t => {
  const { service, leaf, middle, root, add, innerLink, outerLink, inner, outer } = setup(t);
  const tags = add(leaf.id, { name: 'Tags', type: 'multiSelect', options: [{ id: 'blue', name: '蓝色', color: '#315CBE' }, { id: 'red', name: 'Red' }, { id: 'unused', name: 'Unused' }] });
  const files = add(leaf.id, { name: 'Files', type: 'attachment' });
  const tagValues = inner(tags.id), fileValues = inner(files.id);
  const rootTags = outer(tagValues.id), rootFiles = outer(fileValues.id);
  const file = service.uploadAttachment(leaf.id, { filename: 'chain.txt', mediaType: 'text/plain', data: Buffer.from('Chained file').toString('base64') });
  const item = service.createRecords(leaf.id, [{ values: { [tags.id]: ['blue', 'red'], [files.id]: [file.id] } }]).records[0]!;
  const collection = service.createRecords(middle.id, [{ values: { [innerLink.id]: [item.id] } }]).records[0]!;
  const record = service.createRecords(root.id, [{ values: { [outerLink.id]: [collection.id] } }]).records[0]!;
  const schema = service.getTable(root.id), tagsField = schema.fields.find(field => field.id === rootTags.id)!;
  assert.equal(cellDisplay(tagsField, record.values[rootTags.id]), '蓝色, Red');
  assert.equal(cellText(tagsField, record.values[rootTags.id]), '["蓝色","Red"]');
  assert.deepEqual(selectedOptions(tagsField, record.values[rootTags.id])?.map(option => option.color), ['#315CBE', undefined]);
  assert.deepEqual(filterOperators(tagsField), ['hasAny', 'isEmpty', 'isNotEmpty']);
  assert.deepEqual(record.attachments![rootFiles.id]!.map(file => [file.filename, file.tableId]), [['chain.txt', leaf.id]]);
  const filesField = schema.fields.find(field => field.id === rootFiles.id)!;
  assert.equal(filesField.lookupResultTableId, middle.id);
  assert.equal(filesField.lookupResult!.lookupResultTableId, leaf.id);
  assert.equal(cellDisplay(filesField, record.values[rootFiles.id]), '1 file');
  for (const input of [{ search: '蓝色' }, { search: 'chain.txt' }, { filter: { conjunction: 'and', conditions: [{ fieldId: rootTags.id, operator: 'hasAny', value: ['red'] }] } }]) {
    assert.equal(service.queryRecords(root.id, input).total, 1);
  }
  const view = service.createView(root.id, { name: 'Unused option', query: { filter: { conjunction: 'and', conditions: [{ fieldId: rootTags.id, operator: 'hasAny', value: ['unused'] }] } } });
  const before = service.getTable(root.id);
  assert.throws(() => service.updateField(leaf.id, tags.id, { expectedVersion: service.getTable(leaf.id).version, options: tags.options!.slice(0, 2) }), code('VIEW_DEPENDENCY'));
  assert.deepEqual(service.getTable(root.id), before);
  service.deleteView(root.id, view.id, { expectedVersion: view.version });
  service.updateField(leaf.id, tags.id, { expectedVersion: service.getTable(leaf.id).version, options: tags.options!.map(option => ({ ...option, name: option.name + ' renamed' })) });
  assert.equal(cellText(service.getTable(root.id).fields.find(field => field.id === rootTags.id)!, record.values[rootTags.id]), '["蓝色 renamed","Red renamed"]');
});

test('chained arrays report their calculation limit without exposing a silently truncated value', t => {
  const { service, leaf, middle, root, add, innerLink, outerLink, inner, outer } = setup(t);
  const amount = add(leaf.id, { name: 'Amount', type: 'number' }), middleValues = inner(amount.id), rootValues = outer(middleValues.id);
  const items = service.createRecords(leaf.id, Array.from({ length: 200 }, () => ({ values: { [amount.id]: 1 } }))).records;
  const itemIds = items.map(record => record.id);
  const collections = service.createRecords(middle.id, Array.from({ length: 200 }, () => ({ values: { [innerLink.id]: itemIds } }))).records;
  const extraCollection = service.createRecords(middle.id, [{ values: { [innerLink.id]: [itemIds[0]!] } }]).records[0]!;
  const portfolios = service.createRecords(root.id, [
    { values: { [outerLink.id]: collections.map(record => record.id) } }, { values: { [outerLink.id]: [extraCollection.id] } },
  ]).records;
  assert.equal((portfolios[0]!.values[rootValues.id] as unknown[]).length, 40_000);
  const report = service.createTable({ name: 'Report' });
  const links = add(report.id, { name: 'Portfolios', type: 'relation', relation: { tableId: root.id, multiple: true } });
  const values = add(report.id, { name: 'All amounts', type: 'lookup', lookup: { relationFieldId: links.id, fieldId: rootValues.id } });
  const count = add(report.id, { name: 'Count', type: 'lookup', lookup: { relationFieldId: links.id, fieldId: rootValues.id, operation: 'count' } });
  const record = service.createRecords(report.id, [{ values: { [links.id]: portfolios.map(record => record.id) } }]).records[0]!;
  assert.equal(record.values[values.id], null);
  assert.match(record.formulaErrors![values.id]!, /40,000/);
  assert.equal(record.values[count.id], 40_001);
  service.updateBatch([{ id: record.id, expectedVersion: record.version, values: { [links.id]: [portfolios[0]!.id] } }], report.id);
  const recovered = service.getRecord(report.id, record.id);
  assert.equal((recovered.values[values.id] as unknown[]).length, 40_000);
  assert.equal(recovered.formulaErrors?.[values.id], undefined);
});

test('deep mixed lookup chains preserve results without a small artificial depth limit', t => {
  const { service, leaf, add } = setup(t);
  let table = leaf;
  let field = add(table.id, { name: 'Amount', type: 'number' });
  let record = service.createRecords(table.id, [{ values: { [field.id]: 7 } }]).records[0]!;
  for (let index = 0; index < 16; index++) {
    const next = service.createTable({ name: `Level ${index + 1}` });
    const link = add(next.id, { name: 'Previous', type: 'relation', relation: { tableId: table.id, multiple: true } });
    field = add(next.id, { name: 'Result', type: 'lookup', lookup: { relationFieldId: link.id, fieldId: field.id, ...(index % 2 ? { operation: 'sum' as const } : {}) } });
    record = service.createRecords(next.id, [{ values: { [link.id]: [record.id] } }]).records[0]!;
    assert.deepEqual(record.values[field.id], index % 2 ? 7 : [7]);
    table = next;
  }
  assert.equal(service.queryRecords(table.id, { filter: { conjunction: 'and', conditions: [{ fieldId: field.id, operator: 'eq', value: 7 }] } }).total, 1);
});

test('linked errors and recovery propagate through lookup arrays, summaries and downstream formulas once', t => {
  const { service, leaf, middle, root, add, innerLink, outerLink, inner, outer } = setup(t);
  const divisor = add(leaf.id, { name: 'Divisor', type: 'number' });
  const quotient = add(leaf.id, { name: 'Quotient', type: 'formula', formula: { expression: `10 / [${JSON.stringify(divisor.id)}]`, resultType: 'number' } });
  const middleValues = inner(quotient.id), values = outer(middleValues.id), sum = outer(middleValues.id, 'sum');
  const formula = add(root.id, { name: 'Calculated total', type: 'formula', formula: { expression: `ARRAYSUM([${JSON.stringify(values.id)}])`, resultType: 'number' } });
  const item = service.createRecords(leaf.id, [{ values: { [divisor.id]: 0 } }]).records[0]!;
  const collection = service.createRecords(middle.id, [{ values: { [innerLink.id]: [item.id] } }]).records[0]!;
  const record = service.createRecords(root.id, [{ values: { [outerLink.id]: [collection.id] } }]).records[0]!;
  assert.deepEqual(record.values[values.id], [null]);
  assert.equal(record.values[sum.id], null);
  for (const field of [values, sum, formula]) assert.ok(record.formulaErrors?.[field.id]);
  service.updateBatch([{ id: item.id, expectedVersion: item.version, values: { [divisor.id]: 2 } }], leaf.id);
  const after = service.getRecord(root.id, record.id);
  assert.deepEqual(after.values[values.id], [5]); assert.equal(after.values[sum.id], 5); assert.equal(after.values[formula.id], 5);
  for (const field of [values, sum, formula]) assert.equal(after.formulaErrors?.[field.id], undefined);
  assert.equal(after.version, record.version + 1);
  assert.equal(valueField(service.getTable(root.id).fields.find(field => field.id === sum.id)!).type, 'number');
});

test('chained summaries report numeric overflow and keep numeric formatting across scalar and array targets', t => {
  const { service, leaf, middle, root, add, innerLink, outerLink, inner, outer } = setup(t);
  const amount = add(leaf.id, { name: 'Amount', type: 'number', numberFormat: 'currency', currency: 'USD', precision: 2 });
  const innerValues = inner(amount.id), innerSum = inner(amount.id, 'sum'), innerCount = inner(amount.id, 'count');
  const sum = outer(innerValues.id, 'sum'), values = outer(innerSum.id), counts = outer(innerCount.id), sumOfCounts = outer(innerCount.id, 'sum');
  const items = service.createRecords(leaf.id, [1e308, 1e308].map(value => ({ values: { [amount.id]: value } }))).records;
  const collection = service.createRecords(middle.id, [{ values: { [innerLink.id]: items.map(record => record.id) } }]).records[0]!;
  const record = service.createRecords(root.id, [{ values: { [outerLink.id]: [collection.id] } }]).records[0]!;
  assert.equal(record.values[sum.id], null); assert.match(record.formulaErrors![sum.id]!, /numeric range/);
  assert.deepEqual(record.values[values.id], [null]); assert.match(record.formulaErrors![values.id]!, /numeric range/);
  assert.deepEqual(record.values[counts.id], [2]); assert.equal(record.formulaErrors?.[counts.id], undefined);
  const schema = service.getTable(root.id), summary = schema.fields.find(field => field.id === sum.id)!;
  assert.equal(cellDisplay(summary, 2), '$2.00');
  assert.equal(cellDisplay(schema.fields.find(field => field.id === sumOfCounts.id)!, 2), '2');
  service.updateBatch(items.map(record => ({ id: record.id, expectedVersion: record.version, values: { [amount.id]: 3 } })), leaf.id);
  const recovered = service.getRecord(root.id, record.id);
  assert.equal(recovered.values[sum.id], 6); assert.deepEqual(recovered.values[values.id], [6]);
  assert.equal(recovered.formulaErrors?.[sum.id], undefined); assert.equal(recovered.formulaErrors?.[values.id], undefined);
});

test('Chained results and field definitions survive reopening and workspace backup', async t => {
  const { data, store, service, leaf, middle, root, add, innerLink, outerLink, inner } = setup(t);
  const amount = add(leaf.id, { name: 'Amount', type: 'number' }), first = inner(amount.id);
  const item = service.createRecords(leaf.id, [{ values: { [amount.id]: 3 } }]).records[0]!;
  const collection = service.createRecords(middle.id, [{ values: { [innerLink.id]: [item.id] } }]).records[0]!;
  const before = service.listTables(); store.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.listTables(), before);
  const schema = reopened.createField(root.id, { expectedVersion: reopened.getTable(root.id).version, name: 'Nested amount', type: 'lookup',
    lookup: { relationFieldId: outerLink.id, fieldId: first.id } });
  const field = schema.fields.at(-1)!;
  const record = reopened.createRecords(root.id, [{ values: { [outerLink.id]: [collection.id] } }]).records[0]!;
  assert.deepEqual(record.values[field.id], [3]);
  assert.deepEqual(new RecordService(data.open()).getRecord(root.id, record.id), record);
  const backup = data.path + '.backup', restored = data.path + '.restored';
  assert.equal((await backupWorkspace(data.path, backup)).version, workspaceFormat);
  await restoreWorkspace(backup, restored);
  const restoredStore = new SqliteRecordStore(restored, null);
  try {
    const restoredService = new RecordService(restoredStore);
    assert.deepEqual(restoredService.getRecord(root.id, record.id), record);
    assert.deepEqual(restoredService.getTable(root.id), reopened.getTable(root.id));
  } finally { restoredStore.close(); }
  const raw = new DatabaseSync(restored);
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get()!['user_version'], workspaceFormat);
    const saved = JSON.parse(raw.prepare('SELECT definition_json FROM fields WHERE id = ?').get(field.id)!['definition_json'] as string);
    assert.equal(saved.lookupResult, undefined); assert.equal(saved.lookupResultTableId, undefined);
  } finally { raw.close(); }
});
