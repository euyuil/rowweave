import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { compileFormulas, rewriteFormulaReferences } from '../../core/src/formulas.js';
import type { Field, Table } from '../../contracts/src/index.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Estimates' });
  for (const name of ['Quantity', 'Price']) table = service.createField(table.id, { expectedVersion: table.version, name, type: 'number' });
  const quantity = table.fields[1]!.id, price = table.fields[2]!.id;
  const formula = (name: string, expression: string, resultType = 'number'): Field => {
    table = service.createField(table.id, { expectedVersion: service.getTable(table.id).version, name, type: 'formula', formula: { expression, resultType } });
    return table.fields.at(-1)!;
  };
  return { data, store, service, table, quantity, price, formula };
}

test('formulas persist transactional results across writes, renames, schema edits, CSV import and reopen', t => {
  const { data, store, service, table, quantity, price, formula } = setup(t);
  const row = service.createRecords(table.id, [{ values: { [quantity]: 3, [price]: 120 } }]).records[0]!;
  const total = formula('Total', `[${quantity}] * [${price}]`);
  const discounted = formula('Discounted', `[${total.id}] * 0.8`);
  let read = service.getRecord(table.id, row.id);
  assert.equal(read.values[total.id], 360);
  assert.equal(read.values[discounted.id], 288);
  assert.throws(() => service.updateBatch([{ id: row.id, expectedVersion: row.version, values: { [quantity]: 4 } }], table.id), /changed/);
  read = service.updateBatch([{ id: row.id, expectedVersion: read.version, values: { [quantity]: 4 } }], table.id).records[0]!;
  assert.equal(read.values[discounted.id], 384);
  const previous = read.version;
  service.updateField(table.id, quantity, { expectedVersion: service.getTable(table.id).version, name: 'Hours' });
  assert.equal(service.getRecord(table.id, row.id).version, previous);
  service.updateField(table.id, total.id, { expectedVersion: service.getTable(table.id).version, formula: { expression: `[${quantity}] * [${price}] + 10`, resultType: 'number' } });
  read = service.getRecord(table.id, row.id);
  assert.equal(read.values[total.id], 490);
  assert.equal(read.values[discounted.id], 392);
  assert.equal(read.version, previous + 1);
  service.importCsv(table.id, { expectedVersion: service.getTable(table.id).version, hasHeader: true, csv: 'Hours,Price\n2,100\n' });
  assert.equal(service.queryRecords(table.id, { sort: [{ fieldId: total.id, direction: 'asc' }] }).records[0]!.values[discounted.id], 168);
  const before = service.queryRecords(table.id, {});
  store.close();
  assert.deepEqual(new RecordService(data.open()).queryRecords(table.id, {}), before);
});

test('formula errors are explicit, dependencies propagate errors, null is distinct and recovery is automatic', t => {
  const { service, table, quantity, price, formula } = setup(t);
  const ratio = formula('Ratio', `[${price}] / [${quantity}]`);
  const child = formula('Child', `[${ratio.id}] + 1`);
  const guarded = formula('Guarded', `IF([${quantity}] == 0, 0, [${price}] / [${quantity}])`);
  const rows = service.createRecords(table.id, [{ values: { [quantity]: 0, [price]: 10 } }, { values: { [quantity]: null, [price]: 10 } }]).records;
  assert.match(rows[0]!.formulaErrors![ratio.id]!, /zero/);
  assert.match(rows[0]!.formulaErrors![child.id]!, /referenced/);
  assert.equal(rows[0]!.values[guarded.id], 0);
  assert.equal(rows[1]!.values[ratio.id], null);
  assert.equal(rows[1]!.formulaErrors, undefined);
  assert.equal(service.queryRecords(table.id, { fields: [quantity] }).records[0]!.formulaErrors, undefined);
  assert.throws(() => service.exportCsv(table.id, {}), /formula error/);
  const changed = service.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [quantity]: 2 } }], table.id).records[0]!;
  assert.equal(changed.values[child.id], 6);
  assert.equal(changed.formulaErrors, undefined);
  assert.match(service.exportCsv(table.id, {}), /5,6,5/);
});

