import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';

const run = promisify(execFile);

test('the packed SDK installs offline outside the repository, exposes usable types, and operates a real service', async t => {
  const npm = process.env['npm_execpath'];
  assert.ok(npm, 'Run SDK package verification with npm test.');
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-sdk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, 'npm-cache');
  const packed = await run(process.execPath, [npm, 'pack', resolve('packages/client'), '--ignore-scripts', '--offline',
    '--json', '--pack-destination', directory, '--cache', cache]);
  const [archive] = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  assert.ok(archive);
  assert.ok(archive.files.some(file => file.path === 'dist/index.js'));
  assert.ok(archive.files.some(file => file.path === 'dist/types/contracts/src/index.d.ts'));
  assert.ok(archive.files.every(file => ['package.json', 'README.md'].includes(file.path) || file.path.startsWith('dist/')));
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run(process.execPath, [npm, 'install', join(directory, archive.filename), '--ignore-scripts', '--offline',
    '--no-audit', '--no-fund', '--cache', cache], { cwd: consumer });
  const installed = JSON.parse(await readFile(join(consumer, 'node_modules/@rowweave/sdk/package.json'), 'utf8'));
  assert.equal(installed.dependencies, undefined);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
    exactOptionalPropertyTypes: true, types: [], lib: ['ES2023', 'DOM'],
  }, files: ['consumer.ts'] }));
  await writeFile(join(consumer, 'consumer.ts'), `
import { createWorkspaceClient, ApiFailure, type RecordQuery, type CsvPreview, type Table, type GroupLayout } from '@rowweave/sdk';
const api = createWorkspaceClient({ url: 'http://127.0.0.1:4317', token: 'provided-at-runtime' });
const calendar = { startFieldId: 'start', endFieldId: 'end', timeZone: 'Asia/Shanghai' };
void api.createView('table', { name: 'Schedule', type: 'calendar', calendar });
void api.rescheduleRecord('table', 'calendar-view', 'record', { expectedVersion: 1, expectedViewVersion: 1, action: 'move', days: 2 });
void api.queryCalendar('table', { viewId: 'calendar-view', from: '2026-11-01', toExclusive: '2026-12-01' });
void api.queryCalendarRecords('table', { viewId: 'calendar-view', bucket: { kind: 'unscheduled' } });
void api.queryCalendar('table', { calendar, from: '2026-11-01', toExclusive: '2026-12-01', previewLimit: 3,
  fields: ['label'], expectedRevision: 1, viewId: 'view', expectedViewVersion: 1 }, new AbortController().signal);
void api.queryCalendarRecords('table', { calendar, bucket: { kind: 'day', date: '2026-11-01' }, limit: 50 });
void api.queryCalendarRecords('table', { calendar, bucket: { kind: 'unscheduled' } });
void api.queryCalendarRecords('table', { calendar, bucket: { kind: 'invalid' } });
const query: RecordQuery = { filter: { conjunction: 'and', conditions: [{ fieldId: 'amount', operator: 'gte', value: 1 }] } };
const tables: Promise<Table[]> = api.listTables();
const preview: Promise<CsvPreview> = api.previewCsv('table', { expectedVersion: 1, hasHeader: true, csv: 'Name\\nA' });
void api.queryRecords('table', query, new AbortController().signal);
const groups: Promise<GroupLayout> = api.queryGroups('table', { groupBy: 'amount', limit: 20,
  measures: [{ fieldId: 'amount', operation: 'sum' }],
  window: 'expandedRecords', collapse: { defaultCollapsed: true, exceptions: [0, null] } }, new AbortController().signal);
void api.createView('table', { name: 'Saved measures', groupBy: 'amount', groupMeasures: [{ fieldId: 'amount', operation: 'sum' }] });
void api.queryGroups('table', { groupBy: ['done', 'amount'], collapse: { defaultCollapsed: true, exceptions: [[false], [false, 0]] } });
void api.createView('table', { name: 'Nested', groupBy: ['done', 'amount'] });
void api.createView('table', { name: 'Annual', query: { filter: { conjunction: 'or', conditions:
  (['thisYear', 'lastYear', 'nextYear'] as const).map(period => ({ fieldId: 'due', operator: 'relativeDate' as const,
    relative: { period, timeZone: 'UTC' } })) } } });
void api.exportCsv('table', { viewId: 'view', expectedViewVersion: 1 });
void api.createView('table', { name: 'Hourly', query: { filter: { conjunction: 'or', conditions:
  (['pastHours', 'nextHours'] as const).map(period => ({ fieldId: 'at', operator: 'relativeDate' as const,
    relative: { period, hours: 2, timeZone: 'UTC' } })) } } });
void api.workspaceState({ tableId: 'table', viewId: 'view', dateContext: 'opaque-context-from-query' });
void api.createView('table', { name: 'Weekdays', query: { filter: { conjunction: 'or', conditions:
  (['pastBusinessDays', 'nextBusinessDays'] as const).map(period => ({ fieldId: 'due', operator: 'relativeDate' as const,
    relative: { period, days: 5, timeZone: 'UTC' } })) } } });
// @ts-expect-error Record writes require numeric versions.
void api.updateRecords('table', [{ id: 'record', expectedVersion: 'stale', values: {} }]);
// @ts-expect-error Field types are a closed set.
void api.createField('table', { expectedVersion: 1, name: 'Unknown', type: 'unsupported' });
const code: string = new ApiFailure('VERSION_CONFLICT', 'Conflict', 409).code;
void [tables, preview, groups, code];
`);
  await run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')]);
  const service = new RecordService(fixture(t, null).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  await writeFile(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createWorkspaceClient, ApiFailure } from '@rowweave/sdk';
const api = createWorkspaceClient({ url: process.env.ROWWEAVE_URL, token: process.env.ROWWEAVE_TOKEN });
let table = await api.createTable({ name: 'SDK workspace' });
table = await api.createField(table.id, { expectedVersion: table.version, name: 'Cost', type: 'number', defaultValue: 0 });
const cost = table.fields[1].id;
const created = (await api.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'SDK 中文', [cost]: 12.5 } }])).records[0];
const view = await api.createView(table.id, { name: 'Paid', query: { filter: { conjunction: 'and', conditions: [{ fieldId: cost, operator: 'gt', value: 10 }] } } });
assert.equal((await api.queryView(table.id, view.id, { expectedViewVersion: view.version })).total, 1);
const changed = (await api.updateRecords(table.id, [{ id: created.id, expectedVersion: created.version, values: { [cost]: 5 } }])).records[0];
assert.equal((await api.queryView(table.id, view.id, {})).total, 0);
await assert.rejects(api.updateRecords(table.id, [{ id: created.id, expectedVersion: 1, values: { [cost]: 99 } }]), error => error instanceof ApiFailure && error.code === 'VERSION_CONFLICT');
const csv = await api.exportCsv(table.id);
assert.ok(csv.startsWith('\\uFEFFName,Cost'));
const input = { expectedVersion: table.version, csv, hasHeader: true };
assert.equal((await api.previewCsv(table.id, input)).invalid, 0);
assert.equal((await api.importCsv(table.id, input)).imported, 1);
const rows = (await api.queryRecords(table.id, {})).records;
assert.equal(rows.length, 2);
const groups = await api.queryGroups(table.id, { groupBy: cost, collapse: { defaultCollapsed: true, exceptions: [5] },
  measures: [{ fieldId: cost, operation: 'sum' }, { fieldId: cost, operation: 'average' }] });
