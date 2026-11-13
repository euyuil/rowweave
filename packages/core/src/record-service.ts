import { randomUUID } from 'node:crypto';
import { maxPageSize, maxBatchRecords, maxBatchCells, maxFields, tableId,
  type BatchResult, type CellValue, type ConversionPreview, type DeleteResult, type Field, type GridView, type QueryPage, type RecordDelete, type RecordPage, type RecordUpdate, type RowRecord, type Table, type ViewPage } from '../../contracts/src/index.js';
import { schemaName, schemaObject, schemaVersion } from './schema-validation.js';
import { parseField } from './field-schema.js';
import { validateValue } from './field-values.js';
import { convertValue } from './field-conversion.js';
import { parseQuery, type CheckedQuery } from './record-query.js';
import { parseView } from './grid-views.js';
import { ServiceError } from './errors.js';
import { prepareCsvImport, type CheckedCsvImport } from './csv.js';
import { parseSummary, type CheckedSummary } from './record-summary.js';
import type { RecordSummary, RecordHistoryQuery, RecordHistoryPage, RecordChangeDetail, RecordRestore } from '../../contracts/src/index.js';
import { historyId, parseHistoryQuery, parseRecordRestore } from './record-history.js';
import type { CsvImportResult, CsvPreview } from '../../contracts/src/index.js';
export { ServiceError } from './errors.js';

