import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { CellValue, RowRecord } from '../../contracts/src/index.js';
import { dirname, join } from 'node:path';
import { fixture } from './helpers.js';
import { RecordService } from '../../core/src/record-service.js';
import { SqliteRecordStore } from '../src/record-store.js';
import { backupWorkspace, restoreWorkspace } from '../src/backup.js';
import { createWorkspaceClient } from '../../client/src/http-client.js';
import { startServer } from '../../../apps/server/src/http-server.js';

function setup(t: Parameters<typeof fixture>[0]) {
  const data = fixture(t, null, () => new Date('2026-11-13T08:00:00Z')), store = data.open(), service = new RecordService(store);
  let table = service.createTable({ name: 'History' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Amount', type: 'number' });
  return { data, store, service, table, amount: table.fields[1]!.id };
}

test('history retains typed snapshots and atomic batches with stable bounded continuation', t => {
  const { service, table, amount } = setup(t);
  const records = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: '', [amount]: 0 } }, { values: {} }]).records;
  const first = records[0]!, second = records[1]!;
  const created = service.recordHistory(table.id, first.id, {}).changes[0]!;
  assert.equal(created.changedAt, '2026-11-13T08:00:00.000Z');
  assert.equal(created.batchId, service.recordHistory(table.id, second.id, {}).changes[0]!.batchId);
  assert.deepEqual(service.recordChange(table.id, first.id, created.id), { ...created, before: null, after: first });
  assert.throws(() => service.updateBatch([
    { id: first.id, expectedVersion: 1, values: { [amount]: 5 } },
    { id: second.id, expectedVersion: 99, values: { [amount]: 6 } },
  ], table.id), /changed/);
  assert.deepEqual(service.recordHistory(table.id, first.id, {}).changes, [created]);
  const updated = service.updateBatch([{ id: first.id, expectedVersion: 1, values: { [amount]: 5 } }], table.id).records[0]!;
  const page = service.recordHistory(table.id, first.id, { limit: 1 });
  assert.equal(page.changes.length, 1);
  assert.ok(!Object.hasOwn(page.changes[0]!, 'before'));
  const detail = service.recordChange(table.id, first.id, page.changes[0]!.id);
  assert.deepEqual(detail.before, first);
  assert.deepEqual(detail.after, updated);
  service.updateBatch([{ id: first.id, expectedVersion: 2, values: { [amount]: 6 } }], table.id);
  const next = service.recordHistory(table.id, first.id, { before: page.nextBefore, limit: 1 });
  assert.deepEqual(next.changes, [created]);
  assert.equal(next.nextBefore, undefined);
  for (const input of [{ limit: 0 }, { limit: 101 }, { before: -1 }, { before: 1.5 }, { limit: '20' }]) {
    assert.throws(() => service.recordHistory(table.id, first.id, input), /history|change ID/);
  }
  assert.throws(() => service.recordChange(table.id, second.id, detail.id), /does not exist/);
  assert.throws(() => service.recordHistory(table.id, 'missing', {}), /no stored history/);
});

