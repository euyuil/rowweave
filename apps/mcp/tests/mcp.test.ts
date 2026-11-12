import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { Table, GridView, BatchResult, QueryPage, ConversionPreview } from '../../../packages/contracts/src/index.js';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { parseCsv } from '../../../packages/core/src/csv.js';
import { startServer } from '../../server/src/http-server.js';

const runFile = promisify(execFile);
const entry = resolve('apps/mcp/dist/rowweave-mcp.js');
type Context = Parameters<typeof fixture>[0];

function text(result: CallToolResult): string {
  assert.equal(result.content.length, 1);
  const content = result.content[0]!;
  assert.equal(content.type, 'text');
  return (content as { text: string }).text;
}

async function resource(client: Client, uri: string): Promise<unknown> {
  const content = (await client.readResource({ uri })).contents[0]!;
  assert.ok('text' in content);
  return JSON.parse(content.text);
}

async function connect(t: Context, environment: Record<string, string>, path = entry, cwd?: string, legacy = false) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path], env: { ...getDefaultEnvironment(), ...environment }, stderr: 'pipe', ...(cwd ? { cwd } : {}) });
  let stderr = '';
  transport.stderr!.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'rowweave-tests', version: '1.0.0' }, legacy ? { supportedProtocolVersions: ['2025-11-25'] } : {});
  t.after(() => client.close());
  await client.connect(transport);
  const used = new Set<string>();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    used.add(name);
    return await client.callTool({ name, arguments: args }) as CallToolResult;
  };
  async function json<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await call(name, args);
    assert.ok(!result.isError, text(result));
    return JSON.parse(text(result)) as T;
  }
  return { client, call, json, used, stderr: () => stderr };
}

async function setup(t: Context) {
  const service = new RecordService(fixture(t, null).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const environment = { ROWWEAVE_URL: server.url, ROWWEAVE_TOKEN: token };
  return { service, server, token, environment };
}

test('MCP creates formulas and returns recalculated values and explicit errors', async t => {
  const { environment } = await setup(t);
  const { json, call } = await connect(t, environment);
  let table = await json<Table>('tables_create', { name: 'Formula records' });
  table = await json<Table>('fields_create', { tableId: table.id, input: { expectedVersion: table.version, name: 'Length', type: 'formula',
    formula: { expression: `LEN([${table.primaryFieldId}])`, resultType: 'number' } } });
  const field = table.fields[1]!;
  const record = (await json<BatchResult>('records_create', { tableId: table.id, records: [{ values: { [table.primaryFieldId]: 'Test' } }] })).records[0]!;
  assert.equal(record.values[field.id], 4);
  const changed = await json<BatchResult>('records_update', { tableId: table.id, records: [{ id: record.id, expectedVersion: 1, values: { [table.primaryFieldId]: 'Longer' } }] });
  assert.equal(changed.records[0]!.values[field.id], 6);
  assert.equal((await call('records_update', { tableId: table.id, records: [{ id: record.id, expectedVersion: 2, values: { [field.id]: 99 } }] })).isError, true);
  await json('fields_update', { tableId: table.id, fieldId: field.id, input: { expectedVersion: table.version, formula: { expression: '1 / 0', resultType: 'number' } } });
  const read = await json<QueryPage>('records_query', { tableId: table.id, query: {} });
  assert.match(read.records[0]!.formulaErrors![field.id]!, /zero/);
});

test('MCP configures linked numeric summaries and exposes scalar query results', async t => {
  const { environment } = await setup(t);
  const { json } = await connect(t, environment);
  let target = await json<Table>('tables_create', { name: 'Amounts' });
  target = await json<Table>('fields_create', { tableId: target.id, input: { expectedVersion: target.version, name: 'Amount', type: 'number' } });
  const amount = target.fields[1]!.id;
  const rows = (await json<BatchResult>('records_create', { tableId: target.id, records: [0, 10, null].map(value => ({ values: { [amount]: value } })) })).records;
  let source = await json<Table>('tables_create', { name: 'Totals' });
  source = await json<Table>('fields_create', { tableId: source.id, input: { expectedVersion: source.version, name: 'Items', type: 'relation', relation: { tableId: target.id, multiple: true } } });
  const link = source.fields[1]!.id;
  source = await json<Table>('fields_create', { tableId: source.id, input: { expectedVersion: source.version, name: 'Total', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } } });
  const sum = source.fields[2]!.id;
  const record = (await json<BatchResult>('records_create', { tableId: source.id, records: [{ values: { [link]: rows.map(row => row.id) } }] })).records[0]!;
  assert.equal(record.values[sum], 10);
  assert.equal((await json<QueryPage>('records_query', { tableId: source.id, query: { filter: { conjunction: 'and', conditions: [{ fieldId: sum, operator: 'gt', value: 5 }] } } })).total, 1);
  source = await json<Table>('fields_update', { tableId: source.id, fieldId: sum, input: { expectedVersion: source.version, lookup: { relationFieldId: link, fieldId: amount, operation: 'count' } } });
  assert.equal((await json<QueryPage>('records_query', { tableId: source.id, query: {} })).records[0]!.values[sum], 2);
});

