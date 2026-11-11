export interface Field {
  id: string;
  name: string;
  type: 'text';
}

export interface Table {
  id: string;
  name: string;
  fields: Field[];
  total: number;
}

export interface RowRecord {
  id: string;
  version: number;
  values: Record<string, string | null>;
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
  values: Record<string, string | null>;
}

export interface BatchResult {
  records: RowRecord[];
}

export const maxBatchRecords = 2_000;
export const maxBatchCells = 20_000;
export const maxTextLength = 10_000;
