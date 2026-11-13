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
import type { Table, GridView, BatchResult, QueryPage, ConversionPreview, RecordHistoryPage, RecordChangeDetail, RowRecord, RecordTrashPage, RecordBatchPage, RecordBatchChanges, RecordBatchUndoResult } from '../../../packages/contracts/src/index.js';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { parseCsv } from '../../../packages/core/src/csv.js';
import { startServer } from '../../server/src/http-server.js';
import type { Attachment } from '../../../packages/contracts/src/index.js';

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

test('MCP and CLI share field descriptions, omission, validation and explicit clearing', async t => {
  const { environment } = await setup(t);
  const { json, call } = await connect(t, environment);
  let table = await json<Table>('tables_create', { name: 'Field guidance' });
  table = await json<Table>('fields_create', { tableId: table.id, input: { expectedVersion: table.version,
    name: 'Budget', type: 'number', description: 'Enter the approved amount.\n预算金额' } });
  const field = table.fields[1]!;
  assert.equal(field.description, 'Enter the approved amount.\n预算金额');
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-descriptions-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'field.json');
  const update = async (changes: object) => {
    await writeFile(input, JSON.stringify({ expectedVersion: table.version, ...changes }));
    const result = await runFile(process.execPath, [resolve('apps/cli/dist/rowweave.js'), 'fields', 'update', table.id, field.id, '--input', input],
      { env: { ...process.env, ...environment } });
    return JSON.parse(result.stdout) as Table;
  };
  table = await update({ name: 'Approved budget' });
  assert.equal(table.fields[1]!.description, field.description);
  table = await update({ description: 'Updated through CLI' });
  assert.equal((await json<Table>('tables_get', { tableId: table.id })).fields[1]!.description, 'Updated through CLI');
  assert.equal((await call('fields_update', { tableId: table.id, fieldId: field.id, input: { expectedVersion: table.version, description: 'x'.repeat(2001) } })).isError, true);
  table = await json<Table>('fields_update', { tableId: table.id, fieldId: field.id, input: { expectedVersion: table.version, description: '' } });
  assert.equal(table.fields[1]!.description, undefined);
});

test('MCP and CLI share URL fields and reject unsafe writes atomically', async t => {
  const { environment, service } = await setup(t);
  const { json, call } = await connect(t, environment);
  let table = await json<Table>('tables_create', { name: 'Web resources' });
  table = await json<Table>('fields_create', { tableId: table.id, input: {
    expectedVersion: table.version, name: 'Website', type: 'url' } });
  const field = table.fields[1]!.id;
  const address = 'https://例子.测试/文档?q=one%20two';
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-url-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'records.json');
  const create = async (values: string[]) => {
    await writeFile(input, JSON.stringify(values.map(value => ({ values: { [field]: value } }))));
    return runFile(process.execPath, [resolve('apps/cli/dist/rowweave.js'), 'records', 'create', table.id, '--input', input],
      { env: { ...process.env, ...environment } });
  };
  const created = JSON.parse((await create([address])).stdout) as BatchResult;
  assert.equal(created.records[0]!.values[field], address);
  const matching = await json<QueryPage>('records_query', { tableId: table.id, query: {
    filter: { conjunction: 'and', conditions: [{ fieldId: field, operator: 'contains', value: '文档' }] } } });
  assert.equal(matching.records[0]!.id, created.records[0]!.id);
  await assert.rejects(create(['https://example.com', 'file:///C:/test']), error => {
    assert.equal(JSON.parse((error as { stderr: string }).stderr).error.code, 'INVALID_VALUE'); return true;
  });
  const invalid = await call('records_update', { tableId: table.id, records: [{ id: created.records[0]!.id,
    expectedVersion: 1, values: { [field]: 'javascript:alert(1)' } }] });
  assert.equal(JSON.parse(text(invalid)).error.code, 'INVALID_VALUE');
  assert.deepEqual(service.queryRecords(table.id, {}).records, created.records);
});

