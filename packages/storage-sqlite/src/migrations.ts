import type { DatabaseSync } from 'node:sqlite';
import { tableId, type Field } from '../../contracts/src/index.js';

export function migrate(db: DatabaseSync): boolean {
  const version = db.prepare('PRAGMA user_version').get()!['user_version'] as number;
  if (version === 3) return false;
  if (version < 0 || version > 3) throw new Error(`Unsupported database version: ${version}.`);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version < 2) {
      if (version === 1) db.exec('ALTER TABLE records RENAME TO prototype_records;');
      db.exec(`
      CREATE TABLE tables (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL,
        primary_field_id TEXT NOT NULL
      );
      CREATE TABLE fields (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, definition_json TEXT NOT NULL
      );
      CREATE INDEX fields_by_table ON fields(table_id, position);
      CREATE TABLE records (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, values_json TEXT NOT NULL,
        UNIQUE(table_id, position)
      );
      `);
      if (version === 1) {
        const metadata = db.prepare('SELECT fields_json FROM table_metadata WHERE id = ?').get(tableId)!;
        const fields = JSON.parse(metadata['fields_json'] as string) as Field[];
        db.prepare('INSERT INTO tables VALUES (?, ?, 1, ?)')
          .run(tableId, 'Prototype workspace', fields[0]!.id);
        const insert = db.prepare('INSERT INTO fields VALUES (?, ?, ?, ?)');
        for (const [position, field] of fields.entries()) insert.run(field.id, tableId, position, JSON.stringify(field));
        db.prepare(`INSERT INTO records (id, table_id, position, version, values_json)
          SELECT id, ?, position, version, values_json FROM prototype_records`).run(tableId);
        db.exec('DROP TABLE prototype_records; DROP TABLE table_metadata;');
      }
    }
    db.exec('ALTER TABLE tables ADD COLUMN revision INTEGER NOT NULL DEFAULT 1; PRAGMA user_version = 3; COMMIT;');
    return version === 0;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
