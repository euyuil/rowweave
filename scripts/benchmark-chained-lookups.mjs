import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/chained-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null), service = new RecordService(store);
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: production-compiled service without renderer or HTTP.',
  scale: { items: 1000, collections: 1000, portfolios: 10000, links: 25000, valuesPerPortfolio: 10 }, samples: {} };
const add = (table, field) => service.createField(table.id, { ...field, expectedVersion: service.getTable(table.id).version }).fields.at(-1);
const measure = (name, read, check, count = 20) => {
  for (let index = 0; index < 2; index++) check(read());
  const times = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now(), value = read(); times.push(performance.now() - start); check(value);
  }
  result.samples[name] = times;
};
try {
  const started = performance.now();
  const items = service.createTable({ name: 'Items' }), collections = service.createTable({ name: 'Collections' }), portfolios = service.createTable({ name: 'Portfolios' });
  const amount = add(items, { name: 'Amount', type: 'number' }).id;
  const itemLink = add(collections, { name: 'Items', type: 'relation', relation: { tableId: items.id, multiple: true } }).id;
  const inner = add(collections, { name: 'Amounts', type: 'lookup', lookup: { relationFieldId: itemLink, fieldId: amount } }).id;
  const collectionLink = add(portfolios, { name: 'Collections', type: 'relation', relation: { tableId: collections.id, multiple: true } }).id;
  const values = add(portfolios, { name: 'Amounts', type: 'lookup', lookup: { relationFieldId: collectionLink, fieldId: inner } }).id;
  const total = add(portfolios, { name: 'Total', type: 'lookup', lookup: { relationFieldId: collectionLink, fieldId: inner, operation: 'sum' } }).id;
  const leaves = service.createRecords(items.id, Array.from({ length: 1000 }, (_, index) => ({ values: { [amount]: index % 10 } }))).records;
  const middles = service.createRecords(collections.id, Array.from({ length: 1000 }, (_, index) => ({ values: {
    [itemLink]: Array.from({ length: 5 }, (_, member) => leaves[(index + member) % 1000].id),
  } }))).records;
  const expected = [];
  for (let start = 0; start < 10000; start += 1000) {
    const records = service.createRecords(portfolios.id, Array.from({ length: 1000 }, (_, index) => ({ values: {
      [portfolios.primaryFieldId]: `Portfolio ${start + index}`, [collectionLink]: [middles[(start + index) % 1000].id, middles[(start + index + 17) % 1000].id],
    } }))).records;
    records.forEach((record, index) => {
      const members = [0, 17].flatMap(offset => Array.from({ length: 5 }, (_, member) => (start + index + offset + member) % 10));
      expected.push({ id: record.id, position: start + index, total: members.reduce((sum, value) => sum + value, 0), values: members });
    });
  }
  result.seedMs = performance.now() - started;
  const query = { select: [total], filter: { conjunction: 'and', conditions: [{ fieldId: total, operator: 'gte', value: 50 }] }, sort: [{ fieldId: total, direction: 'desc' }], limit: 100 };
  const matches = expected.filter(record => record.total >= 50).sort((a, b) => b.total - a.total || a.position - b.position);
  measure('filteredSortedPage100', () => service.queryRecords(portfolios.id, query), page => {
    assert.equal(page.total, matches.length);
    assert.deepEqual(page.records.map(record => [record.id, record.values[total]]), matches.slice(0, 100).map(record => [record.id, record.total]));
  });
  measure('projectedValuesPage100', () => service.queryRecords(portfolios.id, { select: [values], limit: 100 }), page => {
    assert.equal(page.total, 10000); assert.deepEqual(page.records.map(record => record.values[values]), expected.slice(0, 100).map(record => record.values));
  });
  result.correctness = 'Every measured read checks complete count, order and calculated results against independent fixture values outside its timed interval.';
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, seedMs: result.seedMs, summaries: Object.fromEntries(Object.entries(result.samples).map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b); return [name, { p95: sorted[Math.ceil(sorted.length * .95) - 1], min: sorted[0], max: sorted.at(-1) }];
  })) }, null, 2));
} finally { store.close(); }
