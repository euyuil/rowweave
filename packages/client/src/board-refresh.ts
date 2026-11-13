import type { Field, GridView, QueryPage, RecordSummary, Table, ViewPage } from '../../contracts/src/index.js';
import { ApiFailure, type WorkspaceApi } from './http-client.js';

export const boardPageSize = 25;

export interface BoardWindow {
  lane: string | null;
  offset: number;
  near: boolean;
}

export interface BoardSnapshot {
  summary: RecordSummary;
  windows: readonly BoardWindow[];
  pages: ReadonlyMap<string | null, ViewPage>;
}

export function boardCardFields(table: Table, view: GridView): Field[] {
  const fields = new Map(table.fields.map(field => [field.id, field]));
  return view.columns.filter(column => !column.hidden).map(column => fields.get(column.fieldId)!)
    .filter(field => field.id !== table.primaryFieldId && field.id !== view.groupBy).slice(0, 3);
}

export async function prepareBoardSnapshot(api: Pick<WorkspaceApi, 'summarizeRecords' | 'queryView'>, table: Table,
  view: GridView, first: Pick<QueryPage, 'revision' | 'dateContext'>, search: string, windows: readonly BoardWindow[],
  signal: AbortSignal): Promise<BoardSnapshot> {
  const check = (result: { schemaVersion: number }) => {
    if (result.schemaVersion !== table.version) throw new ApiFailure('SCHEMA_CONFLICT', 'The table schema changed while checking board updates.', 409);
  };
  const summary = await api.summarizeRecords(table.id, { viewId: view.id, expectedViewVersion: view.version,
    expectedRevision: first.revision, ...(first.dateContext ? { expectedDateContext: first.dateContext } : {}),
    groupBy: view.groupBy!, search, limit: 500 }, signal);
  check(summary);
  const group = table.fields.find(field => field.id === view.groupBy)!;
  const lanes = new Set<string | null>([...group.options!.map(option => option.id), null]);
  const counts = new Map(summary.groups.map(group => [group.key, group.count]));
  const current = windows.filter(window => lanes.has(window.lane)).map(window => ({ ...window,
    offset: Math.min(window.offset, Math.max(0, Math.floor(((counts.get(window.lane) ?? 0) - 1) / boardPageSize) * boardPageSize)),
  }));
  const fields = [...new Set([table.primaryFieldId, group.id, ...boardCardFields(table, view).map(field => field.id)])];
  const pages = new Map<string | null, ViewPage>();
  for (const window of current) {
    if (!window.near || !counts.get(window.lane)) continue;
    const page = await api.queryView(table.id, view.id, { lane: window.lane, search, offset: window.offset,
      limit: boardPageSize, fields, expectedRevision: summary.revision, expectedViewVersion: view.version,
      ...(summary.dateContext ? { expectedDateContext: summary.dateContext } : {}),
    }, signal);
    check(page);
    pages.set(window.lane, page);
  }
  return { summary, windows: current, pages };
}