export interface RecordStore {
  listTables(): Table[];
  getTable(id?: string): Table;
  createTable(table: Table): Table;
  updateSchema(table: Table, expectedVersion: number, validateRecord?: (record: RowRecord) => void): Table;
  createReciprocalFields(table: Table, target: Table, validateRecord?: (record: RowRecord) => void): Table;
  deleteTable(id: string, expectedVersion: number): void;
  readPage(offset: number, limit: number, id?: string): RecordPage;
  updateBatch(updates: RecordUpdate[], id: string, schemaVersion: number): BatchResult;
  getRecord(tableId: string, recordId: string): RowRecord;
  createRecords(table: Table, values: Array<Record<string, CellValue>>): BatchResult;
  deleteRecords(tableId: string, records: RecordDelete[]): DeleteResult;
  recordHistory(tableId: string, recordId: string, query: RecordHistoryQuery): RecordHistoryPage;
  recordChange(tableId: string, recordId: string, changeId: number): RecordChangeDetail;
  restoreRecord(update: RecordUpdate, tableId: string, schemaVersion: number, source: RecordRestore): RowRecord;
  previewConversion(tableId: string, version: number, field: Field, convert: (value: CellValue) => CellValue): ConversionPreview;
  applyConversion(tableId: string, version: number, field: Field, convert: (value: CellValue) => CellValue): Table;
  queryRecords(table: Table, query: CheckedQuery, view?: GridView): QueryPage;
  summarizeRecords(table: Table, query: CheckedQuery, summary: CheckedSummary, view?: GridView): RecordSummary;
  listViews(tableId: string): GridView[];
  getView(tableId: string, viewId: string): GridView;
  saveView(table: Table, view: GridView, expectedVersion?: number): GridView;
  deleteView(tableId: string, viewId: string, expectedVersion: number): void;
  importCsv(table: Table, plan: CheckedCsvImport, apply: boolean): CsvPreview;
  exportCsv(table: Table, query: CheckedQuery, view?: GridView): string;
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
    return this.store.createTable({ id: randomUUID(), name: schemaName(item['name']), version: 1, revision: 1,
      primaryFieldId: fieldId, fields: [{ id: fieldId, name: 'Name', type: 'text' }], total: 0 });
  }

  updateTable(id: string, input: unknown): Table {
    const item = schemaObject(input);
    const version = schemaVersion(item['expectedVersion']);
    const table = this.store.getTable(id);
    if (item['name'] !== undefined) table.name = schemaName(item['name']);
    if (item['primaryFieldId'] !== undefined) {
      if (!table.fields.some(field => field.id === item['primaryFieldId'])) {
        throw new ServiceError('INVALID_SCHEMA', 'The primary display field must belong to this table.');
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
    const validateRecord = field.required ? () => {
      throw new ServiceError('INVALID_SCHEMA', 'Add this field as optional, fill existing records, then make it required.');
    } : undefined;
    if (item['reverseField'] !== undefined) {
      if (field.type !== 'relation') throw new ServiceError('INVALID_SCHEMA', 'Only linked-record fields can create a reverse field.');
      const reverse = schemaObject(item['reverseField']);
      const target = field.relation!.tableId === id ? table : this.store.getTable(field.relation!.tableId);
      if (table.version !== version || target.version !== schemaVersion(reverse['expectedVersion'])) {
        throw new ServiceError('SCHEMA_CONFLICT', 'A table schema changed. Reload both tables before creating linked fields.', 409);
      }
      if (target.fields.length >= maxFields) throw new ServiceError('INVALID_SCHEMA', `A table supports up to ${maxFields} fields.`);
      const inverse = parseField({ name: reverse['name'], type: 'relation', relation: { tableId: id, multiple: reverse['multiple'] } });
      field.relation!.inverseFieldId = inverse.id;
      inverse.relation!.inverseFieldId = field.id;
      target.fields.push(inverse);
      return this.store.createReciprocalFields(table, target, validateRecord);
    }
    return this.store.updateSchema(table, version, validateRecord);
  }

  updateField(id: string, fieldId: string, input: unknown): Table {
    const item = schemaObject(input);
    if (item['reverseField'] !== undefined) throw new ServiceError('INVALID_SCHEMA', 'Create a new linked field to add a reverse field.');
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
      (field.type === 'relation' && !field.relation!.multiple && previous.relation!.multiple) ||
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
    if (table.primaryFieldId === fieldId) throw new ServiceError('INVALID_SCHEMA', 'Choose another primary display field before deleting this field.');
    table.fields = table.fields.filter(field => field.id !== fieldId);
    return this.store.updateSchema(table, version);
  }

  private conversion(id: string, fieldId: string, input: unknown) {
    const item = schemaObject(input);
    const version = schemaVersion(item['expectedVersion']);
    const table = this.store.getTable(id);
    if (table.version !== version) throw new ServiceError('SCHEMA_CONFLICT', 'The table schema changed. Reload it before trying again.', 409);
    const previous = table.fields.find(field => field.id === fieldId);
    if (!previous) throw new ServiceError('FIELD_NOT_FOUND', 'This field does not exist.', 404);
    const config = schemaObject(item['field']);
    const field = parseField(config, { id: previous.id, name: previous.name, type: previous.type });
    if (['relation', 'lookup', 'formula'].includes(previous.type) || ['relation', 'lookup', 'formula'].includes(field.type)) {
      throw new ServiceError('CONVERSION_REQUIRED', 'Create linked-record and lookup fields explicitly; they cannot be converted to another type.');
    }
    return { version, field, convert: (value: CellValue) => convertValue(previous, field, value) };
  }

  previewConversion(id: string, fieldId: string, input: unknown): ConversionPreview {
    const { version, field, convert } = this.conversion(id, fieldId, input);
    return this.store.previewConversion(id, version, field, convert);
  }

  applyConversion(id: string, fieldId: string, input: unknown): Table {
    const { version, field, convert } = this.conversion(id, fieldId, input);
    return this.store.applyConversion(id, version, field, convert);
  }

  readPage(offset: number, limit: number, id = tableId): RecordPage {
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) {
      throw new ServiceError('INVALID_PAGE', 'Use a non-negative offset and a limit between 1 and 500.');
    }
    this.store.getTable(id);
    return this.store.readPage(offset, limit, id);
  }

  queryRecords(id: string, input: unknown): QueryPage {
    const table = this.store.getTable(id);
    return this.store.queryRecords(table, parseQuery(table, input));
  }

  previewCsv(id: string, input: unknown): CsvPreview {
    const table = this.store.getTable(id);
    return this.store.importCsv(table, prepareCsvImport(table, input), false);
  }

  summarizeRecords(id: string, input: unknown): RecordSummary {
    const table = this.store.getTable(id);
    const item = schemaObject(input);
    if (item['viewId'] !== undefined && (typeof item['viewId'] !== 'string' || !item['viewId'])) {
      throw new ServiceError('INVALID_SUMMARY', 'viewId must be a non-empty string.');
    }
    const view = item['viewId'] === undefined ? undefined : this.store.getView(id, item['viewId'] as string);
    if (item['expectedViewVersion'] !== undefined && (!view || schemaVersion(item['expectedViewVersion']) !== view.version)) {
      throw new ServiceError('VIEW_CONFLICT', 'The view changed. Refresh before summarizing.', 409);
    }
    if (view && item['filter'] !== undefined) throw new ServiceError('INVALID_SUMMARY', 'Use the saved view filter or an explicit filter, not both.');
    const query = parseQuery(table, { filter: view?.query.filter ?? item['filter'],
      search: item['search'] === undefined ? view?.query.search : item['search'],
      offset: item['offset'], limit: item['limit'], expectedRevision: item['expectedRevision'], expectedDateContext: item['expectedDateContext'] });
    return this.store.summarizeRecords(table, query, parseSummary(table, item), view);
  }

  importCsv(id: string, input: unknown): CsvImportResult {
    const table = this.store.getTable(id);
    const plan = prepareCsvImport(table, input);
    if (!plan.validated) throw new ServiceError('INVALID_CSV', 'Map at least one column to a writable field before importing.');
    return { imported: this.store.importCsv(table, plan, true).total };
  }

  exportCsv(id: string, input: unknown): string {
    const table = this.store.getTable(id);
    const item = schemaObject(input);
    if (item['viewId'] !== undefined && (typeof item['viewId'] !== 'string' || !item['viewId'])) {
      throw new ServiceError('INVALID_QUERY', 'viewId must be a non-empty string.');
    }
    const view = item['viewId'] === undefined ? undefined : this.store.getView(id, item['viewId'] as string);
    if (item['expectedViewVersion'] !== undefined && (!view || schemaVersion(item['expectedViewVersion']) !== view.version)) {
      throw new ServiceError('VIEW_CONFLICT', 'The view changed. Refresh before exporting.', 409);
    }
    const query = parseQuery(table, { ...view?.query,
      fields: view?.columns.filter(column => !column.hidden).map(column => column.fieldId),
      search: item['search'] === undefined ? view?.query.search : item['search'] });
    return this.store.exportCsv(table, query, view);
  }

  listViews(id: string): GridView[] {
    this.store.getTable(id);
    return this.store.listViews(id);
  }

  getView(id: string, viewId: string): GridView {
    this.store.getTable(id);
    return this.store.getView(id, viewId);
  }

  createView(id: string, input: unknown): GridView {
    const table = this.store.getTable(id);
    const item = schemaObject(input);
    schemaName(item['name']);
    return this.store.saveView(table, parseView(table, item));
  }

  updateView(id: string, viewId: string, input: unknown): GridView {
    const table = this.store.getTable(id);
    const item = schemaObject(input);
    const version = schemaVersion(item['expectedVersion']);
    const previous = this.store.getView(id, viewId);
    if (previous.version !== version) throw new ServiceError('VIEW_CONFLICT', 'This view changed. Reload before saving again.', 409);
    return this.store.saveView(table, parseView(table, item, previous), version);
  }

  deleteView(id: string, viewId: string, input: unknown): void {
    this.store.deleteView(id, viewId, schemaVersion(schemaObject(input)['expectedVersion']));
  }

  queryView(id: string, viewId: string, input: unknown): ViewPage {
    const item = schemaObject(input);
    const table = this.store.getTable(id);
    const view = this.store.getView(id, viewId);
    if (item['expectedViewVersion'] !== undefined && schemaVersion(item['expectedViewVersion']) !== view.version) {
      throw new ServiceError('VIEW_CONFLICT', 'This view changed. Refresh before continuing.', 409);
    }
    const query = parseQuery(table, { ...view.query, offset: item['offset'], limit: item['limit'],
      fields: item['fields'] === undefined ? view.columns.filter(column => !column.hidden).map(column => column.fieldId) : item['fields'],
      expectedRevision: item['expectedRevision'], expectedDateContext: item['expectedDateContext'], search: item['search'] === undefined ? view.query.search : item['search'] });
    if (item['lane'] !== undefined) {
      if (view.type !== 'board') throw new ServiceError('INVALID_QUERY', 'Lane queries require a board view.');
      const group = table.fields.find(field => field.id === view.groupBy)!;
      const lane = item['lane'];
      if (lane !== null && (typeof lane !== 'string' || !group.options!.some(option => option.id === lane))) {
        throw new ServiceError('INVALID_QUERY', 'Choose a current board option ID or null for records without a value.');
      }
      query.filter = { conjunction: 'and', conditions: [...(query.filter ? [query.filter] : []),
        { fieldId: group.id, operator: 'eq', value: lane as string | null }] };
    }
    return { ...this.store.queryRecords(table, query, view), viewId, viewVersion: view.version };
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

  recordHistory(id: string, recordId: string, input: unknown): RecordHistoryPage {
    this.store.getTable(id);
    return this.store.recordHistory(id, recordId, parseHistoryQuery(input));
  }

  recordChange(id: string, recordId: string, changeId: unknown): RecordChangeDetail {
    this.store.getTable(id);
    return this.store.recordChange(id, recordId, historyId(changeId));
  }

  restoreRecord(id: string, recordId: string, input: unknown): RowRecord {
    const restore = parseRecordRestore(input);
    const table = this.store.getTable(id);
    const snapshot = this.store.recordChange(id, recordId, restore.changeId)[restore.snapshot];
    if (!snapshot) throw new ServiceError('INVALID_HISTORY', 'The record does not exist in this snapshot.');
    const values = Object.fromEntries(table.fields.filter(field => !['lookup', 'formula'].includes(field.type) && Object.hasOwn(snapshot.values, field.id))
      .map(field => [field.id, validateValue(field, snapshot.values[field.id])]));
    if (!Object.keys(values).length) throw new ServiceError('INVALID_HISTORY', 'This snapshot has no current writable fields to restore.');
    return this.store.restoreRecord({ id: recordId, expectedVersion: restore.expectedVersion, values }, id, table.version, restore);
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
        if ((field.type === 'lookup' || field.type === 'formula')) {
          if (Object.hasOwn(values, field.id)) throw new ServiceError('READ_ONLY_FIELD', `${field.name}: computed values are read-only.`);
          continue;
        }
        const provided = (values as Record<string, unknown>)[field.id];
        const value = provided === undefined ? field.defaultValue ?? null : provided;
        try { result[field.id] = validateValue(field, value); }
        catch (error) {
          if (error instanceof ServiceError) throw new ServiceError(error.code, `Row ${index + 1}: ${error.message}`);
          throw error;
        }
      }
      cells += Object.keys(result).length;
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
