import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { startServer } from '../../../apps/server/src/http-server.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';

test('URL fields preserve typed values through defaults, queries, CSV, history and conversion', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Links' });
  const address = 'https://例子.测试/文档?q=one%20two#section';
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Website', type: 'url', defaultValue: address });
  const link = table.fields[1]!.id;
  const rows = service.createRecords(table.id, [{ values: {} }, { values: { [link]: null } }]).records;
  assert.equal(rows[0]!.values[link], address); assert.equal(rows[1]!.values[link], null);
  const query = (operator: string, value?: string) => service.queryRecords(table.id, { filter: { conjunction: 'and', conditions: [{ fieldId: link, operator, ...(value === undefined ? {} : { value }) }] } }).records;
  assert.equal(query('contains', '文档')[0]!.id, rows[0]!.id);
  assert.equal(query('eq', address)[0]!.id, rows[0]!.id); assert.equal(query('isEmpty')[0]!.id, rows[1]!.id);
  const before = service.getTable(table.id);
  assert.throws(() => service.updateBatch(rows.map((row, index) => ({ id: row.id, expectedVersion: 1,
    values: { [link]: index ? 'javascript:alert(1)' : 'https://example.com/new' } })), table.id), { code: 'INVALID_VALUE' });
  assert.deepEqual(service.getTable(table.id), before); assert.deepEqual(service.queryRecords(table.id, {}).records, rows);
  const csv = service.exportCsv(table.id, {});
  service.importCsv(table.id, { expectedVersion: table.version, csv, hasHeader: true });
  assert.deepEqual(service.queryRecords(table.id, {}).records.map(row => row.values[link]), [address, null, address, null]);
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: 1, values: { [link]: 'https://example.com/new' } }], table.id);
  service.undoRecordBatch(table.id, service.recordBatches(table.id, {}).batches[0]!.id);
  assert.equal(service.getRecord(table.id, rows[0]!.id).values[link], address);
  table = service.applyConversion(table.id, link, { expectedVersion: table.version, field: { name: 'Website', type: 'text' } });
  assert.equal(table.fields[1]!.id, link);
  table = service.applyConversion(table.id, link, { expectedVersion: table.version, field: { name: 'Website', type: 'url' } });
  assert.equal(service.getRecord(table.id, rows[0]!.id).values[link], address);
  assert.throws(() => service.updateField(table.id, link, { expectedVersion: table.version, required: true }), { code: 'INVALID_VALUE' });
});

test('URL schema upgrades preserve existing data and survive restart and backups', async t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  const original = service.createTable({ name: 'Existing table' });
  const row = service.createRecords(original.id, [{ values: { [original.primaryFieldId]: 'Keep me' } }]).records[0]!;
  store.close();
  const db = new DatabaseSync(data.path); db.exec('DROP TABLE attachments; DROP TABLE field_sequences; PRAGMA user_version = 19'); db.close();
  const upgraded = new RecordService(data.open());
  assert.deepEqual(upgraded.getRecord(original.id, row.id), row);
  const table = upgraded.createField(original.id, { expectedVersion: original.version, name: 'Website', type: 'url' });
  upgraded.updateBatch([{ id: row.id, expectedVersion: 1, values: { [table.fields[1]!.id]: 'https://example.com' } }], table.id);
  const current = upgraded.getRecord(table.id, row.id);
  assert.deepEqual(new RecordService(data.open()).getRecord(table.id, row.id), current);
  const backup = join(dirname(data.path), 'backup.sqlite'), restored = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup); assert.equal((await restoreWorkspace(backup, restored)).version, 24);
  const restoredStore = new SqliteRecordStore(restored);
  try { assert.deepEqual(restoredStore.getTable(table.id).fields, table.fields); assert.deepEqual(new RecordService(restoredStore).getRecord(table.id, row.id), current); }
  finally { restoredStore.close(); }
});

test('URL CSV and conversion previews report invalid addresses without partial writes', t => {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Imports' });
  const name = table.primaryFieldId;
  const rows = service.createRecords(table.id, ['https://example.com', 'file:///C:/test'].map(value => ({ values: { [name]: value } }))).records;
  const conversion = { expectedVersion: table.version, field: { name: 'Website', type: 'url' } };
  const preview = service.previewConversion(table.id, name, conversion);
  assert.equal(preview.invalid, 1); assert.equal(preview.issues[0]!.recordId, rows[1]!.id);
  assert.throws(() => service.applyConversion(table.id, name, conversion), /could not be converted/);
  assert.deepEqual(service.queryRecords(table.id, {}).records, rows);
  service.updateBatch([{ id: rows[1]!.id, expectedVersion: 1, values: { [name]: 'https://example.com/other' } }], table.id);
  table = service.applyConversion(table.id, name, conversion);
  const current = service.queryRecords(table.id, {}).records;
  const csv = { expectedVersion: table.version, hasHeader: true, csv: 'Website\nhttps://example.com/new\njavascript:alert(1)\n' };
  const imported = service.previewCsv(table.id, csv);
  assert.equal(imported.invalid, 1); assert.equal(imported.issues[0]!.row, 3);
  assert.throws(() => service.importCsv(table.id, csv), { code: 'INVALID_VALUE' });
  assert.deepEqual(service.queryRecords(table.id, {}).records, current);
});

test('HTTP and SDK reject unsafe URLs and expose URL lookups and formula inputs', async t => {
  const service = new RecordService(fixture(t, null).open()), token = randomBytes(32).toString('hex');
  const server = await startServer({ service, token }); t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  let table = await api.createTable({ name: 'Web links' });
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Address', type: 'url', required: true });
  const link = table.fields[1]!.id;
  for (const value of [null, '', 'file:///C:/test', 'https://user:password@example.com', 'example.com']) {
    await assert.rejects(api.createRecords(table.id, [{ values: { [link]: value } }]), { code: 'INVALID_VALUE' });
  }
  const record = (await api.createRecords(table.id, [{ values: { [link]: 'https://example.com/path' } }])).records[0]!;
  table = await api.createField(table.id, { expectedVersion: table.version, name: 'Length', type: 'formula', formula: { expression: `LEN([${link}])`, resultType: 'number' } });
  assert.equal((await api.getRecord(table.id, record.id)).values[table.fields[2]!.id], 24);
  let references = await api.createTable({ name: 'References' });
  references = await api.createField(references.id, { expectedVersion: references.version, name: 'Link', type: 'relation', relation: { tableId: table.id, multiple: false } });
  references = await api.createField(references.id, { expectedVersion: references.version, name: 'Address', type: 'lookup', lookup: { relationFieldId: references.fields[1]!.id, fieldId: link } });
  const linked = (await api.createRecords(references.id, [{ values: { [references.fields[1]!.id]: [record.id] } }])).records[0]!;
  assert.deepEqual(linked.values[references.fields[2]!.id], ['https://example.com/path']);
});
