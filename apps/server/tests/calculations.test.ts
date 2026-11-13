import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Calculations, type CalculationRunner } from '../src/calculations.js';
import { CalculationWorker } from '../src/calculation-runner.js';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import type { CalculationRefresh } from '../../../packages/contracts/src/index.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { startServer } from '../src/http-server.js';
import { startWorkspaceServer } from '../src/workspace-server.js';
import { createWorkspaceClient } from '../../../packages/client/src/http-client.js';
import { writeFileSync, rmSync } from 'node:fs';

const result: CalculationRefresh = { evaluatedAt: '2024-01-01T00:00:00.000Z', changedRecords: 2, changedTableIds: ['table'] };
function deferred() {
  let resolve!: (result: CalculationRefresh) => void, reject!: (error: Error) => void;
  const promise = new Promise<CalculationRefresh>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('background calculations coalesce refreshes, expose progress and queue synchronous writes', async () => {
  const pending = deferred(), order: string[] = [];
  const runner: CalculationRunner = { refresh: () => { order.push('calculate'); return pending.promise; }, close: async () => { order.push('close'); } };
  const calculations = new Calculations(runner, false);
  const first = calculations.refresh(); assert.equal(calculations.refresh(), first);
  const write = calculations.write(() => { order.push('write'); return 3; });
  await setImmediate(); assert.deepEqual(order, ['calculate']); assert.equal(calculations.status().running, true);
  pending.resolve(result);
  assert.equal(await write, 3); assert.deepEqual(await first, result);
  assert.deepEqual(order, ['calculate', 'write']); assert.equal(calculations.status().running, false);
  assert.deepEqual(calculations.status().lastResult, result);
  await calculations.close(); assert.deepEqual(order, ['calculate', 'write', 'close']);
  await assert.rejects(calculations.refresh(), { code: 'SERVICE_CLOSING' });
  await assert.rejects(calculations.write(() => 1), { code: 'SERVICE_CLOSING' });
});

test('failed calculations remain visible, release queued writes and can be requested again', async () => {
  const pending = deferred(); let calls = 0;
  const calculations = new Calculations({ refresh: () => ++calls === 1 ? pending.promise : Promise.resolve(result), close: async () => {} }, false);
  const failed = assert.rejects(calculations.refresh(), { code: 'CALCULATION_FAILED', message: 'Calculation test failure' });
  const write = calculations.write(() => 'saved');
  pending.reject(new Error('Calculation test failure'));
  await failed; assert.equal(await write, 'saved');
  assert.equal(calculations.status().lastError, 'Calculation test failure');
  assert.deepEqual(await calculations.refresh(), result); assert.equal(calculations.status().lastError, undefined);
  await calculations.close();
});

test('a queued write also waits for a refresh requested by an earlier completion handler', async () => {
  const first = deferred(), second = deferred(); let calls = 0, written = false;
  const calculations = new Calculations({ refresh: () => ++calls === 1 ? first.promise : second.promise, close: async () => {} }, false);
  const refresh = calculations.refresh();
  const next = refresh.then(() => calculations.refresh());
  const write = calculations.write(() => { written = true; });
  first.resolve(result); await setImmediate();
  assert.equal(calls, 2); assert.equal(written, false);
  second.resolve(result); await Promise.all([next, write]);
  assert.equal(written, true); await calculations.close();
});

test('automatic calculations start immediately, skip overlapping ticks and stop scheduling during shutdown', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = deferred(); let calls = 0, closed = false;
  const calculations = new Calculations({ refresh: () => { calls++; return pending.promise; }, close: async () => { closed = true; } }, true);
  calculations.start(); await setImmediate(); assert.equal(calls, 1);
  t.mock.timers.tick(180_000); await setImmediate(); assert.equal(calls, 1);
  pending.resolve(result); await setImmediate();
  t.mock.timers.tick(60_000); await setImmediate(); assert.equal(calls, 2);
  await calculations.close(); t.mock.timers.tick(120_000); await setImmediate();
  assert.equal(calls, 2); assert.equal(closed, true);
});

test('closing waits for the accepted calculation and write before releasing its runner', async () => {
  const pending = deferred(), order: string[] = [];
  const calculations = new Calculations({ refresh: () => pending.promise, close: async () => { order.push('close'); } }, false);
  const refresh = calculations.refresh(), write = calculations.write(() => { order.push('write'); });
  const closing = calculations.close();
  await setImmediate(); assert.deepEqual(order, []);
  pending.resolve(result); await Promise.all([refresh, write, closing]);
  assert.deepEqual(order, ['write', 'close']);
});

