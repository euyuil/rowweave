import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fixture, removeWorkspaceState } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';

test('array lookup formulas store scalar results and recalculate complete dependent records atomically', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let target = service.createTable({ name: 'Items' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number' });
  const amount = target.fields[1]!.id;
  const rows = service.createRecords(target.id, [3, null, 4].map((value, index) => ({ values: {
    [target.primaryFieldId]: index === 1 ? 'Beta' : 'Alpha', [amount]: value,
  } }))).records;
  let source = service.createTable({ name: 'Reports' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Items', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = source.fields[1]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Amounts', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount } });
  const amounts = source.fields[2]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Names', type: 'lookup', lookup: { relationFieldId: link, fieldId: target.primaryFieldId } });
  const names = source.fields[3]!.id;
  const add = (name: string, expression: string, resultType = 'number') => {
    source = service.createField(source.id, { expectedVersion: source.version, name, type: 'formula', formula: { expression, resultType } });
    return source.fields.at(-1)!.id;
  };
  const sum = add('Total', 'ARRAYSUM([' + amounts + '])');
  const average = add('Average', 'ARRAYAVERAGE([' + amounts + '])');
  const count = add('Count', 'ARRAYCOUNT([' + amounts + '])');
  const length = add('Links', 'ARRAYLEN([' + link + '])');
  const labels = add('Labels', 'ARRAYJOIN(ARRAYUNIQUE([' + names + ']), ", ")', 'text');
  const record = service.createRecords(source.id, [{ values: { [link]: rows.map(row => row.id) } }]).records[0]!;
  assert.equal(record.values[sum], 7); assert.equal(record.values[average], 3.5);
  assert.equal(record.values[count], 2); assert.equal(record.values[length], 3); assert.equal(record.values[labels], 'Alpha, Beta');
  const page = service.queryRecords(source.id, {});
  const updated = service.updateBatch([{ id: rows[0]!.id, expectedVersion: rows[0]!.version, values: { [amount]: 5 } }], target.id);
  const changed = service.getRecord(source.id, record.id);
  assert.equal(changed.values[sum], 9); assert.equal(changed.version, record.version + 1);
  assert.throws(() => service.queryRecords(source.id, { expectedRevision: page.revision }), /changed/);
  assert.equal(service.queryRecords(source.id, { filter: { conjunction: 'and', conditions: [{ fieldId: sum, operator: 'eq', value: 9 }] } }).total, 1);
  assert.match(service.exportCsv(source.id, {}), /Alpha, Beta/);
  assert.throws(() => service.updateBatch([
    { id: rows[0]!.id, expectedVersion: updated.records[0]!.version, values: { [amount]: 100 } },
    { id: rows[1]!.id, expectedVersion: 999, values: { [amount]: 100 } },
  ], target.id), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(service.getRecord(source.id, record.id), changed);
  service.undoRecordBatch(target.id, updated.batchId!);
  assert.equal(service.getRecord(source.id, record.id).values[sum], 7);
  assert.throws(() => service.deleteField(source.id, amounts, { expectedVersion: source.version }), /dependent formulas/);
  source = service.updateField(source.id, names, { expectedVersion: source.version, name: 'Current names' });
  const before = service.getRecord(source.id, record.id);
  store.close(); assert.deepEqual(new RecordService(data.open()).getRecord(source.id, record.id), before);
  const db = new DatabaseSync(data.path);
  const values = JSON.parse(db.prepare('SELECT values_json FROM records WHERE id = ?').get(record.id)!['values_json'] as string);
  assert.equal(Object.hasOwn(values, amounts), false); assert.equal(Object.hasOwn(values, names), false);
  assert.equal(values[labels], 'Alpha, Beta'); db.close();
});

test('raw relation calculations run after reciprocal writes, deletion and saved undo on either side', t => {
  const service = new RecordService(fixture(t, null).open());
  let projects = service.createTable({ name: 'Projects' }), tasks = service.createTable({ name: 'Tasks' });
  tasks = service.createField(tasks.id, { expectedVersion: tasks.version, name: 'Project', type: 'relation', relation: { tableId: projects.id, multiple: false },
    reverseField: { name: 'Tasks', multiple: true, expectedVersion: projects.version } });
  const link = tasks.fields[1]!.id; projects = service.getTable(projects.id);
  const reverse = projects.fields[1]!.id;
  projects = service.createField(projects.id, { expectedVersion: projects.version, name: 'Task count', type: 'formula',
    formula: { expression: 'ARRAYLEN(COALESCE([' + reverse + '], ARRAY()))', resultType: 'number' } });
  const count = projects.fields[2]!.id;
  const project = service.createRecords(projects.id, [{ values: {} }]).records[0]!;
  assert.equal(project.values[count], 0);
  const task = service.createRecords(tasks.id, [{ values: { [link]: [project.id] } }]).records[0]!;
  let current = service.getRecord(projects.id, project.id);
  assert.equal(current.values[count], 1); assert.equal(current.version, project.version + 1);
  const detached = service.updateBatch([{ id: current.id, expectedVersion: current.version, values: { [reverse]: [] } }], projects.id);
  assert.equal(detached.records[0]!.values[count], 0);
  assert.deepEqual(service.getRecord(tasks.id, task.id).values[link], []);
  service.undoRecordBatch(projects.id, detached.batchId!);
  assert.equal(service.getRecord(projects.id, project.id).values[count], 1);
  const activeTask = service.getRecord(tasks.id, task.id);
  service.deleteRecords(tasks.id, [{ id: task.id, expectedVersion: activeTask.version }]);
  current = service.getRecord(projects.id, project.id); assert.equal(current.values[count], 0);
  const deleted = service.recordTrash(tasks.id, {}).records[0]!;
  service.restoreDeletedRecords(tasks.id, [{ id: task.id, deletionId: deleted.deletionId }]);
  assert.equal(service.getRecord(projects.id, project.id).values[count], 1);
});

test('multiple-select and file arrays share formulas, CSV, bounded lookup evaluation and self-contained backup', async t => {
  const data = fixture(t, null), service = new RecordService(data.open());
  let table = service.createTable({ name: 'Collections' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Tags', type: 'multiSelect',
    options: Array.from({ length: 200 }, (_, i) => ({ name: 'Tag ' + i })) });
  const tags = table.fields[1]!.id, options = table.fields[1]!.options!.map(option => option.id);
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Files', type: 'attachment' });
  const files = table.fields[2]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Files attached', type: 'formula',
    formula: { expression: 'ARRAYLEN([' + files + '])', resultType: 'number' } });
  const fileCount = table.fields[3]!.id;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Tag count', type: 'formula',
    formula: { expression: 'ARRAYLEN([' + tags + '])', resultType: 'number' } });
  const tagCount = table.fields[4]!.id;
  const upload = service.uploadAttachment(table.id, { filename: 'fixture.txt', mediaType: 'text/plain', data: 'aGk=' });
  const rows = service.createRecords(table.id, Array.from({ length: 200 }, () => ({ values: { [tags]: options, [files]: [upload.id] } }))).records;
  assert.equal(rows[0]!.values[tagCount], 200); assert.equal(rows[0]!.values[fileCount], 1);
  let reports = service.createTable({ name: 'Collection report' });
  reports = service.createField(reports.id, { expectedVersion: reports.version, name: 'Collections', type: 'relation', relation: { tableId: table.id, multiple: true } });
  const link = reports.fields[1]!.id;
  reports = service.createField(reports.id, { expectedVersion: reports.version, name: 'All tags', type: 'lookup', lookup: { relationFieldId: link, fieldId: tags } });
  const all = reports.fields[2]!.id;
  for (const [name, expression, resultType] of [['Count', 'ARRAYLEN([' + all + '])', 'number'],
    ['Unique', 'ARRAYLEN(ARRAYUNIQUE([' + all + ']))', 'number'], ['Joined', 'ARRAYJOIN([' + all + '], "")', 'text']]) {
    reports = service.createField(reports.id, { expectedVersion: reports.version, name, type: 'formula', formula: { expression, resultType } });
  }
  const report = service.createRecords(reports.id, [{ values: { [link]: rows.map(row => row.id) } }]).records[0]!;
  assert.equal(report.values[reports.fields[3]!.id], 40_000); assert.equal(report.values[reports.fields[4]!.id], 200);
  assert.match(report.formulaErrors![reports.fields[5]!.id]!, /exceeds/);
  service.importCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: 'Tags,Files\n"[""Tag 0""]","[""' + upload.id + '""]"\n' });
  const imported = service.queryRecords(table.id, { offset: 200 }).records[0]!;
  assert.equal(imported.values[tagCount], 1); assert.equal(imported.values[fileCount], 1);
  const backup = join(dirname(data.path), 'arrays.sqlite'), restored = join(dirname(data.path), 'restored.sqlite');
  await backupWorkspace(data.path, backup); await restoreWorkspace(backup, restored);
  const restoredStore = new SqliteRecordStore(restored);
  try { assert.deepEqual(new RecordService(restoredStore).getRecord(reports.id, report.id), report); }
  finally { restoredStore.close(); }
});

