import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/connected-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'));
const service = new RecordService(store);
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: direct compiled service calls without renderer, HTTP or GUI.', rows: 10000, linksPerRow: 1, formulasPerRow: 2, samples: {} };
const measure = (name, operation, repeat = 1) => {
  const times = [];
  let value;
  for (let i = 0; i < repeat; i++) { const start = performance.now(); value = operation(i); times.push(performance.now() - start); }
  result.samples[name] = times;
  return value;
};
try {
  let items = service.createTable({ name: 'Items' });
  items = service.createField(items.id, { expectedVersion: items.version, name: 'Amount', type: 'number' });
  const amount = items.fields[1].id;
  const item = service.createRecords(items.id, [{ values: { [amount]: 10 } }]).records[0];
  let orders = service.createTable({ name: 'Orders' });
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Items', type: 'relation', relation: { tableId: items.id, multiple: true } });
  const link = orders.fields[1].id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Subtotal', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } });
  const subtotal = orders.fields[2].id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Total', type: 'formula', formula: { expression: '[' + subtotal + '] * 2', resultType: 'number' } });
  const total = orders.fields[3].id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Final', type: 'formula', formula: { expression: '[' + total + '] + 1', resultType: 'number' } });
  const final = orders.fields[4].id;
  measure('seed10000Records', () => {
    for (let start = 0; start < 10000; start += 1000) service.createRecords(orders.id, Array.from({ length: 1000 }, (_, i) => ({ values: {
      [orders.primaryFieldId]: `Order ${start + i}`, [link]: [item.id],
    } })));
  });
  const view = service.createView(orders.id, { name: 'Calculated totals', query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: final, operator: 'gte', value: 1 }] }, sort: [{ fieldId: final, direction: 'desc' }],
  } });
  measure('updateTarget10000Dependents20000Formulas', i => service.updateBatch([{ id: item.id, expectedVersion: i + 1, values: { [amount]: i + 20 } }], items.id), 10);
  assert.equal(service.queryRecords(orders.id, { filter: { conjunction: 'and', conditions: [{ fieldId: final, operator: 'eq', value: 59 }] } }).total, 10000);
  for (let i = 0; i < 2; i++) service.queryView(orders.id, view.id, {});
  measure('filteredSortedPage100', () => service.queryView(orders.id, view.id, { limit: 100 }), 20);
  result.correctness = 'All 10,000 dependent rows contain 59 after the tenth target update.';
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { store.close(); }
