import { maxPageSize, maxTextLength, type Field, type FieldFilter, type FilterGroup, type RecordQuery, type Table } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { validateValue } from './field-values.js';

export type CheckedQuery = RecordQuery & { offset: number; limit: number };

export function queryValueField(field: Field): Field {
  return field.type === 'lookup' ? { ...field.lookupResult!, id: field.id, name: field.name, required: false } : field;
}

export function parseQuery(table: Table, input: unknown): CheckedQuery {
  const invalid = (message: string): never => { throw new ServiceError('INVALID_QUERY', message); };
  const object = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected a query object.');
    return value as Record<string, unknown>;
  };
  const source = object(input);
  const fields = new Map(table.fields.map(field => [field.id, field]));
  const field = (id: unknown): Field => {
    if (typeof id !== 'string' || !fields.has(id)) return invalid(`Unknown query field: ${String(id)}.`);
    return fields.get(id)!;
  };
  const offset = source['offset'] ?? 0;
  const limit = source['limit'] ?? 100;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > maxPageSize) {
    return invalid(`Use a non-negative offset and a limit between 1 and ${maxPageSize}.`);
  }
  const query: CheckedQuery = { offset: offset as number, limit: limit as number };
  if (source['recordIds'] !== undefined) {
    const ids = source['recordIds'];
    if (!Array.isArray(ids) || ids.length > 2_000 || new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== 'string' || !id || id.length > 100)) return invalid('Use up to 2,000 unique record IDs.');
    query.recordIds = ids as string[];
  }
  let conditionCount = 0;
  function group(value: unknown, depth: number): FilterGroup {
    if (depth > 4) return invalid('Filter groups may be nested up to four levels.');
    const item = object(value);
    if ((item['conjunction'] !== 'and' && item['conjunction'] !== 'or') || !Array.isArray(item['conditions'])) {
      return invalid('A filter group requires and/or conjunction and conditions.');
    }
    const conditions = item['conditions'].map((entry: unknown): FieldFilter | FilterGroup => {
      if (++conditionCount > 100) return invalid('Use at most 100 filter conditions.');
      const item = object(entry);
      if ('conjunction' in item) return group(item, depth + 1);
      const original = field(item['fieldId']);
      const selected = queryValueField(original);
      const operator = item['operator'];
      if (original.type === 'lookup' && selected.type === 'multiSelect' && (operator === 'eq' || operator === 'neq')) {
        return invalid('Use hasAny or empty checks for a multiple-select lookup.');
      }
      if (operator === 'isEmpty' || operator === 'isNotEmpty') return { fieldId: selected.id, operator };
      if (operator === 'contains') {
        if (!['text', 'multiline'].includes(selected.type) || typeof item['value'] !== 'string' || item['value'].length > maxTextLength) {
          return invalid('contains requires a text field and a text value.');
        }
        return { fieldId: selected.id, operator, value: item['value'] };
      }
      if (operator === 'hasAny') {
        if (!['multiSelect', 'relation'].includes(selected.type) || !Array.isArray(item['value'])) return invalid('hasAny requires a select or linked-record field and IDs.');
      } else if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
        if (!['number', 'date', 'datetime'].includes(selected.type) || item['value'] === null) {
          return invalid('Ordered comparisons require a number, date or timestamp value.');
        }
      } else if (operator !== 'eq' && operator !== 'neq') {
        return invalid('Unknown filter operator.');
      } else if (['multiSelect', 'relation'].includes(selected.type) && item['value'] !== null) {
        return invalid('Use hasAny for select or linked-record matching.');
      }
      return { fieldId: selected.id, operator,
        value: validateValue({ ...selected, required: false,
          ...(selected.relation ? { relation: { ...selected.relation, multiple: true } } : {}) }, item['value']) };
    });
    return { conjunction: item['conjunction'], conditions };
  }
  if (source['filter'] !== undefined) query.filter = group(source['filter'], 0);
  if (source['sort'] !== undefined) {
    const sort = source['sort'];
    if (!Array.isArray(sort) || sort.length > fields.size) return invalid('Expected a list of distinct sort fields.');
    const sorted = new Set<string>();
    query.sort = sort.map(entry => {
      const item = object(entry);
      const selected = field(item['fieldId']);
      if (sorted.has(selected.id) || (item['direction'] !== 'asc' && item['direction'] !== 'desc')) {
        return invalid('Use each sort field once with asc or desc direction.');
      }
      sorted.add(selected.id);
      return { fieldId: selected.id, direction: item['direction'] };
    });
  }
  if (source['search'] !== undefined) {
    if (typeof source['search'] !== 'string' || source['search'].length > maxTextLength) return invalid('Search must be bounded text.');
    query.search = source['search'];
  }
  if (source['fields'] !== undefined) {
    const selected = source['fields'];
    if (!Array.isArray(selected) || selected.length > fields.size || new Set(selected).size !== selected.length) return invalid('Select each output field at most once.');
    query.fields = selected.map(id => field(id).id);
  }
  if (source['expectedRevision'] !== undefined) {
    if (!Number.isSafeInteger(source['expectedRevision']) || (source['expectedRevision'] as number) < 1) return invalid('expectedRevision must be a positive integer.');
    query.expectedRevision = source['expectedRevision'] as number;
  }
  return query;
}
