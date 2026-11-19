import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { valueField, type CellValue, type Field, type Table } from '../../contracts/src/index.js';

type RecordSchema = Pick<Table, 'id' | 'fields'>;
type RecordValues = Record<string, CellValue>;

export const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const recordTable = identifier;
export const recordSource = (id: string) => identifier(`rowweave_rows_${id}`);
export const fieldColumn = (id: string, alias = '') => `${alias ? `${alias}.` : ''}${identifier(id)}`;
export const fieldPath = (id: string) => '$.' + JSON.stringify(id);

const stored = (fields: Field[]) => fields.filter(field => field.type !== 'lookup' && field.type !== 'relation');

export function cellBinding(value: CellValue | undefined): SQLInputValue {
  // JSON strings preserve lone UTF-16 surrogates that SQLite's UTF-8 binding replaces.
  if (Array.isArray(value) || (typeof value === 'string' && /[\uD800-\uDFFF]/u.test(value))) {
    return Buffer.from(JSON.stringify(value));
  }
  if (typeof value === 'boolean') return value ? 1n : 0n;
  return value ?? null;
}

// A STRICT ANY column preserves REAL for numbers, INTEGER for booleans and BLOB for arrays.
export function cellJson(column: string): string {
  return `CASE typeof(${column}) WHEN 'integer' THEN CASE ${column} WHEN 0 THEN 'false' ELSE 'true' END
    WHEN 'blob' THEN CAST(${column} AS TEXT) ELSE json_quote(${column}) END`;
}

export function scalarColumn(field: Field, alias = ''): string {
  const column = fieldColumn(field.id, alias);
  const type = valueField(field).type;
  if (['multiSelect', 'attachment'].includes(type)) return `CAST(${column} AS TEXT)`;
  if (['text', 'multiline', 'singleSelect', 'url'].includes(type)) {
    return `(CASE WHEN typeof(${column}) = 'blob' THEN json_extract(CAST(${column} AS TEXT), '$') ELSE ${column} END)`;
  }
  return column;
}

function valuesJson(fields: Field[], alias: string): string {
  const entries = fields.filter(field => field.type !== 'lookup').map((field, index) => {
    const key = literal((index === 0 ? '' : ',') + JSON.stringify(field.id) + ':');
    if (field.type === 'relation') {
      return `${key} || (SELECT json_group_array(edge.target_record_id ORDER BY edge.position)
        FROM relation_edges edge WHERE edge.source_record_id = ${alias}.id AND edge.field_id = ${literal(field.id)})`;
    }
    return `${key} || (${cellJson(fieldColumn(field.id, alias))})`;
  });
  return entries.length ? `'{' || ${entries.join(' || ')} || '}'` : "'{}'";
}

const historyTrigger = (id: string, event: string) => identifier(`rowweave_history_${event.toLowerCase()}_${id}`);
const historyEvents = ['INSERT', 'UPDATE', 'DELETE'];

function writeProjection(db: DatabaseSync, table: RecordSchema): void {
  const physical = recordTable(table.id);
  const owner = literal(table.id);
  db.exec(`CREATE VIEW ${recordSource(table.id)} AS SELECT p.*, ${valuesJson(table.fields, 'p')} AS values_json FROM ${physical} p`);
  for (const event of historyEvents) {
    const previous = event === 'INSERT' ? 'NULL, NULL, NULL' : `OLD.version, ${valuesJson(table.fields, 'OLD')}, OLD.formula_errors_json`;
    const next = event === 'DELETE' ? 'NULL, NULL, NULL' : `NEW.version, ${valuesJson(table.fields, 'NEW')}, NEW.formula_errors_json`;
    const record = event === 'DELETE' ? 'OLD' : 'NEW';
    db.exec(`CREATE TRIGGER ${historyTrigger(table.id, event)} AFTER ${event} ON ${physical}
      WHEN EXISTS (SELECT 1 FROM record_change_context) AND EXISTS (SELECT 1 FROM tables WHERE id = ${owner})
      BEGIN INSERT INTO record_changes (batch_id, table_id, record_id, changed_at, before_version, before_values_json, before_errors_json,
        after_version, after_values_json, after_errors_json, restored_from, restored_snapshot)
      SELECT batch_id, ${owner}, ${record}.id, changed_at, ${previous}, ${next}, restored_from, restored_snapshot
        FROM record_change_context WHERE 1
      ON CONFLICT(batch_id, record_id) DO UPDATE SET after_version = excluded.after_version,
        after_values_json = excluded.after_values_json, after_errors_json = excluded.after_errors_json;
      END;`);
  }
}

export function createRecordTable(db: DatabaseSync, table: RecordSchema): void {
  const id = literal(table.id);
  const columns = stored(table.fields).map(field => `${fieldColumn(field.id)} ANY`);
  db.exec(`CREATE TABLE ${recordTable(table.id)} (
    id TEXT PRIMARY KEY, table_id TEXT GENERATED ALWAYS AS (${id}) VIRTUAL NOT NULL,
    position INTEGER NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1,
    formula_errors_json TEXT NOT NULL DEFAULT '{}',
    ${columns.length ? columns.join(', ') + ',' : ''}
    FOREIGN KEY(id, table_id) REFERENCES record_ids(id, table_id) ON DELETE CASCADE
  ) STRICT`);
  writeProjection(db, table);
}

