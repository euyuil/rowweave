import { maxTextLength, type CellValue, type Field } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';

export function validateValue(field: Field, input: unknown): CellValue {
  if (field.type === 'lookup') throw new ServiceError('READ_ONLY_FIELD', `${field.name}: lookup values are read-only.`);
  const invalid = (reason: string): never => { throw new ServiceError('INVALID_VALUE', `${field.name} (${field.id}): ${reason}`); };
  if (input === null) {
    if (field.required) return invalid('a value is required.');
    return null;
  }
  switch (field.type) {
    case 'text':
    case 'multiline':
      if (typeof input !== 'string' || input.length > maxTextLength) return invalid(`use text up to ${maxTextLength} characters.`);
      if (field.required && !input.trim()) return invalid('a non-empty value is required.');
      return input;
    case 'number':
      if (typeof input !== 'number' || !Number.isFinite(input)) return invalid('use a finite number.');
      return input;
    case 'checkbox':
      if (typeof input !== 'boolean') return invalid('use true or false.');
      return input;
    case 'date':
      if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input) ||
          !Number.isFinite(Date.parse(input)) || new Date(input).toISOString().slice(0, 10) !== input) {
        return invalid('use a valid calendar date in YYYY-MM-DD format.');
      }
      return input;
    case 'datetime':
      if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input) ||
          !Number.isFinite(Date.parse(input)) || new Date(input.slice(0, 10)).toISOString().slice(0, 10) !== input.slice(0, 10)) {
        return invalid('use an ISO timestamp with an explicit time zone.');
      }
      return new Date(input).toISOString();
    case 'singleSelect':
      if (typeof input !== 'string' || !field.options!.some(option => option.id === input)) return invalid('choose an existing option ID.');
      return input;
    case 'multiSelect':
      if (!Array.isArray(input) || input.length > field.options!.length || new Set(input).size !== input.length ||
          input.some(id => typeof id !== 'string' || !field.options!.some(option => option.id === id))) {
        return invalid('use a list of unique existing option IDs.');
      }
      if (field.required && !input.length) return invalid('choose at least one option.');
      return input as string[];
    case 'relation':
      if (!Array.isArray(input) || input.length > (field.relation!.multiple ? 200 : 1) ||
          new Set(input).size !== input.length || input.some(id => typeof id !== 'string' || !id || id.length > 100)) {
        return invalid(`choose up to ${field.relation!.multiple ? 200 : 1} unique record IDs.`);
      }
      if (field.required && !input.length) return invalid('choose at least one record.');
      return input as string[];
  }
}

export function parseTextValue(field: Field, text: string): CellValue {
  if (field.type === 'text' || field.type === 'multiline') return validateValue(field, text);
  if (!text.trim()) return validateValue(field, null);
  let value: unknown = text;
  if (field.type === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) {
      throw new ServiceError('INVALID_VALUE', `${field.name}: enter a decimal number.`);
    }
    value = Number(text);
  } else if (field.type === 'checkbox') {
    if (!/^(true|false)$/i.test(text.trim())) throw new ServiceError('INVALID_VALUE', `${field.name}: enter true or false.`);
    value = text.trim().toLowerCase() === 'true';
  } else if (field.type === 'singleSelect') {
    value = (field.options!.find(option => option.name === text) ?? field.options!.find(option => option.id === text))?.id;
  } else if (field.type === 'relation') {
    try { value = JSON.parse(text); }
    catch { throw new ServiceError('INVALID_VALUE', `${field.name}: use a JSON array of record IDs.`); }
  } else if (field.type === 'multiSelect') {
    let items: unknown;
    try { items = JSON.parse(text); }
    catch { throw new ServiceError('INVALID_VALUE', `${field.name}: use a JSON array of option names or IDs.`); }
    if (!Array.isArray(items)) throw new ServiceError('INVALID_VALUE', `${field.name}: use a JSON array of option names or IDs.`);
    value = items.map(item => (field.options!.find(option => option.name === item) ?? field.options!.find(option => option.id === item))?.id);
  }
  return validateValue(field, value);
}
