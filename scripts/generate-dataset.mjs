import { open, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';

const [target, rowArgument, columnArgument, extra] = process.argv.slice(2);
const rows = Number(rowArgument);
const columns = Number(columnArgument);
if (!target || extra || !Number.isSafeInteger(rows) || rows < 1 || rows > 100_000 ||
    !Number.isSafeInteger(columns) || columns < 1 || columns > 100) {
  throw new Error('Usage: npm run dataset -- <new-database.sqlite> <rows:1-100000> <columns:1-100>');
}
const database = resolve(target);
await mkdir(dirname(database), { recursive: true });
// Reserve the destination atomically: never overwrite or reseed an existing workspace.
const file = await open(database, 'wx');
await file.close();
const start = performance.now();
const store = new SqliteRecordStore(database, { rows, columns });
store.close();
console.log(JSON.stringify({ database, rows, columns,
  elapsedMs: Math.round(performance.now() - start), bytes: (await stat(database)).size }));
