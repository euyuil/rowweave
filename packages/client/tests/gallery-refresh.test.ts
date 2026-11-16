import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../../storage-sqlite/tests/helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { galleryCardFields, galleryCover, galleryProjection, prepareGallerySnapshot } from '../src/gallery-refresh.js';
import type { WorkspaceApi } from '../src/http-client.js';
import type { Attachment } from '../../contracts/src/index.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const service = new RecordService(fixture(t, null).open());
  let table = service.createTable({ name: 'Gallery pages' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Files', type: 'attachment' });
  for (let i = 0; i < 8; i++) table = service.createField(table.id, { expectedVersion: table.version, name: 'Field ' + i, type: 'text' });
  const name = table.primaryFieldId, cover = table.fields[1]!.id;
  const records = service.createRecords(table.id, Array.from({ length: 85 }, (_, index) => ({ values: {
    [name]: 'Card ' + String(index).padStart(3, '0'), ...Object.fromEntries(table.fields.slice(2).map(field => [field.id, 'Value ' + index])),
  } }))).records;
  const view = service.createView(table.id, { name: 'Cards', type: 'gallery', gallery: { cardSize: 'medium', coverFit: 'cover', coverFieldId: cover },
    query: { sort: [{ fieldId: name, direction: 'asc' }] },
    columns: [...table.fields].reverse().map(field => ({ fieldId: field.id, width: 180, hidden: field.id === name || field.id === cover })) });
  assert.ok(view.type === 'gallery');
  const api: Pick<WorkspaceApi, 'queryView'> = { queryView: async (id, viewId, input) => service.queryView(id, viewId, input) };
  const first = () => service.queryView(table.id, view.id, { limit: 1 });
  return { service, table, name, cover, records, view, api, first };
}

test('gallery pages project the title, hidden cover and first six ordered card fields, and clamp removed pages', async t => {
  const { service, table, name, cover, records, view, api, first } = setup(t);
  const shown = table.fields.slice(4).reverse().map(field => field.id);
  assert.deepEqual(galleryCardFields(table, view).map(field => field.id), shown);
  assert.deepEqual(galleryProjection(table, view), [name, cover, ...shown]);
  const controller = new AbortController();
  const measured = { queryView: async (...args: Parameters<typeof api.queryView>) => {
    assert.equal(args[3], controller.signal); assert.equal(args[2].limit, 40);
    assert.deepEqual(args[2].fields, [name, cover, ...shown]); return api.queryView(...args);
  } };
  const snapshot = await prepareGallerySnapshot(measured, table, view, first(), '', { offset: 80 }, controller.signal);
  assert.equal(snapshot.page.total, 85); assert.equal(snapshot.page.records.length, 5);
  assert.equal(snapshot.page.records[0]!.id, records[80]!.id);
  assert.equal(snapshot.page.records[0]!.values[table.fields[2]!.id], undefined);
  service.deleteRecords(table.id, records.slice(60).map(record => ({ id: record.id, expectedVersion: record.version })));
  const next = await prepareGallerySnapshot(measured, table, view, first(), '', snapshot.window, controller.signal);
  assert.equal(next.window.offset, 40); assert.equal(next.page.records.length, 20); assert.equal(next.page.records[0]!.id, records[40]!.id);
  const remaining = service.queryRecords(table.id, {}).records;
  service.deleteRecords(table.id, remaining.map(record => ({ id: record.id, expectedVersion: record.version })));
  const empty = await prepareGallerySnapshot(measured, table, view, first(), '', next.window, controller.signal);
  assert.equal(empty.window.offset, 0); assert.equal(empty.page.total, 0); assert.deepEqual(empty.page.records, []);
});

test('gallery cover selection uses supported images in file order with explicit non-image fallback', t => {
  const { cover, records, view } = setup(t);
  const file = (id: string, mediaType: string): Attachment => ({ id, tableId: 'source', filename: id, mediaType, size: 3, sha256: 'hash', createdAt: '2024-01-01T00:00:00.000Z' });
  const pdf = file('notes.pdf', 'application/pdf'), svg = file('drawing.svg', 'image/svg+xml');
  const first = file('first.png', 'image/png'), second = file('second.jpeg', 'image/jpeg');
  const record = { ...records[0]!, attachments: { [cover]: [pdf, svg, first, second] } };
  assert.equal(galleryCover(view, record), first);
  assert.equal(galleryCover(view, { ...record, attachments: { [cover]: [pdf, svg] } }), pdf);
  assert.equal(galleryCover(view, records[0]!), undefined);
  assert.equal(galleryCover({ ...view, gallery: { cardSize: 'small', coverFit: 'contain' } }, record), undefined);
});

test('gallery snapshots reject mixed data, schema and view versions and forward cancellation', async t => {
  const { service, table, name, records, view, api, first } = setup(t);
  const old = first();
  service.updateBatch([{ id: records[0]!.id, expectedVersion: records[0]!.version, values: { [name]: 'Updated' } }], table.id);
  await assert.rejects(prepareGallerySnapshot(api, table, view, old, '', { offset: 0 }, new AbortController().signal), { code: 'DATA_CHANGED' });
  const changedSchema = { queryView: async (...args: Parameters<typeof api.queryView>) => ({ ...await api.queryView(...args), schemaVersion: table.version + 1 }) };
  await assert.rejects(prepareGallerySnapshot(changedSchema, table, view, first(), '', { offset: 0 }, new AbortController().signal), { code: 'SCHEMA_CONFLICT' });
  const controller = new AbortController(); let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held: Pick<WorkspaceApi, 'queryView'> = { queryView: async (_id, _viewId, _input, signal) => {
    assert.equal(signal, controller.signal);
    return new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); started(); });
  } };
  const cancelled = assert.rejects(prepareGallerySnapshot(held, table, view, first(), '', { offset: 0 }, controller.signal), { name: 'AbortError' });
  await ready; controller.abort(); await cancelled;
  const current = first(); service.updateView(table.id, view.id, { expectedVersion: view.version, name: 'Changed' });
  await assert.rejects(prepareGallerySnapshot(api, table, view, current, '', { offset: 0 }, new AbortController().signal), { code: 'VIEW_CONFLICT' });
});
