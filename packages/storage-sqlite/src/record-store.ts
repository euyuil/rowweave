import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { tableId, type BatchResult, type Field, type RecordPage, type RecordUpdate, type RowRecord, type Table } from '../../contracts/src/index.js';
import { ServiceError, type RecordStore } from '../../core/src/record-service.js';
import { migrate } from './migrations.js';

export interface SeedOptions {
  rows: number;
  columns: number;
}

interface StoredRecord {
  id: string;
  version: number;
  values_json: string;
}

interface StoredTable {
  id: string;
  name: string;
  version: number;
  primary_field_id: string;
  fields_json: string;
  total: number;
}

const selectTables = `SELECT t.*,
  (SELECT json_group_array(json(definition_json)) FROM
    (SELECT definition_json FROM fields WHERE table_id = t.id ORDER BY position)) AS fields_json,
  (SELECT COUNT(*) FROM records WHERE table_id = t.id) AS total FROM tables t`;

export class SqliteRecordStore implements RecordStore {
  private readonly db: DatabaseSync;

  constructor(path: string, seed: SeedOptions | null = { rows: 10_000, columns: 20 }) {
    if (seed && (!Number.isSafeInteger(seed.rows) || seed.rows < 1 || seed.rows > 100_000 ||
        !Number.isSafeInteger(seed.columns) || seed.columns < 1 || seed.columns > 100)) {
      throw new Error('Seed size must be 1–100,000 rows and 1–100 columns.');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      const fresh = migrate(this.db);
      if (fresh && seed) this.seed(seed);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertFields(table: Table): void {
    const write = this.db.prepare(`INSERT INTO fields VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET position = excluded.position, definition_json = excluded.definition_json`);
    for (const [position, field] of table.fields.entries()) {
      write.run(field.id, table.id, position, JSON.stringify(field));
    }
  }

  private seed(options: SeedOptions): void {
    const fields: Field[] = Array.from({ length: options.columns }, (_, i) => ({
      id: `field_${i + 1}`, name: `Field ${i + 1}`, type: 'text',
    }));
    this.transaction(() => {
      const table: Table = { id: tableId, name: 'Prototype workspace', version: 1,
        primaryFieldId: fields[0]!.id, fields, total: options.rows };
      this.db.prepare('INSERT INTO tables VALUES (?, ?, 1, ?)').run(table.id, table.name, table.primaryFieldId);
      this.insertFields(table);
      const insert = this.db.prepare('INSERT INTO records (id, table_id, position, values_json) VALUES (?, ?, ?, ?)');
      for (let row = 0; row < options.rows; row++) {
        const values = Object.fromEntries(fields.map((field, col) => {
          const cell = row * options.columns + col;
          const value = cell % 29 === 0 ? null
            : cell % 31 === 0 ? 'Long text '.repeat(40)
            : cell % 11 === 0 ? `中文示例 🌱 ${row + 1}`
            : `Row ${row + 1} · ${col + 1}`;
          return [field.id, value];
        }));
        insert.run(`record_${row + 1}`, tableId, row, JSON.stringify(values));
      }
    });
  }

  private decodeTable(row: StoredTable): Table {
    return { id: row.id, name: row.name, version: row.version, primaryFieldId: row.primary_field_id,
      fields: JSON.parse(row.fields_json) as Field[], total: row.total };
  }

  listTables(): Table[] {
    const rows = this.db.prepare(`${selectTables} ORDER BY t.rowid`).all() as unknown as StoredTable[];
    return rows.map(row => this.decodeTable(row));
  }

  getTable(id = tableId): Table {
    const row = this.db.prepare(`${selectTables} WHERE t.id = ?`).get(id) as unknown as StoredTable | undefined;
    if (!row) throw new ServiceError('TABLE_NOT_FOUND', 'This table does not exist.', 404);
    return this.decodeTable(row);
  }

  createTable(table: Table): Table {
    return this.transaction(() => {
      this.db.prepare('INSERT INTO tables VALUES (?, ?, 1, ?)').run(table.id, table.name, table.primaryFieldId);
      this.insertFields(table);
      return this.getTable(table.id);
    });
  }

  private checkSchema(id: string, version: number): void {
    const row = this.db.prepare('SELECT version FROM tables WHERE id = ?').get(id);
    if (!row) throw new ServiceError('TABLE_NOT_FOUND', 'This table does not exist.', 404);
    if (row['version'] !== version) {
      throw new ServiceError('SCHEMA_CONFLICT', 'The table schema changed. Reload it before trying again.', 409);
    }
  }

  updateSchema(table: Table, expectedVersion: number): Table {
    return this.transaction(() => {
      this.checkSchema(table.id, expectedVersion);
      if (table.version !== expectedVersion) {
        throw new ServiceError('SCHEMA_CONFLICT', 'The table schema changed. Reload it before trying again.', 409);
      }
      const before = this.getTable(table.id);
      for (const field of before.fields) {
        if (table.fields.some(next => next.id === field.id)) continue;
        this.db.prepare('DELETE FROM fields WHERE id = ? AND table_id = ?').run(field.id, table.id);
        this.db.prepare(`UPDATE records SET values_json = json_remove(values_json, ?), version = version + 1
          WHERE table_id = ? AND json_type(values_json, ?) IS NOT NULL`)
          .run(`$."${field.id}"`, table.id, `$."${field.id}"`);
      }
      this.insertFields(table);
      this.db.prepare('UPDATE tables SET name = ?, primary_field_id = ?, version = version + 1 WHERE id = ?')
        .run(table.name, table.primaryFieldId, table.id);
      return this.getTable(table.id);
    });
  }

  deleteTable(id: string, expectedVersion: number): void {
    this.transaction(() => {
      this.checkSchema(id, expectedVersion);
      this.db.prepare('DELETE FROM tables WHERE id = ?').run(id);
    });
  }

  readPage(offset: number, limit: number, id = tableId): RecordPage {
    const rows = this.db.prepare(`SELECT id, version, values_json FROM records WHERE table_id = ?
      ORDER BY position LIMIT ? OFFSET ?`).all(id, limit, offset) as unknown as StoredRecord[];
    return { offset, records: rows.map(row => this.decode(row)) };
  }

  private decode(row: StoredRecord): RowRecord {
    return { id: row.id, version: row.version, values: JSON.parse(row.values_json) as RowRecord['values'] };
  }

  updateBatch(updates: RecordUpdate[], id: string, schemaVersion: number): BatchResult {
    const read = this.db.prepare('SELECT id, version, values_json FROM records WHERE id = ? AND table_id = ?');
    const write = this.db.prepare('UPDATE records SET values_json = ?, version = version + 1 WHERE id = ? AND table_id = ?');
    return this.transaction(() => {
      this.checkSchema(id, schemaVersion);
      const records = updates.map(update => {
        const stored = read.get(update.id, id) as unknown as StoredRecord | undefined;
        if (!stored) throw new ServiceError('RECORD_NOT_FOUND', `Record ${update.id} does not exist.`, 404);
        if (stored.version !== update.expectedVersion) {
          throw new ServiceError('VERSION_CONFLICT', `Record ${update.id} changed. Reload before saving again.`, 409);
        }
        const record = this.decode(stored);
        record.values = { ...record.values, ...update.values };
        record.version++;
        write.run(JSON.stringify(record.values), record.id, id);
        return record;
      });
      return { records };
    });
  }

  close(): void {
    this.db.close();
  }
}
