import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Table, GridView, BatchResult, QueryPage, RecordHistoryPage, RecordChangeDetail, RowRecord, RecordTrashPage, RecordBatchPage, RecordBatchChanges, RecordBatchUndoResult } from '../../../packages/contracts/src/index.js';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { parseCsv } from '../../../packages/core/src/csv.js';
import { startServer } from '../../server/src/http-server.js';
import type { Attachment, AttachmentPage } from '../../../packages/contracts/src/index.js';

const runFile = promisify(execFile);
async function setup(t: Parameters<typeof fixture>[0]) {
  const service = new RecordService(fixture(t, null).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = { ...process.env, ROWWEAVE_URL: server.url, ROWWEAVE_TOKEN: token };
  const execute = (args: string[], input?: string | Buffer, overrides: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve('apps/cli/dist/rowweave.js'), ...args], { env: { ...environment, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolveResult({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  async function json<T>(args: string[], input?: unknown): Promise<T> {
    const result = await execute(input === undefined ? args : [...args, '--input', '-'], input === undefined ? undefined : JSON.stringify(input));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout) as T;
  }
  return { service, server, token, directory, environment, execute, json };
}

test('CLI uploads and downloads exact binary files with table-scoped metadata and explicit paths', async t => {
  const { directory, execute, json } = await setup(t);
  const table = await json<Table>(['tables', 'create'], { name: 'Files' });
  const source = join(directory, '设计 🌱.bin'), destination = join(directory, 'download.bin');
  const bytes = Buffer.from([0, 255, 13, 10, 128, 32]); await writeFile(source, bytes);
  const file = await json<Attachment>(['attachments', 'upload', table.id, '--file', source]);
  assert.equal(file.filename, '设计 🌱.bin'); assert.equal(file.mediaType, 'application/octet-stream'); assert.equal(file.size, bytes.length);
  assert.deepEqual(await json(['attachments', 'get', table.id, file.id]), file);
  assert.deepEqual(await json<AttachmentPage>(['attachments', 'list', table.id], { limit: 1 }), { attachments: [file] });
  assert.deepEqual(await json(['attachments', 'download', table.id, file.id, '--output', destination]), { path: destination, bytes: bytes.length });
  assert.deepEqual(await readFile(destination), bytes);
  const fromStdin = await execute(['attachments', 'upload', table.id, '--file', '-', '--json', JSON.stringify({ filename: 'stdin.txt', mediaType: 'text/plain' })], '中文');
  assert.equal(fromStdin.code, 0, fromStdin.stderr); assert.equal(JSON.parse(fromStdin.stdout).size, 6);
  for (const args of [
    ['attachments', 'upload', table.id], ['attachments', 'upload', table.id, '--file', '-'],
    ['attachments', 'upload', table.id, '--file', '-', '--input', '-'], ['attachments', 'download', table.id, file.id],
  ]) { const result = await execute(args); assert.equal(result.code, 2, result.stderr); }
  await json(['attachments', 'delete', table.id, file.id]);
  const missing = await execute(['attachments', 'download', table.id, file.id, '--output', destination]);
  assert.equal(missing.code, 1); assert.equal(JSON.parse(missing.stderr).error.code, 'ATTACHMENT_NOT_FOUND');
  assert.deepEqual(await readFile(destination), bytes);
});

test('CLI subprocesses manage schema, atomic records, views and CSV using machine-readable results', async t => {
  const { service, directory, execute, json } = await setup(t);
  assert.deepEqual(await json(['tables', 'list']), []);
  let table = await json<Table>(['tables', 'create'], { name: 'CLI projects' });
  assert.deepEqual(await json(['tables', 'get', table.id]), table);
  table = await json<Table>(['tables', 'update', table.id], { expectedVersion: table.version, name: 'Renamed' });
  table = await json<Table>(['fields', 'create', table.id], { expectedVersion: table.version, name: 'Budget', type: 'number' });
  const budget = table.fields[1]!.id;
  table = await json<Table>(['fields', 'create', table.id], { expectedVersion: table.version, name: 'Code', type: 'text' });
  const reference = table.fields[2]!.id;
  table = await json<Table>(['fields', 'update', table.id, reference], { expectedVersion: table.version, name: 'Reference' });
  const created = (await json<BatchResult>(['records', 'create', table.id], [12, 7].map((cost, i) => ({ values: {
    [table.primaryFieldId]: `CLI ${i} 中文`, [budget]: cost, [reference]: String(42 + i),
  } })))).records;
  assert.deepEqual(await json(['records', 'get', table.id, created[0]!.id]), created[0]);
  const summary = await json<{ totals: { count: number; values: number[] } }>(['records', 'summarize', table.id], {
    measures: [{ fieldId: budget, operation: 'sum' }],
  });
  assert.deepEqual(summary.totals, { count: 2, values: [19] });
  const conflict = await execute(['records', 'update', table.id, '--input', '-'], JSON.stringify(created.map((record, i) => ({
    id: record.id, expectedVersion: i ? 99 : record.version, values: { [budget]: 99 },
  }))));
  assert.equal(conflict.code, 1);
  assert.equal(conflict.stdout, '');
  assert.equal(JSON.parse(conflict.stderr).error.code, 'VERSION_CONFLICT');
  assert.deepEqual((await json<QueryPage>(['records', 'query', table.id])).records, created);
  await json(['records', 'update', table.id], [{ id: created[0]!.id, expectedVersion: 1, values: { [budget]: 15 } }]);
  const history = await json<RecordHistoryPage>(['records', 'history', table.id, created[0]!.id], { limit: 1 });
  const change = await json<RecordChangeDetail>(['records', 'change', table.id, created[0]!.id], { changeId: history.changes[0]!.id });
  assert.equal(change.before!.values[budget], 12);
  assert.equal(change.after!.values[budget], 15);
  const restored = await json<RowRecord>(['records', 'restore', table.id, created[0]!.id], { changeId: change.id, snapshot: 'after', expectedVersion: 2 });
  assert.equal(restored.version, 3);
  const staleRestore = await execute(['records', 'restore', table.id, restored.id, '--json', JSON.stringify({ changeId: change.id, snapshot: 'before', expectedVersion: 2 })]);
  assert.equal(staleRestore.code, 1);
  assert.equal(JSON.parse(staleRestore.stderr).error.code, 'VERSION_CONFLICT');
  await json(['records', 'delete', table.id], [{ id: restored.id, expectedVersion: restored.version }]);
  const trash = await json<RecordTrashPage>(['records', 'trash', table.id], { limit: 1 });
  assert.equal(trash.records[0]!.id, restored.id);
  const recover = [{ id: restored.id, deletionId: trash.records[0]!.deletionId }];
  const recovered = await json<BatchResult>(['records', 'restore-deleted', table.id], recover);
  assert.deepEqual(recovered.records[0], { ...restored, version: restored.version + 1 });
  const repeated = await execute(['records', 'restore-deleted', table.id, '--json', JSON.stringify(recover)]);
  assert.equal(JSON.parse(repeated.stderr).error.code, 'VERSION_CONFLICT');
  const batches = await json<RecordBatchPage>(['records', 'batches', table.id], { limit: 1 });
  const transaction = await json<RecordBatchChanges>(['records', 'batch-changes', table.id, batches.batches[0]!.id], { limit: 1 });
  assert.equal(transaction.batch.recordWrite, true);
  assert.equal(transaction.changes[0]!.recordId, restored.id);
  const undo = await json<RecordBatchUndoResult>(['records', 'undo-batch', table.id, transaction.batch.id]);
  assert.equal(service.queryRecords(table.id, {}).total, 1);
  await json(['records', 'undo-batch', table.id, undo.batchId]);
  assert.equal(service.queryRecords(table.id, {}).total, 2);
  const conversion = { expectedVersion: table.version, field: { name: 'Reference', type: 'number' } };
  assert.equal((await json<{ invalid: number }>(['fields', 'preview-conversion', table.id, reference], conversion)).invalid, 0);
  table = await json<Table>(['fields', 'apply-conversion', table.id, reference], conversion);
  assert.equal(service.getRecord(table.id, created[0]!.id).values[reference], 42);
  table = await json<Table>(['fields', 'delete', table.id, reference], { expectedVersion: table.version });
  let view = await json<GridView>(['views', 'create', table.id], { name: 'High', query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: budget, operator: 'gte', value: 10 }] },
  } });
  assert.equal((await json<GridView[]>(['views', 'list', table.id])).length, 2);
  assert.deepEqual(await json(['views', 'get', table.id, view.id]), view);
  view = await json<GridView>(['views', 'update', table.id, view.id], { expectedVersion: view.version, name: 'High costs' });
  assert.equal((await json<QueryPage>(['views', 'query', table.id, view.id], { expectedViewVersion: view.version })).total, 1);

  const path = join(directory, 'input.csv');
  const csv = 'Name,Budget\r\n"Imported, 🌱",8\r\n';
  await writeFile(path, csv);
  const options = { expectedVersion: table.version, hasHeader: true };
  const optionsPath = join(directory, 'options.json');
  await writeFile(optionsPath, JSON.stringify(options));
  const preview = await execute(['csv', 'preview', table.id, '--file', '-', '--input', optionsPath], csv);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).invalid, 0);
  assert.deepEqual(await json(['csv', 'import', table.id, '--file', path], options), { imported: 1 });
  const outputPath = join(directory, 'export.csv');
  const output = await json<{ path: string; bytes: number }>(['csv', 'export', table.id, '--output', outputPath]);
  assert.equal(output.path, outputPath);
  const saved = await readFile(outputPath, 'utf8');
  assert.equal(Buffer.byteLength(saved), output.bytes);
  assert.ok(saved.startsWith('\uFEFF'));
  assert.equal([...parseCsv(saved)].length, 4);
  const viewExport = await execute(['csv', 'export', table.id, '--json', JSON.stringify({ viewId: view.id, expectedViewVersion: view.version })]);
  assert.equal(viewExport.code, 0);
  assert.equal(viewExport.stderr, '');
  assert.equal([...parseCsv(viewExport.stdout)].length, 2);
  await json(['views', 'delete', table.id, view.id], { expectedVersion: view.version });
  const rows = (await json<QueryPage>(['records', 'query', table.id])).records;
  assert.deepEqual(await json(['records', 'delete', table.id], rows.map(row => ({ id: row.id, expectedVersion: row.version }))), { deleted: rows.map(row => row.id) });
  table = await json<Table>(['fields', 'delete', table.id, budget], { expectedVersion: table.version });
  await json(['tables', 'delete', table.id], { expectedVersion: table.version });
  assert.deepEqual(service.listTables(), []);
});

