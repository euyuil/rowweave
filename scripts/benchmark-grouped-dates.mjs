import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/grouped-date-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null, () => new Date('2026-11-13T12:00:00Z'));
const service = new RecordService(store);
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: direct compiled service calls without renderer, HTTP or GUI.', rows: 100000, columns: 5, samples: {} };
const measure = (name, operation, repeat = 1) => {
  const times = []; let value;
  for (let i = 0; i < repeat; i++) { const start = performance.now(); value = operation(i); times.push(performance.now() - start); }
  result.samples[name] = times; return value;
};
try {
  let table = service.createTable({ name: 'Schedule' });
  for (const field of [{ name: 'Due', type: 'date' }, { name: 'At', type: 'datetime' }, { name: 'Score', type: 'number' },
    { name: 'Status', type: 'singleSelect', options: [{ id: 'open', name: 'Open' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' }] }]) {
    table = service.createField(table.id, { ...field, expectedVersion: table.version });
  }
  const [name, due, at, score, status] = table.fields.map(field => field.id);
  let matchingRows = 0;
  measure('seed100000Records', () => {
    for (let offset = 0; offset < 100000; offset += 2000) service.createRecords(table.id, Array.from({ length: 2000 }, (_, j) => {
      const i = offset + j, day = new Date(Date.parse('2026-11-06T12:00:00Z') + (i % 14) * 86400000).toISOString().slice(0, 10);
      if (i % 14 >= 1 && i % 14 <= 7) matchingRows++;
      return { values: { [name]: `Task ${i}`, [due]: day, [at]: `${day}T12:00:00.000Z`, [score]: i, [status]: ['open', 'doing', 'done'][i % 3] } };
    }));
  });
  const filter = { conjunction: 'and', conditions: [{ fieldId: due, operator: 'relativeDate', relative: { period: 'pastDays', timeZone: 'UTC', days: 7 } }] };
  const views = measure('prepareGroupedViews', () => [
    service.createView(table.id, { name: 'By status', groupBy: status, query: { sort: [{ fieldId: score, direction: 'desc' }] } }),
    service.createView(table.id, { name: 'Recent by status', groupBy: status, query: { filter, sort: [{ fieldId: score, direction: 'desc' }] } }),
    service.createView(table.id, { name: 'Recent dates', query: { filter } }),
  ]);
  for (const [name, operation] of [
    ['groupedPage100', () => service.queryView(table.id, views[0].id, { limit: 100 })],
    ['relativeDatePage100', () => service.queryView(table.id, views[2].id, { limit: 100 })],
    ['groupedRelativePage100', () => service.queryView(table.id, views[1].id, { limit: 100 })],
    ['groupedRelativeSummary', () => service.summarizeRecords(table.id, { viewId: views[1].id, groupBy: status })],
  ]) {
    operation(); operation();
    const page = measure(name, operation, 20);
    assert.equal(page.total ?? page.totals.count, name === 'groupedPage100' ? 100000 : matchingRows);
  }
  result.matchingRows = matchingRows;
  result.correctness = 'Every repeated query/summary returned the complete expected matching count.';
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { store.close(); }