test('MCP creates board views, queries empty lanes and moves records using their versions', async t => {
  const { environment } = await setup(t);
  const { json, call } = await connect(t, environment);
  let table = await json<Table>('tables_create', { name: 'Board tasks' });
  table = await json<Table>('fields_create', { tableId: table.id, input: { expectedVersion: table.version, name: 'Status', type: 'singleSelect', options: [{ id: 'ready', name: 'Ready' }] } });
  const status = table.fields[1]!.id;
  const view = await json<GridView>('views_create', { tableId: table.id, input: { name: 'Status', type: 'board', groupBy: status } });
  const record = (await json<BatchResult>('records_create', { tableId: table.id, records: [{ values: { [table.primaryFieldId]: 'Task' } }] })).records[0]!;
  assert.equal((await json<QueryPage>('views_query', { tableId: table.id, viewId: view.id, query: { lane: null } })).total, 1);
  await json('records_update', { tableId: table.id, records: [{ id: record.id, expectedVersion: record.version, values: { [status]: 'ready' } }] });
  assert.equal((await json<QueryPage>('views_query', { tableId: table.id, viewId: view.id, query: { lane: 'ready' } })).total, 1);
  assert.equal((await call('views_query', { tableId: table.id, viewId: view.id, query: { lane: 'missing' } })).isError, true);
});

