import type { DatabaseSync } from 'node:sqlite';
import type { CheckedQuery } from '../../core/src/record-query.js';
import type { querySql } from './query-sql.js';

export interface StoredRecord {
  id: string;
  version: number;
  values_json: string;
  formula_errors_json: string;
}

export function queryPage(db: DatabaseSync, sql: ReturnType<typeof querySql>, query: Pick<CheckedQuery, 'limit' | 'offset'>) {
  const parameters = { ...sql.parameters, ':limit': query.limit, ':offset': query.offset };
  if (!sql.computed.length) {
    const total = db.prepare(`SELECT COUNT(*) AS total FROM records r WHERE ${sql.where}`).get(sql.countParameters)!['total'] as number;
    const rows = db.prepare(`SELECT r.id, r.version, r.values_json, r.formula_errors_json FROM records r WHERE ${sql.where}
      ORDER BY ${sql.order} LIMIT :limit OFFSET :offset`).all(parameters) as unknown as StoredRecord[];
    return { total, rows };
  }
  // Share expensive linked values between filtering, sorting and counting within this read snapshot.
  const result = db.prepare(`WITH input AS MATERIALIZED (
      SELECT r.*, ${sql.computed.map(column => `${column.expression} AS ${column.name}`).join(', ')}
      FROM records r WHERE ${sql.sourceWhere}
    ), matched AS MATERIALIZED (SELECT * FROM input r WHERE ${sql.where}),
    page AS (SELECT * FROM matched r ORDER BY ${sql.order} LIMIT :limit OFFSET :offset)
    SELECT totals.total, r.id, r.version, r.values_json, r.formula_errors_json
    FROM (SELECT COUNT(*) AS total FROM matched) totals LEFT JOIN page r ON 1 ORDER BY ${sql.order}`).all(parameters);
  // The left join retains the complete count even when the requested page is empty.
  return { total: result[0]!['total'] as number, rows: result.filter(row => row['id'] !== null) as unknown as StoredRecord[] };
}
