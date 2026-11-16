import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { parseCsv } from '../../core/src/csv.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Gallery' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Files', type: 'attachment' });
  const name = table.primaryFieldId, cover = table.fields[1]!.id;
  const file = service.uploadAttachment(table.id, { filename: 'cover.png', mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') });
  const rows = service.createRecords(table.id, [{ values: { [name]: 'Beta', [cover]: [file.id] } },
    { values: { [name]: 'Alpha' } }, { values: { [name]: 'Excluded' } }]).records;
  return { data, store, service, table, name, cover, file, rows };
}

test('gallery settings preserve filters, attachment projection, CSV and record identities across restart', t => {
  const { data, store, service, table, name, cover, file, rows } = setup(t);
  const defaults = service.createView(table.id, { name: 'Default gallery', type: 'gallery' });
  assert.deepEqual(defaults.gallery, { cardSize: 'medium', coverFit: 'cover' });
  let view = service.createView(table.id, { name: 'Collection', type: 'gallery', gallery: { cardSize: 'large', coverFit: 'contain', coverFieldId: cover },
    columns: table.fields.map(field => ({ fieldId: field.id, width: 180, hidden: field.id === cover })),
    query: { filter: { conjunction: 'and', conditions: [{ fieldId: name, operator: 'neq', value: 'Excluded' }] }, sort: [{ fieldId: name, direction: 'asc' }] } });
  const first = service.queryView(table.id, view.id, { limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.records[0]!.id, rows[1]!.id); assert.equal(first.records[0]!.attachments, undefined);
  const second = service.queryView(table.id, view.id, { offset: 1, limit: 1, fields: [name, cover], expectedViewVersion: view.version, expectedRevision: first.revision });
  assert.equal(second.records[0]!.id, rows[0]!.id); assert.deepEqual(second.records[0]!.attachments![cover], [file]);
  assert.deepEqual([...parseCsv(service.exportCsv(table.id, { viewId: view.id }))].slice(1).map(row => row.cells[0]!.text), ['Alpha', 'Beta']);
  view = service.updateView(table.id, view.id, { expectedVersion: view.version, gallery: { cardSize: 'small', coverFit: 'cover' } });
  assert.equal(view.gallery?.coverFieldId, undefined);
  assert.throws(() => service.queryView(table.id, view.id, { expectedViewVersion: first.viewVersion }), { code: 'VIEW_CONFLICT' });
  store.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getView(table.id, view.id), view); assert.deepEqual(reopened.getRecord(table.id, rows[0]!.id), rows[0]);
});

test('gallery configuration validates cover dependencies and supports attachment lookups without copying files', t => {
  const { service, table, name, cover, file, rows } = setup(t);
  const settings = { cardSize: 'medium', coverFit: 'cover', coverFieldId: cover };
  const before = service.workspaceState({ tableId: table.id });
  for (const gallery of [null, {}, { ...settings, cardSize: 'huge' }, { ...settings, coverFit: 'stretch' }, { ...settings, coverFieldId: name },
    { ...settings, coverFieldId: null }, { ...settings, coverFieldId: 'missing' }]) {
    assert.throws(() => service.createView(table.id, { name: 'Invalid', type: 'gallery', gallery }), { code: 'INVALID_VIEW' });
  }
  assert.throws(() => service.createView(table.id, { name: 'Wrong type', type: 'grid', gallery: settings }), { code: 'INVALID_VIEW' });
  assert.throws(() => service.createView(table.id, { name: 'Grouped cards', type: 'gallery', groupBy: name }), { code: 'INVALID_VIEW' });
  assert.deepEqual(service.workspaceState({ tableId: table.id }), before);
  let view = service.createView(table.id, { name: 'Covers', type: 'gallery', gallery: settings });
  const renamed = service.updateField(table.id, cover, { expectedVersion: table.version, name: 'Images' });
  assert.equal(service.getView(table.id, view.id).gallery?.coverFieldId, cover);
  assert.throws(() => service.deleteField(table.id, cover, { expectedVersion: renamed.version }), { code: 'VIEW_DEPENDENCY' });
  let linked = service.createTable({ name: 'Linked covers' });
  linked = service.createField(linked.id, { expectedVersion: linked.version, name: 'Source', type: 'relation', relation: { tableId: table.id, multiple: true } });
  const relation = linked.fields[1]!.id;
  linked = service.createField(linked.id, { expectedVersion: linked.version, name: 'Shared images', type: 'lookup', lookup: { relationFieldId: relation, fieldId: cover } });
  const lookup = linked.fields[2]!.id;
  const record = service.createRecords(linked.id, [{ values: { [relation]: [rows[0]!.id] } }]).records[0]!;
  const linkedView = service.createView(linked.id, { name: 'Related collection', type: 'gallery', gallery: { ...settings, coverFieldId: lookup } });
  const projected = service.queryView(linked.id, linkedView.id, { fields: [lookup] }).records[0]!;
  assert.equal(projected.id, record.id); assert.deepEqual(projected.attachments![lookup], [file]);
  assert.equal(projected.attachments![lookup]![0]!.tableId, table.id);
  view = service.getView(table.id, view.id);
  view = service.updateView(table.id, view.id, { expectedVersion: view.version, type: 'grid' });
  assert.equal(view.gallery, undefined);
  const selected = service.getView(linked.id, linkedView.id);
  service.updateView(linked.id, linkedView.id, { expectedVersion: selected.version, gallery: { cardSize: 'small', coverFit: 'cover' } });
  linked = service.deleteField(linked.id, lookup, { expectedVersion: linked.version });
  service.deleteField(table.id, cover, { expectedVersion: renamed.version });
});

test('format 37 preserves existing views and saved galleries survive backup and restore', async t => {
  const { data, store, service, table, cover } = setup(t);
  const before = service.listViews(table.id), state = service.workspaceState({ tableId: table.id });
  store.close();
  const previous = new DatabaseSync(data.path); previous.exec('PRAGMA user_version = 36'); previous.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.listViews(table.id), before); assert.deepEqual(reopened.workspaceState({ tableId: table.id }), state);
  const view = reopened.createView(table.id, { name: 'Saved gallery', type: 'gallery', gallery: { cardSize: 'small', coverFit: 'contain', coverFieldId: cover } });
  const backup = data.path + '.backup', restored = data.path + '.restored';
  assert.equal((await backupWorkspace(data.path, backup)).version, 37);
  await restoreWorkspace(backup, restored);
  const db = new DatabaseSync(restored);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!['user_version'], 37);
    const config = JSON.parse(db.prepare('SELECT config_json FROM views WHERE id = ?').get(view.id)!['config_json'] as string);
    assert.equal(config.type, 'gallery'); assert.deepEqual(config.gallery, view.gallery);
  } finally { db.close(); }
});
