import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, removeWorkspaceState } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { maxAttachmentBytes } from '../../contracts/src/index.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

const upload = (bytes: Uint8Array, filename = '设计 🌱.bin') => ({ filename, mediaType: 'application/octet-stream', data: Buffer.from(bytes).toString('base64') });

test('attachments retain exact binary bytes and immutable metadata across restart and self-contained backup', async t => {
  const data = fixture(t, null, () => new Date('2026-11-13T01:02:03.004Z'));
  const store = data.open(), service = new RecordService(store), table = service.createTable({ name: 'Files' });
  const bytes = Buffer.from([0, 255, 1, 13, 10, 128, 65]);
  const file = service.uploadAttachment(table.id, upload(bytes));
  assert.equal(file.filename, '设计 🌱.bin'); assert.equal(file.size, bytes.length);
  assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(file.createdAt, '2026-11-13T01:02:03.004Z');
  assert.deepEqual(service.getAttachment(table.id, file.id), file);
  assert.deepEqual(Buffer.from(service.downloadAttachment(table.id, file.id).bytes), bytes);
  assert.deepEqual(service.getTable(table.id), table); assert.deepEqual(service.recordBatches(table.id, {}), { batches: [] });
  store.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getAttachment(table.id, file.id), file);
  const backup = join(dirname(data.path), 'files-backup.sqlite'), restored = join(dirname(data.path), 'restored.sqlite');
  assert.equal((await backupWorkspace(data.path, backup)).version, 34);
  await restoreWorkspace(backup, restored);
  const restoredStore = new SqliteRecordStore(restored);
  try { assert.deepEqual(Buffer.from(new RecordService(restoredStore).downloadAttachment(table.id, file.id).bytes), bytes); }
  finally { restoredStore.close(); }
  reopened.deleteTable(table.id, { expectedVersion: table.version });
  assert.throws(() => reopened.getAttachment(table.id, file.id), { code: 'ATTACHMENT_NOT_FOUND' });
  const db = new DatabaseSync(data.path);
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attachments').get()!['count'], 0); }
  finally { db.close(); }
});

test('attachment validation rejects malformed data and paths without leaving partial uploads', t => {
  const service = new RecordService(fixture(t, null).open()), table = service.createTable({ name: 'Files' });
  const good = upload(Buffer.from('hello'));
  for (const changes of [
    { filename: '' }, { filename: '../file.txt' }, { filename: 'C:\\file.txt' }, { filename: 'bad\r\nname' },
    { filename: '\ud800.txt' }, { filename: '..' }, { filename: 'x'.repeat(201) }, { mediaType: 'text/html\r\nx: y' },
    { mediaType: 'text/plain; charset=utf-8' }, { data: 'SGVsbG8' }, { data: 'SGVsbG8=\n' }, { data: '%%%=' }, { data: 'Zh==' }, { data: 3 },
  ]) assert.throws(() => service.uploadAttachment(table.id, { ...good, ...changes }), { code: 'INVALID_ATTACHMENT' });
  assert.throws(() => service.uploadAttachment(table.id, upload(Buffer.alloc(maxAttachmentBytes + 1))), { code: 'PAYLOAD_TOO_LARGE' });
  assert.throws(() => service.uploadAttachment('missing', good), { code: 'TABLE_NOT_FOUND' });
  assert.deepEqual(service.listAttachments(table.id, {}), { attachments: [] });
  const empty = service.uploadAttachment(table.id, { ...good, data: '' });
  assert.equal(service.downloadAttachment(table.id, empty.id).bytes.byteLength, 0);
  const full = service.uploadAttachment(table.id, upload(Buffer.alloc(maxAttachmentBytes, 255)));
  assert.equal(service.downloadAttachment(table.id, full.id).bytes.byteLength, maxAttachmentBytes);
  assert.equal(service.listAttachments(table.id, {}).attachments.length, 2);
});

test('attachment pages are bounded and stable while new uploads arrive, and files stay scoped to their table', t => {
  const service = new RecordService(fixture(t, null).open()), table = service.createTable({ name: 'Files' }), other = service.createTable({ name: 'Other' });
  const files = Array.from({ length: 5 }, (_, i) => service.uploadAttachment(table.id, upload(Buffer.from([i]), `file-${i}.bin`)));
  const first = service.listAttachments(table.id, { limit: 2 });
  assert.deepEqual(first.attachments, [files[4], files[3]]);
  service.uploadAttachment(table.id, upload(Buffer.from('new')));
  const next = service.listAttachments(table.id, { limit: 2, before: first.nextBefore });
  assert.deepEqual(next.attachments, [files[2], files[1]]);
  assert.deepEqual(service.listAttachments(table.id, { limit: 2, before: next.nextBefore }), { attachments: [files[0]] });
  for (const query of [{ limit: 0 }, { limit: 101 }, { before: -1 }, { before: 1.5 }]) assert.throws(() => service.listAttachments(table.id, query), { code: 'INVALID_QUERY' });
  for (const action of [() => service.getAttachment(other.id, files[0]!.id), () => service.downloadAttachment(other.id, files[0]!.id), () => service.deleteAttachment(other.id, files[0]!.id)]) {
    assert.throws(action, { code: 'ATTACHMENT_NOT_FOUND' });
  }
  service.deleteAttachment(table.id, files[0]!.id);
  assert.throws(() => service.downloadAttachment(table.id, files[0]!.id), { code: 'ATTACHMENT_NOT_FOUND' });
  assert.throws(() => service.deleteAttachment(table.id, files[0]!.id), { code: 'ATTACHMENT_NOT_FOUND' });
});

test('format 22 workspaces gain file storage without changing records or schema', t => {
  const data = fixture(t), store = data.open(), service = new RecordService(store), before = service.getTable();
  const records = service.readPage(0, 12); store.close();
  const db = new DatabaseSync(data.path); removeWorkspaceState(db); db.exec('DROP TABLE attachments; PRAGMA user_version = 22;'); db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(), before); assert.deepEqual(reopened.readPage(0, 12), records);
  assert.equal(reopened.uploadAttachment(before.id, upload(Buffer.from('new capability'))).size, 14);
});
