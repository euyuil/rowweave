import { randomUUID } from 'node:crypto';
import { maxPageSize, maxBatchRecords, maxBatchCells, maxFields, tableId,
  type BatchResult, type CellValue, type DeleteResult, type RecordDelete, type RecordPage, type RecordUpdate, type RowRecord, type Table } from '../../contracts/src/index.js';
import { schemaName, schemaObject, schemaVersion } from './schema-validation.js';
import { parseField } from './field-schema.js';
import { validateValue } from './field-values.js';
import { ServiceError } from './errors.js';
export { ServiceError } from './errors.js';

export interface RecordStore {
  listTables(): Table[];
  getTable(id?: string): Table;
  createTable(table: Table): Table;
  updateSchema(table: Table, expectedVersion: number, validateRecord?: (record: RowRecord) => void): Table;
  deleteTable(id: string, expectedVersion: number): void;
  readPage(offset: number, limit: number, id?: string): RecordPage;
  updateBatch(updates: RecordUpdate[], id: string, schemaVersion: number): BatchResult;
  getRecord(tableId: string, recordId: string): RowRecord;
  createRecords(table: Table, values: Array<Record<string, CellValue>>): BatchResult;
  deleteRecords(tableId: string, records: RecordDelete[]): DeleteResult;
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
    const field = parseField(item);
    table.fields.push(field);
    return this.store.updateSchema(table, version, field.required ? () => {
      throw new ServiceError('INVALID_SCHEMA', 'Add this field as optional, fill existing records, then make it required.');
    } : undefined);
  }

  updateField(id: string, fieldId: string, input: unknown): Table {
    const item = schemaObject(input);
    const version = schemaVersion(item['expectedVersion']);
    const table = this.store.getTable(id);
    const previous = table.fields.find(field => field.id === fieldId);
    if (!previous) throw new ServiceError('FIELD_NOT_FOUND', 'This field does not exist.', 404);
    const field = parseField(item, previous);
    if (field.type !== previous.type) {
      throw new ServiceError('CONVERSION_REQUIRED', 'Field type changes require an explicit conversion.');
    }
    table.fields = table.fields.map(current => current.id === fieldId ? field : current);
    const changedConstraints = (field.required === true && previous.required !== true) ||
      previous.options?.some(option => !field.options!.some(next => next.id === option.id));
    return this.store.updateSchema(table, version, changedConstraints ? record => {
      try { validateValue(field, record.values[fieldId] ?? null); }
      catch (error) {
        if (error instanceof ServiceError) throw new ServiceError(error.code, `Record ${record.id}: ${error.message}`);
        throw error;
      }
    } : undefined);
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
    const fields = new Map(table.fields.map(field => [field.id, field]));
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
      const checked = Object.fromEntries(entries.map(([id, value]) => {
        const field = fields.get(id);
        if (!field) return invalid(`Unknown field: ${id}.`);
        return [id, validateValue(field, value)];
      }));
      return { id: item['id'], expectedVersion: item['expectedVersion'] as number,
        values: checked };
    });
    return this.store.updateBatch(updates, id, table.version);
  }

  getRecord(id: string, recordId: string): RowRecord {
    this.store.getTable(id);
    return this.store.getRecord(id, recordId);
  }

  createRecords(id: string, input: unknown): BatchResult {
    if (!Array.isArray(input) || input.length < 1 || input.length > maxBatchRecords) {
      throw new ServiceError('INVALID_BATCH', `Create between 1 and ${maxBatchRecords} records at a time.`);
    }
    const table = this.store.getTable(id);
    const fields = new Map(table.fields.map(field => [field.id, field]));
    let cells = 0;
    const records = input.map((entry: unknown, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ServiceError('INVALID_BATCH', 'Expected record objects.');
      const values = (entry as Record<string, unknown>)['values'];
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ServiceError('INVALID_BATCH', 'Expected field values.');
      for (const key of Object.keys(values)) if (!fields.has(key)) throw new ServiceError('INVALID_BATCH', `Unknown field: ${key}.`);
      const result: Record<string, CellValue> = {};
      for (const field of table.fields) {
        const provided = (values as Record<string, unknown>)[field.id];
        const value = provided === undefined ? field.defaultValue ?? null : provided;
        try { result[field.id] = validateValue(field, value); }
        catch (error) {
          if (error instanceof ServiceError) throw new ServiceError(error.code, `Row ${index + 1}: ${error.message}`);
          throw error;
        }
      }
      cells += table.fields.length;
      if (cells > maxBatchCells) throw new ServiceError('INVALID_BATCH', `A batch may create at most ${maxBatchCells} cells.`);
      return result;
    });
    return this.store.createRecords(table, records);
  }

  deleteRecords(id: string, input: unknown): DeleteResult {
    if (!Array.isArray(input) || input.length < 1 || input.length > maxBatchRecords) {
      throw new ServiceError('INVALID_BATCH', `Delete between 1 and ${maxBatchRecords} records at a time.`);
    }
    this.store.getTable(id);
    const ids = new Set<string>();
    const records = input.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ServiceError('INVALID_BATCH', 'Expected record objects.');
      const item = entry as Record<string, unknown>;
      if (typeof item['id'] !== 'string' || !item['id'] || ids.has(item['id']) ||
          !Number.isSafeInteger(item['expectedVersion']) || (item['expectedVersion'] as number) < 1) {
        throw new ServiceError('INVALID_BATCH', 'Each deletion requires a unique record ID and positive expectedVersion.');
      }
      ids.add(item['id']);
      return { id: item['id'], expectedVersion: item['expectedVersion'] as number };
    });
    return this.store.deleteRecords(id, records);
  }
}
