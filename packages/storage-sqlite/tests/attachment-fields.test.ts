import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { maxAttachmentsPerCell } from '../../contracts/src/index.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Documents' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Files', type: 'attachment' });
  const field = table.fields[1]!.id;
  const upload = (filename: string, tableId = table.id) => service.uploadAttachment(tableId, { filename, mediaType: 'text/plain', data: Buffer.from(filename).toString('base64') });
  return { data, store, service, table, field, upload };
}

test('attachment fields retain ordered metadata and bytes through clear, history, trash and saved undo', async t => {
  const { data, store, service, table, field, upload } = setup(t), a = upload('设计.txt'), b = upload('notes.txt');
  const created = service.createRecords(table.id, [{ values: { [field]: [b.id, a.id] } }]);
  let row = created.records[0]!;
  assert.deepEqual(row.attachments![field], [b, a]); assert.deepEqual(row.values[field], [b.id, a.id]);
  assert.equal(a.tableId, table.id);
  assert.throws(() => service.deleteAttachment(table.id, a.id), { code: 'ATTACHMENT_RETAINED' });
  const cleared = service.updateBatch([{ id: row.id, expectedVersion: row.version, values: { [field]: [] } }], table.id);
  const change = service.recordChange(table.id, row.id, service.recordHistory(table.id, row.id, {}).changes[0]!.id);
  assert.deepEqual(change.before!.attachments![field], [b, a]); assert.deepEqual(change.after!.attachments![field], []);
  service.undoRecordBatch(table.id, cleared.batchId!); row = service.getRecord(table.id, row.id);
  assert.deepEqual(row.attachments![field], [b, a]);
  service.deleteRecords(table.id, [{ id: row.id, expectedVersion: row.version }]);
  assert.throws(() => service.deleteAttachment(table.id, b.id), { code: 'ATTACHMENT_RETAINED' });
  const deleted = service.recordTrash(table.id, {}).records[0]!;
  const restored = service.restoreDeletedRecords(table.id, [{ id: row.id, deletionId: deleted.deletionId }]).records[0]!;
  assert.deepEqual(restored.attachments![field], [b, a]);
  store.close(); const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getRecord(table.id, row.id).attachments![field], [b, a]);
  const backup = join(dirname(data.path), 'with-record-files.sqlite'), restoredPath = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, restoredPath);
  const restoredStore = new SqliteRecordStore(restoredPath);
  try {
    const restoredService = new RecordService(restoredStore);
    assert.deepEqual(restoredService.getRecord(table.id, row.id).attachments![field], [b, a]);
    assert.equal(Buffer.from(restoredService.downloadAttachment(table.id, a.id).bytes).toString(), a.filename);
    assert.throws(() => restoredService.deleteAttachment(table.id, a.id), { code: 'ATTACHMENT_RETAINED' });
  } finally { restoredStore.close(); }
});

test('attachment writes validate ownership and bounds atomically without retaining files after failed transactions', t => {
  const { service, table, field, upload } = setup(t), file = upload('file.txt');
  const other = service.createTable({ name: 'Other' }), foreign = upload('foreign.txt', other.id);
  for (const value of [[foreign.id], ['missing'], [file.id, file.id], [1], 'path.txt', Array.from({ length: maxAttachmentsPerCell + 1 }, (_, i) => String(i))]) {
    assert.throws(() => service.createRecords(table.id, [{ values: { [field]: value } }]), error => ['INVALID_VALUE', 'INVALID_ATTACHMENT'].includes((error as { code: string }).code));
  }
  assert.throws(() => service.createRecords(table.id, [{ values: { [field]: [file.id] } }, { values: { [field]: ['missing'] } }]), { code: 'INVALID_ATTACHMENT' });
  assert.equal(service.getTable(table.id).total, 0);
  service.deleteAttachment(table.id, file.id);
  const row = service.createRecords(table.id, [{ values: {} }]).records[0]!;
  assert.throws(() => service.updateField(table.id, field, { expectedVersion: table.version, required: true }), { code: 'INVALID_VALUE' });
  assert.throws(() => service.updateField(table.id, field, { expectedVersion: table.version, defaultValue: [] }), { code: 'INVALID_SCHEMA' });
  assert.throws(() => service.updateTable(table.id, { expectedVersion: table.version, primaryFieldId: field }), { code: 'INVALID_SCHEMA' });
  assert.throws(() => service.previewConversion(table.id, field, { expectedVersion: table.version, field: { name: 'Files', type: 'text' } }), { code: 'CONVERSION_REQUIRED' });
  const valid = upload('valid.txt');
  assert.throws(() => service.updateBatch([{ id: row.id, expectedVersion: row.version, values: { [field]: [valid.id] } },
    { id: 'missing', expectedVersion: 1, values: { [field]: [] } }], table.id), { code: 'RECORD_NOT_FOUND' });
  assert.deepEqual(service.getRecord(table.id, row.id), row); service.deleteAttachment(table.id, valid.id);
});

