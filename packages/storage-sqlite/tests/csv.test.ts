import test from 'node:test';
import assert from 'node:assert/strict';
import { maxCsvBytes, maxCsvRows, type FieldCreate } from '../../contracts/src/index.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { csvCell, parseCsv, prepareCsvImport } from '../../core/src/csv.js';
import { fixture } from './helpers.js';

const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;
const cells = (csv: string) => [...parseCsv(csv)].map(row => row.cells.map(cell => cell.text === '' && !cell.quoted ? null : cell.text));

test('CSV preserves typed values, Unicode, multiline text, quoted empty strings and computed exports', t => {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  const target = service.createTable({ name: 'Projects' });
  const project = service.createRecords(target.id, [{ values: { [target.primaryFieldId]: '中文项目 🌱' } }]).records[0]!;
  let table = service.createTable({ name: 'Tasks' });
  for (const field of [
    { name: 'Notes', type: 'multiline' }, { name: 'Amount', type: 'number', numberFormat: 'currency', currency: 'USD', precision: 2 },
    { name: 'Done', type: 'checkbox' }, { name: 'Date', type: 'date' }, { name: 'Time', type: 'datetime' },
    { name: 'Status', type: 'singleSelect', options: [{ id: 'open', name: '待办' }, { id: 'done', name: 'Done' }] },
    { name: 'Tags', type: 'multiSelect', options: [{ id: 'a', name: 'Comma, quote "' }, { id: 'b', name: '蓝色' }] },
    { name: 'Project', type: 'relation', relation: { tableId: target.id, multiple: true } },
  ] satisfies Array<Omit<FieldCreate, 'expectedVersion'>>) table = service.createField(table.id, { expectedVersion: table.version, ...field });
  const [name, notes, amount, done, date, time, status, tags, relation] = table.fields.map(field => field.id) as [string, string, string, string, string, string, string, string, string];
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Project name', type: 'lookup', lookup: { relationFieldId: relation, fieldId: target.primaryFieldId } });
  const values = [
    { [name]: '你好 🌱, "世界"', [notes]: 'Line 1\r\nLine 2\nEnd\rFinal', [amount]: 1.234567, [done]: false,
      [date]: '2024-02-29', [time]: '2026-11-12T02:03:04.005Z', [status]: 'open', [tags]: ['b', 'a'], [relation]: [project.id] },
    { [name]: '', [notes]: '=literal text', [amount]: 0, [done]: true, [tags]: [], [relation]: [] },
    {},
  ];
  const original = service.createRecords(table.id, values.map(values => ({ values }))).records;
  const csv = service.exportCsv(table.id, {});
  assert.ok(csv.startsWith('\uFEFFName,Notes,Amount'));
  assert.ok(csv.endsWith('\r\n'));
  const exported = cells(csv);
  assert.equal(exported[1]![2], '1.234567');
  assert.equal(exported[1]![6], '待办');
  assert.equal(exported[1]![9], '["中文项目 🌱"]');
  assert.equal(exported[2]![0], '');
  assert.equal(exported[3]![0], null);
  const request = { csv, hasHeader: true, expectedVersion: table.version };
  const preview = service.previewCsv(table.id, request);
  assert.equal(preview.validated, true);
  assert.equal(preview.total, 3);
  assert.equal(preview.invalid, 0);
  assert.equal(preview.mapping[9], null);
  assert.equal(service.getTable(table.id).total, 3);
  const revision = service.getTable(table.id).revision;
  assert.deepEqual(service.importCsv(table.id, request), { imported: 3 });
  assert.equal(service.getTable(table.id).revision, revision + 1);
  const restarted = new RecordService(data.open());
  assert.deepEqual(restarted.readPage(3, 10, table.id).records.map(row => row.values), original.map(row => row.values));
});

test('CSV column mappings distinguish omitted defaults, explicit null, duplicate headers and read-only fields', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Mapping' });
  table = service.createField(table.id, { expectedVersion: 1, name: 'Count', type: 'number', defaultValue: 12 });
  const [name, count] = table.fields.map(field => field.id) as [string, string];
  const input = { expectedVersion: table.version, hasHeader: true, csv: 'Unknown,Unknown,Ignored\r\nAlpha,4,skip\r\nBeta,,skip' };
  const unresolved = service.previewCsv(table.id, input);
  assert.equal(unresolved.validated, false);
  assert.deepEqual(unresolved.mapping, [null, null, null]);
  assert.equal(unresolved.total, 2);
  assert.throws(() => service.importCsv(table.id, input), code('INVALID_CSV'));
  assert.throws(() => service.previewCsv(table.id, { ...input, mapping: [name, name, null] }), code('INVALID_CSV'));
  assert.throws(() => service.previewCsv(table.id, { ...input, mapping: [name, 'missing', null] }), code('INVALID_CSV'));
  assert.throws(() => service.previewCsv(table.id, { ...input, mapping: null }), code('INVALID_CSV'));
  service.importCsv(table.id, { ...input, mapping: [name, count, null] });
  service.importCsv(table.id, { expectedVersion: table.version, hasHeader: false, csv: 'Gamma,ignored', mapping: [name, null] });
  assert.deepEqual(service.readPage(0, 10, table.id).records.map(row => row.values[count]), [4, null, 12]);
  table = service.updateField(table.id, count, { expectedVersion: table.version, name: 'Name' });
  assert.deepEqual(service.previewCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: 'Name\nvalue' }).mapping, [null]);
  assert.deepEqual(service.previewCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: 'Name,Name\nvalue,other' }).mapping, [null, null]);
});