test('MCP discovers all operations and runs versioned schema, records, views and CSV workflows over stdio', async t => {
  const { service, environment } = await setup(t);
  const { client, call, json, used, stderr } = await connect(t, environment);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 25);
  assert.ok(tools.every(tool => tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false));
  assert.equal(tools.find(tool => tool.name === 'records_query')!.annotations!.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'records_update')!.annotations!.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === 'records_create')!.annotations!.idempotentHint, false);
  assert.equal((await client.listResourceTemplates()).resourceTemplates.length, 2);
  assert.equal((await client.listResources()).resources.length, 2);
  const usage = await client.readResource({ uri: 'rowweave://usage' });
  assert.match((usage.contents[0] as { text: string }).text, /Writes are never retried/);
  assert.deepEqual(await json('tables_list'), []);
  let table = await json<Table>('tables_create', { name: 'MCP projects' });
  assert.deepEqual(await json('tables_get', { tableId: table.id }), table);
  table = await json<Table>('tables_update', { tableId: table.id, input: { expectedVersion: table.version, name: 'Renamed' } });
  table = await json<Table>('fields_create', { tableId: table.id, input: { expectedVersion: table.version, name: 'Budget', type: 'number' } });
  const budget = table.fields[1]!.id;
  table = await json<Table>('fields_create', { tableId: table.id, input: { expectedVersion: table.version, name: 'Reference', type: 'text' } });
  const reference = table.fields[2]!.id;
  table = await json<Table>('fields_update', { tableId: table.id, fieldId: reference, input: { expectedVersion: table.version, name: 'Code' } });
  const staleSchema = await call('fields_delete', { tableId: table.id, fieldId: reference, expectedVersion: table.version - 1 });
  assert.equal(staleSchema.isError, true);
  assert.equal(JSON.parse(text(staleSchema)).error.code, 'SCHEMA_CONFLICT');
  const schemaUri = `rowweave://tables/${table.id}/schema`;
  assert.ok((await client.listResources()).resources.some(resource => resource.uri === schemaUri));
  assert.deepEqual(await resource(client, schemaUri), table);
  assert.deepEqual(await resource(client, 'rowweave://workspace'), [table]);
  const created = (await json<BatchResult>('records_create', { tableId: table.id, records: [12, 7].map((cost, i) => ({ values: {
    [table.primaryFieldId]: `Task ${i} 中文🌱`, [budget]: cost, [reference]: String(42 + i),
  } })) })).records;
  assert.deepEqual(await json('records_get', { tableId: table.id, recordId: created[0]!.id }), created[0]);
  const conflict = await call('records_update', { tableId: table.id, records: created.map((record, i) => ({
    id: record.id, expectedVersion: i ? 99 : record.version, values: { [budget]: 99 },
  })) });
  assert.equal(conflict.isError, true);
  assert.equal(JSON.parse(text(conflict)).error.code, 'VERSION_CONFLICT');
  assert.deepEqual((await json<QueryPage>('records_query', { tableId: table.id, query: {} })).records, created);
  const summary = await json<{ totals: { count: number; values: number[] } }>('records_summarize', {
    tableId: table.id, input: { measures: [{ fieldId: budget, operation: 'sum' }] },
  });
  assert.deepEqual(summary.totals, { count: 2, values: [19] });
  await json('records_update', { tableId: table.id, records: [{ id: created[0]!.id, expectedVersion: 1, values: { [budget]: 15 } }] });
  const conversion = { expectedVersion: table.version, field: { name: 'Code', type: 'number' } };
  const preview = await json<ConversionPreview>('fields_preview_conversion', { tableId: table.id, fieldId: reference, input: conversion });
  assert.equal(preview.invalid, 0);
  table = await json<Table>('fields_apply_conversion', { tableId: table.id, fieldId: reference, input: conversion });
  assert.equal(service.getRecord(table.id, created[0]!.id).values[reference], 42);
  table = await json<Table>('fields_delete', { tableId: table.id, fieldId: reference, expectedVersion: table.version });
  let view = await json<GridView>('views_create', { tableId: table.id, input: { name: 'High', query: {
    filter: { conjunction: 'and', conditions: [{ conjunction: 'or', conditions: [{ fieldId: budget, operator: 'gte', value: 10 }] }] },
    sort: [{ fieldId: budget, direction: 'desc' }],
  } } });
  assert.equal((await json<GridView[]>('views_list', { tableId: table.id })).length, 2);
  assert.deepEqual(await json('views_get', { tableId: table.id, viewId: view.id }), view);
  view = await json<GridView>('views_update', { tableId: table.id, viewId: view.id, input: { expectedVersion: view.version, name: 'High costs', rowHeight: 64, frozenColumns: 1 } });
  assert.equal(view.rowHeight, 64);
  assert.equal(view.frozenColumns, 1);
  const viewConflict = await call('views_query', { tableId: table.id, viewId: view.id, query: { expectedViewVersion: view.version - 1 } });
  assert.equal(viewConflict.isError, true);
  assert.equal(JSON.parse(text(viewConflict)).error.code, 'VIEW_CONFLICT');
  assert.equal((await json<QueryPage>('views_query', { tableId: table.id, viewId: view.id, query: { expectedViewVersion: view.version } })).total, 1);
  assert.deepEqual(await resource(client, `rowweave://tables/${table.id}/views`), service.listViews(table.id));
  const csv = 'Name,Budget\r\n"Imported, 🌱",8\r\n';
  const input = { expectedVersion: table.version, hasHeader: true, csv };
  assert.equal((await json<{ invalid: number }>('csv_preview', { tableId: table.id, input })).invalid, 0);
  assert.deepEqual(await json('csv_import', { tableId: table.id, input }), { imported: 1 });
  const exported = text(await call('csv_export', { tableId: table.id, query: {} }));
  assert.ok(exported.startsWith('\uFEFF'));
  assert.equal([...parseCsv(exported)].length, 4);
  assert.equal([...parseCsv(text(await call('csv_export', { tableId: table.id, query: { viewId: view.id, expectedViewVersion: view.version } })))].length, 2);
  await json('views_delete', { tableId: table.id, viewId: view.id, expectedVersion: view.version });
  const rows = (await json<QueryPage>('records_query', { tableId: table.id, query: {} })).records;
  assert.deepEqual(await json('records_delete', { tableId: table.id, records: rows.map(row => ({ id: row.id, expectedVersion: row.version })) }), { deleted: rows.map(row => row.id) });
  await json('tables_delete', { tableId: table.id, expectedVersion: table.version });
  assert.deepEqual(service.listTables(), []);
  await assert.rejects(client.readResource({ uri: schemaUri }), error => (error as { code: number }).code === -32602);
  assert.deepEqual([...used].sort(), tools.map(tool => tool.name).sort());
  assert.equal(stderr(), '');
});

