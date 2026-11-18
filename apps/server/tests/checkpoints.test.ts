import { recordTable } from '../../../packages/storage-sqlite/src/record-tables.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fixture } from '../../../packages/storage-sqlite/tests/helpers.js';
import { RecordService } from '../../../packages/core/src/record-service.js';
import { createWorkspaceClient } from '../../../packages/client/src/http-client.js';
import { WorkspaceWorker } from '../src/workspace-runner.js';
import { startWorkspaceServer } from '../src/workspace-server.js';

test('passive checkpoints preserve pinned snapshots and finish after the reader releases them', { timeout: 15_000 }, async t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  const table = service.createTable({ name: 'Pinned reader' });
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Before' } }]).records[0]!;
  const worker = new WorkspaceWorker(data.path), reader = new DatabaseSync(data.path);
  try {
    await worker.start();
    await worker.checkpoint();
    store.useBackgroundCheckpoints(() => {});
    reader.exec('BEGIN');
    const version = () => reader.prepare(`SELECT version FROM ${recordTable(table.id)} WHERE id = ?`).get(record.id)!['version'];
    assert.equal(version(), record.version);
    const saved = service.updateBatch([{ id: record.id, expectedVersion: record.version, values: { [table.primaryFieldId]: 'After' } }], table.id);
    const partial = await worker.checkpoint();
    assert.equal(partial.busy, 0); assert.ok(partial.log > partial.checkpointed);
    assert.equal(version(), record.version);
    assert.deepEqual(service.getRecord(table.id, record.id), saved.records[0]);
    reader.exec('ROLLBACK');
    const complete = await worker.checkpoint();
    assert.equal(complete.busy, 0); assert.equal(complete.checkpointed, complete.log);
    assert.equal(version(), record.version + 1);
  } finally { reader.close(); await worker.close(); }
});

test('checkpoint requests coalesce, retain the latest notification and drain before worker shutdown', { timeout: 15_000 }, async t => {
  const data = fixture(t, null); data.open();
  const worker = new WorkspaceWorker(data.path), post = Worker.prototype.postMessage;
  let release!: () => void, started!: () => void, calls = 0, closed = false;
  const held = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, command: string) {
    if (command === 'checkpoint' && ++calls === 1) {
      release = () => { post.call(this, command); release = () => {}; }; started();
    } else post.call(this, command);
  });
  try {
    const first = worker.checkpoint(); await held;
    for (let index = 0; index < 100; index++) assert.equal(worker.checkpoint(), first);
    release(); await first;
    assert.equal(calls, 2, 'Writes during the first checkpoint require one follow-up, not one per write.');
    const last = first.then(() => worker.checkpoint());
    await last; assert.equal(calls, 3);
    const accepted = worker.checkpoint();
    const closing = worker.close().then(() => { closed = true; });
    assert.equal(closed, false);
    await assert.rejects(worker.checkpoint(), /closing/);
    await assert.rejects(worker.refresh(), /closing/);
    await Promise.all([accepted, closing]); assert.equal(closed, true);
    await worker.close();
  } finally { release?.(); await worker.close(); }
});

for (const failure of ['checkpoint command', 'idle worker exit'] as const) {
  test(`${failure} failure closes the managed service and preserves acknowledged writes`, { timeout: 15_000 }, async t => {
    const data = fixture(t, null), service = new RecordService(data.open());
    const table = service.createTable({ name: 'Maintenance failure' });
    const record = service.createRecords(table.id, [{ values: {} }]).records[0]!;
    let actualWorker!: Worker, fail = false, failed!: () => void, stopped!: () => void;
    const failureReported = new Promise<void>(resolve => { failed = resolve; });
    const workerClosed = new Promise<void>(resolve => { stopped = resolve; });
    const logs = t.mock.method(console, 'error', () => { failed(); });
    const checkpoints = t.mock.method(WorkspaceWorker.prototype, 'checkpoint');
    const post = Worker.prototype.postMessage, close = WorkspaceWorker.prototype.close;
    t.mock.method(Worker.prototype, 'postMessage', function (this: Worker, command: string) {
      actualWorker = this;
      if (command === 'checkpoint' && fail && failure === 'checkpoint command') {
        queueMicrotask(() => this.emit('message', { command, error: 'Injected checkpoint failure' }));
      } else post.call(this, command);
    });
    t.mock.method(WorkspaceWorker.prototype, 'close', async function (this: WorkspaceWorker) { await close.call(this); stopped(); });
    const token = randomBytes(32).toString('hex'), server = await startWorkspaceServer(data.path, { token });
    const api = createWorkspaceClient({ url: server.url, token });
    try {
      await api.refreshCalculations();
      fail = true;
      const saved = await api.updateRecords(table.id, [{ id: record.id, expectedVersion: record.version, values: { [table.primaryFieldId]: 'Acknowledged' } }]);
      if (failure === 'idle worker exit') { await checkpoints.mock.calls.at(-1)!.result; await actualWorker.terminate(); }
      await failureReported; await workerClosed; await server.close();
      assert.equal(logs.mock.callCount(), 1);
      await assert.rejects(api.getRecord(table.id, record.id));
      assert.deepEqual(service.getRecord(table.id, record.id), saved.records[0]);
      assert.equal(service.recordBatchChanges(table.id, saved.batchId!, {}).batch.recordCount, 1);
    } finally { await server.close(); }
  });
}

