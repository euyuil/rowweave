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
