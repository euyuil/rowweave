import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { RecordService } from '../../core/src/record-service.js';

test('online backups include committed WAL data and restore independent schemas, versions, views, relations and lookups', async t => {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  const projects = service.createTable({ name: 'Projects' });
  const project = service.createRecords(projects.id, [{ values: { [projects.primaryFieldId]: '中文 🌱' } }]).records[0]!;
  let tasks = service.createTable({ name: 'Tasks' });
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project', type: 'relation', relation: { tableId: projects.id, multiple: false } });
  const link = tasks.fields[1]!.id;
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project name', type: 'lookup', lookup: { relationFieldId: link, fieldId: projects.primaryFieldId } });
  const task = service.createRecords(tasks.id, [{ values: { [tasks.primaryFieldId]: 'Ship', [link]: [project.id] } }]).records[0]!;
  const view = service.createView(tasks.id, { name: 'Linked work', query: { search: '中文' } });
  const expectedTables = service.listTables();
  const expectedPage = service.queryView(tasks.id, view.id, {});
  assert.ok((await stat(data.path + '-wal')).size > 0);
  const backup = join(dirname(data.path), 'snapshot.sqlite');
  const result = await backupWorkspace(data.path, backup);
  assert.equal(result.path, backup);
  assert.equal(result.version, 27);
  assert.equal(result.bytes, (await stat(backup)).size);
  assert.deepEqual(service.listTables(), expectedTables);
  service.updateBatch([{ id: project.id, expectedVersion: project.version, values: { [projects.primaryFieldId]: 'After backup' } }], projects.id);
  const restoredPath = join(dirname(data.path), 'restored.sqlite');
  assert.equal((await restoreWorkspace(backup, restoredPath)).version, 27);
  const restoredStore = new SqliteRecordStore(restoredPath);
  try {
    const restored = new RecordService(restoredStore);
    assert.deepEqual(restored.listTables(), expectedTables);
    assert.deepEqual(restored.getRecord(tasks.id, task.id), task);
    assert.deepEqual(restored.getView(tasks.id, view.id), view);
    assert.deepEqual(restored.queryView(tasks.id, view.id, {}), expectedPage);
    restored.updateBatch([{ id: project.id, expectedVersion: project.version, values: { [projects.primaryFieldId]: 'Restored edit' } }], projects.id);
    assert.equal(service.getRecord(projects.id, project.id).values[projects.primaryFieldId], 'After backup');
  } finally { restoredStore.close(); }
  const snapshot = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA journal_mode').get()!['journal_mode'], 'delete');
    assert.deepEqual(JSON.parse(snapshot.prepare('SELECT values_json FROM records WHERE id = ?').get(project.id)!['values_json'] as string), project.values);
  } finally { snapshot.close(); }
  assert.ok(!(await readdir(dirname(data.path))).some(name => name.startsWith('.rowweave-backup-')));
  assert.ok(!(await readdir(dirname(backup))).includes('snapshot.sqlite-wal'));
});

test('restoring an old snapshot migrates only the copy and preserves the original backup', async t => {
  const data = fixture(t, null);
  const legacy = new DatabaseSync(data.path);
  const fields = [{ id: 'field_1', name: 'Name', type: 'text' }];
  const values = { field_1: 'Preserved 中文 🌱' };
  legacy.exec(`CREATE TABLE table_metadata (id TEXT PRIMARY KEY, fields_json TEXT NOT NULL);
    CREATE TABLE records (id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE,
      version INTEGER NOT NULL DEFAULT 1, values_json TEXT NOT NULL);
    PRAGMA user_version = 1;`);
  legacy.prepare('INSERT INTO table_metadata VALUES (?, ?)').run('prototype', JSON.stringify(fields));
  legacy.prepare('INSERT INTO records VALUES (?, ?, ?, ?)').run('saved-record', 7, 9, JSON.stringify(values));
  legacy.close();
  const sourceBytes = await readFile(data.path);
  const backup = join(dirname(data.path), 'legacy-backup.sqlite');
  assert.equal((await backupWorkspace(data.path, backup)).version, 1);
  const snapshotBytes = await readFile(backup);
  const restored = join(dirname(data.path), 'upgraded.sqlite');
  assert.equal((await restoreWorkspace(backup, restored)).version, 27);
  const store = new SqliteRecordStore(restored);
  try {
    assert.deepEqual(store.getTable().fields, fields);
    assert.deepEqual(store.readPage(0, 10).records, [{ id: 'saved-record', version: 9, values }]);
    assert.equal(store.listViews('prototype').length, 1);
  } finally { store.close(); }
  assert.deepEqual(await readFile(data.path), sourceBytes);
  assert.deepEqual(await readFile(backup), snapshotBytes);
});