test('restoring a snapshot preserves identity and later fields, validates current schema and records a new change', t => {
  const { service, table: initial, amount } = setup(t);
  let table = service.createField(initial.id, { expectedVersion: initial.version, name: 'Double', type: 'formula', formula: { expression: `[${amount}] * 2`, resultType: 'number' } });
  const formula = table.fields[2]!.id;
  const first = service.createRecords(table.id, [{ values: { [table.primaryFieldId]: 'Original', [amount]: 2 } }]).records[0]!;
  const original = service.recordHistory(table.id, first.id, {}).changes[0]!;
  service.updateBatch([{ id: first.id, expectedVersion: first.version, values: { [amount]: 3 } }], table.id);
  table = service.updateField(table.id, amount, { expectedVersion: table.version, name: 'Renamed amount' });
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Notes', type: 'text' });
  const notes = table.fields.at(-1)!.id;
  service.updateBatch([{ id: first.id, expectedVersion: 2, values: { [notes]: 'Keep later work' } }], table.id);
  table = service.updateField(table.id, formula, { expectedVersion: table.version, formula: { expression: `[${amount}] * 3`, resultType: 'number' } });
  const before = service.getRecord(table.id, first.id);
  const restored = service.restoreRecord(table.id, first.id, { changeId: original.id, snapshot: 'after', expectedVersion: before.version });
  assert.equal(restored.id, first.id);
  assert.equal(restored.version, before.version + 1);
  assert.equal(restored.values[amount], 2);
  assert.equal(restored.values[formula], 6);
  assert.equal(restored.values[notes], 'Keep later work');
  const entry = service.recordHistory(table.id, first.id, {}).changes[0]!;
  assert.deepEqual(entry.restoredFrom, { changeId: original.id, snapshot: 'after' });
  assert.deepEqual(service.recordChange(table.id, first.id, entry.id).before, before);
  assert.throws(() => service.restoreRecord(table.id, first.id, { changeId: original.id, snapshot: 'after', expectedVersion: before.version }), /changed/);
  assert.equal(service.recordHistory(table.id, first.id, {}).changes[0]!.id, entry.id);
  assert.throws(() => service.restoreRecord(table.id, first.id, { changeId: original.id, snapshot: 'before', expectedVersion: restored.version }), /does not exist in this snapshot/);
  table = service.deleteField(table.id, formula, { expectedVersion: table.version });
  table = service.deleteField(table.id, amount, { expectedVersion: table.version });
  const current = service.getRecord(table.id, first.id);
  assert.equal(Object.hasOwn(service.restoreRecord(table.id, first.id, { changeId: original.id, snapshot: 'after', expectedVersion: current.version }).values, amount), false);
});

test('defaults and restores distinguish an empty field from a field added after a snapshot', t => {
  const { service, table: initial } = setup(t);
  const name = initial.primaryFieldId;
  const [original, olderDeleted] = service.createRecords(initial.id, [{ values: { [name]: 'Original' } }, { values: {} }]).records;
  const beforeField = service.recordHistory(initial.id, original!.id, {}).changes[0]!.id;
  service.deleteRecords(initial.id, [{ id: olderDeleted!.id, expectedVersion: olderDeleted!.version }]);
  const table = service.createField(initial.id, {
    expectedVersion: initial.version, name: 'Notes', type: 'text', defaultValue: 'Pending',
  });
  const notes = table.fields.at(-1)!.id;
  assert.ok(!Object.hasOwn(service.recordChange(table.id, original!.id, beforeField).after!.values, notes));
  assert.equal(service.getRecord(table.id, original!.id).values[notes], null);
  const [defaulted, cleared] = service.createRecords(table.id, [{ values: {} }, { values: { [notes]: null } }]).records;
  assert.equal(defaulted!.values[notes], 'Pending');
  assert.equal(cleared!.values[notes], null);

  const update = (record: RowRecord, values: Record<string, CellValue>) =>
    service.updateBatch([{ id: record.id, expectedVersion: record.version, values }], table.id).records[0]!;
  const withDefault = update(defaulted!, { [name]: 'Rename' });
  assert.equal(withDefault.values[notes], 'Pending');
  assert.equal(update(withDefault, { [notes]: null }).values[notes], null);
  const renamed = update(original!, { [name]: 'Changed without notes' });
  const afterField = service.recordHistory(table.id, renamed.id, {}).changes[0]!.id;
  const snapshot = service.recordChange(table.id, renamed.id, afterField);
  assert.equal(snapshot.before!.values[notes], null);
  assert.equal(snapshot.after!.values[notes], null);

  const filled = update(renamed, { [notes]: 'Keep later work' });
  const restore = (changeId: number, expectedVersion: number) =>
    service.restoreRecord(table.id, filled.id, { changeId, snapshot: 'after', expectedVersion });
  const kept = restore(beforeField, filled.version);
  assert.equal(kept.values[notes], 'Keep later work');
  const emptied = restore(afterField, kept.version);
  assert.equal(emptied.values[notes], null);

  service.deleteRecords(table.id, [{ id: emptied.id, expectedVersion: emptied.version }]);
  const deleted = service.recordTrash(table.id, {}).records;
  const restored = service.restoreDeletedRecords(table.id, deleted).records;
  assert.equal(restored.find(record => record.id === olderDeleted!.id)!.values[notes], 'Pending');
  assert.equal(restored.find(record => record.id === emptied.id)!.values[notes], null);
});

