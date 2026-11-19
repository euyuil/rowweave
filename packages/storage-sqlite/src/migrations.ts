import type { DatabaseSync } from 'node:sqlite';

export const workspaceFormat = 41;

export function initializeWorkspace(db: DatabaseSync): boolean {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get()!['user_version'] as number;
    if (version === workspaceFormat) {
      db.exec('COMMIT');
      return false;
    }
    if (version !== 0) throw new Error(`Unsupported database version: ${version}. Create a new RowWeave workspace.`);
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()) {
      throw new Error('Choose an empty database to create a RowWeave workspace.');
    }
    db.exec(`
      CREATE TABLE tables (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL,
        primary_field_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, views_revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE fields (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, definition_json TEXT NOT NULL
      );
      CREATE INDEX fields_by_table ON fields(table_id, position);

      CREATE TABLE record_ids (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        UNIQUE(id, table_id)
      );
      CREATE INDEX record_ids_by_table ON record_ids(table_id);

      CREATE TABLE views (
        id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        name TEXT NOT NULL, version INTEGER NOT NULL, config_json TEXT NOT NULL
      ); CREATE INDEX views_by_table ON views(table_id);

      CREATE TABLE field_relations (
        field_id TEXT PRIMARY KEY REFERENCES fields(id) ON DELETE CASCADE,
        target_table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE RESTRICT
      );
      CREATE INDEX relations_by_target_table ON field_relations(target_table_id);
      CREATE TABLE relation_edges (
        source_record_id TEXT NOT NULL REFERENCES record_ids(id) ON DELETE CASCADE,
        field_id TEXT NOT NULL REFERENCES field_relations(field_id) ON DELETE CASCADE,
        target_record_id TEXT NOT NULL REFERENCES record_ids(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        PRIMARY KEY(source_record_id, field_id, target_record_id),
        UNIQUE(source_record_id, field_id, position)
      );
      CREATE INDEX relations_by_target_record ON relation_edges(target_record_id);

      CREATE TABLE field_lookups (
        field_id TEXT PRIMARY KEY REFERENCES fields(id) ON DELETE CASCADE,
        relation_field_id TEXT NOT NULL REFERENCES field_relations(field_id) ON DELETE RESTRICT,
        target_field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE RESTRICT
      );
      CREATE INDEX lookups_by_relation ON field_lookups(relation_field_id);
      CREATE INDEX lookups_by_target ON field_lookups(target_field_id);

      CREATE TABLE record_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE, record_id TEXT NOT NULL, changed_at TEXT NOT NULL,
        before_version INTEGER, before_values_json TEXT, before_errors_json TEXT,
        after_version INTEGER, after_values_json TEXT, after_errors_json TEXT,
        restored_from INTEGER, restored_snapshot TEXT,
        UNIQUE(batch_id, record_id)
      ); CREATE INDEX changes_by_record ON record_changes(table_id, record_id, id DESC);

      CREATE INDEX changes_deleted ON record_changes(table_id, id DESC) WHERE after_version IS NULL;

      CREATE TABLE record_batches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        changed_at TEXT NOT NULL, record_count INTEGER NOT NULL, record_write INTEGER NOT NULL, undo_of TEXT
      ); CREATE TABLE record_batch_tables (
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES record_batches(id), sequence INTEGER NOT NULL,
        PRIMARY KEY(table_id, batch_id)
      ); CREATE INDEX batches_by_table ON record_batch_tables(table_id, sequence DESC);

      CREATE TABLE record_change_context (
        batch_id TEXT NOT NULL, changed_at TEXT NOT NULL, restored_from INTEGER, restored_snapshot TEXT,
        record_write INTEGER NOT NULL, undo_of TEXT
      );

      CREATE TABLE field_sequences (
        field_id TEXT PRIMARY KEY REFERENCES fields(id) ON DELETE CASCADE, last_value INTEGER NOT NULL
      );

      CREATE TABLE attachments (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
        filename TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, created_at TEXT NOT NULL, content BLOB NOT NULL, retained INTEGER NOT NULL DEFAULT 0
      ); CREATE INDEX attachments_by_table ON attachments(table_id, sequence DESC);

      CREATE TABLE workspace_state (id INTEGER PRIMARY KEY CHECK(id = 1), catalog_revision INTEGER NOT NULL);
      INSERT INTO workspace_state VALUES (1, 1);
      CREATE TRIGGER catalog_insert AFTER INSERT ON tables BEGIN
        UPDATE workspace_state SET catalog_revision = catalog_revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER catalog_delete AFTER DELETE ON tables BEGIN
        UPDATE workspace_state SET catalog_revision = catalog_revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER catalog_rename AFTER UPDATE OF name ON tables WHEN old.name <> new.name BEGIN
        UPDATE workspace_state SET catalog_revision = catalog_revision + 1 WHERE id = 1;
      END;
      CREATE TRIGGER views_insert AFTER INSERT ON views BEGIN
        UPDATE tables SET views_revision = views_revision + 1 WHERE id = new.table_id;
      END;
      CREATE TRIGGER views_update AFTER UPDATE ON views BEGIN
        UPDATE tables SET views_revision = views_revision + 1 WHERE id = new.table_id;
      END;
      CREATE TRIGGER views_delete AFTER DELETE ON views BEGIN
        UPDATE tables SET views_revision = views_revision + 1 WHERE id = old.table_id;
      END;
      PRAGMA user_version = ${workspaceFormat};
    `);
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
