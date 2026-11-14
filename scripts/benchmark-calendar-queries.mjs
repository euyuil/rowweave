import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

const directory = await mkdtemp(resolve('.artifacts/calendar-performance-'));
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null), service = new RecordService(store);
const count = 100000, first = Date.parse('2018-01-01T00:00:00Z'), last = Date.parse('2032-01-01T00:00:00Z');
const values = Array.from({ length: count }, (_, index) => {
  const start = index % 37 ? Math.floor(first + (last - first) * index / count) : null;
  const end = start === null ? null : start + (index % 41 === 0 ? -1 : index % 7 === 0 ? 4000 : index % 5) * 86400000;
  return { start, end, date: start === null ? null : new Date(start).toISOString().slice(0, 10),
    endDate: end === null ? null : new Date(end).toISOString().slice(0, 10), score: index % 20 };
});
const result = { measuredAt: new Date().toISOString(), source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  node: process.version, sqlite: process.versions.sqlite, os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem(), rows: count,
  display: 'Not applicable: compiled service calls without renderer, HTTP or GUI.',
  dataset: '100,000 intervals across 2018–2032; null every 37th, reversed every 41st non-null, 4,000-day spans every seventh remaining, otherwise 0–4 days. Date/timestamp fields and a relation to one of 20 numeric-score records.',
  method: 'Saved-query calendar layouts or bucket pages, complete counts, projected values and continuation metadata; 2 warmups and 20 timed calls. Independent per-day overlap scans and Intl/binary-search day bounds verify every result outside the timed region.', samples: {} };
