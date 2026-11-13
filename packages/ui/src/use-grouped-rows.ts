import { useEffect, useMemo, useState } from 'react';
import type { GridView, QueryPage, RecordSummary, Table } from '../../contracts/src/index.js';
import type { TableModel } from '../../client/src/table-model.js';
import { ApiFailure, type WorkspaceApi } from '../../client/src/http-client.js';
import { GroupedRows } from '../../client/src/grouped-rows.js';

const summaryKey = (model: TableModel, view: GridView | undefined, search: string) =>
  JSON.stringify([view?.id, view?.version, model.queryVersion, model.table?.version, model.dataRevision, model.dateContext, search]);
const collapseKey = (view: GridView) => `${view.id}:${view.groupBy}`;

async function readSummary(api: WorkspaceApi, table: Table, view: GridView, revision: number,
  dateContext: string | undefined, search: string, signal: AbortSignal): Promise<RecordSummary> {
  const result = await api.summarizeRecords(table.id, { viewId: view.id, expectedViewVersion: view.version,
    expectedRevision: revision, ...(dateContext ? { expectedDateContext: dateContext } : {}), groupBy: view.groupBy!, search, limit: 500 }, signal);
  if (result.schemaVersion !== table.version) throw new ApiFailure('SCHEMA_CONFLICT', 'The table schema changed. Reload to see the current groups.', 409);
  return result;
}

export function useGroupedRows(model: TableModel, api: WorkspaceApi, view: GridView | undefined, search: string) {
  const table = model.table;
  const revision = model.dataRevision;
  const dateContext = model.dateContext;
  const enabled = view?.type === 'grid' && !!view.groupBy;
  const key = summaryKey(model, view, search);
  const namespace = view ? collapseKey(view) : '';
  const [summaries, setSummary] = useState<{ key: string; value: RecordSummary }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [collapsed, setCollapsed] = useState(new Map<string, ReadonlySet<string>>());
  useEffect(() => {
    if (!enabled || !table || !view || revision === undefined || summaries?.key === key) return;
    const controller = new AbortController();
    void readSummary(api, table, view, revision, dateContext, search, controller.signal).then(result => {
      if (!controller.signal.aborted) setSummary({ key, value: result });
    }).catch(error => {
      if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : 'Could not load groups.' });
    });
    return () => controller.abort();
  }, [api, model, key, enabled]);
  const rows = useMemo(() => enabled && table && summaries?.key === key
    ? new GroupedRows(table.fields.find(field => field.id === view!.groupBy)!, summaries.value, collapsed.get(namespace) ?? new Set())
    : undefined, [enabled, key, summaries, collapsed, namespace, table, view]);
  return { enabled, rows, error: enabled && failure?.key === key ? failure.message : undefined,
    collapse: (keys: ReadonlySet<string>) => setCollapsed(current => new Map(current).set(namespace, keys)),
    prepareRefresh: async (nextTable: Table, nextView: GridView, first: QueryPage, nextSearch: string, signal: AbortSignal) => {
      const summary = await readSummary(api, nextTable, nextView, first.revision, first.dateContext, nextSearch, signal);
      return { summary, rows: new GroupedRows(nextTable.fields.find(field => field.id === nextView.groupBy)!,
        summary, collapsed.get(collapseKey(nextView)) ?? new Set()) };
    },
    commitRefresh: (summary: RecordSummary, nextView: GridView, nextSearch: string) => {
      setSummary({ key: summaryKey(model, nextView, nextSearch), value: summary });
      setFailure(undefined);
    },
  };
}
