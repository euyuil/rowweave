import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import { createWorkspaceClient } from '../dist/packages/client/src/http-client.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';
import { fixture } from '../dist/packages/storage-sqlite/tests/helpers.js';
import { startServer } from '../dist/apps/server/src/http-server.js';

const spec = await SwaggerParser.parse('docs/openapi.yaml');
const operations = new Map();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (method === 'parameters') continue;
    assert.ok(!operations.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
    operations.set(operation.operationId, { path, method, operation });
  }
}

test('the published OpenAPI file is self-contained and matches the service version and SDK operations', async () => {
  const refs = JSON.stringify(spec).matchAll(/"\$ref":"([^"]+)"/g);
  for (const [, ref] of refs) assert.ok(ref.startsWith('#/'), ref);
  await SwaggerParser.validate(structuredClone(spec), { resolve: { external: false }, dereference: { circular: 'ignore' } });
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(spec.info.version, pkg.version);
  for (const [path, item] of Object.entries(spec.paths)) {
    const expectedNames = [...path.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    const declared = (item.parameters ?? []).map(parameter => spec.components.parameters[parameter.$ref.split('/').at(-1)]);
    assert.deepEqual(declared.map(parameter => parameter.name).sort(), expectedNames, path);
    for (const parameter of declared) {
      assert.equal(parameter.in, 'path');
      assert.equal(parameter.required, true);
    }
  }
  const sdk = createWorkspaceClient({ url: 'http://localhost', token: '' });
  // table() composes other operations. The insertion-order GET page is HTTP-only.
  const expected = [...Object.keys(sdk).filter(name => name !== 'table'), 'readRecordPage'];
  assert.deepEqual([...operations.keys()].sort(), expected.sort());
  assert.deepEqual(spec.security, [{ workspaceToken: [] }]);
  assert.equal(spec.components.securitySchemes.workspaceToken.scheme, 'bearer');
});

