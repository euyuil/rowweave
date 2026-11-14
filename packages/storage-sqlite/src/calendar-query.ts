import type { DatabaseSync } from 'node:sqlite';
import type { CalendarBucket } from '../../contracts/src/index.js';
import type { CheckedCalendar, CheckedCalendarWindow } from '../../core/src/calendar-query.js';
import { Temporal } from '../../core/src/temporal.js';
import type { querySql } from './query-sql.js';

type SqlQuery = ReturnType<typeof querySql>;
interface CalendarRow { id: string; start: number | null; end: number | null; invalid: boolean }
interface Bucket { count: number; ids: string[] }
interface Day extends Bucket { date: string; start: number; end: number }

function days(from: string, toExclusive: string, config: CheckedCalendar): Day[] {
  const output: Day[] = [];
  const bound = (date: Temporal.PlainDate) => config.dateOnly ? Date.parse(date.toString()) : date.toZonedDateTime(config.timeZone).epochMilliseconds;
  for (let date = Temporal.PlainDate.from(from); Temporal.PlainDate.compare(date, toExclusive) < 0; date = date.add({ days: 1 })) {
    output.push({ date: date.toString(), start: bound(date), end: bound(date.add({ days: 1 })), count: 0, ids: [] });
  }
  return output;
}

function* rows(db: DatabaseSync, config: CheckedCalendar, sql: SqlQuery): Iterable<CalendarRow> {
  const path = (id: string) => '$.' + JSON.stringify(id);
  const start = 'json_extract(r.values_json, :calendarStart)';
  const end = config.endField ? 'json_extract(r.values_json, :calendarEnd)' : 'NULL';
  const error = 'json_extract(r.formula_errors_json, :calendarStart) IS NOT NULL' +
    (config.endField ? ' OR json_extract(r.formula_errors_json, :calendarEnd) IS NOT NULL' : '');
  const statement = db.prepare(`SELECT r.id, ${start} AS start_value, ${end} AS end_value, (${error}) AS invalid
    FROM records r WHERE ${sql.where} ORDER BY ${sql.order}`);
  for (const row of statement.iterate({ ...sql.parameters, ':calendarStart': path(config.startField.id),
    ...(config.endField ? { ':calendarEnd': path(config.endField.id) } : {}) })) {
    const startValue = row['start_value'] === null ? null : Date.parse(row['start_value'] as string);
    const endValue = row['end_value'] === null ? null : Date.parse(row['end_value'] as string);
    yield { id: row['id'] as string, start: startValue, end: endValue,
      invalid: !!row['invalid'] || (startValue !== null && endValue !== null && endValue < startValue) };
  }
}

function lowerBound<T>(items: readonly T[], value: number, read: (item: T) => number, afterEqual = false): number {
  let low = 0, high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1, key = read(items[middle]!);
    if (key < value || (afterEqual && key === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}

function interval(days: Day[], row: CalendarRow & { start: number }, dateOnly: boolean): [number, number] {
  const first = lowerBound(days, row.start, day => day.end, true);
  const last = dateOnly ? lowerBound(days, row.end ?? row.start, day => day.start, true)
    : row.end !== null && row.end > row.start ? lowerBound(days, row.end, day => day.start)
      : first < days.length && days[first]!.start <= row.start ? first + 1 : first;
  return [first, last];
}

export function calendarLayout(db: DatabaseSync, config: CheckedCalendar, window: CheckedCalendarWindow, sql: SqlQuery) {
  const allDays = days(window.from, window.toExclusive, config), active = allDays.filter(day => day.start < day.end);
  const differences = new Array<number>(active.length + 1).fill(0);
  const unfilled = window.previewLimit ? active.map((_, index) => index) : [];
  const invalid: Bucket = { count: 0, ids: [] }, unscheduled: Bucket = { count: 0, ids: [] };
  let totalRecords = 0, scheduledRecords = 0;
  for (const row of rows(db, config, sql)) {
    totalRecords++;
    const bucket = row.invalid ? invalid : row.start === null ? unscheduled : undefined;
    if (bucket) {
      bucket.count++;
      if (bucket.ids.length < window.previewLimit) bucket.ids.push(row.id);
      continue;
    }
    const [first, last] = interval(active, row as CalendarRow & { start: number }, config.dateOnly);
    if (first >= last) continue;
    scheduledRecords++; differences[first]!++; differences[last]!--;
    let candidate = lowerBound(unfilled, first, value => value);
    while (candidate < unfilled.length && unfilled[candidate]! < last) {
      const day = active[unfilled[candidate]!]!;
      day.ids.push(row.id);
      if (day.ids.length === window.previewLimit) unfilled.splice(candidate, 1);
      else candidate++;
    }
  }
  let count = 0;
  active.forEach((day, index) => { count += differences[index]!; day.count = count; });
  return { days: allDays.map(({ date, count, ids }) => ({ date, count, ids })), invalid, unscheduled, totalRecords, scheduledRecords };
}

export function calendarPage(db: DatabaseSync, config: CheckedCalendar, bucket: CalendarBucket, sql: SqlQuery, offset: number, limit: number) {
  const selectedDays = bucket.kind === 'day'
    ? days(bucket.date, Temporal.PlainDate.from(bucket.date).add({ days: 1 }).toString(), config).filter(day => day.start < day.end) : [];
  let total = 0;
  const ids: string[] = [];
  for (const row of rows(db, config, sql)) {
    let matches: boolean;
    if (bucket.kind === 'invalid') matches = row.invalid;
    else if (bucket.kind === 'unscheduled') matches = !row.invalid && row.start === null;
    else if (row.invalid || row.start === null) matches = false;
    else {
      const [first, last] = interval(selectedDays, row as CalendarRow & { start: number }, config.dateOnly);
      matches = first < last;
    }
    if (!matches) continue;
    if (total >= offset && ids.length < limit) ids.push(row.id);
    total++;
  }
  return { total, ids };
}