test('MCP and CLI create automatic fields without allowing forged numbers', async t => {
  const { environment, service } = await setup(t);
  const { json, call } = await connect(t, environment);
  let table = await json<Table>('tables_create', { name: 'Numbered tickets' });
  table = await json<Table>('fields_create', { tableId: table.id, input: { expectedVersion: table.version, name: 'Ticket', type: 'autoNumber' } });
  const number = table.fields[1]!.id;
  const first = await json<BatchResult>('records_create', { tableId: table.id, records: [{ values: {} }] });
  assert.equal(first.records[0]!.values[number], 1);
  const rejected = await call('records_update', { tableId: table.id, records: [{ id: first.records[0]!.id,
    expectedVersion: 1, values: { [number]: 99 } }] });
  assert.equal(JSON.parse(text(rejected)).error.code, 'READ_ONLY_FIELD');
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-numbers-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'records.json');
  await writeFile(input, JSON.stringify([{ values: {} }, { values: {} }]));
  const result = await runFile(process.execPath, [resolve('apps/cli/dist/rowweave.js'), 'records', 'create', table.id, '--input', input],
    { env: { ...process.env, ...environment } });
  assert.deepEqual((JSON.parse(result.stdout) as BatchResult).records.map(row => row.values[number]), [2, 3]);
  await writeFile(input, JSON.stringify([{ values: { [number]: null } }]));
  await assert.rejects(runFile(process.execPath, [resolve('apps/cli/dist/rowweave.js'), 'records', 'create', table.id, '--input', input],
    { env: { ...process.env, ...environment } }), error => {
    assert.equal(JSON.parse((error as { stderr: string }).stderr).error.code, 'READ_ONLY_FIELD'); return true;
  });
  assert.deepEqual(service.queryRecords(table.id, {}).records.map(row => row.values[number]), [1, 2, 3]);
});

test('MCP and CLI share service-owned record timestamps and date filters', async t => {
  const { environment, service } = await setup(t);
  const { json, call } = await connect(t, environment);
  let table = await json<Table>('tables_create', { name: 'Timed records' });
  for (const type of ['createdTime', 'updatedTime']) table = await json<Table>('fields_create', { tableId: table.id,
    input: { expectedVersion: table.version, name: type, type } });
  const created = table.fields[1]!.id, edited = table.fields[2]!.id;
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-times-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'records.json');
  await writeFile(input, JSON.stringify([{ values: { [table.primaryFieldId]: 'CLI record' } }]));
  const result = await runFile(process.execPath, [resolve('apps/cli/dist/rowweave.js'), 'records', 'create', table.id, '--input', input],
    { env: { ...process.env, ...environment } });
  const row = (JSON.parse(result.stdout) as BatchResult).records[0]!;
  assert.match(row.values[created] as string, /^\d{4}-\d{2}-\d{2}T/); assert.equal(row.values[edited], row.values[created]);
  assert.equal((await json<QueryPage>('records_query', { tableId: table.id, query: { filter: { conjunction: 'and', conditions: [{ fieldId: edited, operator: 'gte', value: row.values[created] }] } } })).total, 1);
  const invalid = await call('records_update', { tableId: table.id, records: [{ id: row.id, expectedVersion: row.version, values: { [edited]: null } }] });
  assert.equal(JSON.parse(text(invalid)).error.code, 'READ_ONLY_FIELD');
  const saved = (await json<BatchResult>('records_update', { tableId: table.id, records: [{ id: row.id, expectedVersion: row.version, values: { [table.primaryFieldId]: 'MCP edit' } }] })).records[0]!;
  assert.equal(saved.values[created], row.values[created]);
  assert.equal(saved.values[edited], service.recordBatches(table.id, {}).batches[0]!.changedAt);
  assert.deepEqual(service.getRecord(table.id, row.id), saved);
});

