import { randomUUID } from 'node:crypto';
import { maxPageSize, maxBatchRecords, maxBatchCells, maxTextLength, maxFields, tableId,
  type BatchResult, type RecordPage, type RecordUpdate, type Table } from '../../contracts/src/index.js';
import { schemaName, schemaObject, schemaVersion } from './schema-validation.js';
import { ServiceError } from './errors.js';
export { ServiceError } from './errors.js';

export interface RecordStore {
  listTables(): Table[];
  getTable(id?: string): Table;
  createTable(table: Table): Table;
  updateSchema(table: Table, expectedVersion: number): Table;
  deleteTable(id: string, expectedVersion: number): void;
  readPage(offset: number, limit: number, id?: string): RecordPage;
  updateBatch(updates: RecordUpdate[], id: string, schemaVersion: number): BatchResult;
}

export class RecordService {
  constructor(private readonly store: RecordStore) {}

  listTables(): Table[] {
    return this.store.listTables();
  }

  getTable(id = tableId): Table {
    return this.store.getTable(id);
  }

  createTable(input: unknown): Table {
    const item = schemaObject(input);
    const fieldId = randomUUID();
    return this.store.createTable({ id: randomUUID(), name: schemaName(item['name']), version: 1,
      primaryFieldId: fieldId, fields: [{ id: fieldId, name: 'Name', type: 'text' }], total: 0 });
  }

  updateTable(id: string, input: unknown): Table {
    const item = schemaObject(input);
    const version = schemaVersion(item['expectedVersion']);
    const table = this.store.getTable(id);
    if (item['name'] !== undefined) table.name = schemaName(item['name']);
    if (item['primaryFieldId'] !== undefined) {
      if (!table.fields.some(field => field.id === item['primaryFieldId'])) {
        throw new ServiceError('INVALID_SCHEMA', 'The primary field must belong to this table.');
      }
      table.primaryFieldId = item['primaryFieldId'] as string;
    }
    if (item['fieldOrder'] !== undefined) {
      const order = item['fieldOrder'];
      if (!Array.isArray(order) || order.length !== table.fields.length || new Set(order).size !== order.length ||
          order.some(id => !table.fields.some(field => field.id === id))) {
        throw new ServiceError('INVALID_SCHEMA', 'fieldOrder must contain every field ID exactly once.');
      }
      const fields = new Map(table.fields.map(field => [field.id, field]));
      table.fields = order.map(id => fields.get(id)!);
    }
    return this.store.updateSchema(table, version);
  }

  deleteTable(id: string, input: unknown): void {
    this.store.deleteTable(id, schemaVersion(schemaObject(input)['expectedVersion']));
  }

  createField(id: string, input: unknown): Table {
    const item = schemaObject(input);
    const version = schemaVersion(item['expectedVersion']);
    const table = this.store.getTable(id);
    if (table.fields.length >= maxFields) throw new ServiceError('INVALID_SCHEMA', `A table supports up to ${maxFields} fields.`);
    if (item['type'] !== 'text') throw new ServiceError('INVALID_SCHEMA', 'This field type is not supported.');
    table.fields.push({ id: randomUUID(), name: schemaName(item['name']), type: 'text' });
    return this.store.updateSchema(table, version);
  }

  updateField(id: string, fieldId: string, input: unknown): Table {
    const item = schemaObject(input);
    const version = schemaVersion(item['expectedVersion']);
    const table = this.store.getTable(id);
    const field = table.fields.find(field => field.id === fieldId);
    if (!field) throw new ServiceError('FIELD_NOT_FOUND', 'This field does not exist.', 404);
    if (item['type'] !== undefined && item['type'] !== 'text') {
      throw new ServiceError('INVALID_SCHEMA', 'This field type is not supported.');
    }
    field.name = schemaName(item['name']);
    return this.store.updateSchema(table, version);
  }

  deleteField(id: string, fieldId: string, input: unknown): Table {
    const version = schemaVersion(schemaObject(input)['expectedVersion']);
    const table = this.store.getTable(id);
    if (!table.fields.some(field => field.id === fieldId)) throw new ServiceError('FIELD_NOT_FOUND', 'This field does not exist.', 404);
    if (table.primaryFieldId === fieldId) throw new ServiceError('INVALID_SCHEMA', 'Choose another primary field before deleting this field.');
    table.fields = table.fields.filter(field => field.id !== fieldId);
    return this.store.updateSchema(table, version);
  }

  readPage(offset: number, limit: number, id = tableId): RecordPage {
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) {
      throw new ServiceError('INVALID_PAGE', 'Use a non-negative offset and a limit between 1 and 500.');
    }
    this.store.getTable(id);
    return this.store.readPage(offset, limit, id);
  }

  updateBatch(input: unknown, id = tableId): BatchResult {
    const invalid = (message: string): never => { throw new ServiceError('INVALID_BATCH', message); };
    if (!Array.isArray(input) || input.length < 1 || input.length > maxBatchRecords) {
      return invalid(`Submit between 1 and ${maxBatchRecords} record updates.`);
    }
    const table = this.store.getTable(id);
    const fieldIds = new Set(table.fields.map(field => field.id));
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
    return this.store.updateBatch(updates, id, table.version);
  }
}