test('schema changes capture fields according to each snapshot boundary', t => {
  const { service, table: initial, amount } = setup(t);
  const row = service.createRecords(initial.id, [{ values: { [amount]: 2 } }]).records[0]!;
  const numbered = service.createField(initial.id, { expectedVersion: initial.version, name: 'Sequence', type: 'autoNumber' });
  const sequence = numbered.fields.at(-1)!.id;
  const latest = () => {
    const [entry] = service.recordHistory(initial.id, row.id, {}).changes;
    return service.recordChange(initial.id, row.id, entry!.id);
  };
  const numbering = latest();
  assert.deepEqual(numbering.before!.values, row.values);
  assert.equal(numbering.after!.values[sequence], 1);

  let table = service.createField(numbered.id, { expectedVersion: numbered.version, name: 'Double', type: 'formula',
    formula: { expression: `[${amount}] * 2`, resultType: 'number' } });
  const formula = table.fields.at(-1)!.id;
  const calculation = latest();
  assert.deepEqual(calculation.before!.values, numbering.after!.values);
  assert.deepEqual(calculation.after!.values, { ...numbering.after!.values, [formula]: 4 });

  table = service.createField(table.id, { expectedVersion: table.version, name: 'Invalid', type: 'formula',
    formula: { expression: '1 / 0', resultType: 'number' } });
  const invalid = table.fields.at(-1)!.id;
  service.deleteField(table.id, invalid, { expectedVersion: table.version });
  const removal = latest();
  assert.equal(removal.before!.values[invalid], null);
  assert.ok(removal.before!.formulaErrors?.[invalid]);
  assert.ok(!Object.hasOwn(removal.after!.values, invalid));
  assert.equal(removal.after!.formulaErrors?.[invalid], undefined);
});

test('restoration fails atomically for current required fields and missing linked targets', t => {
  const { service, table: initial, amount } = setup(t);
  const row = service.createRecords(initial.id, [{ values: {} }]).records[0]!;
  const original = service.recordHistory(initial.id, row.id, {}).changes[0]!;
  service.updateBatch([{ id: row.id, expectedVersion: 1, values: { [amount]: 2 } }], initial.id);
  let table = service.updateField(initial.id, amount, { expectedVersion: initial.version, required: true });
  const history = service.recordHistory(table.id, row.id, {});
  assert.throws(() => service.restoreRecord(table.id, row.id, { changeId: original.id, snapshot: 'after', expectedVersion: 2 }), /required/);
  assert.deepEqual(service.recordHistory(table.id, row.id, {}), history);
  const target = service.createTable({ name: 'Targets' });
  const linked = service.createRecords(target.id, [{ values: {} }]).records[0]!;
  table = service.createField(table.id, { expectedVersion: table.version, name: 'Link', type: 'relation', relation: { tableId: target.id, multiple: false } });
  const link = table.fields.at(-1)!.id;
  service.updateBatch([{ id: row.id, expectedVersion: 2, values: { [link]: [linked.id] } }], table.id);
  const linkedState = service.recordHistory(table.id, row.id, {}).changes[0]!;
  service.updateBatch([{ id: row.id, expectedVersion: 3, values: { [link]: [] } }], table.id);
  service.deleteRecords(target.id, [{ id: linked.id, expectedVersion: 1 }]);
  const before = service.getRecord(table.id, row.id), beforeHistory = service.recordHistory(table.id, row.id, {});
  assert.throws(() => service.restoreRecord(table.id, row.id, { changeId: linkedState.id, snapshot: 'after', expectedVersion: before.version }), /does not exist in the target/);
  assert.deepEqual(service.getRecord(table.id, row.id), before);
  assert.deepEqual(service.recordHistory(table.id, row.id, {}), beforeHistory);
});

