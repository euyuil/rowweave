import type { CellValue, Field } from '../../contracts/src/index.js';

const numberFormats = new WeakMap<Field, Intl.NumberFormat>();

export function cellText(field: Field, value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (field.type === 'singleSelect') return field.options!.find(option => option.id === value)!.name;
  if (field.type === 'multiSelect') {
    return JSON.stringify((value as string[]).map(id => field.options!.find(option => option.id === id)!.name));
  }
  return String(value);
}

export function cellDisplay(field: Field, value: CellValue | undefined): string {
  if (field.type === 'number' && typeof value === 'number') {
    let formatter = numberFormats.get(field);
    if (!formatter) {
      const format = field.numberFormat;
      formatter = new Intl.NumberFormat('en-US', {
        style: format === 'currency' || format === 'percent' ? format : 'decimal',
        ...(field.currency ? { currency: field.currency } : {}),
        ...(field.precision === undefined ? {} : { minimumFractionDigits: field.precision, maximumFractionDigits: field.precision }),
      });
      numberFormats.set(field, formatter);
    }
    return formatter.format(value);
  }
  return cellText(field, value).replace(/\r?\n/g, ' ↵ ');
}

export function sameValue(left: CellValue | undefined, right: CellValue | undefined): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}
