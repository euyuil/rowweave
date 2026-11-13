import type { DatabaseSync } from 'node:sqlite';
import { tableId, type Field, type ViewQuery } from '../../contracts/src/index.js';
import { defaultView } from '../../core/src/grid-views.js';
import { syncQueryIndexes } from './query-indexes.js';

export function migrate(db: DatabaseSync): boolean {
  const version = db.prepare('PRAGMA user_version').get()!['user_version'] as number;
  if (version === 14) return false;
  if (version < 0 || version > 14) throw new Error(`Unsupported database version: ${version}.`);
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
    if (version < 3) db.exec('ALTER TABLE tables ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;');
    if (version < 4) {
      db.exec(`CREATE TABLE views (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        name TEXT NOT NULL, version INTEGER NOT NULL, config_json TEXT NOT NULL
      ); CREATE INDEX views_by_table ON views(table_id);`);
      const insertView = db.prepare('INSERT INTO views VALUES (?, ?, ?, ?, ?)');
      for (const row of db.prepare('SELECT id FROM tables').all()) {
        const id = row['id'] as string;
        const fields = db.prepare('SELECT definition_json FROM fields WHERE table_id = ? ORDER BY position').all(id)
          .map(row => JSON.parse(row['definition_json'] as string) as Field);
        const view = defaultView({ id, fields });
        insertView.run(view.id, id, view.name, view.version, JSON.stringify({ query: view.query, columns: view.columns }));
      }
    }
    if (version < 5) db.exec(`CREATE TABLE field_relations (
      field_id TEXT PRIMARY KEY REFERENCES fields(id) ON DELETE CASCADE,
      target_table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE RESTRICT
    );
    CREATE INDEX relations_by_target_table ON field_relations(target_table_id);
    CREATE TABLE relation_edges (
      source_record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES field_relations(field_id) ON DELETE CASCADE,
      target_record_id TEXT NOT NULL REFERENCES records(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL,
      PRIMARY KEY(source_record_id, field_id, target_record_id),
      UNIQUE(source_record_id, field_id, position)
    );
    CREATE INDEX relations_by_target_record ON relation_edges(target_record_id);`);
    if (version < 6) db.exec(`CREATE TABLE field_lookups (
      field_id TEXT PRIMARY KEY REFERENCES fields(id) ON DELETE CASCADE,
      relation_field_id TEXT NOT NULL REFERENCES field_relations(field_id) ON DELETE RESTRICT,
      target_field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE RESTRICT
    );
    CREATE INDEX lookups_by_relation ON field_lookups(relation_field_id);
    CREATE INDEX lookups_by_target ON field_lookups(target_field_id);`);
    if (version < 7) for (const row of db.prepare('SELECT id FROM tables').all()) {
      const id = row['id'] as string;
      const fields = db.prepare('SELECT definition_json FROM fields WHERE table_id = ? ORDER BY position').all(id)
        .map(row => JSON.parse(row['definition_json'] as string) as Field);
      const queries = db.prepare('SELECT config_json FROM views WHERE table_id = ?').all(id)
        .map(row => (JSON.parse(row['config_json'] as string) as { query: ViewQuery }).query);
      syncQueryIndexes(db, { id, fields }, queries);
    }
    if (version < 8) db.exec("UPDATE views SET config_json = json_set(config_json, '$.rowHeight', 36, '$.frozenColumns', 0);");
    if (version < 9) db.exec("UPDATE views SET config_json = json_set(config_json, '$.type', 'grid');");
    if (version < 10) db.exec("ALTER TABLE records ADD COLUMN formula_errors_json TEXT NOT NULL DEFAULT '{}';");
    db.exec('PRAGMA user_version = 14; COMMIT;');
    return version === 0;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