test('the calculation worker refreshes the real SQLite workspace and closes its connection', async t => {
  const data = fixture(t, null, () => new Date('2024-01-01T00:00:00Z')), service = new RecordService(data.open());
  let table = service.createTable({ name: 'Worker clock' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
  const field = table.fields[1]!.id, record = service.createRecords(table.id, [{ values: {} }]).records[0]!;
  const calculations = new Calculations(new CalculationWorker(data.path), false);
  try {
    const refreshed = await calculations.refresh();
    assert.equal(refreshed.changedRecords, 1);
    assert.equal(service.getRecord(table.id, record.id).values[field], refreshed.evaluatedAt);
  } finally { await calculations.close(); }
  const current = service.getRecord(table.id, record.id);
  assert.equal(service.updateBatch([{ id: current.id, expectedVersion: current.version, values: { [table.primaryFieldId]: 'After worker close' } }], table.id).records[0]!.version, current.version + 1);
});

test('a worker startup failure is reported after exit and a later explicit request can reopen the repaired database', async t => {
  const data = fixture(t, null);
  writeFileSync(data.path, 'Not a SQLite database');
  const calculations = new Calculations(new CalculationWorker(data.path), false);
  try {
    await assert.rejects(calculations.refresh(), { code: 'CALCULATION_FAILED' });
    assert.equal(calculations.status().running, false); assert.ok(calculations.status().lastError);
    rmSync(data.path);
    data.open();
    assert.equal((await calculations.refresh()).changedRecords, 0);
    assert.equal(calculations.status().lastError, undefined);
  } finally { await calculations.close(); }
});

test('HTTP reads a committed WAL snapshot while a calculation owns the writer and queued edits retain version guards', async t => {
  const data = fixture(t, null), service = new RecordService(data.open()), token = randomBytes(32).toString('hex');
  const table = service.createTable({ name: 'Concurrent reads' });
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Original' } }]).records[0]!;
  const connection = new DatabaseSync(data.path), pending = deferred();
  let started!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  const calculations = new Calculations({ refresh: async () => {
    connection.exec('BEGIN IMMEDIATE');
    connection.prepare('UPDATE records SET version = version + 1 WHERE id = ?').run(record.id);
    started();
    try { const result = await pending.promise; connection.exec('COMMIT'); return result; }
    catch (error) { connection.exec('ROLLBACK'); throw error; }
  }, close: async () => { connection.close(); } }, false);
  const writes = t.mock.method(calculations, 'write');
  const server = await startServer({ service, token, calculations });
  const api = createWorkspaceClient({ url: server.url, token });
  try {
    const refresh = api.refreshCalculations(); await held;
    assert.equal((await api.calculationStatus()).running, true);
    assert.deepEqual(await api.getRecord(table.id, record.id), record);
    assert.equal((await api.queryRecords(table.id, {})).records[0]!.version, record.version);
    const write = assert.rejects(api.updateRecords(table.id, [{ id: record.id, expectedVersion: record.version, values: { [table.primaryFieldId]: 'Stale edit' } }]), { status: 409 });
    for (let attempt = 0; writes.mock.callCount() === 0 && attempt < 100; attempt++) await setTimeout(10);
    assert.equal(writes.mock.callCount(), 1);
    assert.equal((await api.getRecord(table.id, record.id)).values[table.primaryFieldId], 'Original');
    pending.resolve(result); await Promise.all([refresh, write]);
    const current = await api.getRecord(table.id, record.id);
    assert.equal(current.version, record.version + 1);
    assert.equal((await api.updateRecords(table.id, [{ id: current.id, expectedVersion: current.version, values: { [table.primaryFieldId]: 'Fresh edit' } }])).records[0]!.values[table.primaryFieldId], 'Fresh edit');
  } finally { pending.resolve(result); await server.close(); }
});

test('workspace startup automatically refreshes stale clock values and closes its real worker before releasing the database', async t => {
  const data = fixture(t, null, () => new Date('2024-01-01T00:00:00Z')), service = new RecordService(data.open());
  let table = service.createTable({ name: 'Startup refresh' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Now', type: 'formula', formula: { expression: 'NOW()', resultType: 'datetime' } });
  const record = service.createRecords(table.id, [{ values: {} }]).records[0]!, field = table.fields[1]!.id;
  const token = randomBytes(32).toString('hex'), server = await startWorkspaceServer(data.path, { token });
  const api = createWorkspaceClient({ url: server.url, token });
  try {
    let status = await api.calculationStatus();
    for (let attempt = 0; status.running && attempt < 500; attempt++) { await setTimeout(10); status = await api.calculationStatus(); }
    assert.equal(status.automatic, true); assert.equal(status.running, false); assert.equal(status.lastError, undefined);
    assert.equal(status.lastResult!.changedRecords, 1);
    assert.equal((await api.getRecord(table.id, record.id)).values[field], status.lastResult!.evaluatedAt);
  } finally { await server.close(); }
  assert.equal(service.getRecord(table.id, record.id).version, 2);
  service.createRecords(table.id, [{ values: {} }]);
});

test('HTTP shutdown drains an accepted refresh and queued write before closing the calculation runner', async t => {
  const data = fixture(t, null), service = new RecordService(data.open()), token = randomBytes(32).toString('hex');
  const pending = deferred(); let closed = false;
  const calculations = new Calculations({ refresh: () => pending.promise, close: async () => { closed = true; } }, false);
  const writes = t.mock.method(calculations, 'write');
  const server = await startServer({ service, token, calculations }), api = createWorkspaceClient({ url: server.url, token });
  let closing: Promise<void> | undefined;
  try {
    const refresh = api.refreshCalculations();
    for (let attempt = 0; !calculations.status().running && attempt < 100; attempt++) await setTimeout(10);
    assert.equal(calculations.status().running, true);
    const write = api.createTable({ name: 'Accepted before shutdown' });
    for (let attempt = 0; writes.mock.callCount() === 0 && attempt < 100; attempt++) await setTimeout(10);
    assert.equal(writes.mock.callCount(), 1);
    closing = server.close();
    assert.equal(closed, false); pending.resolve(result);
    await Promise.all([refresh, write, closing]); assert.equal(closed, true);
    assert.equal(service.listTables()[0]!.name, 'Accepted before shutdown');
  } finally { pending.resolve(result); await (closing ?? server.close()); }
});
