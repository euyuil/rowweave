import { createHash } from 'node:crypto';
import { Temporal } from '../../core/src/temporal.js';
import type { FieldFilter, FilterGroup, Table } from '../../contracts/src/index.js';
import { queryValueField } from '../../core/src/record-query.js';

export type DateRange = readonly [start: string, end: string];

export function hasRelativeDateFilter(filter: FilterGroup | undefined): boolean {
  return filter?.conditions.some(condition => 'conjunction' in condition
    ? hasRelativeDateFilter(condition) : condition.operator === 'relativeDate') ?? false;
}

export function relativeDateRanges(table: Pick<Table, 'fields'>, filter: FilterGroup | undefined, now: Date, previousContext?: string) {
  const ranges = new Map<FieldFilter, DateRange>(), currentTime = now.getTime();
  const previousTime = previousContext?.startsWith('h:') ? Number(previousContext.split(':')[1]) : NaN;
  // Reuse precise rolling boundaries briefly, without rounding away records created in the current minute.
  const anchor = currentTime >= previousTime && currentTime - previousTime < 60_000 ? previousTime : currentTime;
  let rolling = false;
  const visit = (group: FilterGroup) => {
    for (const condition of group.conditions) {
      if ('conjunction' in condition) { visit(condition); continue; }
      if (condition.operator !== 'relativeDate') continue;
      const { period, timeZone, days, hours } = condition.relative!;
      if (period === 'pastHours' || period === 'nextHours') {
        rolling = true;
        const duration = hours! * 3_600_000;
        const start = period === 'pastHours' ? anchor - duration : anchor;
        const end = period === 'pastHours' ? anchor : anchor + duration;
        // Timestamp values have millisecond precision; include both human-facing endpoints.
        ranges.set(condition, [new Date(start).toISOString(), new Date(end + 1).toISOString()]);
        continue;
      }
      const today = Temporal.Instant.fromEpochMilliseconds(currentTime).toZonedDateTimeISO(timeZone).toPlainDate();
      let start = today;
      let end = today.add({ days: 1 });
      switch (period) {
        case 'yesterday': start = today.subtract({ days: 1 }); end = today; break;
        case 'tomorrow': start = end; end = end.add({ days: 1 }); break;
        case 'thisWeek': case 'lastWeek': case 'nextWeek':
          start = today.subtract({ days: today.dayOfWeek - 1 }).add({ weeks: period === 'lastWeek' ? -1 : period === 'nextWeek' ? 1 : 0 });
          end = start.add({ weeks: 1 }); break;
        case 'thisMonth': case 'lastMonth': case 'nextMonth':
          start = today.with({ day: 1 }).add({ months: period === 'lastMonth' ? -1 : period === 'nextMonth' ? 1 : 0 });
          end = start.add({ months: 1 }); break;
        case 'thisYear': case 'lastYear': case 'nextYear':
          start = today.with({ month: 1, day: 1 }).add({ years: period === 'lastYear' ? -1 : period === 'nextYear' ? 1 : 0 });
          end = start.add({ years: 1 }); break;
        case 'pastDays': start = today.subtract({ days: days! - 1 }); break;
        case 'nextDays': end = today.add({ days: days! }); break;
      }
      const field = queryValueField(table.fields.find(field => field.id === condition.fieldId)!);
      // Omitting plainTime selects the first valid instant of the date, even when midnight is skipped.
      const format = (date: Temporal.PlainDate) => field.type === 'date' ? date.toString()
        : date.toZonedDateTime(timeZone).toInstant().toString({ fractionalSecondDigits: 3 });
      ranges.set(condition, [format(start), format(end)]);
    }
  };
  if (filter) visit(filter);
  const context = [...ranges].map(([condition, range]) => [condition.fieldId, ...range]);
  const hash = context.length ? createHash('sha256').update(JSON.stringify(context)).digest('hex') : undefined;
  return { ranges, ...(hash ? { dateContext: rolling ? `h:${anchor}:${hash}` : hash } : {}) };
}