test('MCP exposes live typed schema, linked records and read-only lookups to a legacy protocol client', async t => {
  const { environment, service } = await setup(t);
  const { client, call, json } = await connect(t, environment, entry, undefined, true);
  let target = service.createTable({ name: 'Target' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Tags', type: 'multiSelect', options: [{ name: '中文' }, { name: 'Blue' }] });
  const tags = target.fields[1]!;
  const targetRecord = service.createRecords(target.id, [{ values: { [target.primaryFieldId]: 'Linked', [tags.id]: [tags.options![0]!.id] } }]).records[0]!;
  let source = await json<Table>('tables_create', { name: 'Source' });
  source = await json<Table>('fields_create', { tableId: source.id, input: { expectedVersion: source.version, name: 'Link', type: 'relation', relation: { tableId: target.id, multiple: false } } });
  const link = source.fields[1]!;
  source = await json<Table>('fields_create', { tableId: source.id, input: { expectedVersion: source.version, name: 'Tags', type: 'lookup', lookup: { relationFieldId: link.id, fieldId: tags.id } } });
  const lookup = source.fields[2]!;
  const schema = await resource(client, `rowweave://tables/${source.id}/schema`) as Table;
  assert.deepEqual(schema.fields[2]!.lookupResult!.options, tags.options);
  const result = await json<BatchResult>('records_create', { tableId: source.id, records: [{ values: { [source.primaryFieldId]: 'Task', [link.id]: [targetRecord.id] } }] });
  assert.deepEqual(result.records[0]!.values[lookup.id], [tags.options![0]!.id]);
  assert.deepEqual(result.records[0]!.links![link.id], [{ id: targetRecord.id, label: 'Linked' }]);
  const readonly = await call('records_update', { tableId: source.id, records: [{ id: result.records[0]!.id, expectedVersion: 1, values: { [lookup.id]: [] } }] });
  assert.equal(readonly.isError, true);
  assert.equal(JSON.parse(text(readonly)).error.code, 'READ_ONLY_FIELD');
  const forbidden = await call('tables_delete', { tableId: target.id, expectedVersion: target.version });
  assert.equal(forbidden.isError, true);
  assert.equal(JSON.parse(text(forbidden)).error.code, 'RELATION_DEPENDENCY');
});

test('MCP rejects malformed inputs, reports authentication failures and never retries uncertain writes', async t => {
  const { environment, service, token } = await setup(t);
  const { call } = await connect(t, environment);
  for (const args of [{ name: 12 }, { name: 'Unexpected', extra: true }]) {
    const result = await call('tables_create', args);
    assert.equal(result.isError, true);
  }
  assert.deepEqual(service.listTables(), []);
  const unauthorized = await connect(t, { ...environment, ROWWEAVE_TOKEN: 'wrong-token' });
  const denied = await unauthorized.call('tables_list');
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(text(denied)).error.code, 'UNAUTHORIZED');
  assert.ok(!text(denied).includes(token));
  let writes = 0;
  const interrupted = createServer((request, response) => {
    request.resume();
    request.on('end', () => { writes++; response.destroy(); });
  });
  await new Promise<void>(resolveListen => interrupted.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>(resolveClose => interrupted.close(() => resolveClose())));
  const address = interrupted.address() as { port: number };
  const uncertain = await connect(t, { ...environment, ROWWEAVE_URL: `http://127.0.0.1:${address.port}` });
  const failed = await uncertain.call('tables_create', { name: 'Uncertain' });
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(text(failed)).error.code, 'CONNECTION_FAILED');
  assert.match(JSON.parse(text(failed)).error.recovery, /may have committed/);
  assert.equal(writes, 1);
  for (const overrides of [{ ROWWEAVE_TOKEN: '' }, { ROWWEAVE_TOKEN: token + '\ninvalid' }, { ROWWEAVE_URL: `http://secret:${token}@example.invalid` }]) {
    await assert.rejects(runFile(process.execPath, [entry], { env: { ...process.env, ...environment, ...overrides } }), error => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.length > 0 && !result.stderr.includes(token));
      return true;
    });
  }
});

test('the MCP archive installs offline and serves the protocol outside the repository', async t => {
  const { environment } = await setup(t);
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const npm = process.env['npm_execpath'];
  assert.ok(npm, 'Run MCP package verification with npm test.');
  const cache = join(directory, 'cache');
  const packed = await runFile(process.execPath, [npm, 'pack', resolve('apps/mcp'), '--ignore-scripts', '--offline', '--json', '--pack-destination', directory, '--cache', cache]);
  const [archive] = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  assert.ok(archive);
  assert.deepEqual(archive.files.map(file => file.path).sort(), ['README.md', 'dist/THIRD-PARTY-NOTICES.txt', 'dist/rowweave-mcp.js', 'package.json']);
  const consumer = join(directory, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true }));
  await runFile(process.execPath, [npm, 'install', join(directory, archive.filename), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', cache], { cwd: consumer });
  const installed = join(consumer, 'node_modules/@rowweave/mcp');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.bin['rowweave-mcp'], 'dist/rowweave-mcp.js');
  await t.test('the installed command serves a real workspace', async installedTest => {
    const { json, stderr } = await connect(installedTest, environment, join(installed, manifest.bin['rowweave-mcp']), consumer);
    assert.deepEqual(await json('tables_list'), []);
    assert.equal((await json<Table>('tables_create', { name: 'Installed' })).name, 'Installed');
    assert.equal(stderr(), '');
  });
  const notices = await readFile(join(installed, 'dist/THIRD-PARTY-NOTICES.txt'), 'utf8');
  for (const name of ['@modelcontextprotocol/server@2.4.0', '@modelcontextprotocol/core@2.4.0', 'zod@4.6.7', 'Apache License']) assert.ok(notices.includes(name));
});
