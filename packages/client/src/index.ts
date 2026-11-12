export { ApiFailure, createWorkspaceClient } from './http-client.js';
export type { Connection, WorkspaceApi, TableApi, TableQuery } from './http-client.js';
export type * from '../../contracts/src/index.js';
export { maxPageSize, maxBatchRecords, maxBatchCells, maxTextLength, maxFields,
  maxCsvBytes, maxCsvRows, maxCsvCells } from '../../contracts/src/index.js';
