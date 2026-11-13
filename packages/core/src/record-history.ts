import type { RecordHistoryQuery, RecordRestore } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { schemaObject } from './schema-validation.js';

export function historyId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ServiceError('INVALID_HISTORY', 'Use a positive change ID or record version.');
  return value as number;
}

export function parseHistoryQuery(input: unknown): RecordHistoryQuery {
  const item = schemaObject(input);
  const limit = item['limit'] ?? 20;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw new ServiceError('INVALID_HISTORY', 'Read between 1 and 100 history entries at a time.');
  }
  return { limit: limit as number, ...(item['before'] === undefined ? {} : { before: historyId(item['before']) }) };
}

export function parseRecordRestore(input: unknown): RecordRestore {
  const item = schemaObject(input);
  if (item['snapshot'] !== 'before' && item['snapshot'] !== 'after') {
    throw new ServiceError('INVALID_HISTORY', 'Choose the before or after snapshot of a record change.');
  }
  return { changeId: historyId(item['changeId']), snapshot: item['snapshot'], expectedVersion: historyId(item['expectedVersion']) };
}
