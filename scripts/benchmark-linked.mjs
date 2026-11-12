import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/linked-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'));
const service = new RecordService(store);
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: direct service calls without renderer, HTTP or GUI.', rows: 10000, linksPerRow: 10, samples: {} };
const measure = (name, operation, repeat = 1) => {
  const times = [];
  let value;
  for (let i = 0; i < repeat; i++) { const start = performance.now(); value = operation(); times.push(performance.now() - start); }
  result.samples[name] = times;
  return value;
};
try {
  let target = service.createTable({ name: 'Items' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number' });
  const amount = target.fields[1].id;
  const rows = service.createRecords(target.id, Array.from({ length: 1000 }, (_, i) => ({ values: {
    [target.primaryFieldId]: `Item ${i}`, [amount]: i % 29 === 0 ? null : i,
  } }))).records;
  let source = service.createTable({ name: 'Groups' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Items', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = source.fields[1].id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Total', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } });
  const sum = source.fields[2].id;
  measure('seed10000Groups100000Links', () => {
    for (let start = 0; start < 10000; start += 1000) service.createRecords(source.id, Array.from({ length: 1000 }, (_, i) => ({ values: {
      [source.primaryFieldId]: `Group ${start + i}`, [link]: Array.from({ length: 10 }, (_, j) => rows[((start + i) * 10 + j) % 1000].id),
    } })));
  });
  const view = service.createView(source.id, { name: 'Large totals', query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: sum, operator: 'gt', value: 5000 }] }, sort: [{ fieldId: sum, direction: 'desc' }],
  } });
  for (let i = 0; i < 2; i++) service.queryView(source.id, view.id, {});
  const page = measure('filteredSortedPage100', () => service.queryView(source.id, view.id, { limit: 100 }), 20);
  result.matchingRows = page.total;
  measure('fullTableSummary', () => service.summarizeRecords(source.id, { measures: [{ fieldId: sum, operation: 'sum' }] }), 5);
  measure('updateTargetWith100Dependents', () => service.updateBatch([{ id: rows[1].id, expectedVersion: 1, values: { [amount]: 20000 } }], target.id));
  measure('queryAfterTargetUpdate', () => service.queryView(source.id, view.id, { limit: 100 }));
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { store.close(); }