test('MCP and CLI preserve relative date rules and reject continuation after calendar rollover', async t => {
  let now = new Date('2026-07-01T23:59:00Z');
  const service = new RecordService(fixture(t, null, () => now).open());
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token }); t.after(() => server.close());
  const environment = { ROWWEAVE_URL: server.url, ROWWEAVE_TOKEN: token };
  const { json, call } = await connect(t, environment);
  let table = await json<Table>('tables_create', { name: 'Relative dates' });
  table = await json<Table>('fields_create', { tableId: table.id, input: { expectedVersion: table.version, name: 'Due', type: 'date' } });
  const due = table.fields[1]!.id;
  await json<BatchResult>('records_create', { tableId: table.id, records: ['2026-07-01', '2026-07-02'].map(value => ({ values: { [due]: value } })) });
  const query = { filter: { conjunction: 'and', conditions: [{ fieldId: due, operator: 'relativeDate', relative: { period: 'today', timeZone: 'UTC' } }] } };
  const view = await json<GridView>('views_create', { tableId: table.id, input: { name: 'Today', query } });
  const first = await json<QueryPage>('views_query', { tableId: table.id, viewId: view.id, query: {} });
  assert.equal(first.records[0]!.values[due], '2026-07-01'); assert.match(first.dateContext!, /^[a-f0-9]{64}$/);
  const guard = { expectedRevision: first.revision, expectedDateContext: first.dateContext };
  const summary = await json<{ dateContext: string; totals: { count: number } }>('records_summarize', { tableId: table.id, input: { viewId: view.id, ...guard } });
  assert.equal(summary.totals.count, 1); assert.equal(summary.dateContext, first.dateContext);
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-dates-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'query.json'); await writeFile(input, JSON.stringify({ ...query, ...guard }));
  const args = [resolve('apps/cli/dist/rowweave.js'), 'records', 'query', table.id, '--input', input];
  const cli = JSON.parse((await runFile(process.execPath, args, { env: { ...process.env, ...environment } })).stdout) as QueryPage;
  assert.equal(cli.dateContext, first.dateContext); assert.equal(cli.total, 1);
  now = new Date('2026-07-02T00:00:00Z');
  const stale = await call('views_query', { tableId: table.id, viewId: view.id, query: guard });
  assert.equal(stale.isError, true); assert.match(text(stale), /DATA_CHANGED/);
  await assert.rejects(runFile(process.execPath, args, { env: { ...process.env, ...environment } }), error => /DATA_CHANGED/.test(String((error as { stderr: string }).stderr)));
  assert.equal((await json<QueryPage>('views_query', { tableId: table.id, viewId: view.id, query: {} })).records[0]!.values[due], '2026-07-02');
  assert.equal((await call('records_query', { tableId: table.id, query: { filter: { conjunction: 'and', conditions: [
    { fieldId: due, operator: 'relativeDate', relative: { period: 'pastDays', timeZone: 'UTC', days: 0 } },
  ] } } })).isError, true);
});

test('MCP and CLI create paired fields and update the same relationship from either side', async t => {
  const { environment, service } = await setup(t);
  const { json, call } = await connect(t, environment);
  const target = await json<Table>('tables_create', { name: 'Projects' });
  let source = await json<Table>('tables_create', { name: 'Tasks' });
  source = await json<Table>('fields_create', { tableId: source.id, input: { expectedVersion: source.version, name: 'Project', type: 'relation',
    relation: { tableId: target.id, multiple: false }, reverseField: { name: 'Tasks', multiple: true, expectedVersion: target.version } } });
  const link = source.fields[1]!, inverse = service.getTable(target.id).fields[1]!;
  assert.equal(link.relation!.inverseFieldId, inverse.id);
  const project = (await json<BatchResult>('records_create', { tableId: target.id, records: [{ values: {} }] })).records[0]!;
  const task = (await json<BatchResult>('records_create', { tableId: source.id, records: [{ values: { [link.id]: [project.id] } }] })).records[0]!;
  assert.deepEqual((await json<QueryPage>('records_query', { tableId: target.id, query: {} })).records[0]!.values[inverse.id], [task.id]);
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-reverse-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'updates.json');
  await writeFile(input, JSON.stringify([{ id: project.id, expectedVersion: 2, values: { [inverse.id]: [] } }]));
  await runFile(process.execPath, [resolve('apps/cli/dist/rowweave.js'), 'records', 'update', target.id, '--input', input], {
    env: { ...process.env, ...environment },
  });
  assert.deepEqual((await json<QueryPage>('records_query', { tableId: source.id, query: {} })).records[0]!.values[link.id], []);
  assert.equal((await call('records_update', { tableId: source.id, records: [{ id: task.id, expectedVersion: 1, values: { [link.id]: [project.id] } }] })).isError, true);
});

