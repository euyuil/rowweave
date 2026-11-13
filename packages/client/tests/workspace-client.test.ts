import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../src/http-client.js';
import { Calculations } from '../../../apps/server/src/calculations.js';
import type { CalculationRefresh } from '../../contracts/src/index.js';

test('aborting a refresh response stops waiting without cancelling the accepted calculation', async t => {
  let complete!: (value: CalculationRefresh) => void, start!: () => void;
  const pending = new Promise<CalculationRefresh>(resolve => { complete = resolve; });
  const started = new Promise<void>(resolve => { start = resolve; });
  const calculations = new Calculations({ refresh: () => { start(); return pending; }, close: async () => {} }, false);
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service: new RecordService(fixture(t, null).open()), token, calculations });
  const result: CalculationRefresh = { evaluatedAt: '2024-01-01T00:00:00.000Z', changedRecords: 0, changedTableIds: [] };
  t.after(async () => { complete(result); await server.close(); });
  const api = createWorkspaceClient({ url: server.url, token }), controller = new AbortController();
  const rejected = assert.rejects(api.refreshCalculations(controller.signal), { name: 'AbortError' });
  await started; controller.abort(); await rejected;
  assert.equal((await api.calculationStatus()).running, true);
  complete(result);
  await calculations.refresh();
  assert.deepEqual((await api.calculationStatus()).lastResult, result);
});

test('the workspace client completes a schema, view, conversion and record lifecycle over HTTP', async t => {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service: new RecordService(fixture(t, null).open()), token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: `${server.url}/`, token });
  let table = await api.createTable({ name: 'Invoices' });
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number', defaultValue: 0 });
  const amount = table.fields[1]!.id;
  const record = (await api.createRecords(table.id, [{ values: { [table.primaryFieldId]: '100', [amount]: 12 } }])).records[0]!;
  let view = await api.createView(table.id, { name: 'Large', query: { filter: { conjunction: 'and', conditions: [{ fieldId: amount, operator: 'gte', value: 10 }] } } });
  assert.equal((await api.queryView(table.id, view.id, {})).total, 1);
  table = await api.updateField(table.id, amount, { expectedVersion: table.version, name: 'Total' });
  table = await api.updateTable(table.id, { expectedVersion: table.version, name: 'Sales' });
  const preview = await api.previewConversion(table.id, table.primaryFieldId, { expectedVersion: table.version, field: { name: 'Invoice', type: 'number' } });
  table = await api.applyConversion(table.id, table.primaryFieldId, { expectedVersion: preview.schemaVersion, field: preview.field });
  const converted = await api.getRecord(table.id, record.id);
  assert.equal(converted.values[table.primaryFieldId], 100);
  const updated = (await api.updateRecords(table.id, [{ id: record.id, expectedVersion: converted.version, values: { [amount]: 3 } }])).records[0]!;
  assert.equal((await api.queryView(table.id, view.id, {})).total, 0);
  await api.deleteRecords(table.id, [{ id: record.id, expectedVersion: updated.version }]);
  table = await api.deleteField(table.id, amount, table.version);
  view = await api.getView(table.id, view.id);
  view = await api.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Empty' });
  await api.deleteView(table.id, view.id, view.version);
  assert.equal((await api.listViews(table.id)).length, 1);
  await api.deleteTable(table.id, table.version);
  assert.deepEqual(await api.listTables(), []);
});

test('workspace state is authenticated, bounded, cancellable and shared with saved view versions', async t => {
  const service = new RecordService(fixture(t, null).open()), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  assert.deepEqual(await api.workspaceState(), service.workspaceState({}));
  const table = await api.createTable({ name: 'State client' }), view = (await api.listViews(table.id))[0]!;
  const request = { tableId: table.id, viewId: view.id };
  const state = await api.workspaceState(request);
  assert.deepEqual(state, service.workspaceState(request));
  const updated = await api.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Updated view' });
  const after = await api.workspaceState(request);
  assert.equal(after.table!.view!.version, updated.version);
  assert.ok(after.table!.viewsRevision > state.table!.viewsRevision);
  assert.equal(after.catalogRevision, state.catalogRevision);
  assert.equal(after.table!.dataRevision, state.table!.dataRevision);
  assert.deepEqual(await api.workspaceState({ tableId: 'deleted', viewId: 'missing' }), { catalogRevision: after.catalogRevision, table: null });
  await assert.rejects(createWorkspaceClient({ url: server.url, token: 'invalid' }).workspaceState(), { status: 401 });
  for (const input of [null, [], { tableId: '' }, { tableId: 1 }, { tableId: 'x'.repeat(201) }, { viewId: view.id }, { tableId: table.id, viewId: false }]) {
    const response = await fetch(server.url + '/workspace/state', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await api.workspaceState(request), after);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.workspaceState(request, controller.signal), { name: 'AbortError' });
});
