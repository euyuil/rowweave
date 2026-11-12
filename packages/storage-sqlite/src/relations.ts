import type { DatabaseSync } from 'node:sqlite';
import type { CellValue, Field, RowRecord, Table } from '../../contracts/src/index.js';
import { ServiceError } from '../../core/src/errors.js';
import { fieldText } from '../../core/src/field-display.js';

export class Relations {
  constructor(private readonly db: DatabaseSync) {}

  validateSchema(table: Table, before: Table): void {
    if (table.fields.find(field => field.id === table.primaryFieldId)!.type === 'relation') {
      throw new ServiceError('INVALID_SCHEMA', 'Use a non-linked field as the primary display value.');
    }
    for (const field of table.fields.filter(field => field.type === 'relation')) {
      if (!this.db.prepare('SELECT 1 FROM tables WHERE id = ?').get(field.relation!.tableId)) {
        throw new ServiceError('INVALID_SCHEMA', `${field.name}: the target table does not exist.`);
      }
      const previous = before.fields.find(item => item.id === field.id);
      if (previous?.relation?.tableId !== field.relation!.tableId &&
          this.db.prepare('SELECT 1 FROM relation_edges WHERE field_id = ? LIMIT 1').get(field.id)) {
        throw new ServiceError('RELATION_DEPENDENCY', 'Remove existing links before changing their target table.', 409);
      }
      this.validateTargets(field, field.defaultValue ?? null);
    }
  }

  syncFields(table: Table): void {
    const write = this.db.prepare(`INSERT INTO field_relations VALUES (?, ?) ON CONFLICT(field_id)
      DO UPDATE SET target_table_id = excluded.target_table_id`);
    for (const field of table.fields.filter(field => field.type === 'relation')) write.run(field.id, field.relation!.tableId);
  }

  validateTargets(field: Field, value: CellValue): void {
    const ids = (value ?? []) as string[];
    if (!ids.length) return;
    const rows = this.db.prepare(`SELECT id FROM records WHERE table_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .all(field.relation!.tableId, JSON.stringify(ids));
    const found = new Set(rows.map(row => row['id']));
    const missing = ids.find(id => !found.has(id));
    if (missing) throw new ServiceError('INVALID_LINK', `${field.name}: record ${missing} does not exist in the target table.`);
  }

  write(table: Table, recordId: string, values: Record<string, CellValue>): void {
    const fields = table.fields.filter(field => field.type === 'relation' && Object.hasOwn(values, field.id));
    if (!fields.length) return;
    const remove = this.db.prepare('DELETE FROM relation_edges WHERE source_record_id = ? AND field_id = ?');
    const insert = this.db.prepare('INSERT INTO relation_edges VALUES (?, ?, ?, ?)');
    for (const field of fields) {
      const value = values[field.id]!;
      this.validateTargets(field, value);
      remove.run(recordId, field.id);
      for (const [position, id] of ((value ?? []) as string[]).entries()) insert.run(recordId, field.id, id, position);
    }
  }

  hydrate(table: Table, records: RowRecord[]): RowRecord[] {
    const fields = table.fields.filter(field => field.type === 'relation');
    if (!fields.length || !records.length) return records;
    const primary = new Map(this.db.prepare(`SELECT t.id, f.definition_json FROM tables t
      JOIN fields f ON f.id = t.primary_field_id WHERE t.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(fields.map(field => field.relation!.tableId)))
      .map(row => [row['id'] as string, JSON.parse(row['definition_json'] as string) as Field]));
    const byId = new Map(records.map(record => {
      record.links = Object.fromEntries(fields.map(field => [field.id, []]));
      return [record.id, record];
    }));
    const edges = this.db.prepare(`SELECT e.source_record_id, e.field_id, target.id, target.table_id,
      target.values_json -> ('$.' || json_quote(t.primary_field_id)) AS value_json
      FROM relation_edges e JOIN records target ON target.id = e.target_record_id
      JOIN tables t ON t.id = target.table_id
      WHERE e.source_record_id IN (SELECT value FROM json_each(?)) AND e.field_id IN (SELECT value FROM json_each(?))
      ORDER BY e.source_record_id, e.field_id, e.position`)
      .all(JSON.stringify(records.map(record => record.id)), JSON.stringify(fields.map(field => field.id)));
    for (const edge of edges) {
      const value = JSON.parse(edge['value_json'] as string ?? 'null') as CellValue;
      byId.get(edge['source_record_id'] as string)!.links![edge['field_id'] as string]!.push({
        id: edge['id'] as string, label: fieldText(primary.get(edge['table_id'] as string)!, value),
      });
    }
    return records;
  }

  bumpRevision(tableId: string): void {
    this.db.prepare(`UPDATE tables SET revision = revision + 1 WHERE id = ? OR id IN (
      SELECT f.table_id FROM field_relations rel JOIN fields f ON f.id = rel.field_id WHERE rel.target_table_id = ?)`)
      .run(tableId, tableId);
  }

  deleteTable(tableId: string): void {
    if (this.db.prepare(`SELECT 1 FROM field_relations rel JOIN fields f ON f.id = rel.field_id
      WHERE rel.target_table_id = ? AND f.table_id <> ? LIMIT 1`).get(tableId, tableId)) {
      throw new ServiceError('RELATION_DEPENDENCY', 'Remove linked fields in other tables before deleting this table.', 409);
    }
    this.db.prepare('DELETE FROM field_relations WHERE field_id IN (SELECT id FROM fields WHERE table_id = ?)').run(tableId);
  }

  deleteRecords(ids: string[]): void {
    const selected = JSON.stringify(ids);
    if (this.db.prepare(`SELECT 1 FROM fields f, json_each(f.definition_json, '$.defaultValue') choice
      WHERE json_extract(f.definition_json, '$.type') = 'relation'
      AND choice.value IN (SELECT value FROM json_each(?)) LIMIT 1`).get(selected)) {
      throw new ServiceError('RELATION_DEPENDENCY', 'Remove linked-field defaults before deleting these records.', 409);
    }
    this.db.prepare('DELETE FROM relation_edges WHERE source_record_id IN (SELECT value FROM json_each(?))').run(selected);
    if (this.db.prepare('SELECT 1 FROM relation_edges WHERE target_record_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(selected)) {
      throw new ServiceError('RELATION_DEPENDENCY', 'Unlink these records from other records before deleting them.', 409);
    }
  }
}
