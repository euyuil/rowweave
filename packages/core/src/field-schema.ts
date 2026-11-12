import { randomUUID } from 'node:crypto';
import type { Field, FieldType, SelectOption } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { schemaName, schemaObject } from './schema-validation.js';
import { validateValue } from './field-values.js';

const fieldTypes: FieldType[] = ['text', 'multiline', 'number', 'checkbox', 'date', 'datetime', 'singleSelect', 'multiSelect'];

export function parseField(input: Record<string, unknown>, previous?: Field): Field {
  const config = { ...previous, ...input };
  if (!fieldTypes.includes(config['type'] as FieldType)) throw new ServiceError('INVALID_SCHEMA', 'This field type is not supported.');
  const field: Field = { id: previous?.id ?? randomUUID(), name: schemaName(config['name']), type: config['type'] as FieldType };
  if (config['required'] !== undefined) {
    if (typeof config['required'] !== 'boolean') throw new ServiceError('INVALID_SCHEMA', 'required must be a boolean.');
    field.required = config['required'];
  }
  if (field.type === 'singleSelect' || field.type === 'multiSelect') {
    const options = config['options'];
    if (!Array.isArray(options) || options.length > 200) throw new ServiceError('INVALID_SCHEMA', 'Provide up to 200 select options.');
    const ids = new Set<string>();
    const names = new Set<string>();
    field.options = options.map(value => {
      const option = schemaObject(value);
      const id = option['id'] ?? randomUUID();
      const name = schemaName(option['name']);
      if (typeof id !== 'string' || !id || id.length > 100 || ids.has(id) || names.has(name)) {
        throw new ServiceError('INVALID_SCHEMA', 'Select option IDs and names must be non-empty and unique.');
      }
      ids.add(id);
      names.add(name);
      const result: SelectOption = { id, name };
      if (option['color'] !== undefined) {
        if (typeof option['color'] !== 'string' || !/^#[\da-f]{6}$/i.test(option['color'])) {
          throw new ServiceError('INVALID_SCHEMA', 'Option colors must use #RRGGBB.');
        }
        result.color = option['color'];
      }
      return result;
    });
  }
  if (field.type === 'number') {
    if (config['numberFormat'] !== undefined) {
      if (!['decimal', 'currency', 'percent'].includes(config['numberFormat'] as string)) {
        throw new ServiceError('INVALID_SCHEMA', 'Unknown number format.');
      }
      field.numberFormat = config['numberFormat'] as NonNullable<Field['numberFormat']>;
    }
    if (config['precision'] !== undefined && config['precision'] !== null) {
      if (!Number.isInteger(config['precision']) || (config['precision'] as number) < 0 || (config['precision'] as number) > 10) {
        throw new ServiceError('INVALID_SCHEMA', 'Number precision must be between 0 and 10.');
      }
      field.precision = config['precision'] as number;
    }
    if (field.numberFormat === 'currency') {
      if (typeof config['currency'] !== 'string' || !/^[A-Z]{3}$/.test(config['currency'])) {
        throw new ServiceError('INVALID_SCHEMA', 'Specify a three-letter currency code.');
      }
      field.currency = config['currency'];
    }
  }
  if (config['defaultValue'] !== undefined && config['defaultValue'] !== null) {
    field.defaultValue = validateValue(field, config['defaultValue']);
  }
  return field;
}
