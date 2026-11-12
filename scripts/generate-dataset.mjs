import { open, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { SqliteRecordStore } from '../dist/packages/storage-sqlite/src/record-store.js';
import { RecordService } from '../dist/packages/core/src/record-service.js';

const [target, rowArgument, columnArgument, mode, extra] = process.argv.slice(2);
const rows = Number(rowArgument);
const columns = Number(columnArgument);
if (!target || extra || (mode && mode !== '--typed') || !Number.isSafeInteger(rows) || rows < 1 || rows > 100_000 ||
    !Number.isSafeInteger(columns) || columns < 1 || columns > 100) {
  throw new Error('Usage: npm run dataset -- <new-database.sqlite> <rows:1-100000> <columns:1-100> [--typed]');
}
const database = resolve(target);
await mkdir(dirname(database), { recursive: true });
// Reserve the destination atomically: never overwrite or reseed an existing workspace.
const file = await open(database, 'wx');
await file.close();
const start = performance.now();
const store = new SqliteRecordStore(database, mode ? null : { rows, columns });
let table;
try {
  if (mode) {
    const service = new RecordService(store);
    table = service.createTable({ name: 'Product benchmark' });
    const types = [
      { name: 'Amount', type: 'number' }, { name: 'Budget', type: 'number', numberFormat: 'currency', currency: 'USD', precision: 2 },
      { name: 'Progress', type: 'number', numberFormat: 'percent', precision: 1 }, { name: 'Done', type: 'checkbox' },
      { name: 'Due', type: 'date' }, { name: 'Updated', type: 'datetime' },
      { name: 'Status', type: 'singleSelect', options: [{ name: 'Planned' }, { name: 'Active' }, { name: 'Complete' }] },
      { name: 'Tags', type: 'multiSelect', options: [{ name: '中文' }, { name: 'Review' }, { name: 'Launch' }] },
      { name: 'Notes', type: 'multiline' }, { name: 'Reference', type: 'text' },
    ];
    for (let column = 1; column < columns; column++) {
      const config = column < 10 ? { name: `Text ${column + 1}`, type: 'text' } : types[(column - 10) % types.length];
      table = service.createField(table.id, { ...config, name: column < 20 ? config.name : `${config.name} ${Math.floor(column / 10)}`,
        expectedVersion: table.version });
    }
    const batchSize = Math.min(2000, Math.floor(20_000 / columns));
    for (let start = 0; start < rows; start += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, rows - start) }, (_, offset) => {
        const row = start + offset;
        return { values: Object.fromEntries(table.fields.map((field, column) => {
          const index = row * columns + column;
          let value;
          if (index % 29 === 0) value = null;
          else if (field.type === 'number') value = field.numberFormat === 'percent' ? (row % 101) / 100 : (row % 10_000) + column / 100;
          else if (field.type === 'checkbox') value = row % 3 === 0;
          else if (field.type === 'date') value = `2026-${String(row % 12 + 1).padStart(2, '0')}-${String(row % 28 + 1).padStart(2, '0')}`;
          else if (field.type === 'datetime') value = new Date(Date.UTC(2026, 0, 1) + row * 60_000).toISOString();
          else if (field.type === 'singleSelect') value = field.options[row % field.options.length].id;
          else if (field.type === 'multiSelect') value = row % 5 === 0 ? [] : field.options.slice(0, row % 2 + 1).map(option => option.id);
          else if (index % 31 === 0) value = 'Long text 中文 🌱 '.repeat(40);
          else if (index % 17 === 0) value = '';
          else if (field.type === 'multiline') value = `Project ${row + 1}\nSecond line 中文 🌱`;
          else value = column === 0 ? `Project ${String(row + 1).padStart(6, '0')}` : `Row ${row + 1} · ${column + 1} 中文 🌱`;
          return [field.id, value];
        })) };
      });
      service.createRecords(table.id, batch);
    }
    table = service.getTable(table.id);
  }
} finally { store.close(); }
console.log(JSON.stringify({ database, rows, columns, kind: mode ? 'typed' : 'text', ...(table ? { table } : {}),
  elapsedMs: Math.round(performance.now() - start), bytes: (await stat(database)).size }));