test('formula fields reject writes, defaults, invalid syntax, cycles and dangling references atomically', t => {
  const { service, table, quantity, formula } = setup(t);
  const first = formula('First', `[${quantity}] + 1`);
  const second = formula('Second', `[${first.id}] * 2`);
  const before = service.getTable(table.id);
  for (const expression of ['process.exit()', 'unknown(1)', '[missing]', 'IF(TRUE, 1)', '1 +', '1e309', '('.repeat(42) + '1' + ')'.repeat(42)]) {
    assert.throws(() => service.createField(table.id, { expectedVersion: before.version, name: 'Bad', type: 'formula', formula: { expression, resultType: 'number' } }));
    assert.deepEqual(service.getTable(table.id), before);
  }
  assert.throws(() => service.updateField(table.id, first.id, { expectedVersion: before.version, formula: { expression: `[${second.id}]`, resultType: 'number' } }), /cycle/);
  assert.throws(() => service.deleteField(table.id, quantity, { expectedVersion: before.version }), /dependent formulas/);
  assert.throws(() => service.createRecords(table.id, [{ values: { [first.id]: null } }]), /read-only/);
  const row = service.createRecords(table.id, [{ values: {} }]).records[0]!;
  assert.throws(() => service.updateBatch([{ id: row.id, expectedVersion: 1, values: { [first.id]: 2 } }], table.id), /read-only/);
  assert.throws(() => service.updateField(table.id, first.id, { expectedVersion: before.version, required: true }), /read-only/);
  assert.throws(() => service.updateField(table.id, first.id, { expectedVersion: before.version, defaultValue: 4 }), /read-only/);
  assert.throws(() => service.previewConversion(table.id, first.id, { expectedVersion: before.version, field: { name: 'Plain', type: 'number' } }), /cannot be converted/);
  service.deleteField(table.id, second.id, { expectedVersion: before.version });
  service.deleteField(table.id, first.id, { expectedVersion: before.version + 1 });
  assert.equal(service.getRecord(table.id, row.id).values[first.id], undefined);
});

test('formulas participate in full-set filters, numeric sorting, search, groups, saved indexes and linked labels', t => {
  const { service, table, quantity, price, formula } = setup(t);
  const total = formula('Total', `[${quantity}] * [${price}]`);
  const label = formula('Label', `CONCAT("Cost ", [${total.id}])`, 'text');
  const flag = formula('Large', `[${total.id}] > 100`, 'checkbox');
  const rows = service.createRecords(table.id, Array.from({ length: 505 }, (_, i) => ({ values: { [quantity]: i, [price]: 2 } }))).records;
  const view = service.createView(table.id, { name: 'Large', query: { filter: { conjunction: 'and', conditions: [{ fieldId: total.id, operator: 'gt', value: 1000 }] }, sort: [{ fieldId: total.id, direction: 'desc' }] } });
  const query = service.queryView(table.id, view.id, {});
  assert.equal(query.total, 4);
  assert.equal(query.records[0]!.values[total.id], 1008);
  assert.equal(service.queryRecords(table.id, { search: 'Cost 1008' }).total, 1);
  const summary = service.summarizeRecords(table.id, { groupBy: flag.id, measures: [{ fieldId: total.id, operation: 'sum' }] });
  assert.equal(summary.totals.values[0], 504 * 505);
  assert.equal(summary.groups.find(group => group.key === false)!.count, 51);
  service.updateTable(table.id, { expectedVersion: service.getTable(table.id).version, primaryFieldId: label.id });
  let linked = service.createTable({ name: 'Linked' });
  linked = service.createField(linked.id, { expectedVersion: linked.version, name: 'Estimate', type: 'relation', relation: { tableId: table.id, multiple: true } });
  const relation = linked.fields[1]!;
  linked = service.createField(linked.id, { expectedVersion: linked.version, name: 'Amounts', type: 'lookup', lookup: { relationFieldId: relation.id, fieldId: total.id } });
  const source = service.createRecords(linked.id, [{ values: { [relation.id]: [rows[504]!.id] } }]).records[0]!;
  assert.equal(source.links![relation.id]![0]!.label, 'Cost 1008');
  assert.deepEqual(source.values[linked.fields[2]!.id], [1008]);
  const page = service.queryRecords(linked.id, {});
  service.updateBatch([{ id: rows[504]!.id, expectedVersion: rows[504]!.version, values: { [price]: 3 } }], table.id);
  assert.throws(() => service.queryRecords(linked.id, { expectedRevision: page.revision }), /changed/);
  assert.deepEqual(service.getRecord(linked.id, source.id).values[linked.fields[2]!.id], [1512]);
});

test('source conversion recalculates values and errors without leaving stale formula data', t => {
  const { service, table, quantity, formula } = setup(t);
  const total = formula('Total', `[${quantity}] + 1`);
  const row = service.createRecords(table.id, [{ values: { [quantity]: 5 } }]).records[0]!;
  service.applyConversion(table.id, quantity, { expectedVersion: service.getTable(table.id).version, field: { name: 'Quantity', type: 'text' } });
  const read = service.getRecord(table.id, row.id);
  assert.equal(read.values[total.id], null);
  assert.match(read.formulaErrors![total.id]!, /number/);
  service.applyConversion(table.id, quantity, { expectedVersion: service.getTable(table.id).version, field: { name: 'Quantity', type: 'number' } });
  assert.equal(service.getRecord(table.id, row.id).values[total.id], 6);
  assert.equal(service.getRecord(table.id, row.id).formulaErrors, undefined);
});

