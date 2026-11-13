import type { WorkspaceApi, TableCreate, TableUpdate, FieldCreate, FieldUpdate, FieldConversion, RecordCreate,
  RecordUpdate, RecordDelete, RecordQuery, ViewCreate, ViewUpdate, ViewPageRequest, SummaryRequest,
  RecordHistoryQuery, RecordRestore, DeletedRecordRestore } from '../../../packages/client/src/index.js';

export class UsageError extends Error {}

export function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UsageError('Provide a JSON object for this command.');
  return input as Record<string, unknown>;
}

interface Command {
  ids: number;
  input: 'none' | 'required' | 'optional';
  run(api: WorkspaceApi, ids: string[], input: unknown): Promise<unknown>;
}

export const commands: Record<string, Command> = {
  'tables list': { ids: 0, input: 'none', run: api => api.listTables() },
  'tables get': { ids: 1, input: 'none', run: (api, [id]) => api.getTable(id!) },
  'tables create': { ids: 0, input: 'required', run: (api, _, input) => api.createTable(input as TableCreate) },
  'tables update': { ids: 1, input: 'required', run: (api, [id], input) => api.updateTable(id!, input as TableUpdate) },
  'tables delete': { ids: 1, input: 'required', run: (api, [id], input) => api.deleteTable(id!, inputObject(input)['expectedVersion'] as number) },
  'fields create': { ids: 1, input: 'required', run: (api, [id], input) => api.createField(id!, input as FieldCreate) },
  'fields update': { ids: 2, input: 'required', run: (api, [id, field], input) => api.updateField(id!, field!, input as FieldUpdate) },
  'fields delete': { ids: 2, input: 'required', run: (api, [id, field], input) => api.deleteField(id!, field!, inputObject(input)['expectedVersion'] as number) },
  'fields preview-conversion': { ids: 2, input: 'required', run: (api, [id, field], input) => api.previewConversion(id!, field!, input as FieldConversion) },
  'fields apply-conversion': { ids: 2, input: 'required', run: (api, [id, field], input) => api.applyConversion(id!, field!, input as FieldConversion) },
  'records get': { ids: 2, input: 'none', run: (api, [id, record]) => api.getRecord(id!, record!) },
  'records history': { ids: 2, input: 'optional', run: (api, [id, record], input) => api.recordHistory(id!, record!, input as RecordHistoryQuery) },
  'records batches': { ids: 1, input: 'optional', run: (api, [id], input) => api.recordBatches(id!, input as RecordHistoryQuery) },
  'records batch-changes': { ids: 2, input: 'optional', run: (api, [id, batch], input) => api.recordBatchChanges(id!, batch!, input as RecordHistoryQuery) },
  'records undo-batch': { ids: 2, input: 'none', run: (api, [id, batch]) => api.undoRecordBatch(id!, batch!) },
  'records change': { ids: 2, input: 'required', run: (api, [id, record], input) => api.recordChange(id!, record!, inputObject(input)['changeId'] as number) },
  'records restore': { ids: 2, input: 'required', run: (api, [id, record], input) => api.restoreRecord(id!, record!, input as RecordRestore) },
  'records trash': { ids: 1, input: 'optional', run: (api, [id], input) => api.recordTrash(id!, input as RecordHistoryQuery) },
  'records restore-deleted': { ids: 1, input: 'required', run: (api, [id], input) => api.restoreDeletedRecords(id!, input as DeletedRecordRestore[]) },
  'records query': { ids: 1, input: 'optional', run: (api, [id], input) => api.queryRecords(id!, input as RecordQuery) },
  'records summarize': { ids: 1, input: 'optional', run: (api, [id], input) => api.summarizeRecords(id!, input as SummaryRequest) },
  'records create': { ids: 1, input: 'required', run: (api, [id], input) => api.createRecords(id!, input as RecordCreate[]) },
  'records update': { ids: 1, input: 'required', run: (api, [id], input) => api.updateRecords(id!, input as RecordUpdate[]) },
  'records delete': { ids: 1, input: 'required', run: (api, [id], input) => api.deleteRecords(id!, input as RecordDelete[]) },
  'views list': { ids: 1, input: 'none', run: (api, [id]) => api.listViews(id!) },
  'views get': { ids: 2, input: 'none', run: (api, [id, view]) => api.getView(id!, view!) },
  'views create': { ids: 1, input: 'required', run: (api, [id], input) => api.createView(id!, input as ViewCreate) },
  'views update': { ids: 2, input: 'required', run: (api, [id, view], input) => api.updateView(id!, view!, input as ViewUpdate) },
  'views delete': { ids: 2, input: 'required', run: (api, [id, view], input) => api.deleteView(id!, view!, inputObject(input)['expectedVersion'] as number) },
  'views query': { ids: 2, input: 'optional', run: (api, [id, view], input) => api.queryView(id!, view!, input as ViewPageRequest) },
};

export const help = `RowWeave CLI

Usage: rowweave <resource> <action> [table-id] [field/record/view-id] [options]

  tables   list | get | create | update | delete
  fields   create | update | delete | preview-conversion | apply-conversion
  records  get | query | summarize | create | update | delete | history | change | restore | trash | restore-deleted | batches | batch-changes | undo-batch
  views    list | get | create | update | delete | query
  csv      preview | import | export

Options:
  --input <file|->   JSON request body from a UTF-8 file or stdin
  --json <text>      JSON request body directly (exclusive with --input)
  --file <file|->    CSV source for preview/import; JSON supplies import options
  --output <file>    CSV export destination; omit to write CSV to stdout
  --url <url>        Service URL (or ROWWEAVE_URL; default http://127.0.0.1:4317)
  --help, -h        Show this help without connecting

Set ROWWEAVE_TOKEN in the environment. Never put tokens in command arguments.
Writes require JSON; queries/export default to {}. Metadata deletion JSON is
{ "expectedVersion": 1 }. Record writes/deletions use arrays of record objects.
CSV options require expectedVersion and hasHeader; mapping is optional.
Do not use stdin for both JSON and CSV in the same command.

Success: JSON on stdout (except CSV export without --output).
Failure: JSON on stderr; exit 2 for usage/input errors, exit 1 otherwise.
Writes are never retried. Inspect service state after an uncertain write result.
API reference: https://github.com/euyuil/rowweave/blob/main/docs/http-api.md
`;