test('CSV rejects malformed syntax, mismatched widths and oversized input without committing any rows', t => {
  const service = new RecordService(fixture(t, null).open());
  const table = service.createTable({ name: 'Parse' });
  for (const csv of ['', '\uFEFF', 'Name\n"unclosed', 'Name\n"closed"oops', 'Name\nunquoted"quote']) {
    assert.throws(() => service.importCsv(table.id, { csv, hasHeader: true, expectedVersion: 1 }), code('INVALID_CSV'));
  }
  const width = service.previewCsv(table.id, { expectedVersion: 1, hasHeader: true, csv: 'Name\nvalid\ntoo,many' });
  assert.equal(width.invalid, 1);
  assert.equal(width.issues[0]!.row, 3);
  assert.match(width.issues[0]!.message, /Expected 1 cells/);
  assert.throws(() => service.importCsv(table.id, { expectedVersion: 1, hasHeader: true, csv: 'Name\nvalid\ntoo,many' }), code('INVALID_CSV'));
  assert.equal(service.getTable(table.id).total, 0);
  assert.deepEqual(cells('\uFEFF"a,b","quote ""x""",\r\n"line\r\n2",,last\r\n'), [['a,b', 'quote "x"', null], ['line\r\n2', null, 'last']]);
  assert.deepEqual(cells('a\rb\n\n""\r\n'), [['a'], ['b'], [null], ['']]);
  assert.throws(() => [...parseCsv('中'.repeat(Math.floor(maxCsvBytes / 3) + 1))], code('CSV_LIMIT'));
  assert.throws(() => [...parseCsv('x,'.repeat(200) + 'x')], code('CSV_LIMIT'));
  const tooManyRows = { expectedVersion: 1, hasHeader: false, csv: 'x\n'.repeat(maxCsvRows + 1), mapping: [table.primaryFieldId] };
  assert.throws(() => service.previewCsv(table.id, tooManyRows), code('CSV_LIMIT'));
});

test('CSV reports bounded typed diagnostics and rolls back late validation failures and stale schemas', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Atomic' });
  table = service.createField(table.id, { expectedVersion: 1, name: 'Count', type: 'number', required: true });
  const input = { expectedVersion: table.version, hasHeader: true, csv: 'Name,Count\n' + 'row,2\n'.repeat(3_001) };
  const invalid = { ...input, csv: input.csv + 'bad,nope\n'.repeat(25) };
  const preview = service.previewCsv(table.id, invalid);
  assert.equal(preview.total, 3_026);
  assert.equal(preview.invalid, 25);
  assert.equal(preview.samples.length, 10);
  assert.equal(preview.issues.length, 20);
  assert.equal(preview.issues[0]!.row, 3_003);
  assert.throws(() => service.importCsv(table.id, invalid), (error: unknown) => code('INVALID_VALUE')(error) && (error as Error).message.startsWith('Row 3003:'));
  assert.deepEqual(service.getTable(table.id), table);
  assert.throws(() => service.importCsv(table.id, { ...input, csv: input.csv + '"unclosed' }), code('INVALID_CSV'));
  assert.deepEqual(service.getTable(table.id), table);
  assert.deepEqual(service.importCsv(table.id, input), { imported: 3_001 });
  assert.equal(service.getTable(table.id).revision, table.revision + 1);
  const current = service.getTable(table.id);
  service.previewCsv(table.id, input);
  service.updateTable(table.id, { expectedVersion: current.version, name: 'Changed' });
  assert.throws(() => service.importCsv(table.id, input), code('SCHEMA_CONFLICT'));
  assert.equal(service.getTable(table.id).total, 3_001);
});

test('CSV previews target existence, rejects lookup mappings and rolls back references that change before import', t => {
  const service = new RecordService(fixture(t, null).open());
  const target = service.createTable({ name: 'Target' });
  const record = service.createRecords(target.id, [{ values: {} }]).records[0]!;
  let table = service.createTable({ name: 'Linked' });
  table = service.createField(table.id, { expectedVersion: 1, name: 'Link', type: 'relation', relation: { tableId: target.id, multiple: false } });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Lookup', type: 'lookup', lookup: { relationFieldId: table.fields[1]!.id, fieldId: target.primaryFieldId } });
  const request = { expectedVersion: table.version, hasHeader: true, csv: `Name,Link\nfirst,\nsecond,${csvCell(JSON.stringify([record.id]))}` };
  const preview = service.previewCsv(table.id, request);
  assert.equal(preview.invalid, 0);
  assert.throws(() => service.previewCsv(table.id, { ...request, mapping: [table.primaryFieldId, table.fields[2]!.id] }), code('INVALID_CSV'));
  const lateMissing = { ...request, csv: request.csv + '\nlast,' + csvCell('["missing-target"]') };
  assert.equal(service.previewCsv(table.id, lateMissing).invalid, 1);
  assert.throws(() => service.importCsv(table.id, lateMissing), code('INVALID_LINK'));
  assert.equal(service.getTable(table.id).total, 0);
  service.deleteRecords(target.id, [{ id: record.id, expectedVersion: record.version }]);
  assert.equal(service.previewCsv(table.id, request).issues[0]!.code, 'INVALID_LINK');
  assert.throws(() => service.importCsv(table.id, request), code('INVALID_LINK'));
  assert.equal(service.getTable(table.id).total, 0);
});

