import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { tableId, type BatchResult, type Field, type RecordPage, type RecordUpdate, type RowRecord, type Table } from '../../contracts/src/index.js';
import { ServiceError, type RecordStore } from '../../core/src/record-service.js';

export interface SeedOptions {
  rows: number;
  columns: number;
}

interface StoredRecord {
  id: string;
  version: number;
  values_json: string;
}

export class SqliteRecordStore implements RecordStore {
  private readonly db: DatabaseSync;
  private readonly fields: Field[];

  constructor(path: string, seed: SeedOptions = { rows: 10_000, columns: 20 }) {
    if (!Number.isSafeInteger(seed.rows) || seed.rows < 1 || seed.rows > 100_000 ||
        !Number.isSafeInteger(seed.columns) || seed.columns < 1 || seed.columns > 100) {
      throw new Error('Seed size must be 1–100,000 rows and 1–100 columns.');
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get()?.['user_version'];
      if (version !== 0 && version !== 1) throw new Error('Unsupported database version.');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS table_metadata (id TEXT PRIMARY KEY, fields_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE,
          version INTEGER NOT NULL DEFAULT 1, values_json TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      const metadata = this.db.prepare('SELECT fields_json FROM table_metadata WHERE id = ?').get(tableId);
      if (!metadata) this.seed(seed);
      const stored = this.db.prepare('SELECT fields_json FROM table_metadata WHERE id = ?').get(tableId);
      this.fields = JSON.parse(stored?.['fields_json'] as string) as Field[];
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private seed(options: SeedOptions): void {
    const fields: Field[] = Array.from({ length: options.columns }, (_, i) => ({
      id: `field_${i + 1}`, name: `Field ${i + 1}`, type: 'text',
    }));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO table_metadata VALUES (?, ?)').run(tableId, JSON.stringify(fields));
      const insert = this.db.prepare('INSERT INTO records (id, position, values_json) VALUES (?, ?, ?)');
      for (let row = 0; row < options.rows; row++) {
        const values = Object.fromEntries(fields.map((field, col) => {
          const cell = row * options.columns + col;
          const value = cell % 29 === 0 ? null
            : cell % 31 === 0 ? 'Long text '.repeat(40)
            : cell % 11 === 0 ? `中文示例 🌱 ${row + 1}`
            : `Row ${row + 1} · ${col + 1}`;
          return [field.id, value];
        }));
        insert.run(`record_${row + 1}`, row, JSON.stringify(values));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getTable(): Table {
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM records').get()?.['total'] as number;
    return { id: tableId, name: 'Prototype workspace', fields: structuredClone(this.fields), total };
  }

  readPage(offset: number, limit: number): RecordPage {
    const rows = this.db.prepare('SELECT id, version, values_json FROM records ORDER BY position LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as StoredRecord[];
    return { offset, records: rows.map(row => this.decode(row)) };
  }

  private decode(row: StoredRecord): RowRecord {
    return { id: row.id, version: row.version, values: JSON.parse(row.values_json) as RowRecord['values'] };
  }

  updateBatch(updates: RecordUpdate[]): BatchResult {
    const read = this.db.prepare('SELECT id, version, values_json FROM records WHERE id = ?');
    const write = this.db.prepare('UPDATE records SET values_json = ?, version = version + 1 WHERE id = ? AND version = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const records = updates.map(update => {
        const stored = read.get(update.id) as unknown as StoredRecord | undefined;
        if (!stored) throw new ServiceError('RECORD_NOT_FOUND', `Record ${update.id} does not exist.`, 404);
        if (stored.version !== update.expectedVersion) {
          throw new ServiceError('VERSION_CONFLICT', `Record ${update.id} changed. Reload before saving again.`, 409);
        }
        const record = this.decode(stored);
        record.values = { ...record.values, ...update.values };
        record.version++;
        write.run(JSON.stringify(record.values), record.id, update.expectedVersion);
        return record;
      });
      this.db.exec('COMMIT');
      return { records };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
