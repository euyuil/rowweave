import { maxCalendarDays, maxCalendarPreview, valueField, type CalendarBucket, type Field, type Table } from '../../contracts/src/index.js';
import { ServiceError } from './errors.js';
import { Temporal } from './temporal.js';

export interface CheckedCalendar { startField: Field; endField?: Field; dateOnly: boolean; timeZone: string }
export interface CheckedCalendarWindow { from: string; toExclusive: string; previewLimit: number }

function invalid(message: string): never { throw new ServiceError('INVALID_QUERY', message); }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected calendar settings.');
  return value as Record<string, unknown>;
}

function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid('Use a calendar date in YYYY-MM-DD format.');
  try { Temporal.PlainDate.from(value); }
  catch { return invalid('Use a valid calendar date.'); }
  return value;
}

export function parseCalendar(table: Table, input: unknown): CheckedCalendar {
  const source = object(input);
  const field = (id: unknown) => {
    const selected = table.fields.find(field => field.id === id);
    if (!selected || !['date', 'datetime'].includes(valueField(selected).type)) {
      return invalid('Choose a scalar date or timestamp field for the calendar.');
    }
    return selected;
  };
  const startField = field(source['startFieldId']);
  const endField = source['endFieldId'] === undefined ? undefined : field(source['endFieldId']);
  if (endField && valueField(endField).type !== valueField(startField).type) {
    return invalid('Calendar start and end fields must both be dates or both be timestamps.');
  }
  const timeZone = source['timeZone'];
  if (typeof timeZone !== 'string' || !timeZone) return invalid('Choose a named calendar time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone }); }
  catch { return invalid('Choose a valid named calendar time zone.'); }
  return { startField, ...(endField ? { endField } : {}), dateOnly: valueField(startField).type === 'date', timeZone };
}

export function parseCalendarWindow(source: Record<string, unknown>): CheckedCalendarWindow {
  const from = date(source['from']), toExclusive = date(source['toExclusive']);
  const days = Temporal.PlainDate.from(from).until(toExclusive).days;
  if (days < 1 || days > maxCalendarDays) return invalid(`Read between 1 and ${maxCalendarDays} calendar days at a time.`);
  const previewLimit = source['previewLimit'] === undefined ? 3 : source['previewLimit'];
  if (!Number.isSafeInteger(previewLimit) || (previewLimit as number) < 0 || (previewLimit as number) > maxCalendarPreview) {
    return invalid(`Preview between 0 and ${maxCalendarPreview} records per calendar bucket.`);
  }
  return { from, toExclusive, previewLimit: previewLimit as number };
}

export function parseCalendarBucket(input: unknown): CalendarBucket {
  const source = object(input);
  if (source['kind'] === 'day') return { kind: 'day', date: date(source['date']) };
  if (source['kind'] === 'unscheduled' || source['kind'] === 'invalid') {
    if (source['date'] !== undefined) return invalid('Only a day bucket accepts a date.');
    return { kind: source['kind'] };
  }
  return invalid('Choose a day, unscheduled or invalid calendar bucket.');
}