test('reciprocal and connected formula writes share one batch and coalesce intermediate record versions', t => {
  const { service, table: items, amount } = setup(t);
  const item = service.createRecords(items.id, [{ values: { [amount]: 10 } }]).records[0]!;
  let orders = service.createTable({ name: 'Orders' });
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Items', type: 'relation', relation: { tableId: items.id, multiple: true },
    reverseField: { name: 'Orders', multiple: true, expectedVersion: items.version } });
  const link = orders.fields[1]!.id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Total', type: 'lookup', lookup: { relationFieldId: link, fieldId: amount, operation: 'sum' } });
  const total = orders.fields[2]!.id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Double', type: 'formula', formula: { expression: `[${total}] * 2`, resultType: 'number' } });
  const double = orders.fields[3]!.id;
  orders = service.createField(orders.id, { expectedVersion: orders.version, name: 'Triple', type: 'formula', formula: { expression: `[${double}] * 3`, resultType: 'number' } });
  const triple = orders.fields[4]!.id;
  const order = service.createRecords(orders.id, [{ values: { [link]: [item.id] } }]).records[0]!;
  const created = service.recordHistory(orders.id, order.id, {}).changes;
  assert.equal(created.length, 1);
  assert.equal(created[0]!.batchId, service.recordHistory(items.id, item.id, {}).changes[0]!.batchId);
  const snapshot = service.recordChange(orders.id, order.id, created[0]!.id).after!;
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.values[triple], 60);
  assert.equal(Object.hasOwn(snapshot.values, total), false);
  service.updateBatch([{ id: item.id, expectedVersion: service.getRecord(items.id, item.id).version, values: { [amount]: 30 } }], items.id);
  const latest = service.recordHistory(orders.id, order.id, {}).changes;
  assert.equal(latest.length, 2);
  assert.equal(latest[0]!.batchId, service.recordHistory(items.id, item.id, {}).changes[0]!.batchId);
  assert.equal(service.recordChange(orders.id, order.id, latest[0]!.id).after!.values[triple], 180);
  const change = service.recordHistory(items.id, item.id, {}).changes[0]!;
  service.restoreRecord(items.id, item.id, { changeId: change.id, snapshot: 'before', expectedVersion: service.getRecord(items.id, item.id).version });
  assert.equal(service.getRecord(orders.id, order.id).values[triple], 60);
  assert.deepEqual(service.recordHistory(orders.id, order.id, {}).changes[0]!.restoredFrom, { changeId: change.id, snapshot: 'before' });
});

test('History survives restart and backup and retains deletion snapshots', async t => {
  const { data, store, service, table, amount } = setup(t);
  const row = service.createRecords(table.id, [{ values: { [amount]: 1 } }]).records[0]!;
  service.updateBatch([{ id: row.id, expectedVersion: 1, values: { [amount]: 2 } }], table.id);
  const snapshotPath = join(dirname(data.path), 'history-backup.sqlite'), restoredPath = join(dirname(data.path), 'history-restored.sqlite');
  await backupWorkspace(data.path, snapshotPath);
  await restoreWorkspace(snapshotPath, restoredPath);
  const restoredStore = new SqliteRecordStore(restoredPath);
  try {
    const restored = new RecordService(restoredStore);
    assert.deepEqual(restored.recordHistory(table.id, row.id, {}), service.recordHistory(table.id, row.id, {}));
    const change = restored.recordHistory(table.id, row.id, {}).changes[0]!;
    assert.equal(restored.restoreRecord(table.id, row.id, { changeId: change.id, snapshot: 'before', expectedVersion: 2 }).values[amount], 1);
  } finally { restoredStore.close(); }
  service.deleteRecords(table.id, [{ id: row.id, expectedVersion: 2 }]);
  store.close();
  const reopenedStore = data.open(), reopened = new RecordService(reopenedStore);
  const deletion = reopened.recordHistory(table.id, row.id, {}).changes[0]!;
  assert.equal(deletion.afterVersion, null);
  assert.equal(reopened.recordChange(table.id, row.id, deletion.id).before!.values[amount], 2);
  reopened.deleteTable(table.id, { expectedVersion: table.version });
  reopenedStore.close();
});

