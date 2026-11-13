import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

test('view display settings persist independently and reconcile hidden or deleted columns', t => {
  const data = fixture(t);
  const service = new RecordService(data.open());
  const table = service.getTable();
  const original = service.listViews(table.id)[0]!;
  assert.equal(original.rowHeight, 36);
  assert.equal(original.frozenColumns, 0);
  let view = service.createView(table.id, { name: 'Reading', rowHeight: 64, frozenColumns: 3 });
  assert.deepEqual(new RecordService(data.open()).getView(table.id, view.id), view);
  assert.deepEqual(service.getView(table.id, original.id), original);
  view = service.updateView(table.id, view.id, { expectedVersion: view.version,
    columns: view.columns.map((column, i) => ({ ...column, hidden: i === 2 })) });
  assert.equal(view.frozenColumns, 2);
  assert.equal(view.rowHeight, 64);
  service.deleteField(table.id, table.fields[1]!.id, { expectedVersion: table.version });
  const remaining = service.getView(table.id, view.id);
  assert.equal(remaining.frozenColumns, 1);
  assert.equal(remaining.rowHeight, 64);
  assert.ok(remaining.version > view.version);
  assert.throws(() => service.updateView(table.id, view.id, { expectedVersion: view.version, rowHeight: 36 }), /view changed/);
  assert.equal(service.queryView(table.id, view.id, {}).total, 12);
});

test('display input rejects invalid sizes and explicit frozen counts without changing a view', t => {
  const service = new RecordService(fixture(t).open());
  const table = service.getTable();
  const view = service.listViews(table.id)[0]!;
  for (const input of [{ rowHeight: 0 }, { rowHeight: 37 }, { rowHeight: null }, { rowHeight: '48' },
    { frozenColumns: -1 }, { frozenColumns: 1.5 }, { frozenColumns: 4 }, { frozenColumns: null },
    { columns: view.columns.map((column, i) => ({ ...column, hidden: i > 0 })), frozenColumns: 2 }]) {
    assert.throws(() => service.updateView(table.id, view.id, { expectedVersion: view.version, ...input }),
      (error: unknown) => error instanceof ServiceError && error.code === 'INVALID_VIEW');
  }
  assert.deepEqual(service.getView(table.id, view.id), view);
});

test('version-seven migration preserves views and records while adding their original display defaults', t => {
  const data = fixture(t);
  const store = data.open();
  const table = store.getTable();
  const views = store.listViews(table.id);
  const records = store.readPage(0, 12);
  store.close();
  const db = new DatabaseSync(data.path);
  db.exec("DROP TABLE field_sequences; DROP TABLE record_batch_tables; DROP TABLE record_batches; DROP TABLE record_changes; UPDATE views SET config_json = json_remove(config_json, '$.rowHeight', '$.frozenColumns'); ALTER TABLE records DROP COLUMN formula_errors_json; PRAGMA user_version = 7;");
  db.close();
  const upgraded = data.open();
  assert.deepEqual(upgraded.listViews(table.id), views);
  assert.deepEqual(upgraded.getTable(), table);
  assert.deepEqual(upgraded.readPage(0, 12), records);
  upgraded.close();
  assert.deepEqual(data.open().listViews(table.id), views);
});

test('HTTP and SDK expose saved display settings and retain defaults for existing callers', async t => {
  const service = new RecordService(fixture(t).open());
  const table = service.getTable();
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const legacy = await api.createView(table.id, { name: 'Default layout' });
  assert.equal(legacy.rowHeight, 36);
  assert.equal(legacy.frozenColumns, 0);
  const view = await api.updateView(table.id, legacy.id, { expectedVersion: legacy.version, rowHeight: 48, frozenColumns: 1 });
  assert.deepEqual(await api.getView(table.id, view.id), view);
  assert.equal(view.rowHeight, 48);
  assert.equal(view.frozenColumns, 1);
});
