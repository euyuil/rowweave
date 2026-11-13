import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';
import { startWorkspaceServer } from '../dist/apps/server/src/workspace-server.js';
import { createWorkspaceClient } from '../dist/packages/client/src/http-client.js';

await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/background-clock-')), database = join(directory, 'benchmark.sqlite');
const store = new SqliteRecordStore(database, null, () => new Date('2024-02-29T12:00:00Z')), service = new RecordService(store);
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, temporal: JSON.parse(await readFile('node_modules/@js-temporal/polyfill/package.json', 'utf8')).version,
  os: os.type() + ' ' + os.release() + ' ' + os.arch(), cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: production service build, loopback HTTP, no renderer.', rows: 100000, reads: [] };
let table;
try {
  table = service.createTable({ name: 'Background clock benchmark' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
  const clock = table.fields[1].id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Next minute', type: 'formula', formula: { expression: 'DATEADD([' + clock + '], 1, "minute")', resultType: 'datetime' } });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Today', type: 'formula', formula: { expression: 'TODAY("Asia/Shanghai")', resultType: 'date' } });
  const start = performance.now();
  for (let offset = 0; offset < result.rows; offset += 2000) service.createRecords(table.id,
    Array.from({ length: 2000 }, (_, index) => ({ values: { [table.primaryFieldId]: 'Row ' + (offset + index) } })));
  result.seedMilliseconds = performance.now() - start;
  console.log('Seeded ' + result.rows + ' records in ' + result.seedMilliseconds.toFixed(1) + ' ms.');
} finally { store.close(); }
const token = randomBytes(32).toString('hex'), start = performance.now(), server = await startWorkspaceServer(database, { token });
const api = createWorkspaceClient({ url: server.url, token });
try {
  let status = await api.calculationStatus();
  assert.equal(status.running, true);
  while (status.running) {
    const before = performance.now(), page = await api.queryRecords(table.id, { limit: 100 });
    assert.equal(page.records.length, 100);
    const versions = new Set(page.records.map(record => record.version));
    assert.equal(versions.size, 1);
    assert.ok(versions.has(1) || versions.has(2));
    result.reads.push({ milliseconds: performance.now() - before, version: page.records[0].version });
    await setTimeout(100);
    status = await api.calculationStatus();
  }
  result.startupRefreshMilliseconds = performance.now() - start;
  assert.equal(status.lastError, undefined);
  assert.equal(status.lastResult.changedRecords, result.rows);
  assert.ok(result.reads.some(read => read.version === 1));
  const final = await api.queryRecords(table.id, { limit: 100 });
  assert.ok(final.records.every(record => record.version === 2 && record.values[table.fields[1].id] === status.lastResult.evaluatedAt));
  result.status = status;
  const times = result.reads.map(read => read.milliseconds).sort((a, b) => a - b);
  result.readLatency = { samples: times.length, median: times[Math.floor(times.length / 2)], p95: times[Math.ceil(times.length * 0.95) - 1], max: times.at(-1) };
  console.log(JSON.stringify({ directory, startupRefreshMilliseconds: result.startupRefreshMilliseconds, readLatency: result.readLatency }));
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
} finally { await server.close(); }