export function changeRecordColumns(db: DatabaseSync, before: RecordSchema, after: RecordSchema): void {
  const oldIds = stored(before.fields).map(field => field.id);
  const newIds = stored(after.fields).map(field => field.id);
  const removed = oldIds.filter(id => !newIds.includes(id));
  const added = newIds.filter(id => !oldIds.includes(id));
  const oldRelations = before.fields.filter(field => field.type === 'relation').map(field => field.id);
  const newRelations = after.fields.filter(field => field.type === 'relation').map(field => field.id);
  const removedRelations = oldRelations.filter(id => !newRelations.includes(id));
  if (!removed.length && !added.length && !removedRelations.length && newRelations.every(id => oldRelations.includes(id))) return;
  const physical = recordTable(before.id);
  // Capture the removal while the old projection and history triggers can still see the column.
  for (const id of removed) {
    const column = fieldColumn(id);
    db.prepare(`UPDATE ${physical} SET version = version + 1 WHERE ${column} IS NOT NULL`).run();
  }
  for (const id of removedRelations) {
    db.prepare(`UPDATE ${physical} SET version = version + 1
      WHERE id IN (SELECT source_record_id FROM relation_edges WHERE field_id = ?)`).run(id);
    db.prepare('DELETE FROM relation_edges WHERE field_id = ?').run(id);
  }
  db.exec(`DROP VIEW ${recordSource(before.id)}`);
  for (const event of historyEvents) db.exec(`DROP TRIGGER ${historyTrigger(before.id, event)}`);
  for (const id of removed) db.exec(`ALTER TABLE ${physical} DROP COLUMN ${fieldColumn(id)}`);
  for (const id of added) db.exec(`ALTER TABLE ${physical} ADD COLUMN ${fieldColumn(id)} ANY`);
  writeProjection(db, after);
  if (removed.length || removedRelations.length) refreshHistoryValues(db, before.id);
}

export function dropRecordTable(db: DatabaseSync, id: string): void {
  db.exec(`DROP VIEW ${recordSource(id)}; DROP TABLE ${recordTable(id)}`);
}

// Touch the business row before replacing edges so the history trigger sees the original links.
export function touchRelationRecords(db: DatabaseSync, tableId: string, ids: readonly string[], increment: 0 | 1): void {
  if (!ids.length) return;
  db.prepare(`UPDATE ${recordTable(tableId)} SET version = version + ?
    WHERE id IN (SELECT value FROM json_each(?))`).run(increment, JSON.stringify(ids));
}

// The first row trigger preserves the before snapshot. Refresh the after snapshot after changing fields or edges.
export function refreshHistoryValues(db: DatabaseSync, tableId: string, ids?: readonly string[]): void {
  if (ids?.length === 0) return;
  const selected = ids ? ' AND record_id IN (SELECT value FROM json_each(?))' : '';
  db.prepare(`UPDATE record_changes AS change SET after_values_json = (
      SELECT values_json FROM ${recordSource(tableId)} WHERE id = change.record_id
    ) WHERE table_id = ? AND batch_id = (SELECT batch_id FROM record_change_context)
      AND after_version IS NOT NULL${selected}`).run(tableId, ...(ids ? [JSON.stringify(ids)] : []));
}

export function recordInsert(db: DatabaseSync, table: RecordSchema) {
  const fields = stored(table.fields);
  const identify = db.prepare('INSERT INTO record_ids (id, table_id) VALUES (?, ?)');
  const columns = ['id', 'position', 'version', 'formula_errors_json', ...fields.map(field => fieldColumn(field.id))];
  const insert = db.prepare(`INSERT INTO ${recordTable(table.id)} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  return (id: string, position: number, values: RecordValues, version = 1, errors = '{}') => {
    identify.run(id, table.id);
    insert.run(id, position, version, errors, ...fields.map(field => cellBinding(values[field.id])));
  };
}

export function recordUpdate(db: DatabaseSync, table: RecordSchema) {
  const fields = stored(table.fields);
  const assignments = ['version = version + ?', 'formula_errors_json = COALESCE(?, formula_errors_json)',
    ...fields.map(field => `${fieldColumn(field.id)} = ?`)];
  const update = db.prepare(`UPDATE ${recordTable(table.id)} SET ${assignments.join(', ')} WHERE id = ?`);
  return (id: string, values: RecordValues, increment = 1, errors: string | null = null) =>
    update.run(increment, errors, ...fields.map(field => cellBinding(values[field.id])), id);
}

export function recordPatch(db: DatabaseSync, tableId: string, fields: string[]) {
  const assignments = ['version = version + ?', ...fields.map(id => `${fieldColumn(id)} = ?`)];
  const update = db.prepare(`UPDATE ${recordTable(tableId)} SET ${assignments.join(', ')} WHERE id = ?`);
  return (id: string, values: RecordValues, increment: number) =>
    update.run(increment, ...fields.map(field => cellBinding(values[field])), id);
}