test('CSV export follows current view filtering, sorting, visible column order and temporary search', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Views' });
  table = service.createField(table.id, { expectedVersion: 1, name: 'Count', type: 'number' });
  table = service.createField(table.id, { expectedVersion: 2, name: 'Hidden', type: 'text' });
  const [name, count, hidden] = table.fields.map(field => field.id) as [string, string, string];
  service.createRecords(table.id, [1, 3, 2, 0].map(value => ({ values: { [name]: value === 3 ? 'Beta' : 'Alpha', [count]: value, [hidden]: 'secret column' } })));
  const view = service.createView(table.id, { name: 'Ordered', query: { filter: { conjunction: 'and', conditions: [{ fieldId: count, operator: 'gt', value: 0 }] }, sort: [{ fieldId: count, direction: 'desc' }] },
    columns: [{ fieldId: count, width: 100, hidden: false }, { fieldId: hidden, width: 100, hidden: true }, { fieldId: name, width: 100, hidden: false }] });
  assert.deepEqual(cells(service.exportCsv(table.id, { viewId: view.id, expectedViewVersion: view.version })), [['Count', 'Name'], ['3', 'Beta'], ['2', 'Alpha'], ['1', 'Alpha']]);
  assert.deepEqual(cells(service.exportCsv(table.id, { viewId: view.id, search: 'Beta' })), [['Count', 'Name'], ['3', 'Beta']]);
  assert.equal(cells(service.exportCsv(table.id, {})).length, 5);
  assert.throws(() => service.exportCsv(table.id, { viewId: view.id, expectedViewVersion: 42 }), code('VIEW_CONFLICT'));
  assert.throws(() => service.exportCsv(table.id, { search: 123 }), code('INVALID_QUERY'));
});

test('CSV import rechecks schema inside the write transaction and bounds implicit default cells', t => {
  const store = fixture(t, null).open();
  const service = new RecordService(store);
  let table = service.createTable({ name: 'Bounds' });
  const plan = prepareCsvImport(table, { expectedVersion: 1, hasHeader: true, csv: 'Name\nfirst' });
  table = service.updateTable(table.id, { expectedVersion: 1, name: 'Changed' });
  assert.throws(() => store.importCsv({ ...table, version: 1 }, plan, true), code('SCHEMA_CONFLICT'));
  for (let i = 1; i < 21; i++) table = service.createField(table.id, { expectedVersion: table.version, name: `Field ${i}`, type: 'text' });
  assert.throws(() => service.previewCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: 'Unknown\n' + 'x\n'.repeat(100_000) }), code('CSV_LIMIT'));
});

test('CSV select labels take precedence over colliding option IDs during round trips', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Select labels' });
  const options = [{ id: 'second', name: 'First' }, { id: 'first', name: 'second' }];
  for (const type of ['singleSelect', 'multiSelect']) table = service.createField(table.id, { expectedVersion: table.version, name: type, type, options });
  const values = { [table.fields[1]!.id]: 'first', [table.fields[2]!.id]: ['first', 'second'] };
  const original = service.createRecords(table.id, [{ values }]).records[0]!;
  service.importCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: service.exportCsv(table.id, {}) });
  assert.deepEqual(service.readPage(1, 1, table.id).records[0]!.values, original.values);
});

test('CSV export spans hydration batches and rejects oversized output before returning a partial file', t => {
  const service = new RecordService(fixture(t, null).open());
  const table = service.createTable({ name: 'Export bounds' });
  const values = { [table.primaryFieldId]: 'x'.repeat(10_000) };
  service.createRecords(table.id, Array.from({ length: 1_000 }, () => ({ values })));
  assert.equal(cells(service.exportCsv(table.id, {})).length, 1_001);
  service.createRecords(table.id, Array.from({ length: 2_000 }, () => ({ values })));
  service.createRecords(table.id, Array.from({ length: 400 }, () => ({ values })));
  assert.throws(() => service.exportCsv(table.id, {}), code('CSV_LIMIT'));
  assert.equal(service.getTable(table.id).total, 3_400);
  const view = service.createView(table.id, { name: 'Empty', query: { search: 'missing' } });
  assert.deepEqual(cells(service.exportCsv(table.id, { viewId: view.id })), [['Name']]);
});
