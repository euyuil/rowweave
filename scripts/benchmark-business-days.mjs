import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

const directory = await mkdtemp(resolve('.artifacts/business-day-performance-'));
let now = new Date('2026-03-06T12:00:00Z');
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null, () => now), service = new RecordService(store);
const count = 100000, start = Date.parse('2010-01-01T00:00:00Z'), end = Date.parse('2045-01-01T00:00:00Z');
const values = Array.from({ length: count }, (_, index) => index % 37 === 0 ? null : new Date(Math.floor(start + (end - start) * index / count)).toISOString());
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(),
  display: 'Not applicable: compiled service calls without renderer, HTTP or GUI.', rows: count,
  dataset: '100,000 chronological instants across 2010–2045; every 37th row has null date/timestamp. Matching date and timestamp fields, stable generated record UUIDs.',
  method: 'Saved-view first page (50 records), complete matching count and context; 2 warmups and 20 measured calls. Independent weekday iteration and Intl date formatting verify every result and guarded continuation.',
  samples: {} };
try {
  let table = service.createTable({ name: 'Business day benchmark' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Day', type: 'date' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'At', type: 'datetime' });
  const day = table.fields[1].id, at = table.fields[2].id, ids = [];
  for (let offset = 0; offset < count; offset += 2000) {
    const batch = service.createRecords(table.id, values.slice(offset, offset + 2000).map((value, index) => ({ values: {
      [table.primaryFieldId]: 'Event ' + String(offset + index).padStart(6, '0'), [day]: value?.slice(0, 10) ?? null, [at]: value,
    } })));
    ids.push(...batch.records.map(record => record.id));
  }
  for (const [label, instant, timeZone, days, direction, fieldId] of [
    ['shortNextTimestamp', '2026-03-06T12:00:00Z', 'America/New_York', 5, 1, at],
    ['longPastDate', '2026-11-01T12:00:00Z', 'UTC', 3660, -1, day],
    ['longPastTimestamp', '2026-11-01T12:00:00Z', 'America/New_York', 3660, -1, at],
    ['longNextTimestamp', '2026-11-01T12:00:00Z', 'America/New_York', 3660, 1, at],
    ['halfHourTimestamp', '2026-10-02T12:00:00Z', 'Australia/Lord_Howe', 3660, -1, at],
    ['fixedOffsetTimestamp', '2026-01-02T12:00:00Z', 'Asia/Kathmandu', 3660, 1, at],
  ]) {
    now = new Date(instant);
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDate = value => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const cursor = new Date(localDate(instant) + 'T12:00:00Z'), dates = new Set();
    while (dates.size < days) {
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.add(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + direction);
    }
    const expected = values.flatMap((value, index) => value !== null && dates.has(fieldId === day ? value.slice(0, 10) : localDate(value)) ? [index] : []);
    const view = service.createView(table.id, { name: label, query: { filter: { conjunction: 'and', conditions: [
      { fieldId, operator: 'relativeDate', relative: { period: direction > 0 ? 'nextBusinessDays' : 'pastBusinessDays', days, timeZone } },
    ] } } });
    const state = service.workspaceState({ tableId: table.id, viewId: view.id });
    const read = () => service.queryView(table.id, view.id, { limit: 50 });
    const verify = page => {
      assert.equal(page.total, expected.length);
      assert.deepEqual(page.records.map(row => row.id), expected.slice(0, 50).map(index => ids[index]));
      assert.equal(page.dateContext, state.table.view.dateContext);
    };
    verify(read()); verify(read());
    const samples = [];
    let first;
    for (let iteration = 0; iteration < 20; iteration++) {
      const begun = performance.now(); first = read(); samples.push(performance.now() - begun); verify(first);
    }
    const continuation = service.queryView(table.id, view.id, { offset: 50, limit: 50, expectedViewVersion: view.version,
      expectedRevision: first.revision, expectedDateContext: first.dateContext });
    assert.deepEqual(continuation.records.map(row => row.id), expected.slice(50, 100).map(index => ids[index]));
    assert.deepEqual(service.workspaceState({ tableId: table.id, viewId: view.id }), state);
    const sorted = [...samples].sort((a, b) => a - b);
    result.samples[label] = { matching: expected.length, p95: sorted[18], min: sorted[0], max: sorted[19], values: samples };
    console.log(JSON.stringify({ label, ...result.samples[label], values: undefined }));
  }
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2));
  console.log(directory);
} finally { store.close(); }