test('CLI rejects malformed arguments and input, preserves service errors, and keeps credentials out of output', async t => {
  const { service, execute, token, directory } = await setup(t);
  const help = await execute(['--help'], undefined, { ROWWEAVE_TOKEN: '' });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^RowWeave CLI/);
  for (const args of [
    ['unknown'], ['tables', 'get'], ['tables', 'list', 'extra'], ['tables', 'list', '--unknown'],
    ['tables', 'list', '--json', '{}'], ['tables', 'create'], ['tables', 'create', '--json', '{'],
    ['tables', 'create', '--json', '{}', '--input', '-'], ['tables', 'list', '--file', 'data.csv'],
    ['tables', 'list', '--output', 'out.csv'], ['csv', 'import', 'id', '--json', '{}'],
    ['csv', 'preview', 'id', '--input', '-', '--file', '-'],
    ['tables', 'list', '--url', 'http://user:do-not-print@example.invalid/'],
  ]) {
    const result = await execute(args);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENT');
    assert.ok(!result.stderr.includes(token) && !result.stderr.includes('do-not-print'));
  }
  const missing = await execute(['tables', 'list'], undefined, { ROWWEAVE_TOKEN: '' });
  assert.equal(missing.code, 2);
  const invalidToken = await execute(['tables', 'list'], undefined, { ROWWEAVE_TOKEN: token + '\ninvalid' });
  assert.equal(invalidToken.code, 2);
  assert.ok(!invalidToken.stderr.includes(token));
  const unauthorized = await execute(['tables', 'list'], undefined, { ROWWEAVE_TOKEN: 'wrong' });
  assert.equal(unauthorized.code, 1);
  assert.equal(JSON.parse(unauthorized.stderr).error.code, 'UNAUTHORIZED');
  const invalid = await execute(['tables', 'create', '--input', '-'], Buffer.from([0xff, 0x41]));
  assert.equal(invalid.code, 2);
  assert.match(JSON.parse(invalid.stderr).error.message, /UTF-8/);
  const large = join(directory, 'large.json');
  await writeFile(large, ' '.repeat(8 * 1024 * 1024 + 1));
  assert.equal((await execute(['tables', 'create', '--input', large])).code, 2);
  const rejected = await execute(['tables', 'create', '--json', '{}']);
  assert.equal(rejected.code, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'INVALID_SCHEMA');
  assert.deepEqual(service.listTables(), []);
});

test('the packed CLI installs offline and its command runs outside the repository', async t => {
  const { directory, environment } = await setup(t);
  const npm = process.env['npm_execpath'];
  assert.ok(npm, 'Run CLI package verification with npm test.');
  const cache = join(directory, 'npm-cache');
  const packed = await runFile(process.execPath, [npm, 'pack', resolve('apps/cli'), '--ignore-scripts', '--offline', '--json', '--pack-destination', directory, '--cache', cache]);
  const [archive] = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  assert.ok(archive);
  assert.ok(archive.files.some(file => file.path === 'dist/rowweave.js'));
  assert.ok(archive.files.every(file => ['package.json', 'README.md', 'dist/rowweave.js'].includes(file.path)));
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true }));
  await runFile(process.execPath, [npm, 'install', join(directory, archive.filename), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', cache], { cwd: consumer });
  const result = await runFile(process.execPath, [npm, 'exec', '--offline', '--cache', cache, '--', 'rowweave', 'tables', 'list'], { cwd: consumer, env: environment });
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.equal(result.stderr, '');
});
