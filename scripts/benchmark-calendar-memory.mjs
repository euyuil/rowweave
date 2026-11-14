import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

const directory = resolve(process.argv[2] ?? '');
if (dirname(directory) !== resolve('.artifacts') || !basename(directory).startsWith('calendar-performance-')) {
  throw new Error('Provide a generated .artifacts/calendar-performance-* directory, never a working workspace.');
}
const benchmark = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const store = new SqliteRecordStore(join(directory, 'benchmark.sqlite'), null), service = new RecordService(store);
try {
  const table = service.listTables().find(table => table.name === 'Calendar benchmark');
  const field = name => table.fields.find(field => field.name === name).id;
  const views = service.listViews(table.id), base = views.find(view => view.name === 'Calendar source'), linked = views.find(view => view.name === 'Linked source');
  const common = { calendar: { startFieldId: field('At'), endFieldId: field('Until'), timeZone: 'Australia/Lord_Howe' },
    fields: [table.primaryFieldId, field('At'), field('Until'), field('Owner'), field('Score')] };
  const state = service.workspaceState({ tableId: table.id, viewId: linked.id });
  const result = { measuredAt: new Date().toISOString(), source, datasetSource: benchmark.source,
    uncommittedChanges: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    node: process.version, sqlite: process.versions.sqlite, rows: benchmark.rows,
    method: 'Fresh service-only process reopens the generated database without the dataset generator. Two warm-up circuits, then eight circuits of linked-filter/sort month layout, whole-table date layout, and linked busy-day paging. Process RSS includes Node, SQLite and allocator memory; it is not whole-desktop or private-byte usage. No forced GC or renderer.',
    initial: process.memoryUsage(), samples: [] };
  const circuit = () => {
    const layout = service.queryCalendar(table.id, { ...common, viewId: linked.id, expectedViewVersion: linked.version,
      from: '2026-10-01', toExclusive: '2026-11-01', previewLimit: 3 });
    assert.equal(layout.totalRecords, 50000); assert.equal(layout.scheduledRecords, benchmark.samples.linkedFilterSort.scheduledRecords);
    const all = service.queryCalendar(table.id, { ...common, calendar: { startFieldId: field('Date'), endFieldId: field('End date'), timeZone: 'UTC' },
      viewId: base.id, expectedViewVersion: base.version, from: '2026-11-01', toExclusive: '2026-12-01', previewLimit: 3 });
    assert.equal(all.totalRecords, 100000); assert.equal(all.scheduledRecords, benchmark.samples.dateMonth.scheduledRecords);
    const page = service.queryCalendarRecords(table.id, { ...common, viewId: linked.id, expectedViewVersion: linked.version,
      bucket: { kind: 'day', date: '2026-10-01' }, offset: 3, limit: 50, expectedRevision: layout.revision });
    assert.equal(page.total, layout.days[0].count); assert.equal(page.records.length, 50);
  };
  circuit(); circuit();
  result.afterWarmup = process.memoryUsage();
  for (let index = 0; index < 8; index++) { circuit(); result.samples.push(process.memoryUsage()); }
  const last = result.samples.slice(-3).map(sample => sample.rss);
  result.lastThreeRssSpreadBytes = Math.max(...last) - Math.min(...last);
  result.maxMeasuredRssBytes = Math.max(...result.samples.map(sample => sample.rss));
  assert.deepEqual(service.workspaceState({ tableId: table.id, viewId: linked.id }), state);
  await writeFile(join(directory, 'memory-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { store.close(); }
