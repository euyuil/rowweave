import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FieldFilter, FilterGroup, Table, ViewQuery } from '../../contracts/src/index.js';
import { querySql } from './query-sql.js';

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const prefix = (tableId: string) => `rowweave_view_${tableId}_`;

type IndexedQuery = ViewQuery & { groupBy?: string };

function definition(table: Pick<Table, 'id' | 'fields'>, query: IndexedQuery): string | undefined {
  // Index the grouped order independently of filters, including temporary searches.
  if (query.groupBy) query = { groupBy: query.groupBy, ...(query.sort ? { sort: query.sort } : {}) };
  const fields = new Map(table.fields.map(field => [field.id, field]));
  const conditions: FieldFilter[] = [];
  const visit = (group: FilterGroup) => {
    for (const condition of group.conditions) {
      if ('conjunction' in condition) visit(condition);
      else conditions.push(condition);
    }
  };
  if (query.filter) visit(query.filter);
  if (!conditions.length && !query.sort?.length && !query.search && !query.groupBy) return;
  // SQLite expression/partial indexes cannot contain subqueries or read another table.
  if (conditions.some(condition => condition.operator === 'hasAny' || condition.operator === 'relativeDate' || ['relation', 'lookup'].includes(fields.get(condition.fieldId)!.type))) return;
  if (query.sort?.some(sort => ['relation', 'lookup', 'multiSelect'].includes(fields.get(sort.fieldId)!.type))) return;
  if (query.search && table.fields.some(field => ['relation', 'lookup', 'multiSelect'].includes(field.type))) return;
  const sql = querySql(table, { ...query, offset: 0, limit: 1 }, new Map(), true);
  return `ON records(table_id, ${sql.order}) WHERE ${sql.where}`;
}

export function syncQueryIndexes(db: DatabaseSync, table: Pick<Table, 'id' | 'fields'>, queries: readonly IndexedQuery[]): void {
  const desired = new Map<string, string>();
  for (const query of queries) {
    const sql = definition(table, query);
    if (sql) desired.set(prefix(table.id) + createHash('sha256').update(sql).digest('hex'), sql);
  }
  const existing = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND substr(name, 1, ?) = ?")
    .all(prefix(table.id).length, prefix(table.id)).map(row => row['name'] as string));
  let changed = false;
  for (const [name, sql] of desired) {
    if (existing.has(name)) continue;
    db.exec(`CREATE INDEX ${identifier(name)} ${sql}`);
    changed = true;
  }
  for (const name of existing) {
    if (desired.has(name)) continue;
    db.exec(`DROP INDEX ${identifier(name)}`);
    changed = true;
  }
  // Refresh the table's existing index statistics too, so unknown row counts do not defeat the new indexes.
  if (changed) db.exec('ANALYZE records');
}
