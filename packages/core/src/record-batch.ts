import type { CellValue, Table } from '../../contracts/src/index.js';
import { validateValue } from './field-values.js';

export function restoredBatchValues(table: Table, before: Record<string, CellValue>, current?: Record<string, CellValue>): Record<string, CellValue> {
  return Object.fromEntries(table.fields.filter(field => field.type !== 'lookup' && field.type !== 'formula').map(field => {
    const value = Object.hasOwn(before, field.id) ? before[field.id]
      : current ? current[field.id] ?? null : field.defaultValue ?? null;
    return [field.id, validateValue(field, value)];
  }));
}
