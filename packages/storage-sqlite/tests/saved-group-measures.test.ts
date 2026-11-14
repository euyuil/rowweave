import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService, ServiceError } from '../../core/src/record-service.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Group totals' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  const amount = table.fields[1]!.id;
  const measures = [{ fieldId: amount, operation: 'sum' as const }, { fieldId: amount, operation: 'average' as const }];
  const view = service.createView(table.id, { name: 'Totals', groupBy: table.primaryFieldId, groupMeasures: measures });
  return { data, store, service, table, amount, measures, view };
}

test('saved measures include complete groups, support read overrides and survive restart and backup', async t => {
  const { data, service, table, amount, measures, view } = setup(t);
  service.createRecords(table.id, Array.from({ length: 607 }, (_, index) => ({ values: {
    [table.primaryFieldId]: 'Batch', [amount]: index,
  } })));
  const input = { viewId: view.id, expectedViewVersion: view.version, limit: 1 };
  assert.deepEqual(service.queryGroups(table.id, input).groups[0]!.values, [183921, 303]);
  assert.deepEqual(service.queryGroups(table.id, { ...input, collapse: { defaultCollapsed: true, exceptions: [] } }).groups[0]!.values, [183921, 303]);
  assert.equal(service.queryGroups(table.id, { ...input, measures: [] }).groups[0]!.values, undefined);
  assert.deepEqual(service.queryGroups(table.id, { ...input, measures: [{ fieldId: amount, operation: 'max' }] }).groups[0]!.values, [606]);
  assert.deepEqual(service.getView(table.id, view.id).groupMeasures, measures, 'Ad-hoc reads must not modify saved configuration.');
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getView(table.id, view.id), view);
  assert.deepEqual(reopened.queryGroups(table.id, input), service.queryGroups(table.id, input));
  const backup = data.path + '.backup', restored = data.path + '.restored';
  t.after(async () => { const { rm } = await import('node:fs/promises'); await Promise.all([backup, restored].map(path => rm(path, { force: true }))); });
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, restored);
  const db = new DatabaseSync(restored);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 34);
    const config = JSON.parse(db.prepare('SELECT config_json FROM views WHERE id = ?').get(view.id)!['config_json'] as string);
    assert.deepEqual(config.groupMeasures, measures);
  } finally { db.close(); }
});

test('saved measure dependencies preserve identities and require explicit removal before incompatible schema edits', t => {
  const { service, table, amount, view, measures } = setup(t);
  const renamed = service.updateField(table.id, amount, { expectedVersion: table.version, name: 'Budget' });
  assert.deepEqual(service.getView(table.id, view.id).groupMeasures, measures);
  assert.throws(() => service.deleteField(table.id, amount, { expectedVersion: renamed.version }), /Update view/);
  assert.throws(() => service.previewConversion(table.id, amount, { expectedVersion: renamed.version,
    field: { name: 'Budget', type: 'text' } }), /Update view/);
  const current = service.getView(table.id, view.id);
  const cleared = service.updateView(table.id, view.id, { expectedVersion: current.version, groupMeasures: [] });
  assert.equal(cleared.groupMeasures, undefined); assert.equal(cleared.groupBy, table.primaryFieldId);
  assert.throws(() => service.queryGroups(table.id, { viewId: view.id, expectedViewVersion: current.version }), /view changed/);
  service.deleteField(table.id, amount, { expectedVersion: renamed.version });
});

test('saved measures validate configuration and clear when grouping is removed', t => {
  const { service, table, amount, view, measures } = setup(t);
  for (const groupMeasures of [null, {}, [{ fieldId: 'missing', operation: 'sum' }],
    [{ fieldId: table.primaryFieldId, operation: 'sum' }], [{ fieldId: amount, operation: 'count' }], Array(13).fill(measures[0])]) {
    assert.throws(() => service.updateView(table.id, view.id, { expectedVersion: view.version, groupMeasures }), ServiceError);
  }
  assert.deepEqual(service.getView(table.id, view.id), view);
  assert.throws(() => service.createView(table.id, { name: 'Invalid', groupMeasures: measures }), /Group a grid/);
  const cleared = service.updateView(table.id, view.id, { expectedVersion: view.version, groupBy: null });
  assert.equal(cleared.groupMeasures, undefined);
  const regrouped = service.updateView(table.id, view.id, { expectedVersion: cleared.version, groupBy: amount });
  assert.equal(regrouped.groupMeasures, undefined);
});

test('format 30 upgrades older workspaces without changing views, records or history', t => {
  const { data, store, service, table } = setup(t);
  const original = service.listViews(table.id)[0]!;
  const record = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Keep' } }]).records[0]!;
  store.close();
  const old = new DatabaseSync(data.path);
  try {
    old.exec("UPDATE views SET config_json = json_remove(config_json, '$.groupMeasures'); PRAGMA user_version = 29;");
  } finally { old.close(); }
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getView(table.id, original.id), original);
  assert.deepEqual(reopened.getRecord(table.id, record.id), record);
  const check = new DatabaseSync(data.path);
  try {
    assert.equal(check.prepare('PRAGMA user_version').get()!['user_version'], 34);
    assert.equal(check.prepare('SELECT count(*) AS n FROM record_changes').get()!['n'], 1);
  } finally { check.close(); }
});
