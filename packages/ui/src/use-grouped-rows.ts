import { useEffect, useMemo, useState } from 'react';
import type { GridView, RecordSummary } from '../../contracts/src/index.js';
import type { TableModel } from '../../client/src/table-model.js';
import type { WorkspaceApi } from '../../client/src/http-client.js';
import { GroupedRows } from '../../client/src/grouped-rows.js';

export function useGroupedRows(model: TableModel, api: WorkspaceApi, view: GridView | undefined, search: string) {
  const table = model.table;
  const revision = model.dataRevision;
  const enabled = view?.type === 'grid' && !!view.groupBy;
  const key = JSON.stringify([view?.id, view?.version, model.queryVersion, table?.version, revision, search]);
  const namespace = `${view?.id}:${view?.groupBy}`;
  const [summaries, setSummary] = useState<{ key: string; value: RecordSummary }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [collapsed, setCollapsed] = useState(new Map<string, ReadonlySet<string>>());
  useEffect(() => {
    if (!enabled || !table || !view || revision === undefined) return;
    const controller = new AbortController();
    void (async () => {
      const result = await api.summarizeRecords(table.id, { viewId: view.id, expectedViewVersion: view.version,
        expectedRevision: revision, groupBy: view.groupBy!, search, limit: 500 }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.schemaVersion !== table.version) throw new Error('The table schema changed. Reload to see the current groups.');
      setSummary({ key, value: result });
    })().catch(error => {
      if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : 'Could not load groups.' });
    });
    return () => controller.abort();
  }, [api, model, key, enabled]);
  const rows = useMemo(() => enabled && table && summaries?.key === key
    ? new GroupedRows(table.fields.find(field => field.id === view!.groupBy)!, summaries.value, collapsed.get(namespace) ?? new Set())
    : undefined, [enabled, key, summaries, collapsed, namespace, table, view]);
  return { enabled, rows, error: enabled && failure?.key === key ? failure.message : undefined,
    collapse: (keys: ReadonlySet<string>) => setCollapsed(current => new Map(current).set(namespace, keys)) };
}