assert.deepEqual(groups.groups.map(group => [group.key, group.count, group.rowStart]), [[5, 2, 0], [null, 0, 3]]);
assert.deepEqual(groups.groups.map(group => group.values), [[10, 5], [null, null]]);
const grouped = await api.createView(table.id, { name: 'Cost groups', groupBy: cost,
  groupMeasures: [{ fieldId: cost, operation: 'sum' }, { fieldId: cost, operation: 'average' }] });
assert.deepEqual((await api.queryGroups(table.id, { viewId: grouped.id, expectedViewVersion: grouped.version,
  collapse: { defaultCollapsed: true, exceptions: [5] } })).groups, groups.groups);
const nested = await api.queryGroups(table.id, { groupBy: [cost, table.primaryFieldId], measures: [{ fieldId: cost, operation: 'sum' }],
  collapse: { defaultCollapsed: true, exceptions: [[5], [5, 'SDK 中文']] } });
assert.deepEqual(nested.groups.map(group => [group.path, group.leaf, group.count, group.values]), [
  [[5], false, 2, [10]], [[5, 'SDK 中文'], true, 2, [10]], [[null], false, 0, [null]],
]);
assert.equal(nested.totalRows, 5);
const nestedView = await api.createView(table.id, { name: 'Nested cost groups', groupBy: [cost, table.primaryFieldId],
  groupMeasures: [{ fieldId: cost, operation: 'sum' }] });
assert.deepEqual((await api.queryGroups(table.id, { viewId: nestedView.id, expectedViewVersion: nestedView.version,
  collapse: { defaultCollapsed: true, exceptions: [[5], [5, 'SDK 中文']] } })).groups, nested.groups);
assert.deepEqual((await api.queryView(table.id, nestedView.id, {})).records.map(row => row.id), rows.map(row => row.id));
assert.deepEqual((await api.queryGroups(table.id, { groupBy: cost, window: 'expandedRecords' })).groups.map(group =>
  [group.key, group.count, group.expandedOffset]), [[5, 2, 0]]);
assert.equal((await api.queryRecords(table.id, { groupBy: cost, offset: groups.groups[0].recordOffset,
  expectedRevision: groups.revision })).total, 2);
assert.equal((await api.getRecord(table.id, created.id)).version, changed.version);
await api.deleteRecords(table.id, rows.map(row => ({ id: row.id, expectedVersion: row.version })));
await api.deleteTable(table.id, table.version);
assert.deepEqual(await api.listTables(), []);
console.log('SDK consumer passed.');
`);
  const result = await run(process.execPath, ['consumer.mjs'], { cwd: consumer,
    env: { ...process.env, ROWWEAVE_URL: server.url, ROWWEAVE_TOKEN: token } });
  assert.equal(result.stdout.trim(), 'SDK consumer passed.');
  assert.deepEqual(service.listTables(), []);
});