test('linked formula errors remain visible, exports reject them, and failed batches roll back recalculation', t => {
  const { service, table, quantity, formula } = setup(t);
  const ratio = formula('Ratio', `10 / [${quantity}]`);
  const rows = service.createRecords(table.id, [0, 2].map(value => ({ values: { [quantity]: value } }))).records;
  service.updateTable(table.id, { expectedVersion: service.getTable(table.id).version, primaryFieldId: ratio.id });
  let source = service.createTable({ name: 'References' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Target', type: 'relation', relation: { tableId: table.id, multiple: true } });
  const link = source.fields[1]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Result', type: 'lookup', lookup: { relationFieldId: link, fieldId: ratio.id } });
  const lookup = source.fields[2]!.id;
  const row = service.createRecords(source.id, [{ values: { [link]: [rows[0]!.id] } }]).records[0]!;
  assert.match(row.formulaErrors![lookup]!, /linked formula/);
  assert.match(row.links![link]![0]!.label, /zero/);
  assert.throws(() => service.exportCsv(source.id, {}), /formula error/);
  const before = service.queryRecords(table.id, {});
  assert.throws(() => service.updateBatch([
    { id: rows[0]!.id, expectedVersion: 1, values: { [quantity]: 5 } },
    { id: rows[1]!.id, expectedVersion: 99, values: { [quantity]: 5 } },
  ], table.id), /changed/);
  assert.deepEqual(service.queryRecords(table.id, {}), before);
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [quantity]: 5 } }], table.id);
  assert.equal(service.getRecord(source.id, row.id).formulaErrors, undefined);
  assert.match(service.exportCsv(source.id, {}), /\[2\]/);
});

test('formula syntax is bounded and supports conditional, text, Unicode and numeric operations', () => {
  const calculate = (expression: string, resultType: 'number' | 'text' | 'checkbox' = 'number') => compileFormulas({ fields: [
    { id: 'x', name: 'Input', type: 'text' }, { id: 'f', name: 'Result', type: 'formula', formula: { expression, resultType } },
  ] })({ x: '  中文 🌱  ' });
  assert.equal(calculate('2 + 3 * 4 - 8 / 2').values['f'], 10);
  assert.equal(calculate('ROUND(ABS(-2.345), 2)').values['f'], 2.35);
  assert.equal(calculate('LEN(TRIM(["x"]))').values['f'], 4);
  assert.equal(calculate('CONCAT(UPPER("ab"), LOWER("CD"), TRIM([x]))', 'text').values['f'], 'ABcd中文 🌱');
  assert.equal(calculate('AND(1 < 2, OR(FALSE, NOT(FALSE)))', 'checkbox').values['f'], true);
  assert.equal(calculate('COALESCE(NULL, 0, 1 / 0)').values['f'], 0);
  assert.equal(calculate('IF(FALSE, 1 / 0, 7)').values['f'], 7);
  assert.match(calculate('"text"').formulaErrors!['f']!, /number result/);
  assert.match(calculate('1e308 * 1e308').formulaErrors!['f']!, /finite/);
  assert.match(calculate('ROUND(1, 11)').formulaErrors!['f']!, /precision/);
  assert.equal(rewriteFormulaReferences('CONCAT("[x]", ["x"])', () => 'Name ] "quoted"'), `CONCAT("[x]", [${JSON.stringify('Name ] "quoted"')}])`);
});

test('version-nine migration preserves board configuration, records and optimistic versions', t => {
  const { data, store, service, table } = setup(t);
  const row = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Keep' } }]).records[0]!;
  const before = service.getTable(table.id), views = service.listViews(table.id);
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec('ALTER TABLE records DROP COLUMN formula_errors_json; PRAGMA user_version = 9;');
  db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(table.id), before);
  assert.deepEqual(reopened.listViews(table.id), views);
  assert.deepEqual(reopened.getRecord(table.id, row.id), row);
});

test('HTTP and SDK expose formula configuration, computed results, query operators and write rejection', async t => {
  const data = fixture(t, null), store = data.open();
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ token, service: new RecordService(store) });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  let table: Table = await api.createTable({ name: 'API formulas' });
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Length', type: 'formula', formula: { expression: `LEN([${table.primaryFieldId}])`, resultType: 'number' } });
  const field = table.fields[1]!;
  const row = (await api.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Hello' } }])).records[0]!;
  assert.equal(row.values[field.id], 5);
  assert.equal((await api.queryRecords(table.id, { filter: { conjunction: 'and', conditions: [{ fieldId: field.id, operator: 'gt', value: 4 }] } })).total, 1);
  await assert.rejects(api.updateRecords(table.id, [{ id: row.id, expectedVersion: row.version, values: { [field.id]: 1 } }]), /read-only/);
});
