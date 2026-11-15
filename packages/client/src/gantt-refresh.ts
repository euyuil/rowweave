import type { Field, GridView, QueryPage, Table, ViewPage } from '../../contracts/src/index.js';
import { ApiFailure, type WorkspaceApi } from './http-client.js';

export const ganttPageSize = 50;
export interface GanttWindow { offset: number }
export interface GanttSnapshot { window: GanttWindow; page: ViewPage }
type GanttView = Extract<GridView, { type: 'gantt' }>;

export function ganttCardFields(table: Table, view: GanttView): Field[] {
  const fields = new Map(table.fields.map(field => [field.id, field]));
  return view.columns.filter(column => !column.hidden).map(column => fields.get(column.fieldId)!)
    .filter(field => field.id !== table.primaryFieldId && field.id !== view.gantt.startFieldId && field.id !== view.gantt.endFieldId).slice(0, 3);
}
export function ganttProjection(table: Table, view: GanttView): string[] {
  return [...new Set([table.primaryFieldId, view.gantt.startFieldId, ...(view.gantt.endFieldId ? [view.gantt.endFieldId] : []),
    ...ganttCardFields(table, view).map(field => field.id)])];
}
export async function prepareGanttSnapshot(api: Pick<WorkspaceApi, 'queryView'>, table: Table, view: GanttView,
  first: Pick<QueryPage, 'revision' | 'dateContext' | 'total'>, search: string, window: GanttWindow, signal: AbortSignal): Promise<GanttSnapshot> {
  const offset = Math.min(window.offset, Math.max(0, Math.floor((first.total - 1) / ganttPageSize) * ganttPageSize));
  const page = await api.queryView(table.id, view.id, { offset, limit: ganttPageSize, fields: ganttProjection(table, view),
    expectedViewVersion: view.version, expectedRevision: first.revision, ...(first.dateContext ? { expectedDateContext: first.dateContext } : {}), search }, signal);
  if (page.schemaVersion !== table.version) throw new ApiFailure('SCHEMA_CONFLICT', 'The table schema changed while checking timeline updates.', 409);
  return { window: { offset }, page };
}
