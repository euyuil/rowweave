import type { SummaryMeasure, Table } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { schemaObject } from './schema-validation.js';
import { valueField } from '../../contracts/src/index.js';

export interface CheckedSummary {
  groupBy?: string;
  measures: SummaryMeasure[];
}

export function parseSummary(table: Table, input: Record<string, unknown>): CheckedSummary {
  const fields = new Map(table.fields.map(field => [field.id, field]));
  const groupBy = input['groupBy'];
  if (groupBy !== undefined && (typeof groupBy !== 'string' || !fields.has(groupBy) ||
      ['multiSelect', 'relation', 'lookup'].includes(fields.get(groupBy)!.type))) {
    throw new ServiceError('INVALID_SUMMARY', 'Group by a text, number, checkbox, date, timestamp or single-select field.');
  }
  const measures = input['measures'] ?? [];
  if (!Array.isArray(measures) || measures.length > 12) {
    throw new ServiceError('INVALID_SUMMARY', 'Use at most 12 numeric summary measures.');
  }
  const checked = measures.map((value: unknown): SummaryMeasure => {
    const item = schemaObject(value);
    const fieldId = item['fieldId'];
    const operation = item['operation'];
    if (typeof fieldId !== 'string' || !fields.has(fieldId) || valueField(fields.get(fieldId)!).type !== 'number' ||
        !['sum', 'average', 'min', 'max'].includes(operation as string)) {
      throw new ServiceError('INVALID_SUMMARY', 'Each measure needs a numeric field and sum, average, min or max.');
    }
    return { fieldId, operation: operation as SummaryMeasure['operation'] };
  });
  return { ...(groupBy === undefined ? {} : { groupBy: groupBy as string }), measures: checked };
}
