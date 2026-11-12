export type CellValue = string | number | boolean | string[] | null;

export interface SelectOption {
  id: string;
  name: string;
  color?: string;
}

export type FieldType = 'text' | 'multiline' | 'number' | 'checkbox' | 'date' | 'datetime' | 'singleSelect' | 'multiSelect';

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  required?: boolean;
  defaultValue?: CellValue;
  options?: SelectOption[];
  numberFormat?: 'decimal' | 'currency' | 'percent';
  precision?: number;
  currency?: string;
}

export interface Table {
  id: string;
  name: string;
  version: number;
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
  type: FieldType;
  required?: boolean;
  defaultValue?: CellValue;
  options?: Array<Omit<SelectOption, 'id'> & { id?: string }>;
  numberFormat?: Field['numberFormat'];
  precision?: number;
  currency?: string;
}

export type FieldUpdate = SchemaWrite & Partial<Omit<FieldCreate, 'expectedVersion'>>;

export interface FieldConversion extends SchemaWrite {
  field: Omit<FieldCreate, 'expectedVersion'>;
}

export interface ConversionPreview {
  tableId: string;
  fieldId: string;
  schemaVersion: number;
  total: number;
  changed: number;
  invalid: number;
  samples: Array<{ recordId: string; before: CellValue; after: CellValue }>;
  issues: Array<{ recordId: string; message: string }>;
}

export interface RowRecord {
  id: string;
  version: number;
  values: Record<string, CellValue>;
}

export interface RecordPage {
  offset: number;
  records: RowRecord[];
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
}

export const maxBatchRecords = 2_000;
export const maxBatchCells = 20_000;
export const maxTextLength = 10_000;
export const maxFields = 200;
