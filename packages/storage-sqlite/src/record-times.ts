import { recordPatch, recordSource, recordTable, recordUpdate } from './record-tables.js';
import type { DatabaseSync } from 'node:sqlite';
import type { CellValue, Field, Table } from '../../contracts/src/index.js';
import { compileFormulas } from '../../core/src/formulas.js';

export class RecordTimes {
  private readonly transactionTime;
  private readonly createdTime;
  private readonly editedTime;

  constructor(private readonly db: DatabaseSync) {
    this.transactionTime = db.prepare('SELECT changed_at FROM record_change_context');
    this.createdTime = db.prepare(`SELECT changed_at FROM record_changes
      WHERE table_id = ? AND record_id = ? AND before_version IS NULL AND after_version = 1 ORDER BY id LIMIT 1`);
    this.editedTime = db.prepare(`SELECT c.changed_at FROM record_changes c LEFT JOIN record_batches b ON b.id = c.batch_id
      WHERE c.table_id = ? AND c.record_id = ? AND (b.record_write = 1 OR b.id IS NULL) ORDER BY c.id DESC LIMIT 1`);
  }

  create(table: Table, id: string, version: number, values: Record<string, CellValue>): void {
    const fields = table.fields.filter(field => field.type === 'createdTime' || field.type === 'updatedTime');
    if (!fields.length) return;
    const now = this.transactionTime.get()!['changed_at'] as string;
    for (const field of fields) values[field.id] = field.type === 'updatedTime' || version === 1 ? now
      : this.createdTime.get(table.id, id)?.['changed_at'] as string ?? null;
  }

  edit(fields: Field[], values: Record<string, CellValue>): void {
    const updated = fields.filter(field => field.type === 'updatedTime');
    if (!updated.length) return;
    const now = this.transactionTime.get()!['changed_at'] as string;
    for (const field of updated) values[field.id] = now;
  }

  addFields(table: Table, previous: Table): Set<string> {
    const added = table.fields.filter(field => (field.type === 'createdTime' || field.type === 'updatedTime') && !previous.fields.some(before => before.id === field.id));
    const changed = new Set<string>();
    if (!added.length) return changed;
    const write = recordPatch(this.db, table.id, added.map(field => field.id));
    for (const row of this.db.prepare(`SELECT id FROM ${recordTable(table.id)} ORDER BY position`).iterate()) {
      const id = row['id'] as string, values: Record<string, CellValue> = {};
      for (const field of added) values[field.id] = (field.type === 'createdTime' ? this.createdTime : this.editedTime).get(table.id, id)?.['changed_at'] as string ?? null;
      write(id, values, 1); changed.add(id);
    }
    return changed;
  }

  editRelated(table: Table, ids: Set<string>): Set<string> {
    const changed = new Set<string>(), fields = table.fields.filter(field => field.type === 'updatedTime');
    if (!fields.length) return changed;
    const now = this.transactionTime.get()!['changed_at'] as string, calculate = compileFormulas(table, { skipLinked: true, now: new Date(now) });
    const read = this.db.prepare(`SELECT values_json, formula_errors_json FROM ${recordSource(table.id)} WHERE id = ?`);
    const write = recordUpdate(this.db, table);
    for (const id of ids) {
      const row = read.get(id);
      if (!row) continue;
      const values = JSON.parse(row['values_json'] as string) as Record<string, CellValue>;
      if (fields.every(field => values[field.id] === now)) continue;
      for (const field of fields) values[field.id] = now;
      const result = calculate(values, JSON.parse(row['formula_errors_json'] as string) as Record<string, string>);
      write(id, result.values, 0, JSON.stringify(result.formulaErrors ?? {})); changed.add(id);
    }
    return changed;
  }
}
