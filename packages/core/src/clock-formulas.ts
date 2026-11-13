import type { ScalarValue } from '../../contracts/src/index.js';
import { calculationError } from './calculation-error.js';
import { Temporal } from './temporal.js';

export const clockFunctionArities: Record<string, [number, number]> = { NOW: [0, 0], TODAY: [0, 1] };

export function calculateClockFunction(name: string, inputs: ScalarValue[], now: Date | undefined): ScalarValue {
  if (!now) throw new Error('Clock formulas require the service calculation time.');
  const instant = Temporal.Instant.fromEpochMilliseconds(Math.floor(now.getTime() / 60_000) * 60_000);
  if (name === 'NOW') {
    const value = instant.toString({ fractionalSecondDigits: 3 });
    return /^\d{4}-/.test(value) ? value : calculationError('Date results must have a year between 0000 and 9999.');
  }
  const zone = inputs.length ? inputs[0] : 'UTC';
  if (zone === null) return null;
  if (typeof zone !== 'string' || !zone || /^[+-]/.test(zone)) return calculationError('Use a named time zone, such as Asia/Shanghai or UTC.');
  let date: Temporal.PlainDate;
  try { date = instant.toZonedDateTimeISO(zone).toPlainDate(); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return calculationError('Use a valid named time zone, such as Asia/Shanghai or UTC.');
  }
  return date.year >= 0 && date.year <= 9999 ? date.toString() : calculationError('Date results must have a year between 0000 and 9999.');
}
