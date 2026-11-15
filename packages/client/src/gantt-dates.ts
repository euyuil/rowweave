import { isReadOnlyField, valueField, type GanttConfig, type RowRecord, type Table } from '../../contracts/src/index.js';
import { Temporal } from '../../core/src/temporal.js';

export type GanttInterval = { kind: 'unscheduled' | 'invalid' } | { kind: 'scheduled'; from: string; to: string; point: boolean };
export interface GanttRange { from: string; toExclusive: string; dayCount: number; dayWidth: number }
export const firstGanttDate = '0001-01-01';
export function ganttDayCount(scale: GanttConfig['scale']): number { return scale === 'day' ? 42 : 168; }
export function lastGanttDate(scale: GanttConfig['scale']): string {
  return Temporal.PlainDate.from('9999-12-31').subtract({ days: ganttDayCount(scale) - 1 }).toString();
}
export function ganttRange(from: string, scale: GanttConfig['scale']): GanttRange {
  const dayCount = ganttDayCount(scale);
  return { from, toExclusive: Temporal.PlainDate.from(from).add({ days: dayCount }).toString(), dayCount, dayWidth: scale === 'day' ? 40 : 12 };
}
export function ganttStart(date: string, scale: GanttConfig['scale'], days = 0): string {
  const next = Temporal.PlainDate.from(date).add({ days }), last = lastGanttDate(scale);
  return Temporal.PlainDate.compare(next, firstGanttDate) < 0 ? firstGanttDate : Temporal.PlainDate.compare(next, last) > 0 ? last : next.toString();
}

export function ganttInterval(table: Table, config: GanttConfig, record: RowRecord): GanttInterval {
  const start = record.values[config.startFieldId], end = config.endFieldId ? record.values[config.endFieldId] : null;
  if (record.formulaErrors?.[config.startFieldId] || (config.endFieldId && record.formulaErrors?.[config.endFieldId])) return { kind: 'invalid' };
  if (start == null) return { kind: 'unscheduled' };
  const dateOnly = valueField(table.fields.find(field => field.id === config.startFieldId)!).type === 'date';
  if (dateOnly) return end != null && Temporal.PlainDate.compare(end as string, start as string) < 0
    ? { kind: 'invalid' } : { kind: 'scheduled', from: start as string, to: (end ?? start) as string, point: false };
  const first = Temporal.Instant.from(start as string), last = end == null ? first : Temporal.Instant.from(end as string);
  const order = Temporal.Instant.compare(last, first);
  if (order < 0) return { kind: 'invalid' };
  return { kind: 'scheduled', from: first.toZonedDateTimeISO(config.timeZone).toPlainDate().toString(),
    to: (order === 0 ? first : last.subtract({ nanoseconds: 1 })).toZonedDateTimeISO(config.timeZone).toPlainDate().toString(), point: order === 0 };
}

export function ganttBar(range: GanttRange, interval: Extract<GanttInterval, { kind: 'scheduled' }>) {
  const first = Temporal.PlainDate.from(range.from), start = first.until(interval.from).days, end = first.until(interval.to).days + 1;
  if (end <= 0) return { kind: 'before' as const };
  if (start >= range.dayCount) return { kind: 'after' as const };
  return { kind: 'visible' as const, left: Math.max(0, start) * range.dayWidth,
    width: (Math.min(range.dayCount, end) - Math.max(0, start)) * range.dayWidth,
    clippedStart: start < 0, clippedEnd: end > range.dayCount };
}

export function ganttActions(table: Table, config: GanttConfig, record: RowRecord) {
  const start = table.fields.find(field => field.id === config.startFieldId)!, end = table.fields.find(field => field.id === config.endFieldId);
  const valid = ganttInterval(table, config, record).kind === 'scheduled';
  return { move: valid && !isReadOnlyField(start) && (!end || record.values[end.id] == null || !isReadOnlyField(end)),
    resizeStart: valid && !!end && start.id !== end.id && !isReadOnlyField(start),
    resizeEnd: valid && !!end && start.id !== end.id && !isReadOnlyField(end) };
}
