import { Temporal } from './temporal.js';
import type { ScalarValue } from '../../contracts/src/index.js';
import { calculationError } from './calculation-error.js';
import { validateValue } from './field-values.js';
import { ServiceError } from './errors.js';

export const dateFunctionArities: Record<string, [number, number]> = {
  DATE: [3, 3], DATEVALUE: [1, 1], DATETIMEVALUE: [1, 1],
  YEAR: [1, 1], MONTH: [1, 1], DAY: [1, 1], WEEKDAY: [1, 1],
  HOUR: [1, 1], MINUTE: [1, 1], SECOND: [1, 1], DATEADD: [3, 3], DATEDIFF: [3, 3],
};
const units = { year: 'years', month: 'months', week: 'weeks', day: 'days', hour: 'hours', minute: 'minutes', second: 'seconds' } as const;
type DateValue = Temporal.PlainDate | Temporal.ZonedDateTime;

function integer(value: ScalarValue): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : calculationError('Expected a whole number within the safe integer range.');
}

function date(value: ScalarValue): DateValue {
  if (typeof value !== 'string') return calculationError('Expected a calendar date or timestamp.');
  const type = /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'date' : 'datetime';
  let normalized: string;
  try { normalized = validateValue({ id: 'date', name: 'Date', type }, value) as string; }
  catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    return calculationError('Expected YYYY-MM-DD or an ISO timestamp with an explicit time zone.');
  }
  return type === 'date' ? Temporal.PlainDate.from(normalized) : Temporal.Instant.from(normalized).toZonedDateTimeISO('UTC');
}

function timestamp(value: DateValue): Temporal.ZonedDateTime {
  return value instanceof Temporal.PlainDate ? value.toZonedDateTime('UTC') : value;
}

function format(value: DateValue): string {
  if (value.year < 0 || value.year > 9999) return calculationError('Date results must have a year between 0000 and 9999.');
  return value instanceof Temporal.PlainDate ? value.toString() : value.toInstant().toString({ fractionalSecondDigits: 3 });
}

function unit(value: ScalarValue) {
  const result = typeof value === 'string' && Object.hasOwn(units, value.toLowerCase()) ? units[value.toLowerCase() as keyof typeof units] : undefined;
  return result ?? calculationError('Use year, month, week, day, hour, minute or second as the date unit.');
}

export function calculateDateFunction(name: string, inputs: ScalarValue[]): ScalarValue {
  const a = inputs[0]!, b = inputs[1]!, c = inputs[2]!;
  try {
    if (name === 'DATE') return format(Temporal.PlainDate.from({ year: integer(a), month: integer(b), day: integer(c) }, { overflow: 'reject' }));
    const value = date(a);
    switch (name) {
      case 'YEAR': return value.year;
      case 'MONTH': return value.month;
      case 'DAY': return value.day;
      case 'WEEKDAY': return value.dayOfWeek;
      case 'HOUR': case 'MINUTE': case 'SECOND':
        if (value instanceof Temporal.PlainDate) return calculationError('Time components require a timestamp. Use DATETIMEVALUE for UTC midnight.');
        return name === 'HOUR' ? value.hour : name === 'MINUTE' ? value.minute : value.second;
      case 'DATEVALUE': return format(value instanceof Temporal.PlainDate ? value : value.toPlainDate());
      case 'DATETIMEVALUE': return format(timestamp(value));
      case 'DATEADD': {
        const selected = unit(c), amount = integer(b);
        if (value instanceof Temporal.PlainDate && ['hours', 'minutes', 'seconds'].includes(selected)) {
          return calculationError('Use DATETIMEVALUE before adding hours, minutes or seconds to a date.');
        }
        return format(value.add({ [selected]: amount }, { overflow: 'constrain' }));
      }
      case 'DATEDIFF': {
        const selected = unit(c), start = timestamp(value), end = timestamp(date(b));
        const descending = Temporal.ZonedDateTime.compare(start, end) > 0;
        const earlier = descending ? end : start, later = descending ? start : end;
        const amount = earlier.until(later, { largestUnit: selected, smallestUnit: selected, roundingMode: 'trunc' })[selected];
        return amount === 0 ? 0 : descending ? -amount : amount;
      }
      default: throw new Error('Unchecked date formula operation: ' + name);
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return calculationError('Invalid calendar date, time or date arithmetic range.');
  }
}