test('MCP saves grouped grids and exposes matching records, summaries and removable grouping', async t => {
  const { environment } = await setup(t);
  const { json, call } = await connect(t, environment);
  let table = await json<Table>('tables_create', { name: 'Grouped tasks' });
  table = await json<Table>('fields_create', { tableId: table.id, input: { expectedVersion: table.version, name: 'Status', type: 'singleSelect',
    options: [{ id: 'planned', name: 'Z planned' }, { id: 'done', name: 'A done' }] } });
  const status = table.fields[1]!.id;
  const view = await json<GridView>('views_create', { tableId: table.id, input: { name: 'By status', type: 'grid', groupBy: status } });
  await json('records_create', { tableId: table.id, records: [null, 'done', 'planned'].map(value => ({ values: { [status]: value } })) });
  const result = await json<QueryPage>('views_query', { tableId: table.id, viewId: view.id, query: {} });
  assert.deepEqual(result.records.map(record => record.values[status]), ['planned', 'done', null]);
  const summary = await json<{ groupCount: number }>('records_summarize', { tableId: table.id, input: { viewId: view.id, groupBy: status } });
  assert.equal(summary.groupCount, 3);
  const clear = await json<GridView>('views_update', { tableId: table.id, viewId: view.id, input: { expectedVersion: view.version, groupBy: null } });
  assert.equal(clear.groupBy, undefined);
  assert.equal((await call('views_update', { tableId: table.id, viewId: view.id, input: { expectedVersion: view.version, groupBy: status } })).isError, true);
});

