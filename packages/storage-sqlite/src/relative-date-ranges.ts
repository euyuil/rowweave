import { createHash } from 'node:crypto';
import { Temporal } from '../../core/src/temporal.js';
import type { FieldFilter, FilterGroup, Table } from '../../contracts/src/index.js';
import { queryValueField } from '../../core/src/record-query.js';

export type DateRange = readonly [start: string, end: string];

export function hasRelativeDateFilter(filter: FilterGroup | undefined): boolean {
  return filter?.conditions.some(condition => 'conjunction' in condition
    ? hasRelativeDateFilter(condition) : condition.operator === 'relativeDate') ?? false;
}

export function relativeDateRanges(table: Pick<Table, 'fields'>, filter: FilterGroup | undefined, now: Date) {
  const ranges = new Map<FieldFilter, DateRange>();
  const visit = (group: FilterGroup) => {
    for (const condition of group.conditions) {
      if ('conjunction' in condition) { visit(condition); continue; }
      if (condition.operator !== 'relativeDate') continue;
      const { period, timeZone, days } = condition.relative!;
      const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone).toPlainDate();
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
  return { ranges, ...(context.length ? { dateContext: createHash('sha256').update(JSON.stringify(context)).digest('hex') } : {}) };
}
