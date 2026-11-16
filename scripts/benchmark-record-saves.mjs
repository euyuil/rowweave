import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

if (!process.argv[2]) throw new Error('Pass results.json from the production desktop benchmark. Source databases are copied, never updated.');
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/record-save-performance-'));
const report = {
  measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  sourceDatasetReport: resolve(process.argv[2]), sourceDatasetPackage: input.package,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  method: 'Production-compiled service; isolated SQLite backups of both typed desktop benchmark datasets. ' +
    'Three separate store connections per size, each updating 1,000 records and ten text fields. ' +
    'The timed operation includes validation, complete history and durable commit. Reads, correctness assertions, ' +
    'a rejected stale batch and restart checks are outside timing. No HTTP, renderer or SQL instrumentation.',
  datasets: [],
};
for (const dataset of input.datasets) {
  const database = join(directory, `${dataset.rows}x${dataset.columns}.sqlite`);
  const source = new DatabaseSync(dataset.seed.database, { readOnly: true });
  try { await backup(source, database); } finally { source.close(); }
  const measurements = { rows: dataset.rows, columns: dataset.columns, database, samplesMs: [] };
  report.datasets.push(measurements);
  let expected;
  for (let trial = 0; trial < 3; trial++) {
    const store = new SqliteRecordStore(database), service = new RecordService(store);
    try {
      const table = service.getTable(dataset.seed.table.id);
      assert.equal(table.total, dataset.rows); assert.equal(table.fields.length, dataset.columns);
      const fields = table.fields.slice(0, 10);
      assert.ok(fields.every(field => field.type === 'text'));
      const records = [0, 500].flatMap(offset => service.queryRecords(table.id, { offset, limit: 500 }).records);
      assert.equal(records.length, 1000);
      if (expected) assert.deepEqual(records, expected);
      const updates = records.map((record, row) => ({ id: record.id, expectedVersion: record.version,
        values: Object.fromEntries(fields.map((field, column) => [field.id, `Save ${trial} ${row}/${column} 🌱`])) }));
      const start = performance.now();
      const result = service.updateBatch(updates, table.id);
      measurements.samplesMs.push(performance.now() - start);
      assert.equal(result.records.length, 1000);
      for (let index = 0; index < records.length; index++) {
        assert.deepEqual(result.records[index], { ...records[index], version: records[index].version + 1,
          values: { ...records[index].values, ...updates[index].values } });
      }
      const receipt = service.recordBatchChanges(table.id, result.batchId, { limit: 100 });
      assert.equal(receipt.batch.recordCount, 1000); assert.equal(receipt.batch.remainingCount, 1000);
      assert.equal(receipt.batch.recordWrite, true);
      const changes = [...receipt.changes];
      let before = receipt.nextBefore;
      while (before !== undefined) {
        const page = service.recordBatchChanges(table.id, result.batchId, { limit: 100, before });
        changes.push(...page.changes); before = page.nextBefore;
      }
      assert.equal(changes.length, 1000);
      assert.deepEqual(new Set(changes.map(change => change.recordId)), new Set(records.map(record => record.id)));
      for (const index of [0, 999]) {
        const record = records[index], change = changes.find(change => change.recordId === record.id);
        const snapshot = service.recordChange(table.id, record.id, change.id);
        assert.deepEqual(snapshot.before, record); assert.deepEqual(snapshot.after, result.records[index]);
      }
      expected = result.records;
      const batches = service.recordBatches(table.id, {});
      assert.throws(() => service.updateBatch([
        { ...updates[0], expectedVersion: expected[0].version, values: { [fields[0].id]: 'Must roll back' } },
        updates[999],
      ], table.id), { code: 'VERSION_CONFLICT' });
      assert.deepEqual(service.recordBatches(table.id, {}), batches);
      assert.deepEqual(service.getRecord(table.id, records[0].id), expected[0]);
    } finally { store.close(); }
  }
  const reopened = new SqliteRecordStore(database), service = new RecordService(reopened);
  try {
    assert.deepEqual([0, 500].flatMap(offset => service.queryRecords(dataset.seed.table.id, { offset, limit: 500 }).records), expected);
  } finally { reopened.close(); }
  await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${dataset.rows} × ${dataset.columns}: ${measurements.samplesMs.map(value => value.toFixed(1)).join(', ')} ms.`);
}
console.log(`Results: ${join(directory, 'results.json')}`);
