import { maxPageSize, maxTextLength, maxGroupLevels, valueField, isLookupSummary, supportsScalarGrouping, relativeDatePeriods, maxRelativeDays, maxRelativeHours, dateContextPattern,
  type Field, type FieldFilter, type FilterGroup, type RecordQuery, type RelativeDateFilter, type Table } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { validateValue } from './field-values.js';

export type CheckedQuery = RecordQuery & { offset: number; limit: number };

export function queryValueField(field: Field): Field {
  return valueField(field.type === 'lookup' && !isLookupSummary(field) ? { ...field.lookupResult!, id: field.id, name: field.name, required: false } : field);
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
  if (source['groupBy'] !== undefined) {
    const values = Array.isArray(source['groupBy']) ? source['groupBy'] : [source['groupBy']];
    if (!values.length || values.length > maxGroupLevels || new Set(values).size !== values.length) {
      return invalid(`Group by one to ${maxGroupLevels} distinct scalar fields.`);
    }
    const ids = values.map(value => {
      const selected = field(value);
      if (!supportsScalarGrouping(selected)) return invalid('Group by a text, number, checkbox, date, timestamp or single-select field.');
      return selected.id;
    });
    query.groupBy = ids.length === 1 ? ids[0]! : ids;
  }
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
      if (original.type === 'lookup' && ['multiSelect', 'attachment'].includes(selected.type) && (operator === 'eq' || operator === 'neq')) {
        return invalid('Use hasAny or empty checks for a multiple-value lookup.');
      }
      if (operator === 'isEmpty' || operator === 'isNotEmpty') return { fieldId: selected.id, operator };
      if (operator === 'relativeDate') {
        if (selected.type !== 'date' && selected.type !== 'datetime') return invalid('Relative dates require a date or timestamp field.');
        const relative = object(item['relative']);
        if (!relativeDatePeriods.includes(relative['period'] as RelativeDateFilter['period'])) return invalid('Choose a supported relative date period.');
        const timeZone = relative['timeZone'];
        if (typeof timeZone !== 'string' || !timeZone || /^[+-]/.test(timeZone)) return invalid('Use a named time zone, such as Asia/Shanghai or UTC.');
        try { new Intl.DateTimeFormat('en', { timeZone }); }
        catch { return invalid('Use a valid named time zone, such as Asia/Shanghai or UTC.'); }
        const period = relative['period'] as RelativeDateFilter['period'];
        const business = period === 'pastBusinessDays' || period === 'nextBusinessDays';
        const counted = period === 'pastDays' || period === 'nextDays' || business;
        const rolling = period === 'pastHours' || period === 'nextHours';
        if (rolling && selected.type !== 'datetime') return invalid('Rolling hours require a timestamp field.');
        const days = relative['days'];
        if (counted && (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > maxRelativeDays)) {
          return invalid(`Use between 1 and ${maxRelativeDays} ${business ? 'business' : 'calendar'} days.`);
        }
        if (!counted && days !== undefined) return invalid('Only pastDays, nextDays, pastBusinessDays and nextBusinessDays accept a day count.');
        const hours = relative['hours'];
        if (rolling && (!Number.isSafeInteger(hours) || (hours as number) < 1 || (hours as number) > maxRelativeHours)) {
          return invalid(`Use between 1 and ${maxRelativeHours} elapsed hours.`);
        }
        if (!rolling && hours !== undefined) return invalid('Only pastHours and nextHours accept an hour count.');
        if (item['value'] !== undefined) return invalid('Relative dates use relative settings instead of a fixed value.');
        return { fieldId: selected.id, operator, relative: { period, timeZone,
          ...(counted ? { days: days as number } : {}), ...(rolling ? { hours: hours as number } : {}) } };
      }
      if (operator === 'contains') {
        if (!['text', 'multiline', 'url'].includes(selected.type) || typeof item['value'] !== 'string' || item['value'].length > maxTextLength) {
          return invalid('contains requires a text field and a text value.');
        }
        return { fieldId: selected.id, operator, value: item['value'] };
      }
      if (operator === 'hasAny') {
        if (!['multiSelect', 'relation', 'attachment'].includes(selected.type) || !Array.isArray(item['value'])) return invalid('hasAny requires a select, linked-record or attachment field and IDs.');
      } else if (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') {
        if (!['number', 'date', 'datetime'].includes(selected.type) || item['value'] === null) {
          return invalid('Ordered comparisons require a number, date or timestamp value.');
        }
      } else if (operator !== 'eq' && operator !== 'neq') {
        return invalid('Unknown filter operator.');
      } else if (['multiSelect', 'relation', 'attachment'].includes(selected.type) && item['value'] !== null) {
        return invalid('Use hasAny for select, linked-record or attachment matching.');
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
  if (source['expectedDateContext'] !== undefined) {
    if (typeof source['expectedDateContext'] !== 'string' || !dateContextPattern.test(source['expectedDateContext'])) {
      return invalid('expectedDateContext must be the dateContext returned by the first page or summary.');
    }
    query.expectedDateContext = source['expectedDateContext'];
  }
  return query;
}