test('HTTP and SDK share history paging, snapshot restore and stale-write rejection', async t => {
  const { service, table, amount } = setup(t);
  const token = randomBytes(32).toString('hex'), server = await startServer({ service, token });
  t.after(() => server.close());
  const api = createWorkspaceClient({ url: server.url, token });
  const row = (await api.createRecords(table.id, [{ values: { [amount]: 10 } }])).records[0]!;
  await api.updateRecords(table.id, [{ id: row.id, expectedVersion: 1, values: { [amount]: 20 } }]);
  const page = await api.recordHistory(table.id, row.id, { limit: 1 });
  const change = await api.recordChange(table.id, row.id, page.changes[0]!.id);
  const input = { changeId: change.id, snapshot: 'before' as const, expectedVersion: 2 };
  const restored = await api.restoreRecord(table.id, row.id, input);
  assert.equal(restored.id, row.id);
  assert.equal(restored.version, 3);
  assert.equal(restored.values[amount], 10);
  await assert.rejects(api.restoreRecord(table.id, row.id, input), { code: 'VERSION_CONFLICT' });
  assert.equal((await api.recordHistory(table.id, row.id, { before: page.nextBefore! })).changes.length, 1);
  await assert.rejects(api.recordHistory(table.id, row.id, { limit: 101 }), { code: 'INVALID_HISTORY' });
});

test('CSV, schema conversion and separate service connections retain independent committed batches', t => {
  const { data, service, table, amount } = setup(t);
  service.importCsv(table.id, { expectedVersion: table.version, hasHeader: true, csv: 'Name,Amount\r\nOne,1\r\nTwo,2\r\n' });
  const [first, second] = service.queryRecords(table.id, {}).records;
  const created = service.recordHistory(table.id, first!.id, {}).changes[0]!;
  assert.equal(created.batchId, service.recordHistory(table.id, second!.id, {}).changes[0]!.batchId);
  const other = new RecordService(data.open());
  const change = other.updateBatch([{ id: first!.id, expectedVersion: 1, values: { [amount]: 4 } }], table.id).records[0]!;
  assert.equal(service.recordChange(table.id, first!.id, service.recordHistory(table.id, first!.id, {}).changes[0]!.id).after!.values[amount], 4);
  assert.throws(() => service.restoreRecord(table.id, first!.id, { changeId: created.id, snapshot: 'after', expectedVersion: 1 }), /changed/);
  const restored = service.restoreRecord(table.id, first!.id, { changeId: created.id, snapshot: 'after', expectedVersion: change.version });
  assert.equal(other.getRecord(table.id, first!.id).version, restored.version);
  const converted = other.applyConversion(table.id, amount, { expectedVersion: table.version, field: { name: 'Amount text', type: 'text' } });
  const latest = service.recordHistory(table.id, first!.id, {}).changes[0]!;
  const snapshot = service.recordChange(table.id, first!.id, latest.id);
  assert.equal(snapshot.before!.values[amount], 1);
  assert.equal(snapshot.after!.values[amount], '1');
  const currentHistory = service.recordHistory(table.id, first!.id, {});
  assert.throws(() => service.restoreRecord(table.id, first!.id, { changeId: created.id, snapshot: 'after', expectedVersion: snapshot.after!.version }), /use text/);
  assert.deepEqual(other.recordHistory(table.id, first!.id, {}), currentHistory);
  assert.equal(service.getTable(table.id).version, converted.version);
});
