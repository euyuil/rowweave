import type { CalendarBucket, CalendarLayout, CalendarPage, Field, GridView, QueryPage, Table } from '../../contracts/src/index.js';
import { Temporal } from '../../core/src/temporal.js';
import { ApiFailure, type WorkspaceApi } from './http-client.js';

export const calendarPageSize = 25;
export const calendarPreviewSize = 2;
export interface CalendarWindow { month: string; bucket?: CalendarBucket; offset: number }
export interface CalendarSnapshot { window: CalendarWindow; layout: CalendarLayout; page?: CalendarPage }
type CalendarView = Extract<GridView, { type: 'calendar' }>;

export function calendarMonthRange(month: string): { from: string; toExclusive: string } {
  const first = Temporal.PlainYearMonth.from(month).toPlainDate({ day: 1 });
  const from = first.subtract({ days: first.dayOfWeek - 1 });
  return { from: from.toString(), toExclusive: from.add({ days: 42 }).toString() };
}

export function calendarCardFields(table: Table, view: CalendarView): Field[] {
  const fields = new Map(table.fields.map(field => [field.id, field]));
  return view.columns.filter(column => !column.hidden).map(column => fields.get(column.fieldId)!)
    .filter(field => field.id !== table.primaryFieldId && field.id !== view.calendar.startFieldId && field.id !== view.calendar.endFieldId).slice(0, 3);
}

export function calendarProjection(table: Table, view: CalendarView): string[] {
  return [...new Set([table.primaryFieldId, view.calendar.startFieldId, ...(view.calendar.endFieldId ? [view.calendar.endFieldId] : []),
    ...calendarCardFields(table, view).map(field => field.id)])];
}

export function calendarBucketCount(layout: CalendarLayout, bucket: CalendarBucket): number {
  return bucket.kind === 'day' ? layout.days.find(day => day.date === bucket.date)!.count : layout[bucket.kind].count;
}

export async function prepareCalendarSnapshot(api: Pick<WorkspaceApi, 'queryCalendar' | 'queryCalendarRecords'>, table: Table,
  view: CalendarView, first: Pick<QueryPage, 'revision' | 'dateContext'>, search: string, window: CalendarWindow,
  signal: AbortSignal): Promise<CalendarSnapshot> {
  const check = (result: { schemaVersion: number }) => {
    if (result.schemaVersion !== table.version) throw new ApiFailure('SCHEMA_CONFLICT', 'The table schema changed while checking calendar updates.', 409);
  };
  const query = { calendar: view.calendar, viewId: view.id, expectedViewVersion: view.version, expectedRevision: first.revision,
    ...(first.dateContext ? { expectedDateContext: first.dateContext } : {}), search, fields: calendarProjection(table, view) };
  const layout = await api.queryCalendar(table.id, { ...query, ...calendarMonthRange(window.month), previewLimit: calendarPreviewSize }, signal);
  check(layout);
  if (!window.bucket) return { window, layout };
  const count = calendarBucketCount(layout, window.bucket);
  const current = { ...window, offset: Math.min(window.offset, Math.max(0, Math.floor((count - 1) / calendarPageSize) * calendarPageSize)) };
  if (!count) return { window: current, layout };
  const page = await api.queryCalendarRecords(table.id, { ...query, expectedRevision: layout.revision,
    ...(layout.dateContext ? { expectedDateContext: layout.dateContext } : {}), bucket: window.bucket, offset: current.offset, limit: calendarPageSize }, signal);
  check(page);
  return { window: current, layout, page };
}
