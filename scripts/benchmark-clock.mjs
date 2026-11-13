import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/clock-performance-'));
let now = new Date('2024-02-29T12:00:30Z');
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null, () => now), service = new RecordService(store);
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, temporal: JSON.parse(await readFile('node_modules/@js-temporal/polyfill/package.json', 'utf8')).version,
  os: os.type() + ' ' + os.release() + ' ' + os.arch(), cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: production service build, direct calls without renderer, HTTP or GUI.', rows: 100000, samples: {} };
const measure = (name, operation, repeat = 1) => {
  const samples = []; let value;
  for (let index = 0; index < repeat; index++) {
    const start = performance.now(); value = operation();
    samples.push({ milliseconds: performance.now() - start, memory: process.memoryUsage(), ...(value?.changedRecords === undefined ? {} : value) });
  }
  result.samples[name] = samples;
  console.log(name + ': ' + samples.map(sample => sample.milliseconds.toFixed(1) + ' ms').join(', '));
  return value;
};
try {
  let table = service.createTable({ name: 'Clock benchmark' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
  const clock = table.fields[1].id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Next minute', type: 'formula', formula: { expression: 'DATEADD([' + clock + '], 1, "minute")', resultType: 'datetime' } });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Today', type: 'formula', formula: { expression: 'TODAY("Asia/Shanghai")', resultType: 'date' } });
  measure('seed100000', () => {
    for (let offset = 0; offset < result.rows; offset += 2000) service.createRecords(table.id,
      Array.from({ length: 2000 }, (_, index) => ({ values: { [table.primaryFieldId]: 'Row ' + (offset + index) } })));
  });
  assert.equal(measure('sameMinute', () => service.refreshCalculations(), 3).changedRecords, 0);
  assert.equal(measure('nextMinute', () => { now = new Date(now.getTime() + 60_000); return service.refreshCalculations(); }, 3).changedRecords, result.rows);
  now = new Date('2024-03-01T00:00:00Z');
  assert.equal(measure('nextDay', () => service.refreshCalculations()).changedRecords, result.rows);
  const page = measure('read100AfterRefresh', () => service.queryRecords(table.id, { limit: 100 }));
  assert.ok(page.records.every(row => row.version === 5 && row.values[clock] === now.toISOString()));
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { store.close(); }
