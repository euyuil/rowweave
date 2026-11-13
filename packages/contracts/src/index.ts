export type ScalarValue = string | number | boolean | null;
export type CellValue = ScalarValue | ScalarValue[];

export const maxAttachmentBytes = 8 * 1024 * 1024;
export const maxAttachmentsPerCell = 20;
export interface AttachmentUpload { filename: string; mediaType: string; data: string }
export interface Attachment {
  id: string;
  tableId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
}
export interface AttachmentQuery { before?: number; limit?: number }
export interface AttachmentPage { attachments: Attachment[]; nextBefore?: number }

export interface SelectOption {
  id: string;
  name: string;
  color?: string;
}

export type FieldType = 'text' | 'multiline' | 'url' | 'attachment' | 'number' | 'autoNumber' | 'createdTime' | 'updatedTime' | 'checkbox' | 'date' | 'datetime' | 'singleSelect' | 'multiSelect' | 'relation' | 'lookup' | 'formula';

export interface Field {
  id: string;
  name: string;
  description?: string;
  type: FieldType;
  required?: boolean;
  defaultValue?: CellValue;
  options?: SelectOption[];
  numberFormat?: 'decimal' | 'currency' | 'percent';
  precision?: number;
  currency?: string;
  relation?: { tableId: string; multiple: boolean; inverseFieldId?: string };
  lookup?: { relationFieldId: string; fieldId: string; operation?: 'values' | 'count' | 'sum' | 'average' | 'min' | 'max' };
  formula?: { expression: string; resultType: 'number' | 'text' | 'checkbox' };
  // Resolved from the current target schema; not writable field configuration.
  lookupResult?: Field;
}

export interface Table {
  id: string;
  name: string;
  version: number;
  revision: number;
  primaryFieldId: string;
  fields: Field[];
  total: number;
}

export interface TableCreate {
  name: string;
}

export interface SchemaWrite {
  expectedVersion: number;
}

export interface TableUpdate extends SchemaWrite {
  name?: string;
  primaryFieldId?: string;
  fieldOrder?: string[];
}

export interface FieldCreate extends SchemaWrite {
  name: string;
  description?: string;
  type: FieldType;
  required?: boolean;
  defaultValue?: CellValue;
  options?: Array<Omit<SelectOption, 'id'> & { id?: string }>;
  numberFormat?: Field['numberFormat'];
  precision?: number;
  currency?: string;
  relation?: Field['relation'];
  reverseField?: { name: string; multiple: boolean; expectedVersion: number };
  lookup?: Field['lookup'];
  formula?: Field['formula'];
}

export type FieldUpdate = SchemaWrite & Partial<Omit<FieldCreate, 'expectedVersion' | 'precision' | 'reverseField'>> & { precision?: number | null };

export interface FieldConversion extends SchemaWrite {
  field: Omit<FieldCreate, 'expectedVersion' | 'reverseField'>;
}

export interface ConversionPreview {
  tableId: string;
  fieldId: string;
  field: Field;
  schemaVersion: number;
  total: number;
  changed: number;
  invalid: number;
  samples: Array<{ recordId: string; before: CellValue; after: CellValue }>;
  issues: Array<{ recordId: string; message: string }>;
}

export interface RecordLink { id: string; label: string }

export interface RowRecord {
  id: string;
  version: number;
  values: Record<string, CellValue>;
  links?: Record<string, RecordLink[]>;
  attachments?: Record<string, Attachment[]>;
  formulaErrors?: Record<string, string>;
}

export interface RecordChange {
  id: number;
  batchId: string;
  recordId: string;
  changedAt: string;
  beforeVersion: number | null;
  afterVersion: number | null;
  restoredFrom?: { changeId: number; snapshot: 'before' | 'after' };
}

export interface RecordChangeDetail extends RecordChange {
  before: RowRecord | null;
  after: RowRecord | null;
}

export interface RecordHistoryQuery { before?: number; limit?: number }
export interface RecordHistoryPage { changes: RecordChange[]; nextBefore?: number }
export interface RecordRestore {
  changeId: number;
  snapshot: 'before' | 'after';
  expectedVersion: number;
}

export interface DeletedRecord {
  id: string;
  deletionId: number;
  batchId: string;
  deletedAt: string;
  version: number;
  displayValue: CellValue;
}
export interface RecordTrashPage { records: DeletedRecord[]; nextBefore?: number }
export interface DeletedRecordRestore { id: string; deletionId: number; values?: Record<string, CellValue> }

export interface RecordBatch {
  sequence: number;
  id: string;
  changedAt: string;
  recordCount: number;
  remainingCount: number;
  recordWrite: boolean;
  undoOf?: string;
}
export interface RecordBatchPage { batches: RecordBatch[]; nextBefore?: number }
export interface RecordBatchChange extends RecordChange { tableId: string }
export interface RecordBatchChanges { batch: RecordBatch; changes: RecordBatchChange[]; nextBefore?: number }
export interface RecordBatchUndoResult { batchId: string; undoneBatchId: string }

export function valueField(field: Field): Field {
  if (field.type === 'autoNumber') return { ...field, type: 'number' };
  if (field.type === 'createdTime' || field.type === 'updatedTime') return { ...field, type: 'datetime' };
  if (isLookupSummary(field)) return field.lookup!.operation === 'count' ? { id: field.id, name: field.name, type: 'number' }
    : { ...valueField(field.lookupResult!), id: field.id, name: field.name, required: false };
  return field.type === 'formula' ? { ...field, type: field.formula!.resultType } : field;
}

