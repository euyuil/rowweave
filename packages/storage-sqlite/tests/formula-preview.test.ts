import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import type { Field } from '../../contracts/src/index.js';

test('formula previews use real saved records and leave all committed workspace data unchanged', t => {
  const data = fixture(t, null), service = new RecordService(data.open());
  let table = service.createTable({ name: 'Preview calculations' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const amount = table.fields[1]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Doubled', type: 'formula',
    formula: { expression: '[' + amount + '] * 2', resultType: 'number' } });
  const doubled = table.fields[2]!.id;
  table = service.updateTable(table.id, { expectedVersion: table.version, primaryFieldId: doubled });
  const rows = service.createRecords(table.id, [3, 0, null].map(value => ({ values: { [amount]: value } }))).records;
  const observer = new DatabaseSync(data.path);
  try {
    const before = observer.prepare('PRAGMA data_version').get();
    const preview = (expression: string, resultType: NonNullable<Field['formula']>['resultType'] = 'number', recordId?: string, fieldId?: string) =>
      service.previewFormula(table.id, { expectedVersion: table.version, formula: { expression, resultType }, ...(recordId ? { recordId } : {}), ...(fieldId ? { fieldId } : {}) });
    assert.deepEqual(preview('[' + amount + '] * 4', 'number', undefined, doubled).sample,
      { id: rows[0]!.id, version: rows[0]!.version, label: '6', value: 12 });
    assert.equal(preview('[' + doubled + '] + 1').sample!.value, 7);
    assert.equal(preview('[' + amount + ']', 'number', rows[2]!.id).sample!.value, null);
    assert.match(preview('1 / [' + amount + ']', 'number', rows[1]!.id).sample!.error!, /zero/);
    assert.match(preview('"text"').sample!.error!, /number result/);
    assert.equal(preview('ARRAYSUM(ARRAY(1, 2, NULL))').sample!.value, 3);
    assert.equal(preview('DATEADD(DATE(2024, 1, 31), 1, "month")', 'date').sample!.value, '2024-02-29');
    assert.throws(() => preview('[' + doubled + '] + 1', 'number', undefined, doubled), /cycle/);
    assert.throws(() => preview('[' + amount + '] +'), { code: 'INVALID_FORMULA' });
    assert.throws(() => preview('[missing]'), { code: 'INVALID_FORMULA' });
    assert.deepEqual(observer.prepare('PRAGMA data_version').get(), before, 'Previews must not commit any schema, value, view, history or sequence writes.');
    assert.deepEqual(service.queryRecords(table.id, {}).records, rows);
  } finally { observer.close(); }
  table = service.updateField(table.id, doubled, { expectedVersion: table.version,
    formula: { expression: '[' + amount + '] * 4', resultType: 'number' } });
  assert.equal(service.getRecord(table.id, rows[0]!.id).values[doubled], 12);
});

test('empty-table previews validate drafts, schema versions, IDs and the existing-field boundary', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Empty' });
  const input = { expectedVersion: table.version, formula: { expression: '1 / 0', resultType: 'number' } };
  assert.deepEqual(service.previewFormula(table.id, input), { tableId: table.id, schemaVersion: table.version, formula: input.formula, sample: null });
  for (const expression of ['', '1 +', 'UNSUPPORTED(1)', '[missing]', '1'.repeat(4097)]) {
    assert.throws(() => service.previewFormula(table.id, { ...input, formula: { ...input.formula, expression } }), { code: 'INVALID_FORMULA' });
  }
  for (const change of [{ expectedVersion: 0 }, { recordId: '' }, { recordId: 3 }, { recordId: 'x'.repeat(201) }, { fieldId: null }, { formula: null }, { formula: { expression: 1, resultType: 'number' } }]) {
    assert.throws(() => service.previewFormula(table.id, { ...input, ...change }), { code: 'INVALID_SCHEMA' });
  }
  assert.throws(() => service.previewFormula(table.id, { ...input, fieldId: 'missing' }), { code: 'FIELD_NOT_FOUND' });
  assert.throws(() => service.previewFormula(table.id, { ...input, fieldId: table.primaryFieldId }), { code: 'INVALID_SCHEMA' });
  assert.throws(() => service.previewFormula(table.id, { ...input, recordId: 'missing' }), { code: 'RECORD_NOT_FOUND' });
  const other = service.createTable({ name: 'Other' });
  const foreign = service.createRecords(other.id, [{ values: {} }]).records[0]!;
  assert.throws(() => service.previewFormula(table.id, { ...input, recordId: foreign.id }), { code: 'RECORD_NOT_FOUND' });
  table = service.updateTable(table.id, { expectedVersion: table.version, name: 'Renamed' });
  assert.throws(() => service.previewFormula(table.id, input), { code: 'SCHEMA_CONFLICT' });
  const row = service.createRecords(table.id, [{ values: {} }]).records[0]!;
  service.deleteRecords(table.id, [{ id: row.id, expectedVersion: row.version }]);
  assert.throws(() => service.previewFormula(table.id, { ...input, expectedVersion: table.version, recordId: row.id }), { code: 'RECORD_NOT_FOUND' });
});

