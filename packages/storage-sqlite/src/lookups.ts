import type { DatabaseSync } from 'node:sqlite';
import type { CellValue, Field, RowRecord, Table } from '../../contracts/src/index.js';
import { ServiceError } from '../../core/src/errors.js';

export function lookupSql(field: Field, alias = 'r'): string {
  const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const path = literal(`$.${JSON.stringify(field.lookup!.fieldId)}`);
  const multi = field.lookupResult!.type === 'multiSelect';
  return `(SELECT json_group_array(${multi ? 'item' : 'json(item)'}) FROM (
    SELECT ${multi ? 'choice.value' : `target.values_json -> ${path}`} AS item
    FROM relation_edges edge JOIN records target ON target.id = edge.target_record_id
    ${multi ? `JOIN json_each(json_extract(target.values_json, ${path})) choice` : ''}
    WHERE edge.source_record_id = ${alias}.id AND edge.field_id = ${literal(field.lookup!.relationFieldId)}
    ORDER BY edge.position${multi ? ', CAST(choice.key AS INTEGER)' : ''}))`;
}

export class Lookups {
  constructor(private readonly db: DatabaseSync) {}

  resolve(table: Table): Table {
    const ids = table.fields.filter(field => field.type === 'lookup').map(field => field.id);
    if (!ids.length) return table;
    const definitions = new Map(this.db.prepare(`SELECT l.field_id, f.definition_json FROM field_lookups l
      JOIN fields f ON f.id = l.target_field_id WHERE l.field_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)).map(row => [row['field_id'] as string, JSON.parse(row['definition_json'] as string) as Field]));
    table.fields = table.fields.map(field => field.type === 'lookup' ? { ...field, lookupResult: definitions.get(field.id)! } : field);
    return table;
  }

  validateSchema(table: Table, before: Table): void {
    if (table.fields.find(field => field.id === table.primaryFieldId)!.type === 'lookup') {
      throw new ServiceError('INVALID_SCHEMA', 'A lookup cannot be the primary display field.');
    }
    const removed = before.fields.filter(field => !table.fields.some(next => next.id === field.id)).map(field => field.id);
    if (removed.length && this.db.prepare(`SELECT 1 FROM field_lookups WHERE
      (relation_field_id IN (SELECT value FROM json_each(?)) OR target_field_id IN (SELECT value FROM json_each(?)))
      AND field_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`).get(JSON.stringify(removed), JSON.stringify(removed), JSON.stringify(removed))) {
      throw new ServiceError('LOOKUP_DEPENDENCY', 'Remove dependent lookup fields before deleting this field.', 409);
    }
    for (const previous of before.fields) {
      const next = table.fields.find(field => field.id === previous.id);
      if (next && next.type !== previous.type && this.db.prepare('SELECT 1 FROM field_lookups WHERE target_field_id = ? LIMIT 1').get(previous.id)) {
        throw new ServiceError('LOOKUP_DEPENDENCY', 'Remove dependent lookup fields before converting this field.', 409);
      }
    }
    for (const field of table.fields.filter(field => field.type === 'lookup')) {
      const relation = table.fields.find(source => source.id === field.lookup!.relationFieldId);
      if (relation?.type !== 'relation') throw new ServiceError('INVALID_SCHEMA', `${field.name}: choose a linked-record field in this table.`);
      const row = this.db.prepare('SELECT definition_json FROM fields WHERE id = ? AND table_id = ?')
        .get(field.lookup!.fieldId, relation.relation!.tableId);
      const target = relation.relation!.tableId === table.id ? table.fields.find(target => target.id === field.lookup!.fieldId)
        : row ? JSON.parse(row['definition_json'] as string) as Field : undefined;
      if (!target || target.type === 'relation' || target.type === 'lookup') {
        throw new ServiceError('INVALID_SCHEMA', `${field.name}: choose a non-linked, non-lookup field in the target table.`);
      }
      field.lookupResult = target;
    }
  }

  sync(table: Table): void {
    const write = this.db.prepare(`INSERT INTO field_lookups VALUES (?, ?, ?) ON CONFLICT(field_id)
      DO UPDATE SET relation_field_id = excluded.relation_field_id, target_field_id = excluded.target_field_id`);
    for (const field of table.fields.filter(field => field.type === 'lookup')) write.run(field.id, field.lookup!.relationFieldId, field.lookup!.fieldId);
  }

  hydrate(table: Table, records: RowRecord[], output?: string[]): RowRecord[] {
    const fields = table.fields.filter(field => field.type === 'lookup' && (!output || output.includes(field.id)));
    if (!fields.length || !records.length) return records;
    const rows = this.db.prepare(`SELECT r.id, ${fields.map((field, index) => `${lookupSql(field)} AS value_${index}`).join(', ')}
      FROM records r WHERE r.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(records.map(record => record.id)));
    const byId = new Map(records.map(record => [record.id, record]));
    for (const row of rows) {
      const record = byId.get(row['id'] as string)!;
      fields.forEach((field, index) => { record.values[field.id] = JSON.parse(row[`value_${index}`] as string) as CellValue; });
    }
    return records;
  }

  dependents(tableId: string): string[] {
    return this.db.prepare(`SELECT DISTINCT source.table_id FROM field_lookups l
      JOIN fields target ON target.id = l.target_field_id JOIN fields source ON source.id = l.field_id
      WHERE target.table_id = ?`).all(tableId).map(row => row['table_id'] as string);
  }

  deleteTable(tableId: string): void {
    this.db.prepare('DELETE FROM field_lookups WHERE field_id IN (SELECT id FROM fields WHERE table_id = ?)').run(tableId);
  }
}