export function isReadOnlyField(field: Pick<Field, 'type'>): boolean {
  return field.type === 'lookup' || field.type === 'formula' || field.type === 'autoNumber' || field.type === 'createdTime' || field.type === 'updatedTime';
}

export function isLookupSummary(field: Field): boolean {
  return field.type === 'lookup' && field.lookup!.operation !== undefined && field.lookup!.operation !== 'values';
}

export interface RecordPage {
  offset: number;
  records: RowRecord[];
}

export const relativeDatePeriods = ['today', 'yesterday', 'tomorrow', 'thisWeek', 'lastWeek', 'nextWeek', 'thisMonth', 'lastMonth', 'nextMonth', 'pastDays', 'nextDays'] as const;
export const maxRelativeDays = 3660;
export interface RelativeDateFilter {
  period: typeof relativeDatePeriods[number];
  timeZone: string;
  days?: number;
}

export type FilterOperator = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'isEmpty' | 'isNotEmpty' | 'hasAny' | 'relativeDate';

export interface FieldFilter {
  fieldId: string;
  operator: FilterOperator;
  value?: CellValue;
  relative?: RelativeDateFilter;
}

export interface FilterGroup {
  conjunction: 'and' | 'or';
  conditions: Array<FieldFilter | FilterGroup>;
}

export interface SortRule {
  fieldId: string;
  direction: 'asc' | 'desc';
}

export interface RecordQuery {
  recordIds?: string[];
  offset?: number;
  limit?: number;
  filter?: FilterGroup;
  sort?: SortRule[];
  search?: string;
  fields?: string[];
  expectedRevision?: number;
  expectedDateContext?: string;
}

export interface QueryPage extends RecordPage {
  total: number;
  revision: number;
  schemaVersion: number;
  dateContext?: string;
}

export interface SummaryMeasure {
  fieldId: string;
  operation: 'sum' | 'average' | 'min' | 'max';
}

export interface SummaryRequest {
  viewId?: string;
  expectedViewVersion?: number;
  filter?: FilterGroup;
  search?: string;
  groupBy?: string;
  measures?: SummaryMeasure[];
  offset?: number;
  limit?: number;
  expectedRevision?: number;
  expectedDateContext?: string;
}

export interface SummaryValues {
  count: number;
  values: Array<number | null>;
}

export interface RecordSummary {
  totals: SummaryValues;
  groups: Array<SummaryValues & { key: CellValue; label: string }>;
  groupCount: number;
  offset: number;
  revision: number;
  schemaVersion: number;
  dateContext?: string;
}

export interface ViewColumn {
  fieldId: string;
  width: number;
  hidden: boolean;
}

export type ViewQuery = Pick<RecordQuery, 'filter' | 'sort' | 'search'>;
export type RowHeight = 36 | 48 | 64;

export interface GridView {
  id: string;
  tableId: string;
  name: string;
  version: number;
  query: ViewQuery;
  columns: ViewColumn[];
  rowHeight: RowHeight;
  frozenColumns: number;
  type: 'grid' | 'board';
  groupBy?: string;
}

export interface ViewCreate {
  name: string;
  query?: ViewQuery;
  columns?: ViewColumn[];
  rowHeight?: RowHeight;
  frozenColumns?: number;
  type?: 'grid' | 'board';
  groupBy?: string | null;
}

export interface ViewUpdate extends Partial<ViewCreate> {
  expectedVersion: number;
}

export interface ViewPageRequest extends Pick<RecordQuery, 'offset' | 'limit' | 'fields' | 'expectedRevision' | 'expectedDateContext' | 'search'> {
  expectedViewVersion?: number;
  lane?: string | null;
}

export interface ViewPage extends QueryPage {
  viewId: string;
  viewVersion: number;
}

export interface ApiError {
  error: { code: string; message: string };
}

export const tableId = 'prototype';
export const maxPageSize = 500;

export interface RecordUpdate {
  id: string;
  expectedVersion: number;
  values: Record<string, CellValue>;
}

export interface RecordCreate {
  values: Record<string, CellValue>;
}

export interface RecordDelete {
  id: string;
  expectedVersion: number;
}

export interface DeleteResult {
  deleted: string[];
}

export interface BatchResult {
  records: RowRecord[];
  batchId?: string;
}

export const maxBatchRecords = 2_000;
export const maxBatchCells = 20_000;
export const maxTextLength = 10_000;
export const maxUrlLength = 2_048;
export const maxFields = 200;

export const maxCsvBytes = 32 * 1024 * 1024;
export const maxCsvRows = 100_000;
export const maxCsvCells = 2_000_000;

export interface CsvImportRequest extends SchemaWrite {
  csv: string;
  hasHeader: boolean;
  // One entry per source column; null skips that column.
  mapping?: Array<string | null>;
}

export interface CsvPreview {
  tableId: string;
  schemaVersion: number;
  columns: string[];
  mapping: Array<string | null>;
  validated: boolean;
  total: number;
  invalid: number;
  samples: Array<{ row: number; cells: Array<string | null> }>;
  issues: Array<{ row: number; code: string; message: string }>;
}

export interface CsvImportResult {
  imported: number;
}

export interface CsvExportRequest {
  viewId?: string;
  expectedViewVersion?: number;
  search?: string;
}
