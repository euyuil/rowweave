import { isReadOnlyField, valueField, type CalendarConfig, type CellValue, type Table } from '../../contracts/src/index.js';
import { Temporal } from '../../core/src/temporal.js';

export function calendarToday(timeZone: string, now = Date.now()): string {
  return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function calendarDateLabel(date: string): string {
  return Temporal.PlainDate.from(date).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

export function calendarMonthLabel(month: string): string {
  return Temporal.PlainYearMonth.from(month).toPlainDate({ day: 1 }).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

export function calendarInitialValues(table: Table, config: CalendarConfig, date: string):
  { values: Record<string, CellValue>; unavailable?: never } | { values?: never; unavailable: string } {
  const start = table.fields.find(field => field.id === config.startFieldId)!;
  if (isReadOnlyField(start)) return { unavailable: 'This start field is read-only. Use New record to create records from their inputs.' };
  let value = date;
  if (valueField(start).type === 'datetime') {
    const beginning = Temporal.PlainDate.from(date).toZonedDateTime(config.timeZone);
    if (beginning.toPlainDate().toString() !== date) return { unavailable: 'This date does not occur in the calendar time zone.' };
    value = beginning.toInstant().toString({ smallestUnit: 'millisecond' });
  }
  const values: Record<string, CellValue> = { [start.id]: value };
  const end = config.endFieldId ? table.fields.find(field => field.id === config.endFieldId)! : undefined;
  if (end && !isReadOnlyField(end)) values[end.id] = value;
  return { values };
}

export function calendarKeyboardDate(date: string, key: string): string | undefined {
  const current = Temporal.PlainDate.from(date);
  const days = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -7 : key === 'ArrowDown' ? 7
    : key === 'Home' ? 1 - current.dayOfWeek : key === 'End' ? 7 - current.dayOfWeek : undefined;
  if (days !== undefined) return current.add({ days }).toString();
  if (key === 'PageUp' || key === 'PageDown') return current.add({ months: key === 'PageUp' ? -1 : 1 }).toString();
  return undefined;
}
