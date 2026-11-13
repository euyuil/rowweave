import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

await mkdir('.artifacts', { recursive: true });
const directory = await mkdtemp(resolve('.artifacts/group-layout-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null);
const service = new RecordService(store);
const count = 100000, key = index => 'Group ' + String(index).padStart(6, '0');
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: compiled service calls without renderer, HTTP or GUI.',
  rows: count, distinctGroups: count, samples: {} };
const measure = (name, operation, validate, repeats = 20) => {
  const times = [];
  for (let index = 0; index < repeats; index++) {
    const started = performance.now(), value = operation();
    times.push(performance.now() - started); validate(value);
  }
  result.samples[name] = times;
};
try {
  const table = service.createTable({ name: 'Many groups' }), groupBy = table.primaryFieldId;
  const started = performance.now();
  for (let offset = 0; offset < count; offset += 2000) {
    service.createRecords(table.id, Array.from({ length: 2000 }, (_, index) => ({
      values: { [groupBy]: key(count - 1 - offset - index) },
    })));
  }
  result.seedMs = performance.now() - started;
  const before = service.workspaceState({ tableId: table.id });
  const many = Array.from({ length: count / 2 }, (_, index) => key(index * 2));
  for (const [name, offset, collapse, expectedRows, position, collapsed] of [
    ['expandedFirst', 0, { defaultCollapsed: false, exceptions: [] }, 200001, index => index * 2, () => false],
    ['expandedDeep', 99999, { defaultCollapsed: false, exceptions: [] }, 200001, index => index * 2, () => false],
    ['collapsedDeep', 50000, { defaultCollapsed: true, exceptions: [] }, 100001, index => index, () => true],
    ['fiftyThousandExceptions', 75001, { defaultCollapsed: false, exceptions: many }, 150001,
      index => index + Math.floor(index / 2), index => index % 2 === 0 && index !== count],
  ]) {
    const read = () => service.queryGroups(table.id, { groupBy, offset, limit: 50, collapse });
    read(); read();
    measure(name, read, layout => {
      assert.equal(layout.totalRecords, count); assert.equal(layout.totalGroups, count + 1);
      assert.equal(layout.totalRows, expectedRows); assert.ok(layout.groups.length <= 50);
      let covered = offset;
      for (const group of layout.groups) {
        const index = group.key === null ? count : Number(group.key.slice(6));
        assert.equal(group.recordOffset, index); assert.equal(group.rowStart, position(index));
        assert.equal(group.count, index === count ? 0 : 1); assert.equal(group.collapsed, collapsed(index));
        assert.ok(group.rowStart <= covered); covered = group.rowStart + 1 + (group.collapsed ? 0 : group.count);
      }
      assert.ok(covered >= Math.min(expectedRows, offset + 50));
    });
  }
  const read = () => service.queryRecords(table.id, { groupBy, offset: 50000, limit: 50, fields: [groupBy] });
  read(); read();
  measure('matchingRecordPage', read, page => {
    assert.equal(page.total, count);
    assert.deepEqual(page.records.map(record => record.values[groupBy]), Array.from({ length: 50 }, (_, index) => key(50000 + index)));
  });
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  result.correctness = 'Every sample checked complete counts, typed keys, offsets, contiguous window coverage or matching record order; no workspace state changed.';
  result.summary = Object.fromEntries(Object.entries(result.samples).map(([name, samples]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return [name, { min: sorted[0], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) }];
  }));
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, ...result }, null, 2));
} finally { store.close(); }