test('attachment filenames, IDs, empty values, CSV and linked lookups agree across queries', t => {
  const { service, table, field, upload } = setup(t), z = upload('zebra.txt'), a = upload('alpha.txt');
  const rows = service.createRecords(table.id, [{ values: { [field]: [z.id, a.id] } }, { values: { [field]: [] } }, { values: { [field]: [a.id] } }]).records;
  assert.deepEqual(service.queryRecords(table.id, { search: 'alpha' }).records.map(row => row.id), [rows[0]!.id, rows[2]!.id]);
  assert.deepEqual(service.queryRecords(table.id, { sort: [{ fieldId: field, direction: 'asc' }] }).records.map(row => row.id), [rows[2]!.id, rows[0]!.id, rows[1]!.id]);
  const filter = (operator: string, value?: unknown) => ({ filter: { conjunction: 'and', conditions: [{ fieldId: field, operator, ...(value === undefined ? {} : { value }) }] } });
  assert.equal(service.queryRecords(table.id, filter('isEmpty')).records[0]!.id, rows[1]!.id);
  assert.equal(service.queryRecords(table.id, filter('hasAny', [z.id])).records[0]!.id, rows[0]!.id);
  assert.equal(service.queryRecords(table.id, { fields: [] }).records[0]!.attachments, undefined);
  const csv = `Files\r\n"[""${a.id}""]"\r\n`;
  assert.equal(service.previewCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv }).invalid, 0);
  service.importCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv });
  assert.ok(service.exportCsv(table.id, {}).includes(a.id));
  const invalid = service.previewCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: 'Files\r\n"[""missing""]"\r\n' });
  assert.equal(invalid.invalid, 1);
  let source = service.createTable({ name: 'Reports' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Documents', type: 'relation', relation: { tableId: table.id, multiple: true } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'All files', type: 'lookup', lookup: { relationFieldId: source.fields[1]!.id, fieldId: field } });
  const lookup = source.fields[2]!.id;
  const report = service.createRecords(source.id, [{ values: { [source.fields[1]!.id]: [rows[0]!.id, rows[2]!.id] } }]).records[0]!;
  assert.deepEqual(report.values[lookup], [z.id, a.id, a.id]); assert.deepEqual(report.attachments![lookup], [z, a, a]);
  const single = service.createRecords(table.id, [{ values: { [field]: [z.id] } }]).records[0]!;
  const second = service.createRecords(source.id, [{ values: { [source.fields[1]!.id]: [single.id] } }]).records[0]!;
  assert.deepEqual(service.queryRecords(source.id, { sort: [{ fieldId: lookup, direction: 'asc' }] }).records.map(row => row.id), [report.id, second.id]);
  assert.equal(service.queryRecords(source.id, { search: 'zebra' }).records[0]!.id, report.id);
  assert.deepEqual(service.queryRecords(source.id, { fields: [lookup] }).records[0]!.attachments![lookup], [z, a, a]);
  service.updateBatch([{ id: rows[0]!.id, expectedVersion: rows[0]!.version, values: { [field]: [] } }], table.id);
  assert.deepEqual(service.getRecord(source.id, report.id).attachments![lookup], [a]);
});

test('format 23 uploaded files remain attachable after migration and field deletion retains saved file content', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Existing uploads' });
  const file = service.uploadAttachment(table.id, { filename: 'existing.txt', mediaType: 'text/plain', data: 'aGk=' }); store.close();
  const db = new DatabaseSync(data.path); db.exec('ALTER TABLE attachments DROP COLUMN retained; PRAGMA user_version = 23;'); db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getAttachment(table.id, file.id), file);
  table = reopened.createField(table.id, { expectedVersion: table.version, name: 'Files', type: 'attachment', required: true });
  const field = table.fields[1]!.id;
  assert.throws(() => reopened.createRecords(table.id, [{ values: { [field]: [] } }]), { code: 'INVALID_VALUE' });
  reopened.createRecords(table.id, [{ values: { [field]: [file.id] } }]);
  reopened.deleteField(table.id, field, { expectedVersion: table.version });
  assert.throws(() => reopened.deleteAttachment(table.id, file.id), { code: 'ATTACHMENT_RETAINED' });
  assert.equal(Buffer.from(reopened.downloadAttachment(table.id, file.id).bytes).toString(), 'hi');
});
