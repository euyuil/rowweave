import type { DatabaseSync } from 'node:sqlite';
import type { CellValue, Field, Table } from '../../contracts/src/index.js';
import { ServiceError } from '../../core/src/errors.js';

export class AutomaticNumbers {
  private readonly allocate;

  constructor(private readonly db: DatabaseSync) {
    this.allocate = db.prepare(`UPDATE field_sequences SET last_value = last_value + 1
      WHERE field_id = ? AND last_value < ${Number.MAX_SAFE_INTEGER} RETURNING last_value`);
  }

  assign(fields: Field[], values: Record<string, CellValue>): void {
    for (const field of fields) {
      if (field.type !== 'autoNumber' || values[field.id] !== undefined) continue;
      const row = this.allocate.get(field.id);
      if (!row) throw new ServiceError('SEQUENCE_EXHAUSTED', `${field.name}: this automatic sequence has reached its maximum safe integer.`);
      values[field.id] = row['last_value'] as number;
    }
  }

  addFields(table: Table, previous: Table): Set<string> {
    const added = table.fields.filter(field => field.type === 'autoNumber' && !previous.fields.some(before => before.id === field.id));
    const changed = new Set<string>();
    if (!added.length) return changed;
    const create = this.db.prepare('INSERT INTO field_sequences (field_id, last_value) VALUES (?, 0)');
    for (const field of added) create.run(field.id);
    const write = this.db.prepare('UPDATE records SET values_json = ?, version = version + 1 WHERE id = ?');
    for (const row of this.db.prepare('SELECT id, values_json FROM records WHERE table_id = ? ORDER BY position').iterate(table.id)) {
      const values = JSON.parse(row['values_json'] as string) as Record<string, CellValue>;
      this.assign(added, values);
      write.run(JSON.stringify(values), row['id']!);
      changed.add(row['id'] as string);
    }
    return changed;
  }
}
