import { isReadOnlyField, type CellValue, type Table } from '../../contracts/src/index.js';
import { validateValue } from './field-values.js';

export function restoredBatchValues(table: Table, before: Record<string, CellValue>, current?: Record<string, CellValue>): Record<string, CellValue> {
  const values: Record<string, CellValue> = {};
  for (const field of table.fields) {
    if (field.type === 'autoNumber') {
      const value = current?.[field.id] ?? before[field.id];
      if (value !== undefined) values[field.id] = value;
      continue;
    }
    if (isReadOnlyField(field)) continue;
    const value = Object.hasOwn(before, field.id) ? before[field.id]
      : current ? current[field.id] ?? null : field.defaultValue ?? null;
    values[field.id] = validateValue(field, value);
  }
  return values;
}