test('backup and restore refuse existing destinations and leave sources and unrelated files untouched', async t => {
  const data = fixture(t);
  data.open().close();
  const source = await readFile(data.path);
  const destination = join(dirname(data.path), 'existing.sqlite');
  await writeFile(destination, 'Do not replace');
  for (const operation of [backupWorkspace, restoreWorkspace]) {
    await assert.rejects(operation(data.path, destination), { code: 'EEXIST' });
    await assert.rejects(operation(data.path, data.path), { code: 'EEXIST' });
    assert.equal(await readFile(destination, 'utf8'), 'Do not replace');
    assert.deepEqual(await readFile(data.path), source);
  }
  assert.ok(!(await readdir(dirname(data.path))).some(name => name.startsWith('.rowweave-backup-')));
});

test('missing, corrupt, uninitialized and unsupported restore inputs produce no completed destination', async t => {
  const data = fixture(t, null);
  const directory = dirname(data.path);
  const destination = join(directory, 'restored.sqlite');
  await assert.rejects(restoreWorkspace(data.path, destination));
  assert.deepEqual(await readdir(directory), []);
  await writeFile(data.path, 'Not a SQLite database');
  await assert.rejects(restoreWorkspace(data.path, destination));
  const empty = join(directory, 'empty.sqlite');
  new DatabaseSync(empty).close();
  await assert.rejects(restoreWorkspace(empty, destination), /not an initialized RowWeave workspace/);
  const newer = join(directory, 'newer.sqlite');
  const db = new DatabaseSync(newer);
  db.exec('CREATE TABLE records (id TEXT); PRAGMA user_version = 99;');
  db.close();
  const before = await readFile(newer);
  await assert.rejects(restoreWorkspace(newer, destination), /Unsupported database version: 99/);
  assert.deepEqual(await readFile(newer), before);
  const broken = join(directory, 'broken-migration.sqlite');
  const legacy = new DatabaseSync(broken);
  legacy.exec(`CREATE TABLE table_metadata (id TEXT PRIMARY KEY, fields_json TEXT NOT NULL);
    CREATE TABLE records (id TEXT PRIMARY KEY, position INTEGER, version INTEGER, values_json TEXT);
    INSERT INTO table_metadata VALUES ('prototype', 'invalid json'); PRAGMA user_version = 1;`);
  legacy.close();
  const legacyBytes = await readFile(broken);
  await assert.rejects(restoreWorkspace(broken, destination), SyntaxError);
  assert.deepEqual(await readFile(broken), legacyBytes);
  assert.ok(!(await readdir(directory)).includes('restored.sqlite'));
  assert.ok(!(await readdir(directory)).some(name => name.startsWith('.rowweave-backup-')));
});

test('referential corruption is rejected before a snapshot is published', async t => {
  const data = fixture(t, null);
  const service = new RecordService(data.open());
  service.createTable({ name: 'Keep' });
  const corrupt = new DatabaseSync(data.path, { enableForeignKeyConstraints: false });
  corrupt.prepare('INSERT INTO records (id, table_id, position, values_json) VALUES (?, ?, ?, ?)').run('orphan', 'missing-table', 0, '{}');
  corrupt.close();
  const destination = join(dirname(data.path), 'bad-backup.sqlite');
  await assert.rejects(backupWorkspace(data.path, destination), /integrity check/);
  assert.ok(!(await readdir(dirname(data.path))).includes('bad-backup.sqlite'));
});
