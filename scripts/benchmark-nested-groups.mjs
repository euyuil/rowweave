import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

const directory = await mkdtemp(resolve('.artifacts/nested-group-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null), service = new RecordService(store);
const count = 100000, key = index => 'Group ' + String(index).padStart(6, '0'), amountAt = index => index % 101 - 50;
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: compiled service calls without renderer, HTTP or GUI.', rows: count,
  dataset: '100,000 distinct text values; 100 numeric buckets each containing 10 parts of 100 records; amounts cycle from -50 to 50.', samples: {} };
try {
  let table = service.createTable({ name: 'Nested group benchmark' });
  for (const name of ['Bucket', 'Part', 'Amount']) table = service.createField(table.id, { expectedVersion: table.version, name, type: 'number' });
  const name = table.primaryFieldId, bucket = table.fields[1].id, part = table.fields[2].id, amount = table.fields[3].id;
  for (let offset = 0; offset < count; offset += 2000) service.createRecords(table.id, Array.from({ length: 2000 }, (_, i) => {
    const index = count - 1 - offset - i;
    return { values: { [name]: key(index), [bucket]: Math.floor(index / 1000), [part]: Math.floor(index % 1000 / 100), [amount]: amountAt(index) } };
  }));
  const before = service.workspaceState({ tableId: table.id });
  const groupBy = [name, bucket, part], measures = ['sum', 'average', 'min', 'max'].map(operation => ({ fieldId: amount, operation }));
  const exceptions = [1, count - 2].flatMap(index => [[key(index)], [key(index), Math.floor(index / 1000)],
    [key(index), Math.floor(index / 1000), Math.floor(index % 1000 / 100)]]);
  for (const [label, input] of [
    ['distinctCollapsed', { groupBy, offset: 50000, limit: 50, collapse: { defaultCollapsed: true, exceptions: [] } }],
    ['distinctExpanded', { groupBy, offset: 200000, limit: 50 }],
    ['distinctCollapsedMeasures', { groupBy, measures, offset: 50000, limit: 50, collapse: { defaultCollapsed: true, exceptions: [] } }],
    ['balancedExpandedMeasures', { groupBy: [bucket, part, name], measures, offset: 100000, limit: 50 }],
    ['twoLevelExpandedMeasures', { groupBy: [bucket, part], measures, offset: 50000, limit: 50 }],
    ['sparseExpandedMeasures', { groupBy, measures, window: 'expandedRecords', limit: 2, collapse: { defaultCollapsed: true, exceptions } }],
  ]) {
    const read = () => service.queryGroups(table.id, input); read(); read();
    const samples = [];
    for (let sample = 0; sample < 20; sample++) {
      const started = performance.now(), layout = read(); samples.push(performance.now() - started);
      assert.equal(layout.totalRecords, count); assert.ok(layout.groups.length <= input.limit);
      const balanced = input.groupBy[0] === bucket, twoLevel = input.groupBy.length === 2, sparse = input.window === 'expandedRecords';
      assert.equal(layout.totalGroups, twoLevel ? 1101 : balanced ? 101101 : sparse ? count + 5 : input.collapse ? count + 1 : count * 3 + 1);
      assert.equal(layout.totalRows, twoLevel ? 101101 : balanced ? 201101 : sparse ? count + 7 : input.collapse ? count + 1 : count * 4 + 1);
      for (const group of layout.groups) {
        let start, length;
        if (!balanced) { start = Number(group.path[0].slice(6)); length = 1; }
        else if (group.path.length === 1) { start = group.path[0] * 1000; length = 1000; }
        else if (group.path.length === 2) { start = group.path[0] * 1000 + group.path[1] * 100; length = 100; }
        else { start = Number(group.path[2].slice(6)); length = 1; }
        assert.equal(group.count, length); assert.equal(group.recordOffset, start);
        assert.equal(group.leaf, group.path.length === input.groupBy.length);
        if (input.measures) {
          const amounts = Array.from({ length }, (_, index) => amountAt(start + index)), sum = amounts.reduce((sum, value) => sum + value, 0);
          assert.deepEqual(group.values, [sum, sum / length, Math.min(...amounts), Math.max(...amounts)]);
        } else assert.equal(group.values, undefined);
      }
      if (sparse) assert.deepEqual(layout.groups.map(group => [group.recordOffset, group.expandedOffset]), [[1, 0], [count - 2, 1]]);
    }
    result.samples[label] = samples;
  }
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  result.correctness = 'Every sample checked complete record/visible-heading counts, bounded results, typed paths, leaf/source offsets and independent complete-group measures; sparse reads verified expanded offsets. Workspace state did not change.';
  result.summary = Object.fromEntries(Object.entries(result.samples).map(([name, samples]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return [name, { min: sorted[0], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) }];
  }));
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { store.close(); }
