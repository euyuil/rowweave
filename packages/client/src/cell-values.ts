import { isLookupSummary, type CellValue, type Field } from '../../contracts/src/index.js';
import { fieldText } from '../../core/src/field-display.js';

const numberFormats = new WeakMap<Field, Intl.NumberFormat>();

export const cellText = fieldText;

export function cellDisplay(field: Field, value: CellValue | undefined): string {
  if (field.type === 'attachment' || (field.type === 'lookup' && field.lookupResult!.type === 'attachment')) {
    const count = ((value ?? []) as string[]).length;
    return count ? `${count} ${count === 1 ? 'file' : 'files'}` : '';
  }
  if (isLookupSummary(field)) return field.lookup!.operation === 'count' ? String(value ?? '') : cellDisplay(field.lookupResult!, value);
  if (field.type === 'lookup') {
    const target = field.lookupResult!;
    const scalar = target.type === 'multiSelect' ? { ...target, type: 'singleSelect' as const } : target;
    return ((value ?? []) as CellValue[]).map(value => cellDisplay(scalar, value)).join(', ');
  }
  if ((field.type === 'number' || field.formula?.resultType === 'number') && typeof value === 'number') {
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
