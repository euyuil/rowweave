import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { SqliteRecordStore, type SeedOptions } from '../src/record-store.js';

export function fixture(t: TestContext, seed: SeedOptions = { rows: 12, columns: 3 }) {
  const directory = mkdtempSync(join(tmpdir(), 'rowweave-test-'));
  const path = join(directory, 'test.sqlite');
  const stores: SqliteRecordStore[] = [];
  const open = () => {
    const store = new SqliteRecordStore(path, seed);
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
