import {
  tableId, type BatchResult, type ConversionPreview, type DeleteResult, type FieldConversion,
  type FieldCreate, type FieldUpdate, type GridView, type QueryPage, type RecordCreate, type RecordDelete,
  type RecordQuery, type RecordUpdate, type RowRecord, type Table, type TableCreate, type TableUpdate,
  type ViewCreate, type ViewPage, type ViewPageRequest, type ViewUpdate,
  type CsvImportRequest, type CsvPreview, type CsvImportResult, type CsvExportRequest,
} from '../../contracts/src/index.js';
import type { RecordSummary, SummaryRequest, RecordHistoryQuery, RecordHistoryPage, RecordChangeDetail, RecordRestore, RecordTrashPage, DeletedRecordRestore } from '../../contracts/src/index.js';

export interface Connection {
  url: string;
  token: string;
}

export interface TableApi {
  getTable(): Promise<Table>;
  readPage(offset: number, limit: number, query?: TableQuery, signal?: AbortSignal): Promise<QueryPage>;
  save(updates: RecordUpdate[]): Promise<BatchResult>;
}

export interface TableQuery extends RecordQuery {
  view?: Pick<GridView, 'id' | 'version'>;
}

export function queryForView(view: GridView, search = view.query.search ?? ''): TableQuery {
  return { view: { id: view.id, version: view.version }, search,
    fields: view.columns.filter(column => !column.hidden).map(column => column.fieldId) };
}

export class ApiFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export function createWorkspaceClient(connection: Connection, request: typeof fetch = fetch) {
  const base = connection.url.replace(/\/$/, '');
  async function responseFor(path: string, init: RequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(15_000);
    const response = await request(`${base}${path}`, {
      ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const body = await response.json();
      throw new ApiFailure(body.error?.code ?? 'REQUEST_FAILED', body.error?.message ?? 'Request failed.', response.status);
    }
    return response;
  }
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await responseFor(path, init)).json() as Promise<T>;
  }
  const root = (id: string) => `/tables/${encodeURIComponent(id)}`;
  const field = (id: string, fieldId: string) => `${root(id)}/fields/${encodeURIComponent(fieldId)}`;
  const view = (id: string, viewId: string) => `${root(id)}/views/${encodeURIComponent(viewId)}`;
  const record = (id: string, recordId: string) => `${root(id)}/records/${encodeURIComponent(recordId)}`;
  const write = <T>(path: string, method: string, body: unknown, signal?: AbortSignal) =>
    call<T>(path, { method, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  const api = {
    listTables: () => call<Table[]>('/tables'),
    getTable: (id: string) => call<Table>(root(id)),
    createTable: (input: TableCreate) => write<Table>('/tables', 'POST', input),
    updateTable: (id: string, input: TableUpdate) => write<Table>(root(id), 'PATCH', input),
    deleteTable: (id: string, expectedVersion: number) => write<{ deleted: string }>(root(id), 'DELETE', { expectedVersion }),
    createField: (id: string, input: FieldCreate) => write<Table>(`${root(id)}/fields`, 'POST', input),
    updateField: (id: string, fieldId: string, input: FieldUpdate) => write<Table>(field(id, fieldId), 'PATCH', input),
    deleteField: (id: string, fieldId: string, expectedVersion: number) => write<Table>(field(id, fieldId), 'DELETE', { expectedVersion }),
    previewConversion: (id: string, fieldId: string, input: FieldConversion) => write<ConversionPreview>(`${field(id, fieldId)}/conversion/preview`, 'POST', input),
    applyConversion: (id: string, fieldId: string, input: FieldConversion) => write<Table>(`${field(id, fieldId)}/conversion/apply`, 'POST', input),
    getRecord: (id: string, recordId: string) => call<RowRecord>(`${root(id)}/records/${encodeURIComponent(recordId)}`),
    recordHistory: (id: string, recordId: string, query: RecordHistoryQuery = {}) => write<RecordHistoryPage>(`${record(id, recordId)}/history`, 'POST', query),
    recordChange: (id: string, recordId: string, changeId: number) => call<RecordChangeDetail>(`${record(id, recordId)}/history/${changeId}`),
    restoreRecord: (id: string, recordId: string, input: RecordRestore) => write<RowRecord>(`${record(id, recordId)}/restore`, 'POST', input),
    recordTrash: (id: string, query: RecordHistoryQuery = {}) => write<RecordTrashPage>(`${root(id)}/trash/query`, 'POST', query),
    restoreDeletedRecords: (id: string, input: DeletedRecordRestore[]) => write<BatchResult>(`${root(id)}/trash/restore`, 'POST', input),
    queryRecords: (id: string, input: RecordQuery, signal?: AbortSignal) => write<QueryPage>(`${root(id)}/query`, 'POST', input, signal),
    summarizeRecords: (id: string, input: SummaryRequest, signal?: AbortSignal) => write<RecordSummary>(`${root(id)}/summary`, 'POST', input, signal),
    previewCsv: (id: string, input: CsvImportRequest, signal?: AbortSignal) => write<CsvPreview>(`${root(id)}/import/preview`, 'POST', input, signal),
    importCsv: (id: string, input: CsvImportRequest) => write<CsvImportResult>(`${root(id)}/import`, 'POST', input),
    exportCsv: async (id: string, input: CsvExportRequest = {}, signal?: AbortSignal): Promise<string> =>
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(await (await responseFor(`${root(id)}/export`,
        { method: 'POST', body: JSON.stringify(input), ...(signal ? { signal } : {}) })).arrayBuffer()),
    createRecords: (id: string, input: RecordCreate[]) => write<BatchResult>(`${root(id)}/records`, 'POST', input),
    updateRecords: (id: string, input: RecordUpdate[]) => write<BatchResult>(`${root(id)}/records`, 'PATCH', input),
    deleteRecords: (id: string, input: RecordDelete[]) => write<DeleteResult>(`${root(id)}/records`, 'DELETE', input),
    listViews: (id: string) => call<GridView[]>(`${root(id)}/views`),
    getView: (id: string, viewId: string) => call<GridView>(view(id, viewId)),
    createView: (id: string, input: ViewCreate) => write<GridView>(`${root(id)}/views`, 'POST', input),
    updateView: (id: string, viewId: string, input: ViewUpdate) => write<GridView>(view(id, viewId), 'PATCH', input),
    deleteView: (id: string, viewId: string, expectedVersion: number) => write<{ deleted: string }>(view(id, viewId), 'DELETE', { expectedVersion }),
    queryView: (id: string, viewId: string, input: ViewPageRequest, signal?: AbortSignal) => write<ViewPage>(`${view(id, viewId)}/query`, 'POST', input, signal),
    table(id: string): TableApi {
      return {
        getTable: () => api.getTable(id),
        readPage: (offset, limit, query = {}, signal) => {
          if (!query.view) return api.queryRecords(id, { ...query, offset, limit }, signal);
          const { view, filter: _filter, sort: _sort, ...page } = query;
          return api.queryView(id, view.id, { ...page, offset, limit, expectedViewVersion: view.version }, signal);
        },
        save: updates => api.updateRecords(id, updates),
      };
    },
  };
  return api;
}

export type WorkspaceApi = ReturnType<typeof createWorkspaceClient>;

export function createHttpClient(connection: Connection, request: typeof fetch = fetch, id = tableId): TableApi {
  return createWorkspaceClient(connection, request).table(id);
}
