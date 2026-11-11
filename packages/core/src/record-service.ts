import { maxPageSize, type RecordPage, type Table } from '../../contracts/src/index.js';

export class ServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export interface RecordStore {
  getTable(): Table;
  readPage(offset: number, limit: number): RecordPage;
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
}
