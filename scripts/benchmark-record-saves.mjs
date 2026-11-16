import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';
import { startWorkspaceServer } from '../dist/apps/server/src/workspace-server.js';
import { createWorkspaceClient } from '../dist/packages/client/src/http-client.js';

if (!process.argv[2]) throw new Error('Pass results.json from the production desktop benchmark. Source databases are copied, never updated.');
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const workspace = process.argv.includes('--workspace');
async function open(database) {
  if (!workspace) {
    const store = new SqliteRecordStore(database);
    return { service: new RecordService(store), close: () => store.close() };
  }
  const token = randomBytes(32).toString('hex'), server = await startWorkspaceServer(database, { token });
  const api = createWorkspaceClient({ url: server.url, token });
  await api.refreshCalculations();
  return { service: { ...api, updateBatch: (updates, id) => api.updateRecords(id, updates) }, close: () => server.close() };
}
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/record-save-performance-'));
const report = {
  measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  sourceDatasetReport: resolve(process.argv[2]), sourceDatasetPackage: input.package,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  mode: workspace ? 'managed-workspace-http' : 'direct-store',
  method: 'Production-compiled service; isolated SQLite backups of both typed desktop benchmark datasets. ' +
    'Three separate workspace lifetimes per size, each updating 1,000 records and ten text fields. ' +
    'The timed operation includes validation, complete history and durable commit. Reads, correctness assertions, ' +
    'a rejected stale batch and restart checks are outside timing. No renderer or SQL instrumentation. ' +
    (workspace ? 'Includes the shared HTTP client and managed background maintenance. Startup calculations finish before timing. ' +
      'A separate projected read is timed immediately after each acknowledged save; checkpoint activity is not instrumented.' : 'No HTTP; default store checkpointing.'),
  datasets: [],
};
for (const dataset of input.datasets) {
  const database = join(directory, `${dataset.rows}x${dataset.columns}.sqlite`);
  const source = new DatabaseSync(dataset.seed.database, { readOnly: true });
  try { await backup(source, database); } finally { source.close(); }
  const measurements = { rows: dataset.rows, columns: dataset.columns, database, samplesMs: [], postSaveReadsMs: [] };
  report.datasets.push(measurements);
  let expected;
  for (let trial = 0; trial < 3; trial++) {
    const { service, close } = await open(database);
    try {
      const table = await service.getTable(dataset.seed.table.id);
      assert.equal(table.total, dataset.rows); assert.equal(table.fields.length, dataset.columns);
      const fields = table.fields.slice(0, 10);
      assert.ok(fields.every(field => field.type === 'text'));
      const records = [];
      for (const offset of [0, 500]) records.push(...(await service.queryRecords(table.id, { offset, limit: 500 })).records);
      assert.equal(records.length, 1000);
      if (expected) assert.deepEqual(records, expected);
      const updates = records.map((record, row) => ({ id: record.id, expectedVersion: record.version,
        values: Object.fromEntries(fields.map((field, column) => [field.id, `Save ${trial} ${row}/${column} 🌱`])) }));
      const start = performance.now();
      const result = await service.updateBatch(updates, table.id);
      measurements.samplesMs.push(performance.now() - start);
      const readStart = performance.now();
      const page = await service.queryRecords(table.id, { limit: 100, fields: fields.map(field => field.id) });
      measurements.postSaveReadsMs.push(performance.now() - readStart);
      assert.equal(page.records.length, 100);
      for (let index = 0; index < page.records.length; index++) assert.deepEqual(page.records[index].values, updates[index].values);
      assert.equal(result.records.length, 1000);
      for (let index = 0; index < records.length; index++) {
        assert.deepEqual(result.records[index], { ...records[index], version: records[index].version + 1,
          values: { ...records[index].values, ...updates[index].values } });
      }
      const receipt = await service.recordBatchChanges(table.id, result.batchId, { limit: 100 });
      assert.equal(receipt.batch.recordCount, 1000); assert.equal(receipt.batch.remainingCount, 1000);
      assert.equal(receipt.batch.recordWrite, true);
      const changes = [...receipt.changes];
      let before = receipt.nextBefore;
      while (before !== undefined) {
        const page = await service.recordBatchChanges(table.id, result.batchId, { limit: 100, before });
        changes.push(...page.changes); before = page.nextBefore;
      }
      assert.equal(changes.length, 1000);
      assert.deepEqual(new Set(changes.map(change => change.recordId)), new Set(records.map(record => record.id)));
      for (const index of [0, 999]) {
        const record = records[index], change = changes.find(change => change.recordId === record.id);
        const snapshot = await service.recordChange(table.id, record.id, change.id);
        assert.deepEqual(snapshot.before, record); assert.deepEqual(snapshot.after, result.records[index]);
      }
      expected = result.records;
      const batches = await service.recordBatches(table.id, {});
      await assert.rejects(async () => service.updateBatch([
        { ...updates[0], expectedVersion: expected[0].version, values: { [fields[0].id]: 'Must roll back' } },
        updates[999],
      ], table.id), { code: 'VERSION_CONFLICT' });
      assert.deepEqual(await service.recordBatches(table.id, {}), batches);
      assert.deepEqual(await service.getRecord(table.id, records[0].id), expected[0]);
    } finally { await close(); }
  }
  const { service, close } = await open(database);
  try {
    const records = [];
    for (const offset of [0, 500]) records.push(...(await service.queryRecords(dataset.seed.table.id, { offset, limit: 500 })).records);
    assert.deepEqual(records, expected);
  } finally { await close(); }
  await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${dataset.rows} × ${dataset.columns}: ${measurements.samplesMs.map(value => value.toFixed(1)).join(', ')} ms.`);
}
console.log(`Results: ${join(directory, 'results.json')}`);