test('workspace startup failure closes the already opened background worker', { timeout: 15_000 }, async t => {
  const data = fixture(t, null);
  const close = t.mock.method(WorkspaceWorker.prototype, 'close');
  await assert.rejects(startWorkspaceServer(data.path, { token: 'invalid' }), /access token/);
  assert.equal(close.mock.callCount(), 1);
  assert.equal(existsSync(data.path + '-wal'), false, 'All workspace connections must close on startup failure.');
});

test('failed clock refreshes still schedule pending checkpoints and can recover', { timeout: 15_000 }, async t => {
  const data = fixture(t, null), token = randomBytes(32).toString('hex');
  const server = await startWorkspaceServer(data.path, { token }), api = createWorkspaceClient({ url: server.url, token });
  try {
    await api.refreshCalculations(); await setImmediate();
    const checkpoint = t.mock.method(WorkspaceWorker.prototype, 'checkpoint');
    const refresh = t.mock.method(WorkspaceWorker.prototype, 'refresh', async () => { throw new Error('Invalid calculation'); });
    await assert.rejects(api.refreshCalculations(), { code: 'CALCULATION_FAILED' });
    assert.equal(checkpoint.mock.callCount(), 1);
    refresh.mock.restore();
    assert.equal((await api.refreshCalculations()).changedRecords, 0);
  } finally { await server.close(); }
});

test('a process crash after HTTP acknowledgement recovers uncheckpointed values, versions and history', { timeout: 30_000 }, async t => {
  const data = fixture(t, null), seed = data.open(), service = new RecordService(seed);
  const table = service.createTable({ name: 'Crash recovery' });
  const before = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Before' } }]).records[0]!;
  seed.close();
  const token = randomBytes(32).toString('hex');
  const env: NodeJS.ProcessEnv = { ...process.env, ROWWEAVE_DB: data.path, ROWWEAVE_TOKEN: token, ROWWEAVE_PORT: '0', ROWWEAVE_HOST: '127.0.0.1' };
  delete env['ROWWEAVE_ALLOWED_HOSTS']; delete env['ROWWEAVE_ALLOWED_ORIGINS'];
  const child = spawn(process.execPath, [resolve('dist/apps/server/src/cli.js')], { stdio: ['ignore', 'pipe', 'pipe'],
    env });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
  let output = '', errors = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  const ready = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Service exited before ready: ' + errors)));
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      const match = output.match(/RowWeave service listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]!);
    });
  });
  let reader: DatabaseSync | undefined, observer: DatabaseSync | undefined;
  try {
    const url = await ready, api = createWorkspaceClient({ url, token });
    await api.refreshCalculations();
    reader = new DatabaseSync(data.path); observer = new DatabaseSync(data.path);
    observer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    reader.exec('BEGIN');
    assert.equal(reader.prepare(`SELECT version FROM ${recordTable(table.id)} WHERE id = ?`).get(before.id)!['version'], before.version);
    const saved = await api.updateRecords(table.id, [{ id: before.id, expectedVersion: before.version, values: { [table.primaryFieldId]: 'Durable after crash 🌱' } }]);
    const checkpoint = observer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!;
    assert.ok(Number(checkpoint['log']) > Number(checkpoint['checkpointed']), 'The acknowledged write must still be in the WAL at process exit.');
    child.kill('SIGKILL'); await exited;
    const restarted = await startWorkspaceServer(data.path, { token });
    try {
      const reopened = createWorkspaceClient({ url: restarted.url, token });
      assert.deepEqual(await reopened.getRecord(table.id, before.id), saved.records[0]);
      const receipt = await reopened.recordBatchChanges(table.id, saved.batchId!);
      assert.equal(receipt.batch.recordCount, 1);
      const change = await reopened.recordChange(table.id, before.id, receipt.changes[0]!.id);
      assert.deepEqual(change.before, before); assert.deepEqual(change.after, saved.records[0]);
      reader.exec('ROLLBACK'); reader.close(); reader = undefined;
      observer.close(); observer = undefined;
    } finally { await restarted.close(); }
    assert.equal(existsSync(data.path + '-wal'), false);
  } finally { child.kill('SIGKILL'); await exited; reader?.close(); observer?.close(); }
});
