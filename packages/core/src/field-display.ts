import type { CellValue, Field } from '../../contracts/src/index.js';

export function fieldText(field: Field, value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (field.type === 'singleSelect') return field.options!.find(option => option.id === value)!.name;
  if (field.type === 'multiSelect') return JSON.stringify((value as string[]).map(id => field.options!.find(option => option.id === id)!.name));
  if (field.type === 'relation') return JSON.stringify(value);
  return String(value);
}
