import type { CellValue, Field } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { parseTextValue, validateValue } from './field-values.js';

export function convertValue(previous: Field, next: Field, value: CellValue): CellValue {
  if (value === null) return validateValue(next, null);
  if (previous.type === next.type) return validateValue(next, value);
  let text: string;
  if (previous.type === 'singleSelect') {
    if (next.type === 'multiSelect' && next.options!.some(option => option.id === value)) {
      return validateValue(next, [value]);
    }
    text = previous.options!.find(option => option.id === value)!.name;
    if (next.type === 'multiSelect') text = JSON.stringify([text]);
  } else if (previous.type === 'multiSelect') {
    const names = (value as string[]).map(id => previous.options!.find(option => option.id === id)!.name);
    if (next.type === 'singleSelect') {
      if (names.length > 1) throw new ServiceError('INVALID_VALUE', 'Multiple selected options cannot become a single option.');
      const id = (value as string[])[0];
      if (id !== undefined && next.options!.some(option => option.id === id)) return validateValue(next, id);
      return names.length ? parseTextValue(next, names[0]!) : validateValue(next, null);
    }
    text = JSON.stringify(names);
  } else {
    text = String(value);
  }
  return parseTextValue(next, text);
}
