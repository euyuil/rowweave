import type { CellValue, Field } from '../../contracts/src/index.js';
import { parseTextValue, validateValue } from '../../core/src/field-values.js';

export type FormValue = string | string[] | null;

export function toFormValue(field: Field, value: CellValue | undefined): FormValue {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return field.type === 'lookup' ? JSON.stringify(value) : value as string[];
  if (field.type === 'datetime') return String(value).replace(/Z$/, '');
  return String(value);
}

export function fromFormValue(field: Field, value: FormValue): CellValue {
  if (value === null || field.type === 'multiSelect' || field.type === 'singleSelect' || field.type === 'relation') return validateValue(field, value);
  const text = value as string;
  if (field.type === 'datetime' && text) {
    return validateValue(field, `${text.length === 16 ? `${text}:00` : text}Z`);
  }
  return parseTextValue(field, text);
}