try {
  let owners = service.createTable({ name: 'Owners' });
  owners = service.createField(owners.id, { expectedVersion: owners.version, name: 'Score', type: 'number' });
  const ownerRows = service.createRecords(owners.id, Array.from({ length: 20 }, (_, score) => ({ values: {
    [owners.primaryFieldId]: 'Owner ' + score, [owners.fields[1].id]: score,
  } }))).records;
  let table = service.createTable({ name: 'Calendar benchmark' });
  for (const [name, type] of [['Date', 'date'], ['End date', 'date'], ['At', 'datetime'], ['Until', 'datetime']]) {
    table = service.createField(table.id, { expectedVersion: table.version, name, type });
  }
  const [, date, endDate, at, until] = table.fields.map(field => field.id);
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Owner', type: 'relation', relation: { tableId: owners.id, multiple: false } });
  const owner = table.fields.at(-1).id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Score', type: 'lookup',
    lookup: { relationFieldId: owner, fieldId: owners.fields[1].id, operation: 'sum' } });
  const score = table.fields.at(-1).id, ids = [];
  for (let offset = 0; offset < count; offset += 2000) {
    const batch = service.createRecords(table.id, values.slice(offset, offset + 2000).map((value, index) => ({ values: {
      [table.primaryFieldId]: 'Event ' + String(offset + index).padStart(6, '0'), [date]: value.date, [endDate]: value.endDate,
      [at]: value.start === null ? null : new Date(value.start).toISOString(),
      [until]: value.end === null ? null : new Date(value.end).toISOString(), [owner]: [ownerRows[value.score].id],
    } })));
    ids.push(...batch.records.map(record => record.id));
  }
  const base = service.createView(table.id, { name: 'Calendar source', query: { sort: [{ fieldId: table.primaryFieldId, direction: 'asc' }] } });
  const linked = service.createView(table.id, { name: 'Linked source', query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: score, operator: 'gt', value: 9 }] },
    sort: [{ fieldId: score, direction: 'desc' }, { fieldId: table.primaryFieldId, direction: 'asc' }],
  } });
  for (const [label, dateOnly, timeZone, from, toExclusive, kind, useLinked] of [
    ['dateMonth', true, 'UTC', '2026-11-01', '2026-12-01', 'layout', false],
    ['timestampDST', false, 'America/New_York', '2026-03-01', '2026-04-12', 'layout', false],
    ['sixtyTwoDates', true, 'UTC', '2026-01-01', '2026-03-04', 'layout', false],
    ['linkedFilterSort', false, 'Australia/Lord_Howe', '2026-10-01', '2026-11-01', 'layout', true],
    ['busyDayPage', false, 'America/New_York', '2026-11-01', '2026-11-02', 'day', false],
    ['invalidPage', true, 'UTC', '2026-11-01', '2026-11-02', 'invalid', false],
  ]) {
    const indices = values.map((_, index) => index).filter(index => !useLinked || values[index].score > 9);
    if (useLinked) indices.sort((a, b) => values[b].score - values[a].score || a - b);
    const invalid = indices.filter(index => values[index].start !== null && values[index].end < values[index].start);
    const unscheduled = indices.filter(index => values[index].start === null);
    const valid = indices.filter(index => values[index].start !== null && values[index].end >= values[index].start);
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDate = instant => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const bound = date => {
      let low = Date.parse(date) - 2 * 86400000, high = Date.parse(date) + 2 * 86400000;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (localDate(middle) < date) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const days = [], occupied = new Set();
    for (let instant = Date.parse(from); instant < Date.parse(toExclusive); instant += 86400000) {
      const day = new Date(instant).toISOString().slice(0, 10), next = new Date(instant + 86400000).toISOString().slice(0, 10);
      const start = dateOnly ? instant : bound(day), end = dateOnly ? instant + 86400000 : bound(next);
      const matches = valid.filter(index => {
        const row = values[index];
        return dateOnly ? row.date <= day && row.endDate >= day
          : row.start === row.end ? row.start >= start && row.start < end : row.start < end && row.end > start;
      });
      matches.forEach(index => occupied.add(index));
      days.push({ date: day, matches });
    }
    const view = useLinked ? linked : base, state = service.workspaceState({ tableId: table.id, viewId: view.id });
    const common = { calendar: { startFieldId: dateOnly ? date : at, endFieldId: dateOnly ? endDate : until, timeZone },
      viewId: view.id, expectedViewVersion: view.version, fields: [table.primaryFieldId, dateOnly ? date : at, dateOnly ? endDate : until, ...(useLinked ? [owner, score] : [])] };
    const read = () => kind === 'layout' ? service.queryCalendar(table.id, { ...common, from, toExclusive, previewLimit: 3 })
      : service.queryCalendarRecords(table.id, { ...common, bucket: kind === 'day' ? { kind, date: from } : { kind }, offset: 100, limit: 50 });
    const verifyIds = (records, expected) => assert.deepEqual(records.map(record => record.id), expected.map(index => ids[index]));
    const verify = output => {
      assert.equal(output.revision, state.table.dataRevision); assert.equal(output.viewVersion, view.version);
      if (kind === 'layout') {
        assert.equal(output.totalRecords, indices.length); assert.equal(output.scheduledRecords, occupied.size);
        output.days.forEach((day, index) => { assert.equal(day.date, days[index].date); assert.equal(day.count, days[index].matches.length); verifyIds(day.records, days[index].matches.slice(0, 3)); });
        assert.equal(output.invalid.count, invalid.length); verifyIds(output.invalid.records, invalid.slice(0, 3));
        assert.equal(output.unscheduled.count, unscheduled.length); verifyIds(output.unscheduled.records, unscheduled.slice(0, 3));
      } else {
        const matches = kind === 'day' ? days[0].matches : invalid;
        assert.equal(output.total, matches.length); verifyIds(output.records, matches.slice(100, 150));
      }
    };
    verify(read()); verify(read());
    const samples = [];
    for (let index = 0; index < 20; index++) { const start = performance.now(), output = read(); samples.push(performance.now() - start); verify(output); }
    const ordered = [...samples].sort((a, b) => a - b);
    result.samples[label] = { samples, p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1], minMs: ordered[0], maxMs: ordered.at(-1), totalMatching: indices.length, scheduledRecords: occupied.size };
    const continuation = service.queryCalendarRecords(table.id, { ...common, bucket: { kind: 'day', date: from }, offset: 50, limit: 50, expectedRevision: state.table.dataRevision });
    assert.equal(continuation.total, days[0].matches.length); verifyIds(continuation.records, days[0].matches.slice(50, 100));
    assert.deepEqual(service.workspaceState({ tableId: table.id, viewId: view.id }), state);
    console.log(label, JSON.stringify(result.samples[label]));
  }
  await writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Calendar query benchmark complete:', directory);
} finally { store.close(); }
