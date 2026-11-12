import { randomUUID } from 'node:crypto';
import type { Field, FieldType, SelectOption } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { schemaName, schemaObject } from './schema-validation.js';
import { validateValue } from './field-values.js';

const fieldTypes: FieldType[] = ['text', 'multiline', 'number', 'checkbox', 'date', 'datetime', 'singleSelect', 'multiSelect', 'relation', 'lookup', 'formula'];

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
  if (field.type === 'formula') {
    const formula = schemaObject(config['formula']);
    if (typeof formula['expression'] !== 'string' || !['number', 'text', 'checkbox'].includes(formula['resultType'] as string)) {
      throw new ServiceError('INVALID_SCHEMA', 'A formula requires an expression and a number, text or checkbox result type.');
    }
    if (field.required || (config['defaultValue'] !== undefined && config['defaultValue'] !== null)) {
      throw new ServiceError('INVALID_SCHEMA', 'Formulas are read-only and cannot require a value or set a default.');
    }
    field.formula = { expression: formula['expression'], resultType: formula['resultType'] as NonNullable<Field['formula']>['resultType'] };
  }
  if (field.type === 'number' || field.formula?.resultType === 'number') {
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
  if (field.type === 'relation') {
    const relation = schemaObject(config['relation']);
    if (typeof relation['tableId'] !== 'string' || !relation['tableId'] || relation['tableId'].length > 100 ||
        typeof relation['multiple'] !== 'boolean') {
      throw new ServiceError('INVALID_SCHEMA', 'A linked-record field requires a target table ID and a multiple flag.');
    }
    field.relation = { tableId: relation['tableId'], multiple: relation['multiple'] };
  }
  if (field.type === 'lookup') {
    const lookup = schemaObject(config['lookup']);
    if (['relationFieldId', 'fieldId'].some(key => typeof lookup[key] !== 'string' || !lookup[key] || (lookup[key] as string).length > 100)) {
      throw new ServiceError('INVALID_SCHEMA', 'A lookup requires a linked field ID and a target field ID.');
    }
    if (field.required || (config['defaultValue'] !== undefined && config['defaultValue'] !== null)) {
      throw new ServiceError('INVALID_SCHEMA', 'Lookups are read-only and cannot require a value or set a default.');
    }
    field.lookup = { relationFieldId: lookup['relationFieldId'] as string, fieldId: lookup['fieldId'] as string };
    if (lookup['operation'] !== undefined) {
      if (!['values', 'count', 'sum', 'average', 'min', 'max'].includes(lookup['operation'] as string)) {
        throw new ServiceError('INVALID_SCHEMA', 'Choose values, count, sum, average, min or max for a lookup.');
      }
      field.lookup.operation = lookup['operation'] as NonNullable<NonNullable<Field['lookup']>['operation']>;
    }
  }
  if (config['defaultValue'] !== undefined && config['defaultValue'] !== null) {
    field.defaultValue = validateValue(field, config['defaultValue']);
  }
  return field;
}
