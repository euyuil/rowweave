import { maxPageSize, maxBatchRecords, maxBatchCells, maxTextLength,
  type BatchResult, type RecordPage, type RecordUpdate, type Table } from '../../contracts/src/index.js';

export class ServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export interface RecordStore {
  getTable(): Table;
  readPage(offset: number, limit: number): RecordPage;
  updateBatch(updates: RecordUpdate[]): BatchResult;
}

export class RecordService {
  constructor(private readonly store: RecordStore) {}

  getTable(): Table {
    return this.store.getTable();
  }

  readPage(offset: number, limit: number): RecordPage {
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) {
      throw new ServiceError('INVALID_PAGE', 'Use a non-negative offset and a limit between 1 and 500.');
    }
    return this.store.readPage(offset, limit);
  }

  updateBatch(input: unknown): BatchResult {
    const invalid = (message: string): never => { throw new ServiceError('INVALID_BATCH', message); };
    if (!Array.isArray(input) || input.length < 1 || input.length > maxBatchRecords) {
      return invalid(`Submit between 1 and ${maxBatchRecords} record updates.`);
    }
    const fieldIds = new Set(this.store.getTable().fields.map(field => field.id));
    const recordIds = new Set<string>();
    let cells = 0;
    const updates: RecordUpdate[] = input.map((update: unknown) => {
      if (!update || typeof update !== 'object' || Array.isArray(update)) return invalid('Invalid record update.');
      const item = update as Record<string, unknown>;
      if (typeof item['id'] !== 'string' || !item['id'] || recordIds.has(item['id'])) {
        return invalid('Record IDs must be non-empty and unique within a batch.');
      }
      recordIds.add(item['id']);
      if (!Number.isSafeInteger(item['expectedVersion']) || (item['expectedVersion'] as number) < 1) {
        return invalid('Each update requires a positive expectedVersion.');
      }
      const values = item['values'];
      if (!values || typeof values !== 'object' || Array.isArray(values)) return invalid('Expected field values.');
      const entries = Object.entries(values);
      if (!entries.length) return invalid('Each update must change at least one field.');
      cells += entries.length;
      if (cells > maxBatchCells) return invalid(`A batch may change at most ${maxBatchCells} cells.`);
      for (const [id, value] of entries) {
        if (!fieldIds.has(id)) return invalid(`Unknown field: ${id}.`);
        if (value !== null && (typeof value !== 'string' || value.length > maxTextLength)) {
          return invalid(`Text values may contain at most ${maxTextLength} characters, or be null.`);
        }
      }
      return { id: item['id'], expectedVersion: item['expectedVersion'] as number,
        values: Object.fromEntries(entries) as RecordUpdate['values'] };
    });
    return this.store.updateBatch(updates);
  }
}
