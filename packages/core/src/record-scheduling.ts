import type { CellValue, RecordSchedule, RowRecord } from '../../contracts/src/index.js';
import type { CheckedCalendar } from './calendar-query.js';
import { ServiceError } from './errors.js';
import { validateValue } from './field-values.js';
import { schemaObject, schemaVersion } from './schema-validation.js';
import { Temporal } from './temporal.js';

function invalid(message: string): never { throw new ServiceError('INVALID_SCHEDULE', message); }

export function parseRecordSchedule(input: unknown): RecordSchedule {
  const source = schemaObject(input);
  const action = source['action'], days = source['days'];
  if (action !== 'move' && action !== 'resizeStart' && action !== 'resizeEnd') {
    return invalid('Choose move, resizeStart or resizeEnd for the schedule.');
  }
  if (!Number.isSafeInteger(days) || days === 0) return invalid('Change the schedule by a non-zero whole number of days.');
  return { action, days: days as number, expectedVersion: schemaVersion(source['expectedVersion']),
    expectedViewVersion: schemaVersion(source['expectedViewVersion']) };
}

export function rescheduledValues(calendar: CheckedCalendar, record: RowRecord, change: Pick<RecordSchedule, 'action' | 'days'>): Record<string, CellValue> {
  const { startField, endField, dateOnly, timeZone } = calendar;
  if (record.formulaErrors?.[startField.id] || (endField && record.formulaErrors?.[endField.id])) {
    return invalid('Resolve the configured date calculation errors before changing this schedule.');
  }
  const startValue = record.values[startField.id], endValue = endField ? record.values[endField.id] : null;
  if (startValue == null) return invalid('Set a start date before moving or resizing this record.');
  if (change.action !== 'move' && (!endField || endField.id === startField.id)) {
    return invalid('Configure separate start and end fields before resizing this record.');
  }
  let start = startValue as string, end = endValue as string | null | undefined;
  const moveStart = change.action !== 'resizeEnd';
  const moveEnd = change.action === 'resizeEnd' || (change.action === 'move' && end != null);
  try {
    if (dateOnly) {
      if (moveStart) start = Temporal.PlainDate.from(start).add({ days: change.days }).toString();
      if (moveEnd) end = Temporal.PlainDate.from(end ?? startValue as string).add({ days: change.days }).toString();
      if (end != null && Temporal.PlainDate.compare(end, start) < 0) return invalid('The end date cannot precede the start date.');
    } else {
      const originalStart = Temporal.Instant.from(start);
      const shift = (value: string) => {
        const current = Temporal.Instant.from(value).toZonedDateTimeISO(timeZone);
        const target = current.toPlainDate().add({ days: change.days });
        const shifted = current.add({ days: change.days });
        if (!shifted.toPlainDate().equals(target)) return invalid('The requested date does not occur in the configured time zone.');
        return shifted.toInstant();
      };
      if (moveStart) start = shift(start).toString({ smallestUnit: 'millisecond' });
      if (moveEnd) {
        const shiftedEnd = change.action === 'move'
          ? Temporal.Instant.fromEpochNanoseconds(Temporal.Instant.from(end!).epochNanoseconds
            + Temporal.Instant.from(start).epochNanoseconds - originalStart.epochNanoseconds)
          : shift(end ?? startValue as string);
        end = shiftedEnd.toString({ smallestUnit: 'millisecond' });
      }
      if (end != null && Temporal.Instant.compare(end, start) < 0) return invalid('The end timestamp cannot precede the start timestamp.');
    }
  } catch (error) {
    if (error instanceof RangeError) return invalid('The requested schedule is outside the supported date range.');
    throw error;
  }
  const values: Record<string, CellValue> = {};
  if (moveStart) values[startField.id] = validateValue(startField, start);
  if (moveEnd) values[endField!.id] = validateValue(endField!, end);
  return values;
}
