import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteRecordStore, type SeedOptions } from '../src/record-store.js';

export function removeWorkspaceState(db: DatabaseSync): void {
  db.exec(`DROP TRIGGER catalog_insert; DROP TRIGGER catalog_delete; DROP TRIGGER catalog_rename;
    DROP TRIGGER views_insert; DROP TRIGGER views_update; DROP TRIGGER views_delete;
    DROP TABLE workspace_state; ALTER TABLE tables DROP COLUMN views_revision;`);
}

export function fixture(t: TestContext, seed: SeedOptions | null = { rows: 12, columns: 3 }, clock?: () => Date) {
  const directory = mkdtempSync(join(tmpdir(), 'rowweave-test-'));
  const path = join(directory, 'test.sqlite');
  const stores: SqliteRecordStore[] = [];
  const open = () => {
    const store = new SqliteRecordStore(path, seed, clock);
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) {
      try { store.close(); } catch { /* A test may close a store to verify restart behavior. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, open };
}
