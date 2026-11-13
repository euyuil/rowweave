import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CellValue, RecordChange, RecordChangeDetail, RecordHistoryPage, RecordHistoryQuery, RecordRestore, RowRecord, RecordTrashPage, Table } from '../../contracts/src/index.js';
import { ServiceError } from '../../core/src/errors.js';

const metadata = 'id, batch_id, record_id, changed_at, before_version, after_version, restored_from, restored_snapshot';

function change(row: Record<string, unknown>): RecordChange {
  return { id: row['id'] as number, batchId: row['batch_id'] as string, recordId: row['record_id'] as string,
    changedAt: row['changed_at'] as string, beforeVersion: row['before_version'] as number | null, afterVersion: row['after_version'] as number | null,
    ...(row['restored_from'] === null ? {} : { restoredFrom: { changeId: row['restored_from'] as number, snapshot: row['restored_snapshot'] as 'before' | 'after' } }) };
}

function snapshot(row: Record<string, unknown>, side: 'before' | 'after'): RowRecord | null {
  if (row[`${side}_version`] === null) return null;
  const errors = JSON.parse(row[`${side}_errors_json`] as string) as Record<string, string>;
  return { id: row['record_id'] as string, version: row[`${side}_version`] as number,
    values: JSON.parse(row[`${side}_values_json`] as string) as Record<string, CellValue>,
    ...(Object.keys(errors).length ? { formulaErrors: errors } : {}) };
}

export class RecordHistory {
  constructor(private readonly db: DatabaseSync) {
    // Connection-local context records every service write, including indirect formula and relationship changes.
    db.exec(`CREATE TEMP TABLE record_change_context (batch_id TEXT NOT NULL, changed_at TEXT NOT NULL, restored_from INTEGER, restored_snapshot TEXT);`);
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const previous = event === 'INSERT' ? 'NULL, NULL, NULL' : 'OLD.version, OLD.values_json, OLD.formula_errors_json';
      const next = event === 'DELETE' ? 'NULL, NULL, NULL' : 'NEW.version, NEW.values_json, NEW.formula_errors_json';
      const record = event === 'DELETE' ? 'OLD' : 'NEW';
      db.exec(`CREATE TEMP TRIGGER record_history_${event.toLowerCase()} AFTER ${event} ON main.records
        WHEN EXISTS (SELECT 1 FROM record_change_context) AND EXISTS (SELECT 1 FROM tables WHERE id = ${record}.table_id)
        BEGIN INSERT INTO record_changes (batch_id, table_id, record_id, changed_at, before_version, before_values_json, before_errors_json,
          after_version, after_values_json, after_errors_json, restored_from, restored_snapshot)
        SELECT batch_id, ${record}.table_id, ${record}.id, changed_at, ${previous}, ${next}, restored_from, restored_snapshot
          FROM record_change_context WHERE 1
        ON CONFLICT(batch_id, record_id) DO UPDATE SET after_version = excluded.after_version,
          after_values_json = excluded.after_values_json, after_errors_json = excluded.after_errors_json;
        END;`);
    }
  }

  begin(changedAt: string, restore?: Pick<RecordRestore, 'changeId' | 'snapshot'>): void {
    this.db.prepare('INSERT INTO record_change_context VALUES (?, ?, ?, ?)')
      .run(randomUUID(), changedAt, restore?.changeId ?? null, restore?.snapshot ?? null);
  }

  end(): void { this.db.exec('DELETE FROM record_change_context'); }

  list(tableId: string, recordId: string, query: RecordHistoryQuery): RecordHistoryPage {
    if (!this.db.prepare('SELECT 1 FROM records WHERE table_id = ? AND id = ?').get(tableId, recordId)
      && !this.db.prepare('SELECT 1 FROM record_changes WHERE table_id = ? AND record_id = ? LIMIT 1').get(tableId, recordId)) {
      throw new ServiceError('RECORD_NOT_FOUND', 'This record has no stored history.', 404);
    }
    const limit = query.limit ?? 20;
    const rows = this.db.prepare(`SELECT ${metadata} FROM record_changes WHERE table_id = ? AND record_id = ?
      ${query.before === undefined ? '' : 'AND id < ?'} ORDER BY id DESC LIMIT ?`)
      .all(tableId, recordId, ...(query.before === undefined ? [] : [query.before]), limit + 1);
    const changes = rows.slice(0, limit).map(change);
    return { changes, ...(rows.length > limit ? { nextBefore: changes.at(-1)!.id } : {}) };
  }

  get(tableId: string, recordId: string, changeId: number): RecordChangeDetail {
    const row = this.db.prepare('SELECT * FROM record_changes WHERE table_id = ? AND record_id = ? AND id = ?').get(tableId, recordId, changeId);
    if (!row) throw new ServiceError('HISTORY_NOT_FOUND', 'This record change does not exist.', 404);
    return { ...change(row), before: snapshot(row, 'before'), after: snapshot(row, 'after') };
  }

  trash(table: Table, query: RecordHistoryQuery): RecordTrashPage {
    const limit = query.limit ?? 20;
    const rows = this.db.prepare(`SELECT c.id, c.record_id, c.batch_id, c.changed_at, c.before_version,
      c.before_values_json -> :primary AS display_value FROM record_changes c
      WHERE c.table_id = :table AND c.after_version IS NULL
      AND NOT EXISTS (SELECT 1 FROM records r WHERE r.id = c.record_id)
      AND NOT EXISTS (SELECT 1 FROM record_changes newer WHERE newer.table_id = c.table_id AND newer.record_id = c.record_id AND newer.id > c.id)
      ${query.before === undefined ? '' : 'AND c.id < :before'} ORDER BY c.id DESC LIMIT :limit`)
      .all({ ':table': table.id, ':primary': `$.${JSON.stringify(table.primaryFieldId)}`, ':limit': limit + 1,
        ...(query.before === undefined ? {} : { ':before': query.before }) });
    const records = rows.slice(0, limit).map(row => ({ id: row['record_id'] as string, deletionId: row['id'] as number,
      batchId: row['batch_id'] as string, deletedAt: row['changed_at'] as string, version: row['before_version'] as number,
      displayValue: JSON.parse(row['display_value'] as string ?? 'null') as CellValue }));
    return { records, ...(rows.length > limit ? { nextBefore: records.at(-1)!.deletionId } : {}) };
  }

  checkDeleted(tableId: string, recordId: string, deletionId: number): void {
    const latest = this.db.prepare('SELECT id, after_version FROM record_changes WHERE table_id = ? AND record_id = ? ORDER BY id DESC LIMIT 1').get(tableId, recordId);
    if (latest?.['id'] !== deletionId || latest['after_version'] !== null || this.db.prepare('SELECT 1 FROM records WHERE id = ?').get(recordId)) {
      throw new ServiceError('VERSION_CONFLICT', 'The deleted record changed or was already restored. Refresh the trash before continuing.', 409);
    }
  }

  markRestored(recordId: string, deletionId: number): void {
    this.db.prepare(`UPDATE record_changes SET restored_from = ?, restored_snapshot = 'before'
      WHERE record_id = ? AND batch_id = (SELECT batch_id FROM record_change_context)`).run(deletionId, recordId);
  }
}