test('documented HTTP operations and examples work against a new workspace', async t => {
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ service: new RecordService(fixture(t, null).open()), token });
  t.after(() => server.close());
  const schemas = new Ajv2020({ strict: false, validateFormats: false });
  const documentId = 'urn:rowweave:openapi';
  schemas.addSchema(spec, documentId);
  const exercised = new Set();
  const ids = {};
  function validate(pointer, value) {
    const check = schemas.getSchema(`${documentId}#${pointer}`);
    assert.ok(check, pointer);
    assert.ok(check(value), `${pointer}: ${schemas.errorsText(check.errors)}`);
  }
  async function call(name, { body, status, auth = true } = {}) {
    const { path, method, operation } = operations.get(name);
    const url = path.replace(/\{(\w+)\}/g, (_, key) => {
      assert.ok(ids[key], `Missing parameter ${key} for ${name}`);
      return encodeURIComponent(ids[key]);
    });
    const pointer = '/paths/' + path.replaceAll('/', '~1') + '/' + method;
    const headers = auth ? { Authorization: `Bearer ${token}` } : {};
    if (operation.requestBody) {
      body ??= operation.requestBody.content['application/json'].example;
      assert.notEqual(body, undefined, `${name} needs a request body`);
      validate(pointer + '/requestBody/content/application~1json/schema', body);
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(server.url + url, { method: method.toUpperCase(), headers, body: JSON.stringify(body) });
    const expected = status ?? Number(Object.keys(operation.responses).find(key => /^2\d\d$/.test(key)));
    if (response.status !== expected) assert.fail(`${name}: expected ${expected}, received ${response.status} ${await response.text()}`);
    const responseKey = operation.responses[expected] ? expected : 'default';
    let definition = operation.responses[responseKey];
    let responsePointer = pointer + '/responses/' + responseKey;
    if (definition.$ref) {
      responsePointer = definition.$ref.slice(1);
      definition = spec.components.responses[responsePointer.split('/').at(-1)];
    }
    const media = response.headers.get('content-type')?.split(';')[0];
    assert.ok(Object.hasOwn(definition.content, media), `${name}: unexpected ${media}`);
    if (response.ok) exercised.add(name);
    if (media === 'application/x-ndjson') {
      const reader = response.body.getReader();
      try {
        let frame = '';
        const decoder = new TextDecoder();
        while (!frame.includes('\n')) {
          const { value, done } = await reader.read();
          assert.ok(!done, 'Stream ended before its initial frame');
          frame += decoder.decode(value, { stream: true });
        }
        return JSON.parse(frame.split('\n')[0]);
      } finally {
        await reader.cancel();
      }
    }
    if (media === 'application/octet-stream') return Buffer.from(await response.arrayBuffer());
    if (media === 'text/csv') return response.text();
    const result = await response.json();
    validate(responsePointer + '/content/application~1json/schema', result);
    return result;
  }

  assert.equal((await call('listTables', { auth: false, status: 401 })).error.code, 'UNAUTHORIZED');
  assert.deepEqual(await call('listTables'), []);
  assert.deepEqual(await call('watchWorkspace'), {});
  await call('workspaceState');
  await call('refreshCalculations');
  await call('calculationStatus');

  let table = await call('createTable');
  ids.table = table.id;
  const primary = table.primaryFieldId;
  await call('getTable');
  await call('previewCsv');
  await call('importCsv');
  assert.match(await call('exportCsv'), /Launch/);
  table = await call('updateTable', { body: { name: 'Roadmap', expectedVersion: table.version } });

  const attachment = await call('uploadAttachment');
  ids.attachment = attachment.id;
  await call('listAttachments', { body: {} });
  await call('getAttachment');
  assert.deepEqual(await call('downloadAttachment'), Buffer.from('Hello'));
  await call('deleteAttachment');

  async function addField(name, type, settings = {}) {
    table = await call('createField', { body: { expectedVersion: table.version, name, type, ...settings } });
    return table.fields.at(-1).id;
  }
  ids.field = await addField('Optional text', 'text');
  table = await call('updateField', { body: { name: 'Quantity', expectedVersion: table.version } });
  const conversion = { expectedVersion: table.version, field: { type: 'number', name: 'Quantity' } };
  await call('previewConversion', { body: conversion });
  table = await call('applyConversion', { body: conversion });
  await call('previewFormula', { body: { expectedVersion: table.version, formula: { expression: '1 + 1', resultType: 'number' } } });
  table = await call('deleteField', { body: { expectedVersion: table.version } });

  const relation = { tableId: ids.table, multiple: true };
  ids.field = await addField('Parent', 'relation', { relation });
  const inverse = await addField('Children', 'relation', { relation });
  table = await call('pairRelationFields', { body: { expectedVersion: table.version, expectedTargetVersion: table.version, targetFieldId: inverse } });
  const startFieldId = await addField('Start', 'date');
  const calendar = { startFieldId, timeZone: 'UTC' };

  const created = await call('createRecords');
  const [record] = created.records;
  ids.record = record.id;
  const edit = [{ id: record.id, expectedVersion: record.version, values: { [primary]: 'Review', [startFieldId]: '2026-01-01' } }];
  const saved = await call('updateRecords', { body: edit });
  assert.equal((await call('updateRecords', { body: edit, status: 409 })).error.code, 'VERSION_CONFLICT');
  assert.equal((await call('getRecord')).values[primary], 'Review');
  await call('readRecordPage');
  await call('queryRecords');
  await call('summarizeRecords', { body: {} });
  await call('queryGroups', { body: { groupBy: primary } });

  await call('listViews');
  let view = await call('createView', { body: { name: 'Schedule', type: 'calendar', calendar } });
  ids.view = view.id;
  await call('getView');
  view = await call('updateView', { body: { name: 'Calendar', expectedVersion: view.version } });
  await call('queryView', { body: { expectedViewVersion: view.version } });
  await call('queryCalendar', { body: { viewId: view.id, from: '2026-01-01', toExclusive: '2026-01-03' } });
  await call('queryCalendarRecords', { body: { viewId: view.id, bucket: { kind: 'day', date: '2026-01-01' } } });
  const moved = await call('rescheduleRecord', { body: { expectedVersion: saved.records[0].version, expectedViewVersion: view.version, action: 'move', days: 1 } });
  await call('deleteView', { body: { expectedVersion: view.version } });

  const history = await call('recordHistory', { body: {} });
  ids.change = history.changes[0].id;
  await call('recordChange');
  const restored = await call('restoreRecord', { body: { changeId: ids.change, snapshot: 'before', expectedVersion: moved.records[0].version } });
  await call('recordBatches', { body: {} });
  await call('deleteRecords', { body: [{ id: record.id, expectedVersion: restored.version }] });
  const trash = await call('recordTrash', { body: {} });
  const recovered = await call('restoreDeletedRecords', { body: [{ id: record.id, deletionId: trash.records[0].deletionId }] });
  ids.batch = recovered.batchId;
  await call('recordBatchChanges', { body: {} });
  await call('undoRecordBatch', { body: {} });
  await call('deleteTable', { body: { expectedVersion: table.version } });
  assert.deepEqual([...exercised].sort(), [...operations.keys()].sort());
});