test('MCP formulas over linked summaries stay consistent after CLI target edits', async t => {
  const { environment, service } = await setup(t);
  const { json, call } = await connect(t, environment);
  let items = await json<Table>('tables_create', { name: 'Items' });
  items = await json<Table>('fields_create', { tableId: items.id, input: { expectedVersion: items.version, name: 'Amount', type: 'number' } });
  const amount = items.fields[1]!.id;
  const item = (await json<BatchResult>('records_create', { tableId: items.id, records: [{ values: { [amount]: 30 } }] })).records[0]!;
  let orders = await json<Table>('tables_create', { name: 'Orders' });
  orders = await json<Table>('fields_create', { tableId: orders.id, input: { expectedVersion: orders.version, name: 'Items', type: 'relation', relation: { tableId: items.id, multiple: true } } });
  const link = orders.fields[1]!.id;
  orders = await json<Table>('fields_create', { tableId: orders.id, input: { expectedVersion: orders.version, name: 'Subtotal', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } } });
  const subtotal = orders.fields[2]!.id;
  orders = await json<Table>('fields_create', { tableId: orders.id, input: { expectedVersion: orders.version, name: 'Total', type: 'formula', formula: { expression: '[' + subtotal + '] * 2', resultType: 'number' } } });
  const total = orders.fields[3]!.id;
  const order = (await json<BatchResult>('records_create', { tableId: orders.id, records: [{ values: { [link]: [item.id] } }] })).records[0]!;
  assert.equal(order.values[total], 60);
  const directory = await mkdtemp(join(tmpdir(), 'rowweave-linked-formula-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'updates.json');
  await writeFile(input, JSON.stringify([{ id: item.id, expectedVersion: item.version, values: { [amount]: 40 } }]));
  await runFile(process.execPath, [resolve('apps/cli/dist/rowweave.js'), 'records', 'update', items.id, '--input', input], { env: { ...process.env, ...environment } });
  const result = await json<QueryPage>('records_query', { tableId: orders.id, query: { filter: { conjunction: 'and', conditions: [{ fieldId: total, operator: 'eq', value: 80 }] } } });
  assert.equal(result.total, 1);
  assert.equal(result.records[0]!.version, 2);
  assert.equal(service.getRecord(orders.id, order.id).values[total], 80);
  const stale = await call('records_update', { tableId: orders.id, records: [{ id: order.id, expectedVersion: 1, values: { [link]: [] } }] });
  assert.equal(stale.isError, true);
  assert.equal(JSON.parse(text(stale)).error.code, 'VERSION_CONFLICT');
});

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
  assert.equal(tools.length, 38);
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
  const fileData = Buffer.from([0, 255, 13, 10, 128]).toString('base64');
  const file = await json<Attachment>('attachments_upload', { tableId: table.id, input: { filename: '设计.bin', mediaType: 'application/octet-stream', data: fileData } });
  const fileArgs = { tableId: table.id, attachmentId: file.id };
  assert.deepEqual(await json('attachments_get', fileArgs), file);
  assert.deepEqual(await json('attachments_list', { tableId: table.id, query: { limit: 1 } }), { attachments: [file] });
  assert.deepEqual(await json('attachments_download', fileArgs), { data: fileData });
  assert.equal(JSON.parse(text(await call('attachments_upload', { tableId: table.id, input: { filename: '../bad', mediaType: 'text/plain', data: '' } }))).error.code, 'INVALID_ATTACHMENT');
  await json('attachments_delete', fileArgs);
  assert.equal(JSON.parse(text(await call('attachments_get', fileArgs))).error.code, 'ATTACHMENT_NOT_FOUND');
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
  const historyArgs = { tableId: table.id, recordId: created[0]!.id };
  const history = await json<RecordHistoryPage>('records_history', { ...historyArgs, query: { limit: 1 } });
  const change = await json<RecordChangeDetail>('records_change', { ...historyArgs, changeId: history.changes[0]!.id });
  assert.equal(change.before!.values[budget], 12);
  assert.equal(change.after!.values[budget], 15);
  const restored = await json<RowRecord>('records_restore', { ...historyArgs, input: { changeId: change.id, snapshot: 'after', expectedVersion: 2 } });
  assert.equal(restored.version, 3);
  const staleRestore = await call('records_restore', { ...historyArgs, input: { changeId: change.id, snapshot: 'before', expectedVersion: 2 } });
  assert.equal(JSON.parse(text(staleRestore)).error.code, 'VERSION_CONFLICT');
  await json('records_delete', { tableId: table.id, records: [{ id: restored.id, expectedVersion: restored.version }] });
  const trash = await json<RecordTrashPage>('records_trash', { tableId: table.id, query: { limit: 1 } });
  assert.equal(trash.records[0]!.id, restored.id);
  const recover = { tableId: table.id, records: [{ id: restored.id, deletionId: trash.records[0]!.deletionId }] };
  const recovered = await json<BatchResult>('records_restore_deleted', recover);
  assert.deepEqual(recovered.records[0], { ...restored, version: restored.version + 1 });
  const repeated = await call('records_restore_deleted', recover);
  assert.equal(JSON.parse(text(repeated)).error.code, 'VERSION_CONFLICT');
  const batches = await json<RecordBatchPage>('records_batches', { tableId: table.id, query: { limit: 1 } });
  const transaction = await json<RecordBatchChanges>('records_batch_changes', { tableId: table.id, batchId: batches.batches[0]!.id, query: { limit: 1 } });
  assert.equal(transaction.batch.recordWrite, true);
  assert.equal(transaction.changes[0]!.recordId, restored.id);
  const undo = await json<RecordBatchUndoResult>('records_undo_batch', { tableId: table.id, batchId: transaction.batch.id });
  assert.equal(service.queryRecords(table.id, {}).total, 1);
  await json('records_undo_batch', { tableId: table.id, batchId: undo.batchId });
  assert.equal(service.queryRecords(table.id, {}).total, 2);
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
