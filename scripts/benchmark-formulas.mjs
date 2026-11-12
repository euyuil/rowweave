import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/formula-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'));
const service = new RecordService(store);
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: direct service calls without renderer, HTTP or GUI.', rows: 100000, samples: {} };
const measure = (name, operation, repeat = 1) => {
  const times = [];
  let value;
  for (let i = 0; i < repeat; i++) { const start = performance.now(); value = operation(); times.push(performance.now() - start); }
  result.samples[name] = times;
  return value;
};
try {
  let table = service.createTable({ name: 'Formula benchmark' });
  for (const name of ['Quantity', 'Price']) table = service.createField(table.id, { expectedVersion: table.version, name, type: 'number' });
  const quantity = table.fields[1].id, price = table.fields[2].id;
  measure('seed100000', () => {
    for (let start = 0; start < 100000; start += 2000) service.createRecords(table.id, Array.from({ length: 2000 }, (_, i) => ({ values: {
      [table.primaryFieldId]: `Item ${start + i}`, [quantity]: (start + i) % 29 === 0 ? null : (start + i) % 100,
      [price]: (start + i) % 1000 / 10,
    } })));
  });
  table = measure('addFormula100000', () => service.createField(table.id, { expectedVersion: table.version, name: 'Total', type: 'formula',
    formula: { expression: `ROUND([${quantity}] * [${price}], 2)`, resultType: 'number' } }));
  const formula = table.fields.at(-1).id;
  table = measure('recalculate100000', () => service.updateField(table.id, formula, { expectedVersion: table.version,
    formula: { expression: `ROUND([${quantity}] * [${price}] * 0.8, 2)`, resultType: 'number' } }));
  const view = measure('createIndexedFormulaView', () => service.createView(table.id, { name: 'Large totals', query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: formula, operator: 'gt', value: 1000 }] }, sort: [{ fieldId: formula, direction: 'desc' }],
  } }));
  for (let i = 0; i < 2; i++) service.queryView(table.id, view.id, {});
  const page = measure('indexedQuery100', () => service.queryView(table.id, view.id, { limit: 100 }), 20);
  result.matchingRows = page.total;
  measure('fullTableSummary', () => service.summarizeRecords(table.id, { measures: [{ fieldId: formula, operation: 'sum' }] }), 5);
  const rows = service.readPage(0, 500, table.id).records.concat(service.readPage(500, 500, table.id).records);
  measure('update1000WithRecalculation', () => service.updateBatch(rows.map(row => ({ id: row.id, expectedVersion: row.version, values: { [price]: 20 } })), table.id));
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { store.close(); }