test('preview hydrates linked inputs, propagates errors and rejects cross-table cycles before saving', t => {
  const service = new RecordService(fixture(t, null).open());
  let target = service.createTable({ name: 'Items' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'formula', formula: { expression: '7', resultType: 'number' } });
  const amount = target.fields[1]!.id;
  let source = service.createTable({ name: 'Summary' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Items', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = source.fields[1]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Amounts', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount } });
  const lookup = source.fields[2]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Total', type: 'formula', formula: { expression: 'ARRAYSUM([' + lookup + '])', resultType: 'number' } });
  const total = source.fields[3]!.id;
  const item = service.createRecords(target.id, [{ values: {} }]).records[0]!;
  const record = service.createRecords(source.id, [{ values: { [link]: [item.id] } }]).records[0]!;
  const preview = (expression: string) => service.previewFormula(source.id, { expectedVersion: service.getTable(source.id).version, recordId: record.id, formula: { expression, resultType: 'number' } });
  assert.equal(preview('ARRAYSUM([' + lookup + ']) + ARRAYLEN([' + link + '])').sample!.value, 8);
  target = service.updateField(target.id, amount, { expectedVersion: target.version, formula: { expression: '1 / 0', resultType: 'number' } });
  assert.match(preview('ARRAYCOUNT([' + lookup + '])').sample!.error!, /referenced calculation/);
  assert.match(preview('[' + total + '] + 1').sample!.error!, /referenced calculation/);
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Summaries', type: 'relation', relation: { tableId: source.id, multiple: true } });
  const back = target.fields.at(-1)!.id;
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Summary totals', type: 'lookup', lookup: { relationFieldId: back, fieldId: total, operation: 'sum' } });
  const backward = target.fields.at(-1)!.id;
  const input = { expectedVersion: target.version, formula: { expression: '[' + backward + ']', resultType: 'number' } };
  assert.throws(() => service.previewFormula(target.id, { ...input, fieldId: amount }), /dependency cycle/);
  assert.throws(() => service.updateField(target.id, amount, input), /dependency cycle/);
  assert.deepEqual(service.getTable(target.id), target);
});

test('preview and save enforce numeric lookup and local or linked saved-view constraints equally', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Amounts' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'formula', formula: { expression: '1', resultType: 'number' } });
  const amount = table.fields[1]!.id;
  let source = service.createTable({ name: 'Linked amounts' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Items', type: 'relation', relation: { tableId: table.id, multiple: true } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Sum', type: 'lookup', lookup: { relationFieldId: source.fields[1]!.id, fieldId: amount, operation: 'sum' } });
  const assertBoth = (code: string) => {
    const input = { expectedVersion: table.version, formula: { expression: '"text"', resultType: 'text' } };
    assert.throws(() => service.previewFormula(table.id, { ...input, fieldId: amount }), { code });
    assert.throws(() => service.updateField(table.id, amount, input), { code });
  };
  assertBoth('LOOKUP_DEPENDENCY');
  source = service.updateField(source.id, source.fields[2]!.id, { expectedVersion: source.version,
    lookup: { relationFieldId: source.fields[1]!.id, fieldId: amount, operation: 'values' } });
  const linkedView = service.createView(source.id, { name: 'Contains amount', query: { filter: { conjunction: 'and', conditions: [
    { fieldId: source.fields[2]!.id, operator: 'gt', value: 1 },
  ] } } });
  assertBoth('VIEW_DEPENDENCY');
  service.deleteView(source.id, linkedView.id, { expectedVersion: linkedView.version });
  service.createView(table.id, { name: 'Positive', query: { filter: { conjunction: 'and', conditions: [
    { fieldId: amount, operator: 'gt', value: 0 },
  ] } } });
  assertBoth('VIEW_DEPENDENCY');
});
