import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

const directory = await mkdtemp(resolve('.artifacts/group-measure-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null), service = new RecordService(store);
const count = 100000, key = index => 'Group ' + String(index).padStart(6, '0'), amountAt = index => index % 101 - 50;
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: compiled service calls without renderer, HTTP or GUI.', rows: count,
  dataset: '100,000 distinct text groups; 100 numeric buckets of 1,000 records; amounts cycle from -50 to 50.', samples: {} };
try {
  let table = service.createTable({ name: 'Measured groups' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Bucket', type: 'number' });
  const groupBy = table.primaryFieldId, amount = table.fields[1].id, bucket = table.fields[2].id;
  const measures = ['sum', 'average', 'min', 'max'].map(operation => ({ fieldId: amount, operation }));
  const expectedBuckets = new Map();
  for (let offset = 0; offset < count; offset += 2000) {
    service.createRecords(table.id, Array.from({ length: 2000 }, (_, i) => {
      const index = count - 1 - offset - i, value = amountAt(index), group = Math.floor(index / 1000);
      const values = expectedBuckets.get(group) ?? []; values.push(value); expectedBuckets.set(group, values);
      return { values: { [groupBy]: key(index), [amount]: value, [bucket]: group } };
    }));
  }
  const before = service.workspaceState({ tableId: table.id });
  const collapse = { defaultCollapsed: true, exceptions: [] };
  for (const [name, input] of [
    ['baselineDistinct', { groupBy, collapse, offset: 50000, limit: 50 }],
    ['fourMeasuresDistinct', { groupBy, measures, collapse, offset: 50000, limit: 50 }],
    ['twelveMeasuresDistinct', { groupBy, measures: [...measures, ...measures, ...measures], collapse, offset: 50000, limit: 50 }],
    ['fourMeasuresLargeGroups', { groupBy: bucket, measures, offset: 50001, limit: 50 }],
    ['sparseExpandedMeasures', { groupBy, measures, window: 'expandedRecords', offset: 0, limit: 2,
      collapse: { defaultCollapsed: true, exceptions: [key(1), key(count - 2)] } }],
  ]) {
    const read = () => service.queryGroups(table.id, input); read(); read();
    const times = [];
    for (let iteration = 0; iteration < 20; iteration++) {
      const started = performance.now(), layout = read(); times.push(performance.now() - started);
      assert.equal(layout.totalRecords, count); assert.ok(layout.groups.length <= input.limit);
      assert.equal(layout.totalGroups, input.groupBy === bucket ? 101 : 100001);
      for (const group of layout.groups) {
        const values = input.groupBy === bucket ? expectedBuckets.get(group.key) : [amountAt(Number(group.key.slice(6)))];
        assert.equal(group.count, values.length);
        const aggregate = [values.reduce((a, b) => a + b, 0), values.reduce((a, b) => a + b, 0) / values.length, Math.min(...values), Math.max(...values)];
        if (input.measures) assert.deepEqual(group.values, input.measures.length === 12 ? [...aggregate, ...aggregate, ...aggregate] : aggregate);
        else assert.equal(group.values, undefined);
      }
      if (name === 'sparseExpandedMeasures') assert.deepEqual(layout.groups.map(group => group.key), [key(1), key(count - 2)]);
    }
    result.samples[name] = times;
  }
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  result.correctness = 'Every sample checked complete counts and independently calculated measures; sparse windows contain exactly the requested expanded groups; workspace state is unchanged.';
  result.summary = Object.fromEntries(Object.entries(result.samples).map(([name, times]) => {
    const sorted = [...times].sort((a, b) => a - b);
    return [name, { min: sorted[0], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) }];
  }));
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { store.close(); }