test('format 25 migration preserves existing date formulas, values, versions and views', t => {
  const data = fixture(t, null), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'Existing dates' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Date', type: 'formula',
    formula: { expression: 'DATE(2024, 2, 29)', resultType: 'date' } });
  const row = service.createRecords(table.id, [{ values: {} }]).records[0]!, schema = service.getTable(table.id), views = service.listViews(table.id);
  store.close(); const db = new DatabaseSync(data.path); removeWorkspaceState(db); db.exec('PRAGMA user_version = 25;'); db.close();
  const reopened = new RecordService(data.open());
  assert.deepEqual(reopened.getTable(table.id), schema); assert.deepEqual(reopened.getRecord(table.id, row.id), row);
  assert.deepEqual(reopened.listViews(table.id), views);
});

test('a failed linked formula is not disguised as a null item by array counts and clears on recovery', t => {
  const service = new RecordService(fixture(t, null).open());
  let target = service.createTable({ name: 'Inputs' });
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Amount', type: 'number' });
  const amount = target.fields[1]!.id;
  target = service.createField(target.id, { expectedVersion: target.version, name: 'Inverse', type: 'formula',
    formula: { expression: '1 / [' + amount + ']', resultType: 'number' } });
  let source = service.createTable({ name: 'Counts' });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Inputs', type: 'relation', relation: { tableId: target.id, multiple: true } });
  const link = source.fields[1]!.id;
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Results', type: 'lookup',
    lookup: { relationFieldId: link, fieldId: target.fields[2]!.id } });
  source = service.createField(source.id, { expectedVersion: source.version, name: 'Count', type: 'formula',
    formula: { expression: 'ARRAYCOUNT([' + source.fields[2]!.id + '])', resultType: 'number' } });
  const count = source.fields[3]!.id;
  const input = service.createRecords(target.id, [{ values: { [amount]: 0 } }]).records[0]!;
  const output = service.createRecords(source.id, [{ values: { [link]: [input.id] } }]).records[0]!;
  assert.equal(output.values[count], null); assert.match(output.formulaErrors![count]!, /referenced calculation/);
  service.updateBatch([{ id: input.id, expectedVersion: input.version, values: { [amount]: 2 } }], target.id);
  const recovered = service.getRecord(source.id, output.id);
  assert.equal(recovered.values[count], 1); assert.equal(recovered.formulaErrors, undefined);
});
