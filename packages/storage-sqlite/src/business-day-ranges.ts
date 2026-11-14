import { Temporal } from '../../core/src/temporal.js';
import type { DateRange, WeekdayRange } from './relative-date-ranges.js';

export function businessDateRange(today: Temporal.PlainDate, days: number, direction: -1 | 1, timeZone: string, dateOnly: boolean): DateRange {
  const current = today.dayOfWeek > 5 ? today.add({ days: (direction > 0 ? 8 : 5) - today.dayOfWeek }) : today;
  const remaining = days - 1, remainder = remaining % 5;
  const crossesWeekend = direction > 0 ? current.dayOfWeek + remainder > 5 : current.dayOfWeek - remainder < 1;
  const distance = Math.floor(remaining / 5) * 7 + remainder + (crossesWeekend ? 2 : 0);
  const far = current.add({ days: direction * distance });
  const start = direction > 0 ? current : far, end = (direction > 0 ? far : current).add({ days: 1 });
  if (dateOnly) {
    const first = start.toString(), last = end.toString();
    return [first, last, [{ start: first, end: last, offsetSeconds: 0 }]];
  }
  let cursor = start.toZonedDateTime(timeZone);
  const finish = end.toZonedDateTime(timeZone), intervals: WeekdayRange[] = [];
  const format = (value: Temporal.ZonedDateTime) => value.toInstant().toString({ fractionalSecondDigits: 3 });
  const first = format(cursor), last = format(finish);
  // Resolve zone changes once; SQLite can then evaluate local weekdays with fixed offsets.
  while (cursor.epochMilliseconds < finish.epochMilliseconds) {
    const next = cursor.getTimeZoneTransition('next');
    const boundary = next && next.epochMilliseconds < finish.epochMilliseconds ? next : finish;
    intervals.push({ start: format(cursor), end: format(boundary), offsetSeconds: cursor.offsetNanoseconds / 1_000_000_000 });
    cursor = boundary;
  }
  return [first, last, intervals];
}
